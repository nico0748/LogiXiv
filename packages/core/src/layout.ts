import type { PageSize } from './types.ts';
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
 *
 * 判定は「1 つの決め手」ではなく複数の弱い手掛かりの合算にしてある。
 * 単独の規則には必ず反例がある — 番号つき見出しの規則は箇条書きを見出しにし、
 * 文字高の規則は参考文献の長い論文で誤作動する。
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
/** 段として認めるための最小幅（文字のある幅に対する比）。 */
const MIN_COLUMN_RATIO = 0.12;

export interface ColumnRange {
  from: number;
  to: number;
}

const SINGLE_COLUMN: ColumnRange[] = [{ from: -Infinity, to: Infinity }];

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** 大きい方から数えて `ratio` の位置の値。外れ値（全幅の図表）に引きずられない代表値。 */
function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => b - a);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]!;
}

function rowKey(chunk: TextChunk): number {
  return Math.round(chunk.y / 6);
}

/**
 * 本文の文字高。行数ではなく**文字数**で重みを付ける。
 * 単純な median だと、見出しや参考文献の行数が多い文書で代表値がそちらへ引っ張られ、
 * 本文行が「小さい文字＝脚注」と誤判定される（実際に本文の最終行が消えていた）。
 */
function bodyTextHeight(lines: Line[]): number {
  const weight = new Map<number, number>();
  for (const line of lines) {
    const bucket = Math.round(line.height * 2) / 2;
    weight.set(bucket, (weight.get(bucket) ?? 0) + line.text.length);
  }
  let best = 0;
  let bestWeight = -1;
  for (const [height, chars] of weight) {
    if (chars > bestWeight) {
      bestWeight = chars;
      best = height;
    }
  }
  return best || median(lines.map((l) => l.height));
}

/**
 * ページ内の縦の空白帯（段間）を探して、段の x 範囲を返す。
 *
 * 文字の x 範囲を 1 次元に射影し、「ほとんどの行で空いている帯」を段間とみなす。
 * `tolerance` は段間をまたいでよい行の割合。厳しすぎると、両段にまたがる表や
 * 全幅のタイトルブロックが 3 行あるだけで段組検出が丸ごと失敗する（実測済み）。
 */
export function detectColumns(chunks: TextChunk[], tolerance = 0.15): ColumnRange[] {
  if (chunks.length === 0) return SINGLE_COLUMN;

  const minX = Math.min(...chunks.map((c) => c.x));
  const maxX = Math.max(...chunks.map((c) => c.x + c.w));
  const width = maxX - minX;
  if (width <= 0) return SINGLE_COLUMN;

  const binCount = Math.max(1, Math.ceil(width / BIN_WIDTH));
  const rowsPerBin: Set<number>[] = Array.from({ length: binCount }, () => new Set<number>());
  for (const chunk of chunks) {
    const row = rowKey(chunk);
    const start = Math.floor((chunk.x - minX) / BIN_WIDTH);
    const end = Math.min(binCount - 1, Math.floor((chunk.x + chunk.w - minX) / BIN_WIDTH));
    for (let bin = Math.max(0, start); bin <= end; bin++) rowsPerBin[bin]!.add(row);
  }

  const totalRows = new Set(chunks.map(rowKey)).size;
  // 「段間をまたいでよい行数」。割合だけだと行数の少ないページで 0 に落ち、
  // 段間をまたぐ要素が 3 行あるだけで段組検出が壊れていた。
  // 逆に絶対値の下限だけだと、行数の少ないページで全ビンが空扱いになる。
  // 下限 1・上限「行数の半分」で挟む。
  const emptyThreshold = Math.min(
    Math.max(1, Math.floor(totalRows * tolerance)),
    Math.floor(totalRows / 2),
  );

  const gutters: ColumnRange[] = [];
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
  if (gutters.length === 0) return SINGLE_COLUMN;

  const boundaries: ColumnRange[] = [];
  let cursor = minX;
  for (const gutter of gutters) {
    if (gutter.from - cursor >= width * MIN_COLUMN_RATIO) {
      boundaries.push({ from: cursor, to: gutter.from });
      cursor = gutter.to;
    }
  }
  if (maxX - cursor >= width * MIN_COLUMN_RATIO) boundaries.push({ from: cursor, to: maxX });

  if (boundaries.length <= 1) return SINGLE_COLUMN;
  boundaries[0]!.from = -Infinity;
  boundaries[boundaries.length - 1]!.to = Infinity;
  return boundaries;
}

