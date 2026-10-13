// PDF の各文字が実際に描かれる横位置を求める。マーカーの端を文字にぴったり合わせるために使う。
//
// pdf.js の getTextContent は「項目（おおむね 1 行）の文字列と全体の幅」しか持たない。
// 画面のテキスト層も、その文字列を代わりのフォントで描いて幅だけ合わせている。
// そのため文の途中から始まる・途中で終わる範囲の位置を文字数や代わりのフォントで求めると、
// プロポーショナルフォント・和欧混在・両端揃えの行で文頭・文末が数 pt〜数十 pt ずれ、
// 「文頭が塗られない」「文末からはみ出す」ことになる。
// ここでは描画命令（operator list）をたどり、pdf.js の canvas.js の showText と同じ式で
// グリフごとの位置を計算して、テキストの項目の各文字に割り当てる。
// pdf.js 本体は読み込まない（サーバーは legacy 版、画面は通常版を使うため、OPS は呼び出し側から渡す）。

import type { Rect } from "./model.ts";

type Matrix = number[];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 × m2（m2 を先に掛ける）。pdf.js の Util.transform と同じ。 */
export function mul(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** pdf.js の OPS のうち、ここで使うもの。 */
export interface Ops {
  save: number;
  restore: number;
  transform: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  beginText: number;
  setCharSpacing: number;
  setWordSpacing: number;
  setHScale: number;
  setLeading: number;
  setTextRise: number;
  setFont: number;
  moveText: number;
  setLeadingMoveText: number;
  nextLine: number;
  setTextMatrix: number;
  showText: number;
}

export interface FontLike {
  fontMatrix?: ArrayLike<number>;
  vertical?: boolean;
}

interface GlyphLike {
  unicode?: string;
  width?: number;
  isSpace?: boolean;
}

/** 描画された 1 グリフ。x0/x1 はビューポート座標。 */
export interface Glyph {
  ch: string;
  x0: number;
  x1: number;
}

/**
 * 描画命令をたどって、横書きの各グリフが置かれる横の範囲（ビューポート座標）を求める。
 * 縦書き・回転した文字は返さない（呼び出し側は文字数での按分に戻る）。
 */
export function layoutGlyphs(
  ops: Ops,
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<unknown>,
  getFont: (name: string) => FontLike | null,
  viewport: Matrix,
): Glyph[] {
  interface State {
    ctm: Matrix;
    textMatrix: Matrix;
    x: number;
    y: number;
    lineX: number;
    lineY: number;
    leading: number;
    charSpacing: number;
    wordSpacing: number;
    hScale: number;
    rise: number;
    font: FontLike | null;
    fontSize: number;
    fontDirection: number;
  }
  let st: State = {
    ctm: IDENTITY, textMatrix: IDENTITY, x: 0, y: 0, lineX: 0, lineY: 0, leading: 0,
    charSpacing: 0, wordSpacing: 0, hScale: 1, rise: 0, font: null, fontSize: 0, fontDirection: 1,
  };
  const stack: State[] = [];
  const out: Glyph[] = [];
  const moveText = (x: number, y: number) => {
    st.x = st.lineX += x;
    st.y = st.lineY += y;
  };
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const matrix = (v: unknown): Matrix | null =>
    Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v as ArrayLike<number>).slice(0, 6) : null;

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = (argsArray[i] ?? []) as unknown[];
    switch (fn) {
      case ops.save:
        stack.push({ ...st });
        break;
      case ops.restore:
        if (stack.length) st = stack.pop()!;
        break;
      case ops.transform:
        st.ctm = mul(st.ctm, (args as number[]).slice(0, 6));
        break;
      case ops.paintFormXObjectBegin: {
        stack.push({ ...st });
        const m = matrix(args[0]);
        if (m) st.ctm = mul(st.ctm, m);
        break;
      }
      case ops.paintFormXObjectEnd:
        if (stack.length) st = stack.pop()!;
        break;
      case ops.beginText:
        st.textMatrix = IDENTITY;
        st.x = st.lineX = st.y = st.lineY = 0;
        break;
      case ops.setCharSpacing:
        st.charSpacing = num(args[0]);
        break;
      case ops.setWordSpacing:
        st.wordSpacing = num(args[0]);
        break;
      case ops.setHScale:
        st.hScale = num(args[0]) / 100;
        break;
      case ops.setLeading:
        st.leading = -num(args[0]);
        break;
      case ops.setTextRise:
        st.rise = num(args[0]);
        break;
      case ops.setFont: {
        const size = num(args[1]);
        st.font = typeof args[0] === "string" ? getFont(args[0]) : null;
        st.fontDirection = size < 0 ? -1 : 1;
        st.fontSize = Math.abs(size);
        break;
      }
      case ops.moveText:
        moveText(num(args[0]), num(args[1]));
        break;
      case ops.setLeadingMoveText:
        st.leading = num(args[1]);
        moveText(num(args[0]), num(args[1]));
        break;
      case ops.nextLine:
        moveText(0, st.leading);
        break;
      case ops.setTextMatrix: {
        // pdf.js 5 は行列を 1 つの引数で、古い版は 6 つの数で渡す
        const m = args.length >= 6 ? (args as number[]).slice(0, 6) : matrix(args[0]);
        if (m) st.textMatrix = m;
        st.x = st.lineX = st.y = st.lineY = 0;
        break;
      }
      case ops.showText: {
        const font = st.font;
        const glyphs = args[0] as (GlyphLike | number | null)[];
        if (!font || !Array.isArray(glyphs)) break;
        const fm = font.fontMatrix ?? [0.001, 0, 0, 0.001, 0, 0];
        const advanceScale = st.fontSize * fm[0];
        const hScale = st.hScale * st.fontDirection;
        // canvas.js と同じ順: textMatrix → translate(x, y + rise) → scale(hScale, ±1)
        let m = mul(mul(mul(viewport, st.ctm), st.textMatrix), [1, 0, 0, 1, st.x, st.y + st.rise]);
        m = mul(m, [hScale, 0, 0, st.fontDirection > 0 ? -1 : 1, 0, 0]);
        const usable = !font.vertical && Math.abs(m[0]) > 1e-9 && Math.abs(m[1]) <= Math.abs(m[0]) * 0.05;
        const spacingDir = font.vertical ? 1 : -1;
        let x = 0;
        for (const g of glyphs) {
          if (typeof g === "number") {
            x += (spacingDir * g * st.fontSize) / 1000;
            continue;
          }
          if (!g) continue;
          const w = (g.width ?? 0) * advanceScale;
          if (usable && g.unicode) {
            const a = m[0] * x + m[4];
            const b = m[0] * (x + w) + m[4];
            out.push({ ch: g.unicode, x0: Math.min(a, b), x1: Math.max(a, b) });
          }
          const spacing = (g.isSpace ? st.wordSpacing : 0) + st.charSpacing;
          x += font.vertical ? w - spacing * st.fontDirection : w + spacing * st.fontDirection;
        }
        if (font.vertical) st.y -= x;
        else st.x += x * hScale;
        break;
      }
    }
  }
  return out;
}

