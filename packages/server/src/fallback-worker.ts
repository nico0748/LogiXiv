import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import {
  buildSentencesFromChunks,
  guessTitleFromChunks,
  type FallbackResult,
  type PageSize,
  type TextChunk,
} from '@logixiv/core';

/**
 * pdf.js を回し、**文の組み立てまで済ませて**返すワーカー。
 *
 * ここを別スレッドに出しているのは、pdf.js を Node で使うと「fake worker」として
 * 同一スレッドで動き、解析中は HTTP も SSE ハートビートも一切進まなくなるため。
 * 900 ページの PDF 1 本でイベントループが 68 秒止まり、その間の keep-alive 接続が
 * 切られて他のクライアントが ECONNRESET を受ける、という状態だった。
 *
 * かつては「文字片と用紙サイズ」だけを返し、文の組み立て（buildSentencesFromChunks）は
 * 呼び出し側＝**メインスレッド**でやっていた。これが逆に効いていた。実測（合成 PDF・
 * 2 段組）で、ワーカー側の pdf.js は 60 ページ 0.9 秒／120 ページ 1.0 秒とほぼ一定なのに、
 * メインスレッドの組み立ては 30 ページ 3.3 秒 → 60 ページ 11.4 秒 → 120 ページ 37.8 秒と
 * ページ数の**二乗**で伸びていた。つまり所要時間の 99% が「上限の効かない側」にあり、
 * fallback.ts が置いた timeoutMs も、打ち切りの setTimeout が動くべきイベントループごと
 * 止まっているので一度も発火しなかった（200 ページで 120 秒の上限に対し実測 227 秒）。
 *
 * なので責務を「pdf.js の呼び出しだけ」から「DocumentStructure の材料を作るところまで」に
 * 広げた。重い処理が丸ごとこちら側に来ることで、
 *   - 取り込み中でも /api/health も SSE もそのまま返る、
 *   - 呼び出し側の timeoutMs が本当に効く（terminate() は同期実行中の JS も止められる）、
 *   - 文字片（400k 件になりうる）をスレッド間で複製しなくて済む、
 * の 3 つが同時に成り立つ。二乗そのものは core 側の話なので、ここでは直せない。
 */

export interface FallbackWorkerInput {
  pdf: Uint8Array;
  maxPages: number;
  maxChunks: number;
}

export interface FallbackWorkerOutput extends FallbackResult {
  pageSizes: PageSize[];
  /** ページ数の上限で打ち切ったか。 */
  truncatedPages: number;
  /** 文字片の上限で打ち切ったか。 */
  truncatedChunks: boolean;
  /** PDF のメタデータに入っていた題名。無いことも、ファイル名が入っていることも多い。 */
  metadataTitle: string | null;
  /** 版面から推測した題名。選別は呼び出し側（fallback.ts の pickTitle）でやる。 */
  guessedTitle: string | null;
  /** 内訳の実測値。どちらが重いかを人が確かめられるように返す（打ち切りの調整に要る）。 */
  timings: { extractMs: number; buildMs: number };
}

interface PdfJsTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

interface Extracted {
  chunks: TextChunk[];
  pageSizes: PageSize[];
  truncatedPages: number;
  truncatedChunks: boolean;
  metadataTitle: string | null;
}

