import type { NonBodyKind, PageSize } from './types.ts';
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
  /**
   * `role === 'furniture'` のとき、なぜ本文として扱わなかったか。
   *
   * 落とした行は捨てずに画面へ出す（PDF に見えているのに右に無い、という
   * 説明のつかない状態を作らない）。そのとき「（訳さない：参考文献）」のように
   * 理由を言えるよう、判定した場所でそのまま種類を持たせる。
   */
  kind?: NonBodyKind;
  /**
   * その行が付物の**かたまりの先頭**か（キャプションの 1 行目、参考文献の 1 エントリ目）。
   *
   * 続きの行と区別が付かないと、参考文献 3 件が 1 件に束ねられて画面に出る。
   * 先頭かどうかは、ここで使っている正規表現（`isCaption` / `REFERENCE_ENTRY`）を
   * 知っている側でしか決められないので、判定した場所で持たせる。
   */
  startsBlock?: boolean;
}

const BIN_WIDTH = 2;
/**
 * 段の切れ目と認める空白帯の最小幅を、**そのページの字送り**の何倍で測るか。
 *
 * ここを絶対値（12pt）で決めていたときは、`\documentclass[twocolumn]{article}` の
 * 既定（`\columnsep` = 10pt）がそのまま閾値を下回り、段組の検出が丸ごと失敗していた。
 * 実測（pdflatex で組んだ同一原稿の、柱間だけ変えた版）: 柱間 10pt では 56 文中
 * 26 文が左右の段の連結で破壊され、文書が文の途中で途切れていた。14pt なら 0 件。
 * 合成 PDF（両端揃え・柱間 10pt）でも再現率は 15% まで落ちる。
 * arXiv のプレプリントは既定値のまま出すことが多いので、実害が大きい。
 *
 * かといって絶対値を下げるだけでは、1 段組の論文で語間の空白が縦に揃った帯を
 * 段の切れ目と誤検出する。だから絶対値ではなく**字送りとの比**で決める。
 * 語間は字送りの 0.3 倍前後で、両端揃えで伸びても 1 倍には届かない。
 * 一方、柱間 10pt は字送り 4.4pt の 2.3 倍ある（実測値、10pt 本文の論文）。
 * ビンの粒度のぶん帯は最大 2 ビンぶん狭く出る（10pt の柱間が 8pt の帯に見える）ので、
 * 実効の比は 1.8 倍。1.5 倍を下限にすれば両方が成り立つ。
 */
const MIN_GUTTER_ADVANCES = 1.5;
/** 字送りが測れないページ（図版だけのページなど）で使う下限（pt）。 */
const MIN_GUTTER_FLOOR = 5;
/** 段として認めるための最小幅（文字のある幅に対する比）。 */
const MIN_COLUMN_RATIO = 0.12;
/**
 * 段として認めるための最小の幅を、字送りの何倍（＝およそ何文字ぶん）で測るか。
 *
 * ページ全体に対する比（MIN_COLUMN_RATIO）だけでは、幅の狭い版面で
 * 「6 文字ぶんの段」が通ってしまう。空白帯の下限を字送りとの比にすると、
 * この歯止めが無い限り**1 行の中の語間**がそのまま段の切れ目に化ける
 * （実測: 「同一行の矩形は 1 つにまとまる」回帰テストで、1 行が 3 段に割られて
 *  ハイライトの矩形が 3 つになった）。
 *
 * 段とは「running text が何行も積まれる帯」なので、1 行に十数文字は入る。
 * 実測の下限は、2 段組の論文で 55 文字・3 段組で 38 文字ぶんの幅。
 */
const MIN_COLUMN_CHARS = 15;

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
 * 1 文字あたりの送り幅（pt）。文字の大きさと書体の太さが一緒に効くので、
 * 「このページで空白 1 個ぶんはどれくらいか」の物差しになる。
 *
 * 3 文字以下の断片は数えない。合字・記号・上付きの 1 文字片は幅が歪んでいて、
 * 中央値をそちらへ引っ張る。
 */
