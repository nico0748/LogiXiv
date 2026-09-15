import type { TextChunk } from './sentences.ts';

/**
 * ページのレイアウトを読む。
 *
 * ここが無いと、2 段組の論文で左右の段が同じ y に並んでいるせいで
 * 1 行として連結され、本文が交互に混ざる。実測で「正解の文が取れた割合」が
 * 1 段組 60% に対して 2 段組は 30% まで落ちていた。
 *
 * 使う情報は座標と文字高だけ。フォント名や太字は pdf.js の TextItem から
 * 安定して取れないので、当てにしない。
 */

export interface Line {
  page: number;
  /** 段の番号（左から 0）。 */
  column: number;
  /** 文書全体での行の識別子。矩形をまとめる単位。 */
  index: number;
  chunks: TextChunk[];
  y: number;
  /** 行の中で最も多い文字高。見出し判定に使う。 */
  height: number;
  left: number;
  right: number;
  text: string;
}

export type LineRole = 'body' | 'heading' | 'furniture';

export interface ClassifiedLine extends Line {
  role: LineRole;
}

const BIN_WIDTH = 2;
/** これより狭い空白は段の切れ目とみなさない。 */
const MIN_GUTTER = 12;
/** 段として認めるための最小幅（ページ幅に対する比）。 */
const MIN_COLUMN_RATIO = 0.12;

/**
 * ページ内の縦の空白帯（段間）を探して、段の x 範囲を返す。
 *
 * 文字の x 範囲を 1 次元に射影し、「どの行にも覆われていない帯」を段間とみなす。
 * 図や表で偶然できる隙間を拾わないよう、**行数の多い帯だけ**を段間として採る。
 */
export function detectColumns(chunks: TextChunk[]): { from: number; to: number }[] {
  if (chunks.length === 0) return [{ from: -Infinity, to: Infinity }];

  const minX = Math.min(...chunks.map((c) => c.x));
  const maxX = Math.max(...chunks.map((c) => c.x + c.w));
  const width = maxX - minX;
  if (width <= 0) return [{ from: -Infinity, to: Infinity }];

  const binCount = Math.max(1, Math.ceil(width / BIN_WIDTH));
  // 各ビンを覆っている「行」の数。y を丸めて行の代わりにする。
  const rowsPerBin: Set<number>[] = Array.from({ length: binCount }, () => new Set<number>());
  for (const chunk of chunks) {
    const row = Math.round(chunk.y / 6);
    const start = Math.floor((chunk.x - minX) / BIN_WIDTH);
    const end = Math.min(binCount - 1, Math.floor((chunk.x + chunk.w - minX) / BIN_WIDTH));
    for (let bin = Math.max(0, start); bin <= end; bin++) rowsPerBin[bin]!.add(row);
  }

  const totalRows = new Set(chunks.map((c) => Math.round(c.y / 6))).size;
  // 段間は「ほとんどの行で空いている」帯。図や表が両段にまたがる行を数行ぶん許容する。
  // 下限を 1 にしてはいけない — 行数の少ないページで「全ビンが空」になり、段組が壊れる。
  const emptyThreshold = Math.floor(totalRows * 0.08);

  const gutters: { from: number; to: number }[] = [];
  let runStart: number | null = null;
  for (let bin = 0; bin < binCount; bin++) {
    const empty = rowsPerBin[bin]!.size <= emptyThreshold;
    if (empty && runStart === null) runStart = bin;
    if (!empty && runStart !== null) {
      const from = minX + runStart * BIN_WIDTH;
      const to = minX + bin * BIN_WIDTH;
      if (to - from >= MIN_GUTTER) gutters.push({ from, to });
      runStart = null;
    }
  }

  if (gutters.length === 0) return [{ from: -Infinity, to: Infinity }];

  const boundaries: { from: number; to: number }[] = [];
  let cursor = minX;
  for (const gutter of gutters) {
    if (gutter.from - cursor >= width * MIN_COLUMN_RATIO) {
      boundaries.push({ from: cursor, to: gutter.from });
      cursor = gutter.to;
    }
  }
  if (maxX - cursor >= width * MIN_COLUMN_RATIO) boundaries.push({ from: cursor, to: maxX });

  if (boundaries.length <= 1) return [{ from: -Infinity, to: Infinity }];
  // 端は開いておく（段の外へはみ出した文字を落とさない）。
  boundaries[0]!.from = -Infinity;
  boundaries[boundaries.length - 1]!.to = Infinity;
  return boundaries;
}

