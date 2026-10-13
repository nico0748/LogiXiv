/**
 * 文字片（pdf.js の TextItem）の**中**で、何文字目が紙面のどの x にあるか。
 *
 * pdf.js は 1 行まるごとを 1 個の文字片で返すことが普通にある
 * （実測: pdflatex の 1 段組で `…rather than into the rule itself. We expect better …` が 1 個）。
 * 文の枠はその文字片を文の境目で割って作るので、割る位置の x が要る。
 * ところが TextItem が持つのは**文字片全体の幅だけ**で、1 文字ずつの x は無い。
 *
 * 以前は文字数の比で按分していた（10 文字目なら幅の 10/n）。等幅ではないので
 * 境目がずれる。実測（MuPDF で取った 1 文字ずつの位置との差、scripts/measure-edges.ts）:
 *   - 欧文の両端揃え: 語間は伸びるのに 1 文字と数えるので、境目が 1〜3 文字ぶん右にずれる。
 *     文頭が覆われず、前の文の枠が次の文の頭まで食い込む。
 *   - 和文に欧文の術語が混ざる行: 欧字（半角）を全角 1 文字と同じに数えるので、
 *     2〜4 文字（20〜44pt）ずれる。
 *
 * ここでは**字形の幅を見積もって**按分する。見積もりは 2 段:
 *   1. 文字ごとの標準の送り幅（em）。欧字は Computer Modern Roman の幅
 *      （arXiv の論文の大半がこれか、比率の近い Times）。和字・全角は 1em。
 *   2. 文字片の実際の幅に合わせる。語間（空白）は両端揃えで伸び縮みするので、
 *      まず**余りを空白に配り**、それでも合わないぶんを全体に比例で掛ける。
 * 書体の実際の幅は pdf.js の TextItem からは取れない（取るには描画用の命令列を
 * 組み立てる必要があり、画像の復号まで走るので取り込みが桁で遅くなる）。
 */

import type { TextChunk } from './sentences.ts';

/** Computer Modern Roman 10pt の送り幅（em）。ASCII の 0x21〜0x7E。 */
const ASCII_WIDTHS: Record<string, number> = {
  '!': 0.278, '"': 0.5, '#': 0.833, $: 0.5, '%': 0.833, '&': 0.778, "'": 0.278, '(': 0.389, ')': 0.389,
  '*': 0.5, '+': 0.778, ',': 0.278, '-': 0.333, '.': 0.278, '/': 0.5, ':': 0.278, ';': 0.278, '<': 0.778,
  '=': 0.778, '>': 0.778, '?': 0.472, '@': 0.778, '[': 0.278, '\\': 0.5, ']': 0.278, '^': 0.5, _: 0.5,
  '`': 0.278, '{': 0.5, '|': 0.278, '}': 0.5, '~': 0.5,
  A: 0.75, B: 0.708, C: 0.722, D: 0.764, E: 0.681, F: 0.653, G: 0.785, H: 0.75, I: 0.361, J: 0.514,
  K: 0.778, L: 0.625, M: 0.917, N: 0.75, O: 0.778, P: 0.681, Q: 0.778, R: 0.736, S: 0.556, T: 0.722,
  U: 0.75, V: 0.75, W: 1.028, X: 0.75, Y: 0.75, Z: 0.611,
  a: 0.5, b: 0.556, c: 0.444, d: 0.556, e: 0.444, f: 0.306, g: 0.5, h: 0.556, i: 0.278, j: 0.306,
  k: 0.528, l: 0.278, m: 0.833, n: 0.556, o: 0.5, p: 0.556, q: 0.528, r: 0.392, s: 0.394, t: 0.389,
  u: 0.556, v: 0.528, w: 0.722, x: 0.528, y: 0.528, z: 0.444,
};
for (let d = 0; d <= 9; d++) ASCII_WIDTHS[String(d)] = 0.5;

/** よく出る ASCII 外の記号。 */
const SYMBOL_WIDTHS: Record<string, number> = {
  '–': 0.5, '—': 1, '‘': 0.278, '’': 0.278, '“': 0.5, '”': 0.5,
  '•': 0.5, '·': 0.278, '−': 0.778, '×': 0.778, '±': 0.778,
  'ﬀ': 0.583, 'ﬁ': 0.556, 'ﬂ': 0.556, 'ﬃ': 0.833, 'ﬄ': 0.833,
};

