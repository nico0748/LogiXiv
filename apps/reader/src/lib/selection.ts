// マウスで選んだ範囲の、最初と最後の文字を「指を置いた位置」から決め直す。
//
// 画面のテキスト層は、PDF の文字列を代わりのフォントで描いて項目の幅だけ合わせたもので、
// 1 文字ずつの位置は実際に描かれたグリフから数 pt ずれる（実測: 欧文の論文で 12〜21% の文字が
// 半文字以上ずれ、最大 7.8pt）。ブラウザはこのずれた箱で選択の端を決めるので、
// グリフの真ん中を押しても隣の文字から始まる・最後の 1 文字が落ちる（実測で 3 回に 1 回）。
//
// ここでは押した位置・離した位置を覚えておき、その行のグリフの位置（src/lib/glyphs.ts）で
// 端を決め直す。グリフの左半分を押せばその文字から、右半分なら次の文字から（ブラウザと同じ規則）。
// 純粋な関数だけを置く（PdfView から呼び、単体テストもする）。

import { charSpan } from "./glyphs.ts";
import type { LaidItem, Segment } from "./pageText.ts";

/** フレーム（src/lib/pageText.ts）でのページに対する割合の点。 */
export interface Pt {
  x: number;
  y: number;
}

interface CharAt {
  k: number;
  c: number;
  cx: number;
}

const SPACE = /\s/;

/** 縦に半分以上重なれば同じ行（src/lib/pageText.ts の mergeLineRects と同じ規則）。 */
const sameLine = (a: LaidItem, b: LaidItem) =>
  Math.min(a.rect.y + a.rect.h, b.rect.y + b.rect.h) - Math.max(a.rect.y, b.rect.y) > Math.min(a.rect.h, b.rect.h) * 0.5;

/** 点がその項目の行の高さに入っているか（行間の半分まで許す）。 */
const onLine = (it: LaidItem, p: Pt) => p.y >= it.rect.y - it.rect.h * 0.35 && p.y <= it.rect.y + it.rect.h * 1.35;

/** 項目 k と同じ行にある前後の項目（reach 個まで）の文字を、左から順に並べる。 */
function lineChars(items: readonly LaidItem[], k: number, reach = 3): CharAt[] {
  const base = items[k];
  const out: CharAt[] = [];
  for (let i = Math.max(0, k - reach); i <= Math.min(items.length - 1, k + reach); i++) {
    const it = items[i];
    if (!it || !sameLine(base, it)) continue;
    for (let c = 0; c < it.str.length; c++) {
      if (SPACE.test(it.str[c])) continue;
      const s = charSpan(it.str, it.xs, it.rect, c, c + 1);
      if (s) out.push({ k: i, c, cx: (s[0] + s[1]) / 2 });
    }
  }
  return out.sort((a, b) => a.cx - b.cx);
}

/**
 * 決め直しで動かしてよい文字数。テキスト層のずれは 1 文字前後なので、それより大きく動くのは
 * 押した位置が選択の端ではない（別の操作の位置が残っていた等）とみなして、ブラウザの選択を使う。
 */
const MAX_SHIFT = 3;

const before = (a: { k: number; c: number }, b: { k: number; c: number }) => a.k < b.k || (a.k === b.k && a.c < b.c);

/**
 * 選択範囲（項目ごとの文字範囲。b は含まない）の最初と最後の文字を、押した位置 start・離した位置 end
 * （ドラッグの向きに関わらず、文書の順で前の端と後ろの端）から決め直す。
 * 点が無い・その行から外れている・決め直すと範囲が裏返るときは、その端はブラウザの選択のままにする。
 */
export function snapSegments(items: readonly LaidItem[], segs: readonly Segment[], start: Pt | null, end: Pt | null): Segment[] {
  if (!segs.length) return [...segs];
  const first = segs[0];
  const last = segs[segs.length - 1];
  let s = { k: first.k, c: first.a };
  let e = { k: last.k, c: last.b - 1 };

  /** 行の文字の並びの中で、元の端から何文字動くか（元の端が並びに無ければ動かさない） */
  const shift = (chars: CharAt[], from: { k: number; c: number }, to: CharAt) => {
    const i = chars.findIndex((ch) => ch.k === from.k && ch.c >= from.c);
    return i < 0 ? Infinity : Math.abs(chars.indexOf(to) - i);
  };
  /**
   * 点のある行の項目。ふつうは選択の端の項目だが、ブラウザの選択の端が別の行（余白の行番号など）へ
   * 飛んでいることがあるので、そのときは選択の中から点を含む項目を探す（far = 端の行から外れた）。
   */
  const lineAt = (edge: number, p: Pt): { k: number; far: boolean } | null => {
    if (items[edge] && onLine(items[edge], p)) return { k: edge, far: false };
    const order = edge === first.k ? segs : [...segs].reverse();
    for (const sg of order) {
      const it = items[sg.k];
      if (it && onLine(it, p) && p.x >= it.rect.x - it.rect.h && p.x <= it.rect.x + it.rect.w + it.rect.h) return { k: sg.k, far: true };
    }
    return null;
  };
  const sl = start && lineAt(first.k, start);
  if (start && sl) {
    // 押した位置より右に中心がある最初の文字
    const chars = lineChars(items, sl.k);
    const hit = chars.find((ch) => ch.cx >= start.x);
    if (hit && (sl.far || shift(chars, s, hit) <= MAX_SHIFT)) s = { k: hit.k, c: hit.c };
  }
  const el = end && lineAt(last.k, end);
  if (end && el) {
    // 離した位置より左に中心がある最後の文字
    const chars = lineChars(items, el.k);
    let hit: CharAt | undefined;
    for (const ch of chars) if (ch.cx <= end.x) hit = ch;
    if (hit && (el.far || shift(chars, e, hit) <= MAX_SHIFT)) e = { k: hit.k, c: hit.c };
  }
  if (before(e, s)) return [...segs];

  const out: Segment[] = [];
  for (let k = s.k; k <= e.k; k++) {
    const str = items[k]?.str ?? "";
    let a = k === s.k ? s.c : 0;
    let b = k === e.k ? e.c + 1 : str.length;
    while (a < b && SPACE.test(str[a])) a++;
    while (b > a && SPACE.test(str[b - 1])) b--;
    if (a < b) out.push({ k, a, b });
  }
  return out.length ? out : [...segs];
}

/** 選択範囲の文字列（項目の区切りの改行を含む。呼び出し側で空白を詰める）。 */
export function segmentText(items: readonly LaidItem[], segs: readonly Segment[]): string {
  if (!segs.length) return "";
  const from = segs[0].k;
  const to = segs[segs.length - 1].k;
  const byItem = new Map(segs.map((s) => [s.k, s]));
  let text = "";
  for (let k = from; k <= to; k++) {
    const it = items[k];
    if (!it) continue;
    const s = byItem.get(k);
    // 範囲に入っていない間の項目は空白だけの項目なので、そのまま挟む
    if (s && s.a > 0 && k > from) text += " ";
    text += s ? it.str.slice(s.a, s.b) : it.str;
    if (k < to) {
      if (s && s.b < it.str.length) text += " ";
      if (it.hasEOL) text += "\n";
    }
  }
  return text;
}