/** 段ごと・y ごとに文字片をまとめて行にする。 */
export function buildLines(chunks: TextChunk[]): Line[] {
  const byPage = new Map<number, TextChunk[]>();
  for (const chunk of chunks) {
    if (chunk.text.length === 0) continue;
    const list = byPage.get(chunk.page);
    if (list) list.push(chunk);
    else byPage.set(chunk.page, [chunk]);
  }

  const lines: Line[] = [];
  for (const [page, pageChunks] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    const columns = detectColumns(pageChunks);

    columns.forEach((range, columnIndex) => {
      const inColumn = pageChunks.filter((c) => {
        const center = c.x + c.w / 2;
        return center >= range.from && center < range.to;
      });
      inColumn.sort((a, b) => a.y - b.y || a.x - b.x);

      let current: Line | null = null;
      for (const chunk of inColumn) {
        const tolerance = Math.max(2, chunk.h * 0.6);
        if (current && Math.abs(chunk.y - current.y) <= tolerance) {
          current.chunks.push(chunk);
          continue;
        }
        current = {
          page,
          column: columnIndex,
          index: lines.length,
          chunks: [chunk],
          y: chunk.y,
          height: chunk.h,
          left: chunk.x,
          right: chunk.x + chunk.w,
          text: '',
        };
        lines.push(current);
      }
    });
  }

  for (const line of lines) {
    line.chunks.sort((a, b) => a.x - b.x);
    line.text = line.chunks.map((c) => c.text).join('').replace(/\s+/g, ' ').trim();
    line.left = Math.min(...line.chunks.map((c) => c.x));
    line.right = Math.max(...line.chunks.map((c) => c.x + c.w));
    line.height = median(line.chunks.map((c) => c.h));
  }

  return lines;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

const KNOWN_HEADINGS = new Set([
  'abstract',
  'introduction',
  'background',
  'related work',
  'method',
  'methods',
  'methodology',
  'experiments',
  'experimental setup',
  'results',
  'discussion',
  'conclusion',
  'conclusions',
  'references',
  'acknowledgments',
  'acknowledgements',
  'appendix',
  'limitations',
]);

/** 章番号つきの見出し（"3.1 Ablation"）。 */
const NUMBERED_HEADING = /^\d+(\.\d+)*\.?\s+\p{Lu}/u;

/** ここから後ろは本文として扱わない見出し。 */
const TAIL_HEADINGS = new Set(['references', 'bibliography', 'acknowledgments', 'acknowledgements']);

/** 図表のキャプション。 */
const CAPTION = /^(figure|fig\.?|table|algorithm|listing|scheme)\s*\d+\s*[.:）)]/i;

/**
 * 参考文献の 1 エントリ。
 * `1. Author...` の形は入れない — "1. Introduction" のような章見出しと区別できず、
 * 見出しを全部落としてしまう。番号なしの参考文献は tailFrom（References 見出し以降）で拾う。
 */
const REFERENCE_ENTRY = /^(\[\d+\]|\(\d+\))\s*\p{Lu}/u;

/** 数式らしさ。英字が少なく、演算子や添字が多い行。 */
function looksLikeFormula(text: string): boolean {
  if (text.length < 3) return false;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const operators = (text.match(/[=+\-*/^_<>|∑∏∫√≈≤≥±×·]/gu) ?? []).length;
  if (operators === 0) return false;
  return letters / text.length < 0.65 && operators >= 1 && !/[.!?]$/.test(text);
}

/**
 * 行の役割を決める。
 *
 * - furniture … 柱（ランニングヘッド）とノンブル。**複数ページの同じ位置に繰り返し出る**
 *   ことで判定する。1 ページしか無い文書では判定できないので、そのときは何も落とさない。
 * - heading   … 節見出し。本文の文として並べたくない
 * - body      … それ以外
 */
