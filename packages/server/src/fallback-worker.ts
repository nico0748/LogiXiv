import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import type { PageSize, TextChunk } from '@logixiv/core';

/**
 * pdf.js を回すワーカー。
 *
 * ここを別スレッドに出しているのは、pdf.js を Node で使うと「fake worker」として
 * 同一スレッドで動き、解析中は HTTP も SSE ハートビートも一切進まなくなるため。
 * 900 ページの PDF 1 本でイベントループが 68 秒止まり、その間の keep-alive 接続が
 * 切られて他のクライアントが ECONNRESET を受ける、という状態だった。
 *
 * 出力は「文字片と用紙サイズ」だけ。文の組み立ては core 側（メインスレッド）で行う。
 * ワーカーに持たせる責務を pdf.js の呼び出しだけに絞ると、失敗したときに
 * 何が壊れているかが一目で分かる。
 */

export interface FallbackWorkerInput {
  pdf: Uint8Array;
  maxPages: number;
  maxChunks: number;
}

export interface FallbackWorkerOutput {
  chunks: TextChunk[];
  pageSizes: PageSize[];
  /** ページ数の上限で打ち切ったか。 */
  truncatedPages: number;
  /** 文字片の上限で打ち切ったか。 */
  truncatedChunks: boolean;
  /** PDF のメタデータに入っていた題名。無いことも、ファイル名が入っていることも多い。 */
  metadataTitle: string | null;
}

interface PdfJsTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

async function run(input: FallbackWorkerInput): Promise<FallbackWorkerOutput> {
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
        const transform = item.transform;
        const x = transform[4] ?? 0;
        // pdf.js は左下原点。GROBID に合わせて左上原点へ直す。
        const baseline = transform[5] ?? 0;
        const height = item.height > 0 ? item.height : Math.abs(transform[3] ?? 10);
        chunks.push({
          page: pageNumber,
          text: item.str,
          x,
          y: viewport.height - baseline - height,
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