/**
 * 文書全体で段の位置を決める。
 *
 * 段の x 位置は 1 本の論文の中でほぼ動かないので、あるページで検出に失敗しても
 * 他のページの結果を借りられる。表や全幅ブロックのあるページだけ 1 段と判定されて
 * 本文が交互に混ざる、という壊れ方を防ぐ。
 */
function resolveColumns(byPage: Map<number, TextChunk[]>): Map<number, ColumnRange[]> {
  const perPage = new Map<number, ColumnRange[]>();
  for (const [page, chunks] of byPage) perPage.set(page, detectColumns(chunks));

  // いちばん多く現れた段数（2 以上）を文書の段数とみなす。
  const counts = new Map<number, number>();
  for (const ranges of perPage.values()) {
    counts.set(ranges.length, (counts.get(ranges.length) ?? 0) + 1);
  }
  let modeCount = 1;
  let best = -1;
  for (const [count, times] of counts) {
    if (count > 1 && times > best) {
      best = times;
      modeCount = count;
    }
  }
  if (modeCount <= 1) return perPage;

  const samples = [...perPage.values()].filter((r) => r.length === modeCount);
  const reference: ColumnRange[] = [];
  for (let i = 0; i < modeCount; i++) {
    reference.push({
      from: i === 0 ? -Infinity : median(samples.map((r) => r[i]!.from)),
      to: i === modeCount - 1 ? Infinity : median(samples.map((r) => r[i]!.to)),
    });
  }

  // 段数が足りなかったページだけ、緩い許容で代表値を当てはめられるか確かめる。
  for (const [page, ranges] of perPage) {
    if (ranges.length >= modeCount) continue;
    const chunks = byPage.get(page) ?? [];
    const totalRows = new Set(chunks.map(rowKey)).size;
    if (totalRows === 0) continue;
    const crossing = new Set<number>();
    for (let i = 0; i < reference.length - 1; i++) {
      const gutterFrom = reference[i]!.to;
      const gutterTo = reference[i + 1]!.from;
      for (const chunk of chunks) {
        if (chunk.x < gutterTo && chunk.x + chunk.w > gutterFrom) crossing.add(rowKey(chunk));
      }
    }

    // 「またぐ行が少ない」ではなく「またがない行がちゃんとあり、左右の両方に文字がある」で決める。
    // 割合で決めると、全幅のタイトルブロックが過半を占める 1 ページ目を救えない。
    // 逆に、本当に 1 段組のページは全行が段間をまたぐので、ここで弾かれる。
    const notCrossing = [...new Set(chunks.map(rowKey))].filter((row) => !crossing.has(row));
    if (notCrossing.length < 3) continue;
    const rows = new Set(notCrossing);
    const gutterFrom = reference[0]!.to;
    const gutterTo = reference[1]!.from;
    const hasLeft = chunks.some((c) => rows.has(rowKey(c)) && c.x + c.w <= gutterFrom + 1);
    const hasRight = chunks.some((c) => rows.has(rowKey(c)) && c.x >= gutterTo - 1);
    if (hasLeft && hasRight) perPage.set(page, reference);
  }

  return perPage;
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

  const columnsByPage = resolveColumns(byPage);
  const lines: Line[] = [];

  for (const [page, pageChunks] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    const columns = columnsByPage.get(page) ?? SINGLE_COLUMN;

    // どの段にも入らない文字片を作らない。段間に中央揃えされた全幅の 1 行が
    // 黙って消える、という壊れ方をしていた。重なりが最大の段へ必ず割り当てる。
    const buckets: TextChunk[][] = columns.map(() => []);
    for (const chunk of pageChunks) {
      let bestIndex = 0;
      let bestOverlap = -Infinity;
      for (let i = 0; i < columns.length; i++) {
        const range = columns[i]!;
        const overlap = Math.min(range.to, chunk.x + chunk.w) - Math.max(range.from, chunk.x);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestIndex = i;
        }
      }
      buckets[bestIndex]!.push(chunk);
    }

    buckets.forEach((inColumn, columnIndex) => {
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

const KNOWN_HEADINGS = new Set([
  'abstract', 'introduction', 'background', 'related work',
  'method', 'methods', 'methodology', 'approach', 'experiments', 'experimental setup',
  'results', 'evaluation', 'discussion', 'conclusion', 'conclusions', 'future work',
  'references', 'bibliography', 'acknowledgments', 'acknowledgements',
  'appendix', 'limitations', 'ethics statement', 'broader impact',
]);

/** ここから後ろは本文として扱わない見出し。 */
const TAIL_HEADINGS = new Set(['references', 'bibliography', 'acknowledgments', 'acknowledgements']);

/**
 * 図表のキャプションか。出版社ごとに区切りが違う:
 *   "Figure 1: ..."（多数） / "Fig. 2 Overview"（Springer） /
 *   "FIGURE 3 Accuracy"（Wiley） / "Figure 4 | Latency"（Nature） / "Table 2. ..."
 *
 * 番号の直後が小文字なら本文（"Figure 1 shows that ..."）なので落とさない。
 * 大文字の判定を `i` フラグ付きの正規表現に混ぜてはいけない —
 * JavaScript では `i` を付けると `\p{Lu}` が小文字にも一致し、判定が無意味になる。
 */
function isCaption(text: string): boolean {
  const match = /^(fig(?:ure)?|table|tab|algorithm|listing|scheme)\s*\.?\s*(\d+[a-z]?)(.*)$/i.exec(text);
  if (!match) return false;
  const rest = match[3] ?? '';
  if (/^\s*[.:|)）]/.test(rest)) return true;
  // ここは大文字小文字を区別する。
  return /^\s+\p{Lu}/u.test(rest);
}

/** 参考文献の 1 エントリ。`1. Author` の形は章見出しと区別できないので入れない。 */
const REFERENCE_ENTRY = /^(\[\d+\]|\(\d+\))\s*\p{Lu}/u;

/** 行末の式番号 "(3)" / "(3a)" / "[12]"。幅と数式らしさの評価から外す。 */
const EQUATION_NUMBER = /\s*[([]\d+[a-z]?[)\]]\s*$/;

/**
 * 文らしさの手掛かりになる機能語。1 つでもあれば数式ではない。
 * 英字の比率だけで見ていた頃は "we set α = 0.1, β = 0.9, and γ = 0.99 for all runs"
 * のような本文まで数式として落としていた。
 */
const FUNCTION_WORDS =
  /\b(the|we|is|are|was|were|be|of|and|or|for|with|that|this|these|those|in|on|to|as|by|from|it|its|our|their|can|may|has|have|not|but|than|when|which)\b/i;

function looksLikeFormula(text: string): boolean {
  const body = text.replace(EQUATION_NUMBER, '');
  if (body.length < 3) return false;
  if (FUNCTION_WORDS.test(body)) return false;
  if (/[.!?]$/.test(body)) return false;
  const operators = (body.match(/[=+\-*/^_<>|∑∏∫√≈≤≥±×·≠∈∀∃]/gu) ?? []).length;
  if (operators === 0) return false;
  const letters = (body.match(/\p{L}/gu) ?? []).length;
  return letters / body.length < 0.6;
}

/** 先頭の章番号（"3.1 Ablation" → [3, 1]）。 */
function headingNumber(text: string): number[] | null {
  const match = /^(\d+(?:\.\d+)*)\.?\s+\p{Lu}/u.exec(text);
  if (!match) return null;
  return match[1]!.split('.').map((part) => Number.parseInt(part, 10));
}

function bareHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/^\d+(\.\d+)*\.?\s*/, '')
    .replace(/[^a-z ]/g, '')
    .trim();
}

