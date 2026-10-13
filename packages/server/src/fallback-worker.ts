import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import {
  buildSentencesFromChunks,
  guessTitleFromChunks,
  type FallbackResult,
  type PageSize,
  type TextChunk,
} from '@paperlens/core';

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

/** 向きを決める前の、1 つの文字片。 */
interface PlacedItem {
  text: string;
  /** viewport 座標（左上原点・y 下向き）でのベースライン左端。 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** viewport 座標での傾き（ラジアン）。 */
  angle: number;
}

/** 15 度。これより小さい傾きは、同じ向きの組版の誤差とみなす。 */
const UPRIGHT_TOLERANCE = Math.PI / 12;

function normalizeAngle(angle: number): number {
  let value = angle;
  while (value > Math.PI) value -= 2 * Math.PI;
  while (value < -Math.PI) value += 2 * Math.PI;
  return value;
}

/**
 * そのページで、いちばん多くの文字を占めている向き。
 *
 * 件数ではなく**文字数**で数える。図のラベルは短い文字片が何本も並ぶので、
 * 件数で数えると本文 3 行の付録ページで軸ラベルが勝ってしまう。
 * 90 度刻みに丸めるのは、組版が本文を半端な角度で組むことはないため。
 */
function dominantAngle(items: readonly PlacedItem[], pageRotate: number): number {
  // ページ自身が回転を宣言している（pdflscape の /Rotate）なら、viewport が
  // すでにそれを打ち消しているので、本文はまっすぐ＝0 のはず。迷う必要がない。
  if (pageRotate % 360 !== 0) return 0;

  const weight = new Map<number, number>();
  let total = 0;
  for (const item of items) {
    const quarter = Math.round(normalizeAngle(item.angle) / (Math.PI / 2)) * (Math.PI / 2);
    weight.set(quarter, (weight.get(quarter) ?? 0) + item.text.length);
    total += item.text.length;
  }
  if (total === 0) return 0;

  const upright = weight.get(0) ?? 0;
  let best = 0;
  let bestWeight = upright;
  for (const [angle, value] of weight) {
    if (angle !== 0 && value > bestWeight) {
      best = angle;
      bestWeight = value;
    }
  }
  if (best === 0) return 0;

  // 回った側が勝っても、**まっすぐな文字がそれなりにある**ページでは 0 のままにする。
  //
  // 横倒しの大きな表や図は本文より字数が多くなることがあり、単純な多数決だと
  // 「まっすぐな本文の方が付物」に落ちる（ページ 1 枚ぶんの本文が訳す対象から消え、
  // しかも『訳しません』という嘘の理由が付く）。実測では、柱とノンブルだけで
  // 回った本文に競り勝つ版面もあった。
  //
  // 逆に lscape のように**ページごと回っている**版面では、まっすぐな文字は
  // ほとんど無い（あっても柱くらい）。だから「まっすぐが 2 割未満」を条件にすると、
  // 回ったページは拾いつつ、混在ページでは本文を守れる。
  // まっすぐな文字が「柱とノンブルだけ」しかないページでは、割合で見ると
  // 回った本文に競り勝ってしまう（実測: 柱＋ノンブル 74 字 対 回った本文 63 字）。
  // 1 ページぶんの本文になり得ない量（200 字未満）なら、割合に関わらず回った側を取る。
  return upright / total < 0.2 || upright < 200 ? best : 0;
}