/** 空白の自然な幅（em）。CM の語間。 */
const SPACE = 0.333;

/** 東アジアの全角（和字・漢字・ハングル・全角英数と約物）。1em で組まれる。 */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

const COMBINING = /\p{M}/u;
const SPACE_CHAR = /\s/u;

/**
 * 1 文字（コードポイント）の自然な送り幅（em）。空白は呼び出し側で別に扱う。
 * `mono` は等幅書体（verbatim・listings）。全角だけ 2 倍、それ以外は 1 にそろえる。
 */
export function estimateAdvance(ch: string, mono = false): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (COMBINING.test(ch)) return 0;
  if (mono) return isWide(cp) ? 2 : 1;
  const ascii = ASCII_WIDTHS[ch];
  if (ascii !== undefined) return ascii;
  if (isWide(cp)) return 1;
  if (cp >= 0xff61 && cp <= 0xff9f) return 0.5; // 半角カナ
  const symbol = SYMBOL_WIDTHS[ch];
  if (symbol !== undefined) return symbol;
  // アクセント付きの欧字は、元の字の幅で数える（é → e）。
  const base = ch.normalize('NFD')[0];
  if (base !== undefined && base !== ch) {
    const width = ASCII_WIDTHS[base];
    if (width !== undefined) return width;
  }
  if (cp >= 0x0370 && cp <= 0x03ff) return 0.55; // ギリシャ文字
  if (cp >= 0x2190 && cp <= 0x21ff) return 1; // 矢印
  if (cp >= 0x2200 && cp <= 0x22ff) return 0.778; // 数学の演算子
  return 0.5;
}

/**
 * 文字列の自然な幅（em）。空白は語間ひとつぶんで数える。
 * 枠の按分（edits.ts の分割）で、文字数の代わりに使う。
 */
export function estimateTextAdvance(text: string): number {
  let total = 0;
  for (const ch of text) total += SPACE_CHAR.test(ch) ? SPACE : estimateAdvance(ch);
  return total;
}

const cache = new WeakMap<TextChunk, Float64Array>();

/**
 * 文字片の各文字の左端の x（紙面の座標）。長さは `text.length + 1` で、最後は右端。
 * 添字は JavaScript の文字列の添字（UTF-16 の単位）。代用対の後ろ半分は幅 0。
 */
export function chunkCharEdges(chunk: TextChunk): Float64Array {
  const cached = cache.get(chunk);
  if (cached) return cached;
  const edges = computeEdges(chunk);
  cache.set(chunk, edges);
  return edges;
}

function computeEdges(chunk: TextChunk): Float64Array {
  const text = chunk.text;
  const n = text.length;
  const edges = new Float64Array(n + 1);
  const mono = chunk.mono === true;

  // 1 単位（UTF-16）ずつの自然な幅。空白は後で決めるので -1 を置いておく。
  const natural = new Float64Array(n);
  let letters = 0;
  let spaces = 0;
  for (let i = 0; i < n; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) continue; // 代用対の後ろ半分
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (SPACE_CHAR.test(ch)) {
      natural[i] = -1;
      spaces++;
      continue;
    }
    const width = estimateAdvance(ch, mono);
    natural[i] = width;
    letters += width;
  }

  const total = chunk.w;
  const size = chunk.h;
  // 幅も字高も当てにならない文字片（幅 0・右から左）は、文字数の比に戻す。
  if (!(total > 0) || !(size > 0) || letters + spaces === 0) {
    for (let i = 0; i <= n; i++) edges[i] = chunk.x + (n === 0 ? 0 : (Math.max(total, 0) * i) / n);
    return edges;
  }

  // 語間の幅。等幅なら 1 文字ぶん。プロポーショナルなら、実際の幅から字形の幅を
  // 引いた余りを空白に配る（両端揃えで伸びるのは語間だけなので）。
  let space = mono ? 1 : SPACE;
  if (!mono && spaces > 0) {
    const residual = (total / size - letters) / spaces;
    space = Math.min(Math.max(residual, 0.1), 1.2);
  }
  const predicted = letters + spaces * space;
  const scale = total / predicted;

  let x = chunk.x;
  for (let i = 0; i < n; i++) {
    edges[i] = x;
    const width = natural[i] === -1 ? space : natural[i]!;
    x += width * scale;
  }
  edges[n] = chunk.x + total;
  return edges;
}