interface PageStats {
  top: number;
  bottom: number;
  spacing: number;
}

/**
 * 行の役割を決める。
 *
 * - furniture … 柱・ノンブル・脚注・図表キャプション・参考文献・別行立ての数式
 * - heading   … 節見出し。本文の文として並べたくない
 * - body      … それ以外
 */
export function classifyLines(lines: Line[], pages: PageSize[]): ClassifiedLine[] {
  if (lines.length === 0) return [];

  const pageCount = pages.length > 0 ? pages.length : new Set(lines.map((l) => l.page)).size;
  const bodyHeight = bodyTextHeight(lines);

  // ページごとに上下端と行送りを取る。文書全体で 1 つにすると、用紙サイズが混在した
  // 文書（付録だけ縦長など）で、通常ページのフッターが「端」と判定されなくなる。
  const byPage = new Map<number, Line[]>();
  for (const line of lines) {
    const list = byPage.get(line.page);
    if (list) list.push(line);
    else byPage.set(line.page, [line]);
  }

  const stats = new Map<number, PageStats>();
  for (const [page, pageLines] of byPage) {
    const ys = pageLines.map((l) => l.y);
    const spacings: number[] = [];
    const sorted = [...pageLines].sort((a, b) => a.column - b.column || a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      const previous = sorted[i - 1]!;
      const line = sorted[i]!;
      if (previous.column !== line.column) continue;
      const gap = line.y - previous.y;
      if (gap > 0 && gap < 100) spacings.push(gap);
    }
    stats.set(page, {
      top: Math.min(...ys),
      bottom: Math.max(...ys),
      spacing: median(spacings) || bodyHeight * 1.3,
    });
  }

  // 段ごとの代表的な行幅。最大値だと全幅キャプションが 1 行あるだけで閾値が跳ね上がり、
  // 本文行がすべて「短い行」になって見出しに化ける。上位 10% の位置を使う。
  const widthsByColumn = new Map<string, number[]>();
  for (const line of lines) {
    const key = `${line.page}:${line.column}`;
    const list = widthsByColumn.get(key);
    if (list) list.push(line.right - line.left);
    else widthsByColumn.set(key, [line.right - line.left]);
  }
  const columnWidth = new Map<string, number>();
  for (const [key, widths] of widthsByColumn) columnWidth.set(key, percentile(widths, 0.1));

  // 柱・ノンブルの候補: ページ内で最初か最後の行で、隣の行との間隔が広いもの。
  const edgeCandidate = new Set<number>();
  for (const [page, pageLines] of byPage) {
    const spacing = stats.get(page)!.spacing;
    const sorted = [...pageLines].sort((a, b) => a.y - b.y);
    const first = sorted[0];
    const second = sorted[1];
    const last = sorted[sorted.length - 1];
    const secondLast = sorted[sorted.length - 2];
    if (first && (!second || second.y - first.y > spacing * 1.2)) edgeCandidate.add(first.index);
    if (last && (!secondLast || last.y - secondLast.y > spacing * 1.2)) edgeCandidate.add(last.index);
  }

  const repeated = new Map<string, Set<number>>();
  for (const line of lines) {
    if (!edgeCandidate.has(line.index)) continue;
    const key = line.text.replace(/\d+/g, '#');
    if (key.length === 0 || key.length > 120) continue;
    const seen = repeated.get(key);
    if (seen) seen.add(line.page);
    else repeated.set(key, new Set([line.page]));
  }

  // 脚注: 段の下端に続く、本文より小さい文字の塊。
  const footnote = new Set<number>();
  const byColumn = new Map<string, Line[]>();
  for (const line of lines) {
    const key = `${line.page}:${line.column}`;
    const list = byColumn.get(key);
    if (list) list.push(line);
    else byColumn.set(key, [line]);
  }
  for (const columnLines of byColumn.values()) {
    const sorted = [...columnLines].sort((a, b) => a.y - b.y);
    for (let i = sorted.length - 1; i >= 0; i--) {
      const line = sorted[i]!;
      // ノンブルなど、既に端の候補になっているものは飛ばして下から遡る。
      if (i === sorted.length - 1 && edgeCandidate.has(line.index)) continue;
      if (line.height < bodyHeight * 0.88) {
        footnote.add(line.index);
        continue;
      }
      break;
    }
  }

  // 参考文献より後ろは本文にしない。
  let tailFrom = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (TAIL_HEADINGS.has(bareHeading(line.text)) && line.text.length <= 40) {
      tailFrom = line.index;
      break;
    }
  }

  // 見出し番号の連番を追う。箇条書きは段落ごとに 1 に戻るので、単調性が手掛かりになる。
  let lastTopNumber = 0;
  const monotonic = new Set<number>();
  for (const line of [...lines].sort((a, b) => a.index - b.index)) {
    const numbers = headingNumber(line.text);
    if (!numbers) continue;
    const top = numbers[0]!;
    if (numbers.length > 1 ? top === lastTopNumber : top === lastTopNumber + 1) {
      monotonic.add(line.index);
      if (numbers.length === 1) lastTopNumber = top;
    }
  }

  // 同じ段の直前の行。段落の途中かどうかの判定に使う。
  const previousByColumn = new Map<string, Line>();
  const previousLine = new Map<number, Line | undefined>();
  for (const line of [...lines].sort((a, b) => a.index - b.index)) {
    const key = `${line.page}:${line.column}`;
    previousLine.set(line.index, previousByColumn.get(key));
    previousByColumn.set(key, line);
  }

  return lines.map((line) => {
    const pageStats = stats.get(line.page)!;
    const span = Math.max(1, pageStats.bottom - pageStats.top);
    const relative = (line.y - pageStats.top) / span;
    const nearEdge = relative <= 0.15 || relative >= 0.85;
    const key = line.text.replace(/\d+/g, '#');
    const seenOn = repeated.get(key)?.size ?? 0;

    if (line.index > tailFrom) return { ...line, role: 'furniture' as const };
    if (footnote.has(line.index)) return { ...line, role: 'furniture' as const };
    if (isCaption(line.text) || REFERENCE_ENTRY.test(line.text)) {
      return { ...line, role: 'furniture' as const };
    }
    // 複数ページで同じ柱が出ていれば付物。1 ページだけの文書では判定できない。
    if (nearEdge && edgeCandidate.has(line.index) && pageCount >= 2 && seenOn >= 2) {
      return { ...line, role: 'furniture' as const };
    }
    // 端に出る数字だけの行はノンブル。1 ページでも落としてよい。
    if (nearEdge && /^\d{1,4}$/.test(line.text)) {
      return { ...line, role: 'furniture' as const };
    }

    const width = columnWidth.get(`${line.page}:${line.column}`) ?? line.right - line.left;
    // 式番号ぶんを差し引いた実効幅で「短さ」を測る。右端の "(3)" のせいで
    // 数式行が段幅いっぱいになり、数式として落とせていなかった。
    const stripped = line.text.replace(EQUATION_NUMBER, '');
    const effectiveWidth =
      line.text.length === 0 ? 0 : ((line.right - line.left) * stripped.length) / line.text.length;
    const isShort = width > 0 && effectiveWidth < width * 0.7;
    const endsOpen = !/[.!?:;,]$/.test(line.text);

    if (isShort && looksLikeFormula(line.text)) {
      return { ...line, role: 'furniture' as const };
    }

    // 見出しは弱い手掛かりの合算で決める。単独の規則には必ず反例がある
    // （番号だけを見ると箇条書きが見出しになり、文字高だけを見ると
    //  参考文献の多い論文で本文が見出しになる）。
    if (isShort && endsOpen && line.text.length <= 80) {
      const previous = previousLine.get(line.index);
      let score = 0;
      if (KNOWN_HEADINGS.has(bareHeading(line.text))) score += 2;
      if (line.height > bodyHeight * 1.12) score += 1;
      if (monotonic.has(line.index)) score += 1;
      if (previous && line.y - previous.y > pageStats.spacing * 1.4) score += 1;
      // 直前が文として閉じていなければ段落の途中。見出しではなく箇条書きの可能性が高い。
      if (previous && !/[.!?]$/.test(previous.text)) score -= 1;
      if (score >= 2) return { ...line, role: 'heading' as const };
    }

    return { ...line, role: 'body' as const };
  });
}