/** 原点まわりに回す。ページごと回っている版面を、横書きの座標系へ読み直すために使う。 */
function rotatePoint(x: number, y: number, angle: number): [number, number] {
  if (angle === 0) return [x, y];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [x * cos - y * sin, x * sin + y * cos];
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
      const pageItems: PlacedItem[] = [];
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
        // 回転の有無は抽出のこの時点でしか確実に分からないので、ここで直す。
        // viewport の変換を掛けると左上原点・y 下向き（＝GROBID と同じ向き）になり、
        // /Rotate を立てたページ（pdflscape）なら文字が横に流れる座標系に揃う。
        const tx = pdfjs.Util.transform(viewport.transform, item.transform);
        const height = Math.hypot(tx[2] ?? 0, tx[3] ?? 0) || (item.height > 0 ? item.height : 10);
        const angle = Math.atan2(tx[1] ?? 0, tx[0] ?? 1);
        // item.width は既に viewport の尺度で返るので、字高の係数を掛けてはいけない
        // （掛けると幅が字高の倍だけ伸び、行の組み立てが総崩れになる）。
        const width = item.width;
        pageItems.push({ text: item.str, x: tx[4] ?? 0, y: tx[5] ?? 0, width, height, angle });
      }

      // 向きは**ページ単位で**決める。
      //
      // 図の y 軸ラベル（matplotlib / pgfplots をベクタで貼った図）は「回っている少数派」で、
      // 本文と同じ扱いにすると縦の長さが横幅として入り、同じ y に潰れて本文と 1 文に繋がる。
      // 一方 `lscape`（\rotatebox でページごと回す組。/Rotate を立てない）では、
      // **そのページの本文そのものが回っている**。少数派と同じに扱うと節が丸ごと
      // 「本文以外」に落ちて読む手段が無くなる（pdflscape と見た目は同じなのに結果が真逆になる）。
      // だから「そのページの多数派の向き」を本文の向きとみなし、そこから外れたものだけを
      // 付物へ回す。
      const dominant = dominantAngle(pageItems, page.rotate ?? 0);

      // ページごと回っている版面は、座標も**用紙の中へ戻す**。
      //
      // 原点まわりに回すだけだと版面が用紙の外へ出る（実測で x が −725〜−300、
      // 用紙は 0〜595）。文字は拾えても、以後「ページのどこにあるか」を見る規則
      // ——柱とノンブルの帯、余白、段の検出——と、画面のマーカー描画が全部ずれる。
      // マーカーが出ないと「サイドバーの文と PDF が双方向に連動する」という
      // この道具の中心機能が、そのページだけ黙って死ぬ。
      let offsetX = 0;
      let offsetY = 0;
      if (dominant !== 0) {
        const corners: [number, number][] = [
          [0, 0],
          [viewport.width, 0],
          [0, viewport.height],
          [viewport.width, viewport.height],
        ];
        const rotated = corners.map(([cx, cy]) => rotatePoint(cx, cy, -dominant));
        offsetX = -Math.min(...rotated.map(([cx]) => cx));
        offsetY = -Math.min(...rotated.map(([, cy]) => cy));
        // 用紙の向きも入れ替わる。段の検出も余白も、この寸法を基準にする。
        const size = pageSizes[pageSizes.length - 1];
        if (size) {
          const width = Math.max(...rotated.map(([cx]) => cx)) + offsetX;
          const height = Math.max(...rotated.map(([, cy]) => cy)) + offsetY;
          size.width = width;
          size.height = height;
        }
      }
      for (const entry of pageItems) {
        if (chunks.length >= input.maxChunks) {
          truncatedChunks = true;
          break;
        }
        const relative = normalizeAngle(entry.angle - dominant);
        if (Math.abs(relative) < UPRIGHT_TOLERANCE) {
          // 多数派の向き＝このページの「横書き」。その軸に合わせて読み直す。
          const [x, y] = rotatePoint(entry.x, entry.y - entry.height, -dominant);
          chunks.push({
            page: pageNumber,
            text: entry.text,
            x: x + offsetX,
            y: y + offsetY,
            w: entry.width,
            h: entry.height,
          });
          continue;
        }
        // 多数派から外れた向き＝図のラベルなどの付物。外接矩形をその向きで作る。
        const dx = Math.cos(entry.angle) * entry.width;
        const dy = Math.sin(entry.angle) * entry.width;
        chunks.push({
          page: pageNumber,
          text: entry.text,
          x: Math.min(entry.x, entry.x + dx),
          y: Math.min(entry.y - entry.height, entry.y - entry.height + dy),
          w: Math.max(entry.height, Math.abs(dx)),
          h: Math.max(entry.height, Math.abs(dy)),
          rotated: true,
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
