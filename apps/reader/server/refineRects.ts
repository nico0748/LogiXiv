// 文の枠（sentence.rects）の文頭・文末の端を、実際のグリフの端に合わせる。
//
// @paperlens/core の簡易解析は、pdf.js の文字片（ほぼ 1 行）を文の境目で割るときに
// 字幅を見積もって x を決める（packages/core/src/advance.ts）。見積もりなので、
// 書体によっては文頭が 1 文字足りない・文末が 1 文字はみ出すことが残る。
// ここでは描画命令から求めた実際のグリフの位置（src/lib/glyphs.ts、pdftext.ts の readPages）を使い、
// 解析を終えた構造の枠の端だけを直す。文の分け方・本文・ハッシュには触れない。
//
// 端を「いちばん近いグリフの端」に寄せると、隣の文のグリフをつかむことがある。
// そこで文の本文で照合する: 枠の行にあるグリフ列から、文の先頭（末尾）の文字の並びと
// 一致する位置を探し、その位置のグリフの端に合わせる。照合が取れなければ枠は動かさない。
//
// 純粋な関数だけを置く（scripts/measure-edges.ts からも同じものを呼ぶ）。

import type { DocumentStructure, Rect, Sentence } from "@paperlens/core";

/** 1 グリフ（1 文字）。座標は文の枠と同じ（左上原点・pt）。 */
export interface GlyphBox {
  ch: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** グリフの位置が信頼できるページだけを渡す。 */
export interface GlyphPage {
  page: number;
  glyphs: GlyphBox[];
}

/** readPages（pdftext.ts）の 1 ページぶんと同じ形。 */
export interface PageTextLike {
  page: number;
  width?: number;
  height?: number;
  items: { str: string; rect: { x: number; y: number; w: number; h: number }; xs?: Float64Array }[];
}

export interface RefineStats {
  /** グリフが使えたページ数 */
  pages: number;
  /** 端を合わせられた数（動かなかったものも含む）／照合できず元のままにした数 */
  startSnapped: number;
  startKept: number;
  endSnapped: number;
  endKept: number;
}

const KEY = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
const fold = (s: string) => s.normalize("NFKC").toLowerCase();

/**
 * readPages の結果をグリフの列にする。描画命令との対応が取れたページ（xs がある）だけを返す。
 * ページの大きさが文の枠の座標系（structure.pageSizes）と食い違うページは捨てる（回転したページなど）。
 */
export function glyphPagesFromText(pages: readonly PageTextLike[], pageSizes: DocumentStructure["pageSizes"]): GlyphPage[] {
  const out: GlyphPage[] = [];
  for (const p of pages) {
    const size = pageSizes.find((s) => s.page === p.page);
    if (!size || !p.width || !p.height) continue;
    if (Math.abs(size.width - p.width) > 1 || Math.abs(size.height - p.height) > 1) continue;
    const glyphs: GlyphBox[] = [];
    let total = 0;
    for (const it of p.items) {
      for (let c = 0; c < it.str.length; c++) {
        if (SPACE.test(it.str[c])) continue;
        total++;
        const a = it.xs?.[c * 2];
        const b = it.xs?.[c * 2 + 1];
        if (a === undefined || b === undefined || !(a <= b)) continue;
        glyphs.push({
          ch: it.str[c],
          x0: a * p.width,
          x1: b * p.width,
          y0: it.rect.y * p.height,
          y1: (it.rect.y + it.rect.h) * p.height,
        });
      }
    }
    // glyphs.ts は 8 割以上対応したページにだけ xs を付ける。ここでも同じ線で切る。
    if (total > 0 && glyphs.length / total >= 0.8) out.push({ page: p.page, glyphs });
  }
  return out;
}

/** 文の先頭・末尾の照合に使う文字数。これだけ一致すれば、その行に収まりきらなくても採る。 */
const K = 6;

interface Line {
  /** 枠の行のグリフ（x の順） */
  all: GlyphBox[];
  /** all のうち照合に使う文字（英数字・かな漢字）の位置 */
  keys: number[];
  keyCh: string[];
}

function lineOf(glyphs: readonly GlyphBox[], r: Rect, reach: number): Line {
  const all = glyphs
    .filter((g) => {
      const overlap = Math.min(r.y + r.h, g.y1) - Math.max(r.y, g.y0);
      if (overlap <= 0.5 * Math.min(r.h, g.y1 - g.y0)) return false;
      const cx = (g.x0 + g.x1) / 2;
      return cx >= r.x - reach && cx <= r.x + r.w + reach;
    })
    .sort((a, b) => a.x0 - b.x0);
  const keys: number[] = [];
  const keyCh: string[] = [];
  all.forEach((g, i) => {
    const f = fold(g.ch);
    if ([...f].length === 1 && KEY.test(f)) {
      keys.push(i);
      keyCh.push(f);
    }
  });
  return { all, keys, keyCh };
}

/** 文の照合に使う文字の列と、先頭の前・末尾の後ろの約物（空白抜き）。 */
function textKeys(text: string) {
  const chars = [...fold(text)].filter((c) => !SPACE.test(c));
  const keys = chars.filter((c) => KEY.test(c));
  const first = chars.findIndex((c) => KEY.test(c));
  let last = -1;
  for (let i = chars.length - 1; i >= 0; i--) if (KEY.test(chars[i])) {
    last = i;
    break;
  }
  return { keys, lead: first < 0 ? [] : chars.slice(0, first), trail: last < 0 ? [] : chars.slice(last + 1) };
}

/** 文頭のグリフの左端。見つからなければ null。 */
function findStart(line: Line, r: Rect, keys: string[], lead: string[], reach: number): number | null {
  const need = Math.min(K, keys.length);
  let best: { gi: number; d: number } | null = null;
  for (let s = 0; s < line.keys.length; s++) {
    const g = line.all[line.keys[s]];
    const d = Math.abs(g.x0 - r.x);
    if (d > reach || (best && d >= best.d)) continue;
    let j = s;
    let k = 0;
    while (j < line.keys.length && k < keys.length && line.keyCh[j] === keys[k]) {
      j++;
      k++;
    }
    // 先頭 K 文字が一致する／一致がこの枠の右端（行末か文末）まで続く
    const toEdge = j === line.keys.length || (line.all[line.keys[j]].x0 + line.all[line.keys[j]].x1) / 2 > r.x + r.w;
    if (k >= need || (toEdge && k >= Math.min(2, keys.length))) best = { gi: line.keys[s], d };
  }
  if (!best) return null;
  // 文頭の約物（`(` `“` `「`、箇条書きの `•`）を、紙面の並びが一致する限り含める。
  // 箇条書きの記号と本文の間は字下げで空くので、間隔は探す範囲（reach）まで許す
  let gi = best.gi;
  for (let k = lead.length - 1; k >= 0; k--) {
    const prev = line.all[gi - 1];
    if (prev && fold(prev.ch) === lead[k] && line.all[gi].x0 - prev.x1 < reach) gi--;
    else break;
  }
  return line.all[gi].x0;
}

/** 文末のグリフの右端。見つからなければ null。 */
function findEnd(line: Line, r: Rect, keys: string[], trail: string[], reach: number): number | null {
  const need = Math.min(K, keys.length);
  const right = r.x + r.w;
  let best: { gi: number; d: number } | null = null;
  for (let e = line.keys.length - 1; e >= 0; e--) {
    const g = line.all[line.keys[e]];
    const d = Math.abs(g.x1 - right);
    if (d > reach || (best && d >= best.d)) continue;
    let j = e;
    let k = keys.length - 1;
    while (j >= 0 && k >= 0 && line.keyCh[j] === keys[k]) {
      j--;
      k--;
    }
    const matched = keys.length - 1 - k;
    const toEdge = j < 0 || (line.all[line.keys[j]].x0 + line.all[line.keys[j]].x1) / 2 < r.x;
    if (matched >= need || (toEdge && matched >= Math.min(2, keys.length))) best = { gi: line.keys[e], d };
  }
  if (!best) return null;
  // 文末の約物（`.` `)` `。` `」`）を、紙面の並びが一致する限り含める
  let gi = best.gi;
  for (const ch of trail) {
    const next = line.all[gi + 1];
    if (next && fold(next.ch) === ch && next.x0 - line.all[gi].x1 < reach) gi++;
    else break;
  }
  return line.all[gi].x1;
}

/** 1 文の枠の文頭・文末を合わせる。動かせなかった側は元のまま。 */
export function refineSentenceRects<T extends Sentence>(
  sentence: T,
  pages: ReadonlyMap<number, GlyphPage>,
  stats?: RefineStats,
): T {
  if (sentence.rects.length === 0) return sentence;
  const { keys, lead, trail } = textKeys(sentence.text);
  if (keys.length === 0) return sentence;
  const rects = sentence.rects.map((r) => ({ ...r }));
  let changed = false;

  const first = rects[0];
  const fp = pages.get(first.page);
  if (fp) {
    // 見積もりの誤差は 1〜数文字。字の高さ 3 つぶんまでを探す
    const reach = Math.max(first.h * 3, 6);
    const x0 = findStart(lineOf(fp.glyphs, first, reach), first, keys, lead, reach);
    const right = first.x + first.w;
    if (x0 !== null && x0 < right) {
      if (x0 !== first.x) changed = true;
      first.x = x0;
      first.w = right - x0;
      if (stats) stats.startSnapped++;
    } else if (stats) stats.startKept++;
  } else if (stats) stats.startKept++;

  const last = rects[rects.length - 1];
  const lp = pages.get(last.page);
  if (lp) {
    const reach = Math.max(last.h * 3, 6);
    const x1 = findEnd(lineOf(lp.glyphs, last, reach), last, keys, trail, reach);
    if (x1 !== null && x1 > last.x) {
      if (x1 !== last.x + last.w) changed = true;
      last.w = x1 - last.x;
      if (stats) stats.endSnapped++;
    } else if (stats) stats.endKept++;
  } else if (stats) stats.endKept++;

  return changed ? { ...sentence, rects } : sentence;
}

/**
 * 構造の全文（本文と nonBody）の枠の端を、グリフに合わせる。
 * 使えるページが 1 つも無ければ枠はそのままで、rectEdges を "estimate" にする。
 */
export function refineStructureRects(
  structure: DocumentStructure,
  glyphPages: readonly GlyphPage[],
): { structure: DocumentStructure; stats: RefineStats } {
  const stats: RefineStats = { pages: glyphPages.length, startSnapped: 0, startKept: 0, endSnapped: 0, endKept: 0 };
  if (glyphPages.length === 0) return { structure: { ...structure, rectEdges: "estimate" }, stats };
  const pages = new Map(glyphPages.map((p) => [p.page, p]));
  return {
    structure: {
      ...structure,
      sentences: structure.sentences.map((s) => refineSentenceRects(s, pages, stats)),
      ...(structure.nonBody ? { nonBody: structure.nonBody.map((s) => refineSentenceRects(s, pages)) } : {}),
      rectEdges: "glyph",
    },
    stats,
  };
}