async function extract(input: FallbackWorkerInput): Promise<Extracted> {
  const require = createRequire(import.meta.url);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  (pdfjs.GlobalWorkerOptions as { workerSrc: string }).workerSrc = pathToFileURL(
    require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
  ).href;

  // pdf.js は Buffer を受け付けない（Buffer は Uint8Array の派生だが明示的に弾かれる）。
  const data = new Uint8Array(input.pdf.byteLength);
  data.set(input.pdf);

  const task = pdfjs.getDocument({
    data,
    useSystemFonts: false,
    disableFontFace: true,
    // テキスト抽出しかしないので、フォント実体が無いことの警告は出さない。
    verbosity: 0,
    standardFontDataUrl: pathToFileURL(
      require.resolve('pdfjs-dist/package.json').replace(/package\.json$/, 'standard_fonts/'),
    ).href,
  });

  const document = await task.promise;
  // メタデータの題名は当たれば一番正確なので先に見る。ただし空だったり
  // `untitled.dvi` のような組版の痕跡が入っていたりするので、呼び出し側で選別する。
  let metadataTitle: string | null = null;
  try {
    const meta = (await document.getMetadata()) as { info?: { Title?: unknown } };
    const value = meta.info?.Title;
    if (typeof value === 'string' && value.trim().length > 0) metadataTitle = value.trim();
  } catch {
    /* メタデータが壊れていても解析そのものは続ける。 */
  }
  const chunks: TextChunk[] = [];
  const pageSizes: PageSize[] = [];
  let truncatedChunks = false;

  try {
    const pageCount = Math.min(document.numPages, input.maxPages);
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      pageSizes.push({ page: pageNumber, width: viewport.width, height: viewport.height });

      const content = await page.getTextContent();
      for (const raw of content.items as unknown[]) {
        const item = raw as PdfJsTextItem;
        if (typeof item.str !== 'string' || item.str.length === 0) continue;
        if (chunks.length >= input.maxChunks) {
          truncatedChunks = true;
          break;
        }
        // 回転したページ（\begin{landscape} の付録など）では、pdf.js が返す
        // 文字片の座標は**回転前の座標系のまま**で、viewport だけが回っている。
        // そのまま使うと、そのページの行がすべて同じ y を持ち（行送りは x 方向に出る）、
        // 行のまとめが y で行われるのでページ中の全行が 1 行に潰れる。
        // 3 つの文の断片が織り込まれ、`text.corresponds` `sizeone` と語がくっつく。
        // 回転の有無は抽出のこの時点でしか確実に分からないので、ここで直す。
        // viewport の変換を掛けると左上原点・y 下向き（＝GROBID と同じ向き）になり、
        // 回転ページでも文字が横に流れる座標系に揃う。pdf.js 自身のテキストレイヤーと
        // 同じ求め方（左端 = tx[4]、字高 = hypot(tx[2], tx[3])、上端 = ベースライン - 字高）。
        const tx = pdfjs.Util.transform(viewport.transform, item.transform);
        const height = Math.hypot(tx[2] ?? 0, tx[3] ?? 0) || (item.height > 0 ? item.height : 10);
        chunks.push({
          page: pageNumber,
          text: item.str,
          x: tx[4] ?? 0,
          y: (tx[5] ?? 0) - height,
          w: item.width,
          h: height,
        });
      }
      page.cleanup();
      if (truncatedChunks) break;
    }

    return {
      chunks,
      pageSizes,
      truncatedPages: Math.max(0, document.numPages - pageCount),
      truncatedChunks,
      metadataTitle,
    };
  } finally {
    await task.destroy();
  }
}

async function run(input: FallbackWorkerInput): Promise<FallbackWorkerOutput> {
  const startedAt = Date.now();
  const extracted = await extract(input);
  const extractedAt = Date.now();

  // 組み立てもここでやる（＝メインスレッドには重い処理を一切残さない）。
  // このスレッドが何秒回ろうと、HTTP を捌くイベントループは別なので止まらない。
  const built = buildSentencesFromChunks(extracted.chunks, extracted.pageSizes);
  // 題名の推測も文字片を舐めるので、こちら側で済ませる。
  // 「どれを採るか」の判断は fallback.ts に残す（版面の話ではなく方針の話なので）。
  const guessedTitle = guessTitleFromChunks(extracted.chunks);
  const builtAt = Date.now();

  return {
    ...built,
    pageSizes: extracted.pageSizes,
    truncatedPages: extracted.truncatedPages,
    truncatedChunks: extracted.truncatedChunks,
    metadataTitle: extracted.metadataTitle,
    guessedTitle,
    timings: { extractMs: extractedAt - startedAt, buildMs: builtAt - extractedAt },
  };
}

if (parentPort) {
  const port = parentPort;
  run(workerData as FallbackWorkerInput).then(
    (result) => port.postMessage({ ok: true, result }),
    // メッセージだけでなくクラス名も返す。pdf.js は「暗号化されている」と
    // 「壊れている」を例外クラスでしか区別しないので、文字列にしてしまうと
    // 呼び出し側は英語の本文を正規表現で読むしかなくなる（＝将来必ずずれる）。
    (error: unknown) =>
      port.postMessage({
        ok: false,
        error: {
          name: error instanceof Error ? error.name : null,
          message: error instanceof Error ? error.message : String(error),
        },
      }),
  );
}
