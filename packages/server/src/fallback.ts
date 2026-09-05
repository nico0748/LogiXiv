import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { buildSentencesFromChunks, type DocumentStructure, type PageSize, type TextChunk } from '@logixiv/core';

/**
 * GROBID が無い環境向けのフォールバック解析。
 *
 * pdf.js でテキストを取り出し、core の行組み立て＋文分割にかける。
 * 2 段組では読み順が崩れ、数式や脚注が本文に混ざる。精度は GROBID に明確に劣るので、
 * ここを通ったことは structure.parserNote に必ず書いて UI に出す。
 */

interface PdfJsTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}

async function loadPdfJs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Node では実スレッドのワーカーを使わず、pdf.js の「fake worker」を同一プロセスで動かす。
  // ただし workerSrc は空にできず、import 可能な URL を求められるのでモジュールの実体を指す。
  const require = createRequire(import.meta.url);
  const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
  (pdfjs.GlobalWorkerOptions as { workerSrc: string }).workerSrc = pathToFileURL(workerPath).href;
  return pdfjs;
}

export async function parseWithPdfJs(pdf: Uint8Array): Promise<DocumentStructure> {
  const pdfjs = await loadPdfJs();
  // pdf.js は Buffer を受け付けない（Buffer は Uint8Array の派生だが明示的に弾かれる）。
  const data = new Uint8Array(pdf.byteLength);
  data.set(pdf);
  const require = createRequire(import.meta.url);
  const task = pdfjs.getDocument({
    data,
    useSystemFonts: false,
    disableFontFace: true,
    // テキスト抽出しかしないので、フォント実体が無いことの警告は出さない。
    verbosity: 0,
    // 埋め込みフォントを持たない PDF のために、pdf.js 同梱の標準フォントの場所を教える。
    standardFontDataUrl: pathToFileURL(
      require.resolve('pdfjs-dist/package.json').replace(/package\.json$/, 'standard_fonts/'),
    ).href,
  });
  const document = await task.promise;

  const chunks: TextChunk[] = [];
  const pageSizes: PageSize[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      pageSizes.push({ page: pageNumber, width: viewport.width, height: viewport.height });

      const content = await page.getTextContent();
      for (const raw of content.items as unknown[]) {
        const item = raw as PdfJsTextItem;
        if (typeof item.str !== 'string' || item.str.length === 0) continue;
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
    }
  } finally {
    await task.destroy();
  }

  const { sentences, sections } = buildSentencesFromChunks(chunks, pageSizes);

  return {
    version: 1,
    parser: 'fallback',
    parserNote:
      'pdf.js による簡易解析（GROBID 未接続）。2 段組・数式・脚注で文の区切りと読み順が崩れることがあります。',
    parsedAt: new Date().toISOString(),
    title: null,
    abstract: null,
    pageSizes,
    sections,
    sentences,
  };
}
