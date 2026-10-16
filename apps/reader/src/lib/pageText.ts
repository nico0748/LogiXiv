// pdf.js の getTextContent の項目を、マーカーの矩形を作れる形（文字列・行の帯・各文字の横位置）にする。
//
// AI エージェントのマーカー（server/pdftext.ts の findText）と、画面で選んだマーカー（PdfView）の
// 両方がここを通る。同じ文なら、どちらの経路で引いても同じ矩形になる（以前は縦の式が別々で、
// 経路によって高さが 0.1〜0.25em 違っていた）。縦の帯は @paperlens/core/band の lineBand が決める。
//
// 回転したページ（/Rotate 90 など）では、ページの「表示の向き」と「文字が横に流れる向き」が食い違う。
// 文字の並びとグリフの位置は、文字が横に流れる向き（フレーム）で求め、最後に表示の向きへ回して返す。
// pdf.js 本体は読み込まない（サーバーは legacy 版、画面は通常版を使うため）。

import { bandMetrics, type BandMetrics } from "@paperlens/core/band";
import { charSpan, mul } from "./glyphs.ts";
import type { Rect } from "./model.ts";

/** getTextContent の項目のうち、ここで使うもの。 */
export interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  fontName?: string;
  hasEOL?: boolean;
}

/** getTextContent の styles のうち、ここで使うもの（pdf.js の流儀で descent は負）。 */
export interface TextStyleLike {
  ascent?: number;
  descent?: number;
}

/** pdf.js の PageViewport のうち、ここで使うもの。 */
export interface ViewportLike {
  transform: number[];
  width: number;
  height: number;
  scale: number;
}

/** 位置を付けた項目。rect はフレーム（文字が横に流れる向き）でのページに対する割合。 */
export interface LaidItem {
  str: string;
  rect: Rect;
  hasEOL: boolean;
  /** 各文字の左端・右端（フレームの幅に対する割合）。src/lib/glyphs.ts の attachGlyphs が付ける */
  xs?: Float64Array;
}

const ROTATIONS = [0, 90, 180, 270] as const;

/** 項目が、その変換の下で左から右へ横に流れているか。 */
const upright = (tx: number[]) => tx[0] > 0 && Math.abs(tx[1]) <= tx[0] * 0.05;

/**
 * 文字の大半が左から右へ横に流れる向き（ページの回転、時計回り 0/90/180/270）。
 * 普通のページでは表示の向き（page.rotate）と同じ。/Rotate だけ立てて中身を回していない PDF では 0 になる。
 * viewportAt(r) は回転 r のビューポート（pdf.js の page.getViewport({ scale: 1, rotation: r })）。
 */
export function textRotation(items: readonly TextItemLike[], display: number, viewportAt: (rotation: number) => ViewportLike): number {
  let best = ((display % 360) + 360) % 360;
  let bestWeight = -1;
  // 表示の向きを先に試す（同点なら表示の向きを採る）
  for (const r of [best, ...ROTATIONS.filter((r) => r !== best)]) {
    const vp = viewportAt(r).transform;
    let weight = 0;
    for (const it of items) if (it.str.trim() && upright(mul(vp, it.transform))) weight += it.str.length;
    if (weight > bestWeight) {
      best = r;
      bestWeight = weight;
    }
  }
  return best;
}

/**
 * 項目を、フレームのビューポート vp に置く。矩形の縦はベースラインと書体の ascent/descent から求めた帯。
 * フレームで横に流れていない項目（図の軸ラベルなど）は、回った帯の外接矩形にする。
 */
