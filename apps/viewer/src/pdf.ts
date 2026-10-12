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

/**
 * その URL の作り方でワーカーを本当に起動できるかを、小さな台本で確かめる。
 *
 * 判定は「メッセージが返ってくること」まで見る。構築が例外を投げるかどうかでは足りない。
 * file:// の `blob:` + module ワーカーは、構築は通るのに後から error になるためで、
 * pdf.js はそこで黙って fake worker（＝ UI スレッド処理）に落ちる。
 *
 * 試すのは pdf.js 本体ではなく 1 行の台本にする。本物のワーカーは合図を返さないので、
 * 「動いた」ことを確かめようがない。URL の作り方と module 型さえ同じなら、
 * 通るかどうかは同じ条件で決まる。
 */
function probeScheme(makeUrl: (source: string) => string): Promise<boolean> {
  return new Promise((resolve) => {
    let url: string;
    let worker: Worker;
    try {
      url = makeUrl('self.postMessage(1);');
      // pdf.js は module 型で読み込むので、こちらも module で試す。
      worker = new Worker(url, { type: 'module' });
    } catch {
      resolve(false);
      return;
    }
    const finish = (ok: boolean): void => {
      clearTimeout(timer);
      worker.terminate();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 1500);
    worker.addEventListener('message', () => finish(true));
    worker.addEventListener('error', () => finish(false));
    worker.addEventListener('messageerror', () => finish(false));
  });
}

const asBlobUrl = (source: string): string =>
  URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
const asDataUrl = (source: string): string =>
  `data:text/javascript;base64,${bytesToBase64(new TextEncoder().encode(source))}`;

/**
 * ワーカーは**自分で作って渡す**（workerSrc ではなく workerPort）。
 *
 * pdf.js は workerSrc が同一オリジンでないと判断すると、`import "<url>"` だけの
 * blob: ラッパを作り直して module ワーカーとして読み込む。file:// では blob: の
 * オリジンが null なので必ずこの経路に入り、そして file:// では blob: の
 * module ワーカーが起動できないため、毎回 fake worker（UI スレッド処理）に落ちていた。
 * data: の module ワーカーは file:// でも http:// でも動くので、自分で作って
 * 出来上がったものを渡せば、ラッパを挟ませずに済む。
 */
async function ensureWorker(): Promise<void> {
  if (workerReady) return;
  workerReady = true;

  for (const [mode, makeUrl] of [
    ['data', asDataUrl],
    ['blob', asBlobUrl],
  ] as const) {
    try {
      if (!(await probeScheme(makeUrl))) continue;
      const worker = new Worker(makeUrl(workerSource), { type: 'module' });
      (pdfjs.GlobalWorkerOptions as { workerPort: Worker | null }).workerPort = worker;
      workerMode = mode;
      return;
    } catch {
      // この作り方は使えない。次を試す。
    }
  }
  workerMode = 'none';
}

/**
 * PDF を別スレッドで処理できているか。
 *
 * 見込み（workerMode）だけでなく、pdf.js が実際に fake worker へ落ちたときの
 * 警告も見る。予測が外れても画面の表示は事実に合う。
 */
export function isWorkerAvailable(): boolean {
  return workerMode !== 'none' && !fellBackToFakeWorker;
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
let fellBackToFakeWorker = false;
const RESOURCE_WARNING = /cMapUrl|standardFontDataUrl|wasmUrl|translateFont failed/i;
const FAKE_WORKER_WARNING = /fake worker/i;

/**
 * 監視は参照数で管理する。
 *
 * 遅延描画では複数の描画が重なるので、素朴に「保存して戻す」を入れ子にすると、
 * 内側が外側の差し替え済み関数を「元の関数」として保存し、最後に戻すのが
 * 差し替え版になる。console.warn が永久に差し替わったまま残っていた。
 */
let watchers = 0;
let nativeWarn: typeof console.warn | null = null;
let nativeLog: typeof console.log | null = null;

function watchWarnings<T>(task: () => Promise<T>): Promise<T> {
  const check = (args: unknown[]): void => {
    for (const arg of args) {
      if (typeof arg !== 'string') continue;
      if (RESOURCE_WARNING.test(arg)) missingResources = true;
      if (FAKE_WORKER_WARNING.test(arg)) fellBackToFakeWorker = true;
    }
  };
  if (watchers === 0) {
    nativeWarn = console.warn;
    nativeLog = console.log;
    console.warn = (...args: unknown[]) => {
      check(args);
      nativeWarn?.apply(console, args);
    };
    console.log = (...args: unknown[]) => {
      check(args);
      nativeLog?.apply(console, args);
    };
  }
  watchers++;
  return task().finally(() => {
    watchers--;
    if (watchers === 0 && nativeWarn && nativeLog) {
      console.warn = nativeWarn;
      console.log = nativeLog;
      nativeWarn = null;
      nativeLog = null;
    }
  });
}

export function needsMissingResources(): boolean {
  return missingResources;
}

export async function loadPdf(bytes: Uint8Array) {
  await ensureWorker();
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
