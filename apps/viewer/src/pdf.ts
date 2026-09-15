import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
// ワーカーは文字列として同梱し、実行時に URL に変える。
// こうしないと書き出し HTML が外部ファイルを取りに行き、単体で開けなくなる。
import workerSource from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?raw';

/**
 * ワーカーの用意。
 *
 * blob: URL は file:// で開いたときに作れないことがある（生成元が opaque origin になる）。
 * そこは「同僚に送った 1 枚の HTML を開く」という、この機能の本命の場面なので、
 * 黙って fake worker（＝ UI スレッドで PDF を処理する）に落ちるのは避けたい。
 * blob: → data: の順に試し、どちらも駄目なら単一スレッドで動いていることを画面に出す。
 */
let workerReady = false;
let workerMode: 'blob' | 'data' | 'none' = 'none';

function canConstructWorker(url: string): boolean {
  try {
    const probe = new Worker(url, { type: 'classic' });
    probe.terminate();
    return true;
  } catch {
    return false;
  }
}

function ensureWorker(): void {
  if (workerReady) return;
  workerReady = true;

  try {
    const blobUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    if (canConstructWorker(blobUrl)) {
      pdfjs.GlobalWorkerOptions.workerSrc = blobUrl;
      workerMode = 'blob';
      return;
    }
    URL.revokeObjectURL(blobUrl);
  } catch {
    // Blob も URL も使えない環境。次の手に進む。
  }

  try {
    const dataUrl = `data:text/javascript;base64,${bytesToBase64(new TextEncoder().encode(workerSource))}`;
    if (canConstructWorker(dataUrl)) {
      pdfjs.GlobalWorkerOptions.workerSrc = dataUrl;
      workerMode = 'data';
      return;
    }
  } catch {
    // ここまで駄目なら pdf.js の fake worker に任せる。
  }
  workerMode = 'none';
}

/** PDF を別スレッドで処理できているか。できていないときは画面にその旨を出す。 */
export function isWorkerAvailable(): boolean {
  return workerMode !== 'none';
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 同梱していない資源（CMap・標準フォント）を必要とする PDF を見分ける。
 *
 * 外部 URL をゼロにしている代償として、非埋め込みの CID フォントを使う PDF
 * （日本語論文に多い）は pdf.js が文字を描けず、**真っ白なページ**になる。
 * pdf.js はこれを例外ではなく警告として流すので、描画中だけ警告を見張る。
 * ここを黙らせると「開いたけど何も出ない」という、原因の分からない壊れ方になる。
 */
let missingResources = false;
const RESOURCE_WARNING = /cMapUrl|standardFontDataUrl|wasmUrl|translateFont failed/i;

function watchWarnings<T>(task: () => Promise<T>): Promise<T> {
  const original = { warn: console.warn, log: console.log };
  const check = (args: unknown[]): void => {
    if (args.some((arg) => typeof arg === 'string' && RESOURCE_WARNING.test(arg))) missingResources = true;
  };
  console.warn = (...args: unknown[]) => {
    check(args);
    original.warn.apply(console, args);
  };
  console.log = (...args: unknown[]) => {
    check(args);
    original.log.apply(console, args);
  };
  return task().finally(() => {
    console.warn = original.warn;
    console.log = original.log;
  });
}

export function needsMissingResources(): boolean {
  return missingResources;
}

export async function loadPdf(bytes: Uint8Array) {
  ensureWorker();
  return watchWarnings(() => pdfjs.getDocument({ data: bytes, disableFontFace: false }).promise);
}

export type LoadedPdf = Awaited<ReturnType<typeof loadPdf>>;

export interface PageGeometry {
  /** PDF ユーザー空間 → 画面 px の倍率。マーカーの配置に使う。 */
  scale: number;
  width: number;
  height: number;
}

/** 描かずに寸法だけ得る。枠だけ先に並べて、見える範囲になってから描くために使う。 */
export async function pageGeometry(pdf: LoadedPdf, pageNumber: number, cssWidth: number): Promise<PageGeometry> {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = cssWidth / base.width;
  return { scale, width: base.width * scale, height: base.height * scale };
}

/**
 * 1 ページ描いてキャンバスを返す。
 * 高 DPI 画面ではキャンバスの解像度だけ上げ、CSS 幅は論理 px に保つ
 * （マーカーの座標計算を 1 つの scale で完結させるため）。
 */
export async function renderPageCanvas(
  pdf: LoadedPdf,
  pageNumber: number,
  cssWidth: number,
): Promise<HTMLCanvasElement> {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: cssWidth / base.width });
  const ratio = Math.min(window.devicePixelRatio || 1, 2);

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D コンテキストを取得できませんでした');
  context.scale(ratio, ratio);

  await watchWarnings(() => page.render({ canvas, canvasContext: context, viewport, intent: 'display' }).promise);
  return canvas;
}