export function layoutItems(items: readonly TextItemLike[], styles: Readonly<Record<string, TextStyleLike | undefined>>, vp: ViewportLike): LaidItem[] {
  const metrics = new Map<string, BandMetrics>();
  const metricsOf = (font: string | undefined) => {
    const key = font ?? "";
    let m = metrics.get(key);
    if (!m) metrics.set(key, (m = bandMetrics(styles[key]?.ascent, styles[key]?.descent)));
    return m;
  };
  return items.map((it) => {
    const tx = mul(vp.transform, it.transform);
    const size = Math.hypot(tx[2], tx[3]);
    const m = metricsOf(it.fontName);
    // 字の進む向き u と、字の上向き n（どちらも単位ベクトル）
    const along = Math.hypot(tx[0], tx[1]) || 1;
    const u = [tx[0] / along, tx[1] / along];
    const n = size > 0 ? [tx[2] / size, tx[3] / size] : [0, -1];
    const w = it.width * vp.scale;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const t of [0, w]) {
      for (const s of [m.ascent * size, -m.descent * size]) {
        xs.push(tx[4] + u[0] * t + n[0] * s);
        ys.push(tx[5] + u[1] * t + n[1] * s);
      }
    }
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    return {
      str: it.str,
      rect: { x: x0 / vp.width, y: y0 / vp.height, w: (Math.max(...xs) - x0) / vp.width, h: (Math.max(...ys) - y0) / vp.height },
      hasEOL: !!it.hasEOL,
    };
  });
}

/**
 * フレームでの矩形（ページに対する割合）を、表示の向きへ回す。delta はフレームから表示までの時計回りの角度。
 * 90 度刻みの回転なので、軸に沿った矩形は軸に沿った矩形のまま移る。
 */
export function toDisplay(r: Rect, delta: number): Rect {
  const d = ((delta % 360) + 360) % 360;
  if (d === 0) return { ...r };
  const a = rotatePoint(r.x, r.y, d);
  const b = rotatePoint(r.x + r.w, r.y + r.h, d);
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
}

/** 表示の向きでの点（ページに対する割合）を、フレームへ戻す。 */
export function fromDisplay(x: number, y: number, delta: number): [number, number] {
  return rotatePoint(x, y, (360 - (((delta % 360) + 360) % 360)) % 360);
}

/** ページに対する割合の点を、ページごと時計回りに d 度回したときの位置。 */
function rotatePoint(x: number, y: number, d: number): [number, number] {
  switch (d) {
    case 90:
      return [1 - y, x];
    case 180:
      return [1 - x, 1 - y];
    case 270:
      return [y, 1 - x];
    default:
      return [x, y];
  }
}

/**
 * 同じ行に並ぶ矩形を 1 つにまとめる（縦横とも外接矩形）。並び順（読む順）は保つ。
 * 横に離れた矩形（別の段）はまとめない。
 */
export function mergeLineRects(rects: readonly Rect[]): Rect[] {
  const out: Rect[] = [];
  for (const r of rects) {
    const last = out[out.length - 1];
    // 縦に半分以上重なれば同じ行（上付き・下付きの小さな字の項目も同じ行に入る）
    const sameLine = last && Math.min(last.y + last.h, r.y + r.h) - Math.max(last.y, r.y) > Math.min(last.h, r.h) * 0.5;
    if (last && sameLine && r.x - (last.x + last.w) < 0.02 && r.x + r.w > last.x - 0.02) {
      const x2 = Math.max(last.x + last.w, r.x + r.w);
      const y2 = Math.max(last.y + last.h, r.y + r.h);
      last.x = Math.min(last.x, r.x);
      last.y = Math.min(last.y, r.y);
      last.w = x2 - last.x;
      last.h = y2 - last.y;
    } else out.push({ ...r });
  }
  return out;
}

/** 項目 k の a〜b−1 文字目（b は含まない）。 */
export interface Segment {
  k: number;
  a: number;
  b: number;
}

/**
 * 項目の文字範囲の並びを、行ごとの矩形（フレームでのページに対する割合）にする。
 * 横はグリフの位置（無ければ項目の矩形を文字数で按分）、縦は項目の帯。
 */
export function segmentRects(items: readonly LaidItem[], segs: readonly Segment[]): Rect[] {
  const out: Rect[] = [];
  for (const { k, a, b } of segs) {
    const it = items[k];
    if (!it) continue;
    const s = charSpan(it.str, it.xs, it.rect, a, b);
    if (s) out.push({ x: s[0], y: it.rect.y, w: s[1] - s[0], h: it.rect.h });
  }
  return mergeLineRects(out);
}
