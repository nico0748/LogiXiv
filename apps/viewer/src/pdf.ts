import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
// ワーカーは文字列として同梱し、実行時に Blob URL に変える。
// こうしないと書き出し HTML が外部ファイルを取りに行き、単体で開けなくなる。
import workerSource from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?raw';

let workerUrl: string | null = null;

function ensureWorker(): void {
  if (workerUrl) return;
  workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface RenderedPage {
  pageNumber: number;
  container: HTMLDivElement;
  /** PDF ユーザー空間 → 画面 px の倍率。マーカーの配置に使う。 */
  scale: number;
  width: number;
  height: number;
}

export async function loadPdf(bytes: Uint8Array) {
  ensureWorker();
  return pdfjs.getDocument({ data: bytes, disableFontFace: false }).promise;
}

/**
 * 1 ページ描画して、マーカーを載せるための座標系を返す。
 * 高 DPI 画面ではキャンバスの解像度だけ上げ、CSS 幅は論理 px に保つ
 * （マーカーの座標計算を 1 つの scale で完結させるため）。
 */
export async function renderPage(
  pdf: Awaited<ReturnType<typeof loadPdf>>,
  pageNumber: number,
  cssWidth: number,
): Promise<RenderedPage> {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = cssWidth / base.width;
  const viewport = page.getViewport({ scale });
  const ratio = Math.min(window.devicePixelRatio || 1, 2);

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D コンテキストを取得できませんでした');
  context.scale(ratio, ratio);

  const container = document.createElement('div');
  container.className = 'lxv-page';
  container.style.width = `${viewport.width}px`;
  container.style.height = `${viewport.height}px`;
  container.dataset['page'] = String(pageNumber);
  container.append(canvas);

  await page.render({ canvas, canvasContext: context, viewport, intent: 'display' }).promise;

  return { pageNumber, container, scale, width: viewport.width, height: viewport.height };
}