function charAdvance(chunks: TextChunk[]): number {
  const advances: number[] = [];
  for (const chunk of chunks) {
    if (chunk.text.length < 4 || chunk.w <= 0) continue;
    advances.push(chunk.w / chunk.text.length);
  }
  return median(advances);
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

  // 空白帯の下限は、絶対値ではなくこのページの字送りとの比で決める（定数の説明を参照）。
  const minGutter = Math.max(MIN_GUTTER_FLOOR, charAdvance(chunks) * MIN_GUTTER_ADVANCES);

  const gutters: ColumnRange[] = [];
  let runStart: number | null = null;
  for (let bin = 0; bin < binCount; bin++) {
    const empty = rowsPerBin[bin]!.size <= emptyThreshold;
    if (empty && runStart === null) runStart = bin;
    if (!empty && runStart !== null) {
      const from = minX + runStart * BIN_WIDTH;
      const to = minX + bin * BIN_WIDTH;
      if (to - from >= minGutter) gutters.push({ from, to });
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

  // どの段も、1 行ぶんの文章が入る幅を持っているか。
  // 数文字ぶんしかない「段」は、段ではなく行の中の語間。
  const minColumnWidth = charAdvance(chunks) * MIN_COLUMN_CHARS;
  if (boundaries.some((range) => range.to - range.from < minColumnWidth)) return SINGLE_COLUMN;

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

    /**
     * 段を跨ぐ行（表題・著者行・段抜きの図表キャプション・幅の広い数式）を先に分ける。
     *
     * 重なりが最大の段へ入れると、ほぼ左右対称なぶん必ず**右の段**が勝つ。
     * すると表題がページの左段をすべて読み終えた後に現れ、右段の 1 文目と
     * 1 つの文に癒着する。ページを「段抜きの行」で横帯に割り、
     * 帯 → 段 → y の順に読めば、紙の上の見え方と一致する。
     */
    const gutters: { from: number; to: number }[] = [];
    for (let i = 0; i + 1 < columns.length; i++) {
      const from = columns[i]!.to;
      const to = columns[i + 1]!.from;
      if (Number.isFinite(from) && Number.isFinite(to) && to > from) gutters.push({ from, to });
    }
    const spansGutter = (chunk: TextChunk): boolean =>
      gutters.some((gutter) => chunk.x <= gutter.from + 1 && chunk.x + chunk.w >= gutter.to - 1);

    const fullWidth = pageChunks.filter(spansGutter).sort((a, b) => a.y - b.y || a.x - b.x);
    const inColumns = pageChunks.filter((chunk) => !spansGutter(chunk));

    // 段抜きの行の y。これが帯の境目になる。
    const bandBreaks: number[] = [];
    for (const chunk of fullWidth) {
      const last = bandBreaks[bandBreaks.length - 1];
      if (last === undefined || Math.abs(chunk.y - last) > Math.max(2, chunk.h * 0.6)) bandBreaks.push(chunk.y);
    }
    const bandOf = (y: number): number => bandBreaks.filter((breakY) => breakY <= y + 0.5).length;

    const groupIntoLines = (list: TextChunk[], columnIndex: number): void => {
      list.sort((a, b) => a.y - b.y || a.x - b.x);
      let current: Line | null = null;
      for (const chunk of list) {
        // 許容量は小さい方の文字高で測る。大きい見出しの許容量で測ると、
        // その少し上に浮いている小さな柱まで同じ行に吸い込んでしまう。
        const tolerance = Math.max(2, Math.min(chunk.h, current?.height ?? chunk.h) * 0.6);
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
    };

    // どの段にも入らない文字片を作らない。重なりが最大の段へ必ず割り当てる。
    const buckets: TextChunk[][] = columns.map(() => []);
    for (const chunk of inColumns) {
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

    for (let band = 0; band <= bandBreaks.length; band++) {
      if (band > 0) {
        // 帯の頭にある段抜きの行。段より先に読む。
        groupIntoLines(
          fullWidth.filter((chunk) => bandOf(chunk.y) === band && Math.abs(chunk.y - bandBreaks[band - 1]!) <= Math.max(2, chunk.h * 0.6)),
          -1,
        );
      }
      buckets.forEach((inColumn, columnIndex) => {
        groupIntoLines(
          inColumn.filter((chunk) => bandOf(chunk.y) === band),
          columnIndex,
        );
      });
    }
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

/**
 * 参考文献の 1 エントリ。`1. Author` の形は章見出しと区別できないので入れない。
 *
 * `(1)` の形も入れない。本文の箇条書き（"(1) We introduce a new kernel."）が
 * まるごと消えていた。`[12]` の形も、参考文献らしい手掛かり（西暦・掲載誌・
 * ページ番号）が同じ行にあるときだけ furniture にする。無条件に落とすと、
 * "[12] Recent work extends it to long documents." のような本文が消える。
 */
const REFERENCE_ENTRY = /^\[\d+\]\s*\p{Lu}/u;
const REFERENCE_SHAPE = /\b(?:19|20)\d{2}\b|\bIn\s+Proc|\barXiv|\bJournal\b|\bpp?\.\s*\d|\bpages?\s+\d|\d+\(\d+\):\d/;

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

  // 段ごとの代表的な右端。幅と同じ理由で最大値は使わない（全幅の 1 行に引きずられる）。
  const rightsByColumn = new Map<string, number[]>();
  for (const line of lines) {
    const key = `${line.page}:${line.column}`;
    const list = rightsByColumn.get(key);
    if (list) list.push(line.right);
    else rightsByColumn.set(key, [line.right]);
  }
  const columnRight = new Map<string, number>();
  for (const [key, rights] of rightsByColumn) columnRight.set(key, percentile(rights, 0.05));

  // 段ごとの代表的な左端。ここは中央値でよい。段落の 1 行目の字下げ（1〜2 em）や
  // 中央寄せの数式が混ざっても、本文行が多数派なので段の左端に落ち着く。
  // 最小値だと、はみ出した 1 行（行番号・記号）に引きずられる。
  const leftsByColumn = new Map<string, number[]>();
  for (const line of lines) {
    const key = `${line.page}:${line.column}`;
    const list = leftsByColumn.get(key);
    if (list) list.push(line.left);
    else leftsByColumn.set(key, [line.left]);
  }
  const columnLeft = new Map<string, number>();
  for (const [key, lefts] of leftsByColumn) columnLeft.set(key, median(lefts));

  /**
   * その行が段の右端まで届いているか。
   *
   * 届いている＝組版の都合で折り返しただけで、段落はまだ続いている。
   * 届いていない＝段落の最終行。欧文の組版では、段落の最後の行だけが右を余らせる
   * （TeX の \parfillskip）ので、文末記号より信用できる手掛かりになる。
   */
  const reachesRight = (line: Line): boolean => {
    const key = `${line.page}:${line.column}`;
    const right = columnRight.get(key);
    const width = columnWidth.get(key);
    if (right === undefined || width === undefined || width <= 0) return false;
    // 許容量は段幅に対する比。字送りの端数や行末の約物で数 pt はずれる。
    // ここを緩めると、両端揃えでない組版（草稿・プレプリント）で
    // 段落の最終行まで「右端に届いた」ことになり、塊が次の見出しまで伸びる。
    return line.right >= right - Math.max(2, width * 0.03);
  };

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

  // 同じ段の直前の行。段落の途中かどうかの判定に使う。
  const previousByColumn = new Map<string, Line>();
  const previousLine = new Map<number, Line | undefined>();
  for (const line of [...lines].sort((a, b) => a.index - b.index)) {
    const key = `${line.page}:${line.column}`;
    previousLine.set(line.index, previousByColumn.get(key));
    previousByColumn.set(key, line);
  }

  /**
   * その行が「直前の行の続き」か。
   *
   * 同じ段のすぐ上の行が、段の右端まで届いたまま文として閉じずに終わっていて、
   * 行送りも普通のまま、という状態。組版で折り返しただけの行なので、
   * ここに図表キャプションや参考文献の 1 エントリが**始まることはない**。
   *
   * これが無いと、本文が図表を参照する普通の書き方
   * （"… We then report results in Table 3. Our block-sparse kernel …"）で、
   * 折り返しの都合で `Table 3.` が行頭に来た瞬間にキャプションと誤認され、
   * 続きの行まで巻き込んで本文が消えていた。実測（pdflatex の 2 段組）で
   * 本文 3 行が丸ごと落ち、6 文が破壊、うち 1 文は出力から完全に消失していた。
   */
  const continuesParagraph = (line: Line): boolean => {
    const previous = previousLine.get(line.index);
    if (previous === undefined) return false;
    const spacing = stats.get(line.page)?.spacing ?? bodyHeight * 1.3;
    if (line.y - previous.y > spacing * 1.3) return false;
    // 右端に届いていない行は段落の最終行。そのあとにキャプションが来るのは普通。
    if (!reachesRight(previous)) return false;
    return !/[.!?]$/.test(previous.text);
  };

  /** 図表キャプションの**先頭行**か。段落の途中に現れた参照は除く。 */
  const startsCaption = (line: Line): boolean => isCaption(line.text) && !continuesParagraph(line);

  /** 参考文献の 1 エントリの**先頭行**か。こちらも段落の途中には現れない。 */
  const startsReference = (line: Line): boolean =>
    REFERENCE_ENTRY.test(line.text) && REFERENCE_SHAPE.test(line.text) && !continuesParagraph(line);

  /**
   * キャプションと参考文献の**続きの行**も付物にする。
   *
   * 段が狭いほどキャプションは折り返す。先頭行しか落とせていないと、
   * 「pipeline.」のような残骸が本文の文として並び、対訳の相手がいないカードになる。
   *
   * 塊の終わりは**版面**で決める。以前は `open = !/[.!?]$/` だけで見ていたので、
   * `Figure 1: Block-sparse attention pattern learned on PubMed.` のように
   * 先頭行が文末で終わるキャプションはそこで閉じ、残りの
   * `Darker cells are retained.` が本文の文として節と節の間に挿し込まれていた。
   * キャプションは 2 文以上あるのが普通なので、これは珍しい形ではない。
   *
   * 代わりに「右端まで届いている行は段落の途中」とみなす。閉じるのは
   * 段の右端に届かない行＝段落の最終行のときだけ。終端記号は、右端に届かない行が
   * 本当に文として閉じているかの**補強**としてだけ使う（途中で折り返した行が
   * たまたま右を余らせても、文が閉じていなければ塊は続く）。
   * 続きかどうかは、さらに同じページ・同じ段・行送り・文字の大きさでも絞る。
   */
  const continuation = new Set<number>();
  /** 続きの行が、どの塊（キャプション / 参考文献）の続きなのか。 */
  const continuationKind = new Map<number, NonBodyKind>();
  {
    const ordered = [...lines].sort((a, b) => a.index - b.index);
    /** 塊がまだ続いているか。 */
    let open = false;
    /** 塊の先頭行の文字高。見出しや本文に化けた行で塊が伸びるのを止めるために持つ。 */
    let blockHeight = 0;
    let blockKind: NonBodyKind = 'caption';
    let previous: Line | undefined;
    const stillOpen = (line: Line): boolean => reachesRight(line) || !/[.!?]$/.test(line.text);
    for (const line of ordered) {
      const starts = startsCaption(line) || startsReference(line);
      const spacing = stats.get(line.page)?.spacing ?? 13;
      const adjacent =
        previous !== undefined &&
        previous.page === line.page &&
        previous.column === line.column &&
        line.y - previous.y <= spacing * 1.6 &&
        // 文字の大きさが変わったら別の要素（見出し・本文）。キャプションの続きは同じ大きさで組まれる。
        Math.abs(line.height - blockHeight) <= Math.max(0.5, blockHeight * 0.08);
      if (starts) {
        blockHeight = line.height;
        blockKind = startsCaption(line) ? 'caption' : 'reference';
        open = stillOpen(line);
      } else if (open && adjacent) {
        continuation.add(line.index);
        continuationKind.set(line.index, blockKind);
        open = stillOpen(line);
      } else {
        open = false;
      }
      previous = line;
    }
  }

  /**
   * 別行立ての表と数式を見つける。
   *
   * 実物の論文では、これらが**本文の文の途中**に挟まる:
   *   `Information retrieval benefits from ★Model Acc F1 Dense 81.2 79.4★ the same sparsity …`
   *   `The attention weights are computed as ★y = softmax(QK⊤/d)V (1)★ The state-of-the-art …`
   * 文字だけを見る `looksLikeFormula` では落ちない — 表のセルに演算子は無いし、
   * `y = softmax(QK⊤/d)V` は英字比率 0.63 で「英字比率 0.6 未満」の門を通り抜ける
   * （実物の pdflatex 出力で実測）。合成 PDF が数式・表を段落の切れ目に置いていたため、
   * この壊れ方は計測の網にも掛かっていなかった。
   *
   * 版面を見れば別物だと分かる。本文は段の左端から右端まで組まれるが、
   * 別行立ての要素は中央へ寄せて組まれ、右端にも届かない。
   * 判定は次の 3 つを**全部**満たしたときだけにする。どれか 1 つでは本文を落とす
   * （字下げだけを見ると箇条書きが、短さだけを見ると段落の最終行が消える）。
   *
   *   1. 段の左端から明らかに右へ入っている（段落の字下げ 1〜2 em では届かない幅）
   *   2. 段の右端に届かない（右にぶら下がる式番号のぶんは差し引いて測る）
   *   3. 機能語も文末記号も持たない（"the" や "of" が 1 つでもあれば本文）
   */
  const displayBlock = new Set<number>();
  {
    const isDisplay = (line: Line): boolean => {
      const key = `${line.page}:${line.column}`;
      const width = columnWidth.get(key) ?? 0;
      const left = columnLeft.get(key);
      if (width <= 0 || left === undefined || line.text.length === 0) return false;
      // 見出しは中央寄せで組まれることがある。ここでは扱わず、見出しの判定に任せる。
      if (KNOWN_HEADINGS.has(bareHeading(line.text)) || headingNumber(line.text) !== null) return false;
      const stripped = line.text.replace(EQUATION_NUMBER, '').trim();
      if (stripped.length === 0) return false;
      if (FUNCTION_WORDS.test(stripped)) return false;
      if (/[.!?]$/.test(stripped)) return false;
      if (line.left - left <= Math.max(bodyHeight * 1.5, width * 0.08)) return false;
      // 幅は式番号を除いた実効幅で測る。右端にぶら下がる "(1)" のせいで、
      // 別行立ての数式が段幅いっぱいに見えてしまう。
      const effective = ((line.right - line.left) * stripped.length) / line.text.length;
      return effective < width * 0.7;
    };
    for (const line of lines) if (isDisplay(line)) displayBlock.add(line.index);

    // 表は複数行でひとかたまり。1 行でも見つかったら、同じ左端で続く行もまとめて外す。
    // 行ごとに独立して判定すると、セルに "of" のような語が入っている行だけ本文に残り、
    // かえって読みにくい断片が対訳に並ぶ。
    const ordered = [...lines].sort((a, b) => a.index - b.index);
    for (let i = 0; i < ordered.length; i++) {
      const anchor = ordered[i]!;
      if (!isDisplay(anchor)) continue;
      const spacing = stats.get(anchor.page)?.spacing ?? bodyHeight * 1.3;
      for (const step of [-1, 1]) {
        let previous = anchor;
        for (let j = i + step; j >= 0 && j < ordered.length; j += step) {
          const line = ordered[j]!;
          if (line.page !== anchor.page || line.column !== anchor.column) break;
          if (Math.abs(line.y - previous.y) > spacing * 1.6) break;
          // 本文行は段の左端に揃うので、字下げの揃った行だけが表の続きになりうる。
          if (Math.abs(line.left - anchor.left) > 2) break;
          displayBlock.add(line.index);
          previous = line;
        }
      }
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

  /**
   * 前付（表題・著者・所属）の終わり。1 ページ目で最初に節見出しらしい行が来るところ。
   *
   * 著者行は「段の中で中央へ寄っていて、機能語も文末記号も無い」ので、
   * 版面の規則では表のセルと見分けが付かない。位置を見れば前付だと分かるので、
   * ここだけは種類を読み手の見え方に合わせる。
   */
  let frontMatterUntil = 0;
  for (const line of [...lines].sort((a, b) => a.index - b.index)) {
    if (line.page !== 1) break;
    if (KNOWN_HEADINGS.has(bareHeading(line.text)) || headingNumber(line.text) !== null) {
      frontMatterUntil = line.index;
      break;
    }
  }

  return lines.map((line) => {
    const pageStats = stats.get(line.page)!;
    const span = Math.max(1, pageStats.bottom - pageStats.top);
    const relative = (line.y - pageStats.top) / span;
    const nearEdge = relative <= 0.15 || relative >= 0.85;
    const key = line.text.replace(/\d+/g, '#');
    const seenOn = repeated.get(key)?.size ?? 0;

    /** 付物として落とす。種類は画面が「なぜ右に無いか」を言うために持たせる。 */
    const drop = (kind: NonBodyKind): ClassifiedLine => ({
      ...line,
      role: 'furniture' as const,
      // 参考文献の各エントリと各キャプションは、続きの行と束ねずに 1 件ずつ出す。
      startsBlock: isCaption(line.text) || REFERENCE_ENTRY.test(line.text),
      // 版面の規則でしか落ちなかった行（表・数式・その他）が前付の位置にあるなら、
      // それは著者行や所属。柱・ノンブル・キャプション・参考文献は、
      // 1 ページ目にあっても種類がはっきりしているのでそのままにする。
      kind:
        line.index < frontMatterUntil && (kind === 'table' || kind === 'formula' || kind === 'other')
          ? 'frontMatter'
          : kind,
    });

    // ノンブルは、参考文献の後ろにあっても柱として繰り返されていても、読み手には
    // ノンブル。位置と形で先に決めてしまう（種類が版面の都合で入れ替わらないように）。
    const isPageNumber = nearEdge && /^\d{1,4}$/.test(line.text);

    if (line.index > tailFrom) return drop(isPageNumber ? 'pageNumber' : 'reference');
    if (footnote.has(line.index)) return drop('footnote');
    if (continuation.has(line.index)) return drop(continuationKind.get(line.index) ?? 'caption');
    if (startsCaption(line)) return drop('caption');
    if (startsReference(line)) return drop('reference');
    // 複数ページで同じ柱が出ていれば付物。1 ページだけの文書では判定できない。
    if (nearEdge && edgeCandidate.has(line.index) && pageCount >= 2 && seenOn >= 2) {
      return drop(isPageNumber ? 'pageNumber' : 'runningHead');
    }
    // 端に出る数字だけの行はノンブル。1 ページでも落としてよい。
    if (isPageNumber) {
      return drop('pageNumber');
    }

    const width = columnWidth.get(`${line.page}:${line.column}`) ?? line.right - line.left;
    // 式番号ぶんを差し引いた実効幅で「短さ」を測る。右端の "(3)" のせいで
    // 数式行が段幅いっぱいになり、数式として落とせていなかった。
    const stripped = line.text.replace(EQUATION_NUMBER, '');
    const effectiveWidth =
      line.text.length === 0 ? 0 : ((line.right - line.left) * stripped.length) / line.text.length;
    const isShort = width > 0 && effectiveWidth < width * 0.7;
    const endsOpen = !/[.!?:;,]$/.test(line.text);

    // 数式は幅で門を作らない。段が狭いほど数式は段幅いっぱいになるので、
    // 「短いこと」を条件にすると 3 段組で軒並み本文に混ざり、しかも終端記号が
    // 無いので次の文と 1 枚のカードに同居する。
    // looksLikeFormula 自体が「機能語なし・終端記号なし・演算子あり・
    // 英字比率 0.6 未満」の 4 条件なので、これ単体で十分に厳しい。
    if (looksLikeFormula(line.text)) {
      return drop('formula');
    }

    // 別行立ての表・数式（版面で判定したもの）。
    // 演算子があれば数式、無ければ表のセルとして扱う。ここは見た目だけでは
    // 決められないので、外れることがある前提の弱い区別。
    if (displayBlock.has(line.index)) {
      return drop(/[=+\-*/^_<>|∑∏∫√≈≤≥±×·≠∈∀∃]/u.test(stripped) ? 'formula' : 'table');
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

/**
 * 表題らしい行を 1 ページ目から拾う。
 *
 * 簡易解析では題名が取れないので、これまでは本文 1 文目をそのまま題名にしていた。
 * ところが論文の 1 文目は「表題＋著者名」がひとつながりになった行で、
 * `Block Sparse Attention for Long Documents Jane Q. Doe, Alan R. Roe, and Mei Tanaka`
 * が一覧にもヘッダーにも「Claude にこう言う」のコピー文にも出ていた。
 *
 * 論文の表題は、1 ページ目のいちばん大きな文字で、いちばん上にある。
 * 著者名は必ずそれより小さい。だから「最大の文字高を持つ行のかたまり」を
 * 上から取れば、著者名は自然に落ちる。判断できないときは null を返し、
 * 呼び出し側の従来のやり方に任せる（間違った題名を自信ありげに出すよりよい）。
 */
export function guessTitleFromChunks(chunks: TextChunk[]): string | null {
  const firstPage = chunks.filter((chunk) => chunk.page === 1);
  if (firstPage.length === 0) return null;

  const lines = buildLines(firstPage).sort((a, b) => a.y - b.y);
  if (lines.length === 0) return null;

  // 本文の文字高（＝最頻値ではなく中央値。表題や見出しに引きずられない）。
  const body = median(lines.map((line) => line.height));
  if (body <= 0) return null;

  const largest = Math.max(...lines.map((line) => line.height));
  // 本文と同じ大きさしか無いページでは、表題を見分けられない。
  if (largest < body * 1.15) return null;

  const TOLERANCE = 0.9;
  const parts: string[] = [];
  for (const line of lines) {
    if (line.height >= largest * TOLERANCE) {
      parts.push(line.text.trim());
      continue;
    }
    // いちど表題が始まったら、小さい行が来た時点で終わり（そこから先は著者名）。
    if (parts.length > 0) break;
  }

  const title = parts.join(' ').replace(/\s+/g, ' ').trim();
  // 短すぎるもの（柱やページ番号）と、長すぎるもの（表題ではない何か）は使わない。
  if (title.length < 8 || title.length > 300) return null;
  return title;
}