export function classifyLines(lines: Line[], pageCount: number): ClassifiedLine[] {
  const bodyHeight = median(lines.map((l) => l.height));
  const pageTop = Math.min(...lines.map((l) => l.y));
  const pageBottom = Math.max(...lines.map((l) => l.y));
  const span = Math.max(1, pageBottom - pageTop);

  // 行送りの代表値。柱の判定に使う。
  const spacings: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const previous = lines[i - 1]!;
    const line = lines[i]!;
    if (previous.page !== line.page || previous.column !== line.column) continue;
    const gap = line.y - previous.y;
    if (gap > 0 && gap < 100) spacings.push(gap);
  }
  const lineSpacing = median(spacings) || bodyHeight * 1.3;

  /**
   * 柱（ランニングヘッド）とノンブルの候補か。
   *
   * 位置だけで決めてはいけない。「上下 8%」のような帯で切ると、本文の 1 行目が
   * 帯に入ってしまう（実測で first line が消えた）。柱は**本文ブロックから
   * 一行ぶん以上離れている**のが本質なので、隣の行との間隔で判定する。
   */
  const isolated = new Set<number>();
  const byPage = new Map<number, Line[]>();
  for (const line of lines) {
    const list = byPage.get(line.page);
    if (list) list.push(line);
    else byPage.set(line.page, [line]);
  }
  for (const pageLines of byPage.values()) {
    const sorted = [...pageLines].sort((a, b) => a.y - b.y);
    const first = sorted[0];
    const second = sorted[1];
    const last = sorted[sorted.length - 1];
    const secondLast = sorted[sorted.length - 2];
    if (first && second && second.y - first.y > lineSpacing * 1.8) isolated.add(first.index);
    if (last && secondLast && last.y - secondLast.y > lineSpacing * 1.8) isolated.add(last.index);
  }

  // 柱とノンブルの検出: 「上下端に近い」かつ「本文から離れている」行を、数字を伏せた形で数える。
  const repeated = new Map<string, Set<number>>();
  for (const line of lines) {
    const relative = (line.y - pageTop) / span;
    if (relative > 0.15 && relative < 0.85) continue;
    if (!isolated.has(line.index)) continue;
    const key = line.text.replace(/\d+/g, '#');
    if (key.length === 0) continue;
    const pages = repeated.get(key);
    if (pages) pages.add(line.page);
    else repeated.set(key, new Set([line.page]));
  }

  // 段ごとの最大行幅。見出し・数式の「短い行」判定に使う。
  const columnWidths = new Map<string, number>();
  for (const line of lines) {
    const key = `${line.page}:${line.column}`;
    columnWidths.set(key, Math.max(columnWidths.get(key) ?? 0, line.right - line.left));
  }

  // 参考文献より後ろは本文にしない。見出しの位置を先に押さえる。
  let tailFrom = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    const bare = line.text.toLowerCase().replace(/^\d+(\.\d+)*\.?\s*/, '').replace(/[^a-z]/g, '');
    if (TAIL_HEADINGS.has(bare) && line.text.length <= 40) {
      tailFrom = Math.min(tailFrom, line.index);
      break;
    }
  }

  return lines.map((line) => {
    const relative = (line.y - pageTop) / span;
    const key = line.text.replace(/\d+/g, '#');
    const seenOn = repeated.get(key)?.size ?? 0;

    // 参考文献の見出し自体は節として残し、その後ろを本文から外す。
    if (line.index > tailFrom) return { ...line, role: 'furniture' as const };
    if (CAPTION.test(line.text) || REFERENCE_ENTRY.test(line.text)) {
      return { ...line, role: 'furniture' as const };
    }

    const nearEdge = relative <= 0.15 || relative >= 0.85;
    // 2 ページ以上で同じ柱が本文から離れて出ていれば付物。1 ページの文書では落とさない。
    if (nearEdge && isolated.has(line.index) && pageCount >= 2 && seenOn >= 2) {
      return { ...line, role: 'furniture' as const };
    }
    // 端に出る数字だけの行はノンブル。1 ページでも落としてよい。
    if (nearEdge && /^\d{1,4}$/.test(line.text)) {
      return { ...line, role: 'furniture' as const };
    }

    const columnWidth = columnWidths.get(`${line.page}:${line.column}`) ?? 0;
    const isShort = columnWidth > 0 && line.right - line.left < columnWidth * 0.7;
    const endsOpen = !/[.!?:;,]$/.test(line.text);
    const looksLikeHeading =
      line.text.length > 0 &&
      line.text.length <= 80 &&
      (KNOWN_HEADINGS.has(line.text.toLowerCase().replace(/^\d+(\.\d+)*\.?\s*/, '')) ||
        NUMBERED_HEADING.test(line.text) ||
        line.height > bodyHeight * 1.15);

    if (looksLikeHeading && isShort && endsOpen) {
      return { ...line, role: 'heading' as const };
    }

    // 別行立ての数式。英字の比率が低く演算子を含み、行が短く終端が無いもの。
    // 中央寄せを条件に入れない（左寄せで組む雑誌もある）。本文は英字比率が 0.8 前後なので、
    // 0.65 の閾値で取り違えない。「短い」を外すと、インライン数式を含む
    // 本文の折り返し行（"where α = 0.5, β = 0.9 and"）まで落ちてしまう。
    if (isShort && looksLikeFormula(line.text)) {
      return { ...line, role: 'furniture' as const };
    }

    return { ...line, role: 'body' as const };
  });
}