const fold = (s: string) => s.normalize("NFKC").toLowerCase();
const SPACE = /\s/;

/**
 * テキストの項目（getTextContent の str）の各文字に、描画したグリフの横位置を割り当てる。
 * 返り値は項目ごとの配列で、文字 c の左端・右端（ページ幅に対する割合）が [2c], [2c+1] に入る。
 * 対応が取れなかった文字は NaN。ページの大半が対応しない（文字コードの対応表が壊れている等）ときは null。
 * 両者はおおむね同じ順に並ぶが、合字・結合文字・補った空白で食い違うことがあるので、
 * 一致しないところは少し先を探して同期し直す。
 */
export function attachGlyphs(strs: readonly string[], glyphs: readonly Glyph[], pageWidth: number): Float64Array[] | null {
  // グリフ側: NFKC で展開した 1 文字ごとに、グリフの幅を等分する
  const gch: string[] = [];
  const gx0: number[] = [];
  const gx1: number[] = [];
  for (const g of glyphs) {
    const chars = Array.from(fold(g.ch));
    const n = chars.length || 1;
    chars.forEach((c, k) => {
      if (SPACE.test(c)) return;
      gch.push(c);
      gx0.push(g.x0 + ((g.x1 - g.x0) * k) / n);
      gx1.push(g.x0 + ((g.x1 - g.x0) * (k + 1)) / n);
    });
  }
  // 項目側: 空白以外の文字（UTF-16 の位置で覚える）
  const ach: string[] = [];
  const aref: [number, number][] = [];
  const out = strs.map((s, i) => {
    for (let c = 0; c < s.length; c++) {
      if (SPACE.test(s[c])) continue;
      const f = fold(s[c]);
      if (f.length !== 1) continue; // まれな展開文字は按分に任せる
      ach.push(f);
      aref.push([i, c]);
    }
    return new Float64Array(s.length * 2).fill(NaN);
  });
  const K = 3;
  const W = 24;
  const same = (i: number, j: number) => {
    for (let k = 0; k < K; k++) {
      if (i + k >= ach.length || j + k >= gch.length) return k > 0;
      if (ach[i + k] !== gch[j + k]) return false;
    }
    return true;
  };
  let i = 0;
  let j = 0;
  let mapped = 0;
  while (i < ach.length && j < gch.length) {
    if (ach[i] === gch[j]) {
      const [ii, c] = aref[i];
      out[ii][c * 2] = gx0[j] / pageWidth;
      out[ii][c * 2 + 1] = gx1[j] / pageWidth;
      mapped++;
      i++;
      j++;
      continue;
    }
    let moved = false;
    for (let d = 1; d <= W && !moved; d++) {
      if (same(i, j + d)) {
        j += d;
        moved = true;
      } else if (same(i + d, j)) {
        i += d;
        moved = true;
      }
    }
    if (!moved) {
      i++;
      j++;
    }
  }
  if (!ach.length || mapped / ach.length < 0.8) return null;
  return out;
}

/**
 * 項目 str の from〜to 文字目（空白を除く）が占める横の範囲 [左端, 右端]（ページ幅に対する割合）。
 * グリフの位置 xs が無い文字は、項目の矩形 rect を文字数で按分して求める。空白しか無ければ null。
 */
export function charSpan(str: string, xs: Float64Array | null | undefined, rect: Rect, from: number, to: number): [number, number] | null {
  const n = str.length;
  let x0 = Infinity;
  let x1 = -Infinity;
  for (let c = Math.max(0, from); c < Math.min(to, n); c++) {
    if (SPACE.test(str[c])) continue;
    let a = xs ? xs[c * 2] : NaN;
    let b = xs ? xs[c * 2 + 1] : NaN;
    if (!(a <= b)) {
      a = rect.x + (rect.w * c) / n;
      b = rect.x + (rect.w * (c + 1)) / n;
    }
    x0 = Math.min(x0, a);
    x1 = Math.max(x1, b);
  }
  return x0 <= x1 ? [x0, x1] : null;
}
