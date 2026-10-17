// PDF のページを PNG の画像にする。AI エージェントが、文字で取り出せない数式・図・画像だけのスライドを見るときに使う。
// 描画は pdf.js、画面の代わりの canvas は pdf.js が Node.js で使う @napi-rs/canvas（pdfjs-dist の依存）に任せる。

import fs from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Rect } from "../src/lib/model.ts";

/** 画像の長い辺の上限（px）。大きすぎる画像は受け取る側の上限に当たり、読むのにも時間がかかる */
export const MAX_IMAGE_SIDE = 1600;

export interface RenderOptions {
  /** 切り出す範囲（ページに対する割合 0〜1、表示の向き）。省略するとページ全体 */
  rect?: Rect;
  /** 拡大率（1 = 72dpi）。長い辺が MAX_IMAGE_SIDE を超えないよう、自動で下げる */
  scale?: number;
}

/** canvas の最小限の形（@napi-rs/canvas の Canvas） */
interface NodeCanvas {
  toBuffer(type: "image/png"): Buffer;
}

/** ページを PNG にする。page は 1 から。ページの外を指したら Error */
export async function renderPagePng(file: string, page: number, opts: RenderOptions = {}) {
  const data = new Uint8Array(await fs.readFile(file));
  const doc = await getDocument({ data, isEvalSupported: false, verbosity: 0 }).promise;
  try {
    if (page < 1 || page > doc.numPages) throw new Error(`この PDF は ${doc.numPages} ページです。page を 1〜${doc.numPages} で指定してください。`);
    const p = await doc.getPage(page);
    const base = p.getViewport({ scale: 1 });
    const r = opts.rect ?? { x: 0, y: 0, w: 1, h: 1 };
    // 範囲の大きさ（pt）。長い辺が上限に収まる拡大率にする
    const wPt = base.width * r.w;
    const hPt = base.height * r.h;
    const want = opts.scale ?? 2;
    const scale = Math.max(0.1, Math.min(want, MAX_IMAGE_SIDE / Math.max(wPt, hPt)));
    const vp = p.getViewport({ scale });
    const width = Math.max(1, Math.round(vp.width * r.w));
    const height = Math.max(1, Math.round(vp.height * r.h));
    const factory = (doc as unknown as { canvasFactory?: { create(w: number, h: number): { canvas: unknown; context: unknown } } }).canvasFactory;
    if (!factory) throw new Error("この環境では PDF を画像にできません（canvas がありません）。read_paper_text で文字を読んでください。");
    let made: { canvas: unknown; context: unknown };
    try {
      made = factory.create(width, height);
    } catch (e) {
      throw new Error(`この環境では PDF を画像にできません（${e instanceof Error ? e.message : String(e)}）。read_paper_text で文字を読んでください。`);
    }
    const ctx = made.context as { fillStyle: string; fillRect(x: number, y: number, w: number, h: number): void };
    // 透明のままだと、黒い背景で表示する受け手では文字が見えない
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    // 範囲の左上が原点に来るようにずらして描く
    await p.render({
      canvasContext: made.context as CanvasRenderingContext2D,
      canvas: made.canvas as HTMLCanvasElement,
      viewport: vp,
      transform: [1, 0, 0, 1, -vp.width * r.x, -vp.height * r.y],
      background: "#ffffff",
    }).promise;
    const png = (made.canvas as NodeCanvas).toBuffer("image/png");
    p.cleanup();
    return { png, width, height, scale, pages: doc.numPages };
  } finally {
    await doc.destroy();
  }
}
