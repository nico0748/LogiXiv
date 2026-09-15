import type { NonBodyKind, PageSize, StructureQuality } from './types.ts';
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
    const crossesGutter = (chunk: TextChunk): boolean =>
      gutters.some((gutter) => chunk.x <= gutter.from + 1 && chunk.x + chunk.w >= gutter.to - 1);

    /**
     * 段抜きかどうかは、文字片ごとではなく**行ごと**に決める。
     *
     * pdf.js は 1 行を 1 個の文字片で返すとは限らない。両端揃えで語間が伸びた箇所、
     * 書体の切り替わり（インライン数式・`\texttt`）、脚注記号の前後で切れる。
     * 段抜きの行がそうして割れると、段間をまたぐ断片だけが「段抜き」に、
     * 残りの断片は「段の中の行」に振り分けられる。読み順は帯（段抜き）→ 段の順なので、
     * 行の左半分が右半分より**後ろ**に回り、1 つの文の中で語が入れ替わる。
     *
     * 実測（pdflatex の 2 段組・段抜きアブストラクト、インライン数式あり）:
     *   "… reused for both Training with the sparse kernel from scratch … training and inference."
     * ここで期待される 2 文は "The kernel is implemented once and reused for both training
     * and inference." と "Training with the sparse kernel from scratch …"。
     * `fix_sentence_boundary` は結合と文字位置での分割しかできないので、
     * こうして語単位で噛み合った文字列は道具の中では二度と戻せない。
     *
     * 同じ y に並ぶ文字片のうち 1 つでも段間をまたいでいれば、その行は紙の上で
     * 段抜きの行。行に属する文字片を全部まとめて段抜き扱いにする。
     * 本物の 2 段組の行は左右が段間で切れているので、またぐ文字片は 1 つも無い。
     */
    const fullWidthRows = new Set<number>();
    for (const chunk of pageChunks) if (crossesGutter(chunk)) fullWidthRows.add(rowKey(chunk));
    const spansGutter = (chunk: TextChunk): boolean => fullWidthRows.has(rowKey(chunk));

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
 * 付録の始まりらしい見出しか。
 *
 * LaTeX の `\appendix` は章番号を英字に切り替えるので、付録の見出しは
 * "A Additional Sweeps" / "B Implementation Notes" / "Appendix A Proofs" の形で出る。
 * 数字だけを見る `headingNumber` では拾えない。
 *
 * 参考文献のエントリ（"M. Tanaka. Block structured kernels. In Proc. ICML, 2023."）と
 * 見分ける決め手は、**英字の直後にピリオドが無いこと**。人名のイニシャルには必ず点が付く。
 * 念のため、西暦や掲載誌のような参考文献らしい手掛かりがある行も外す。
 */
function isAppendixHeading(text: string): boolean {
  if (text.length > 60) return false;
  if (REFERENCE_SHAPE.test(text)) return false;
  const bare = bareHeading(text);
  if (bare === 'appendix' || bare === 'appendices') return true;
  return /^(?:Appendix\s+)?[A-Z](?:\.\d+)*\s+\p{Lu}/u.test(text);
}

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

/**
 * 擬似コードの行番号（`algorithmic` / `algpseudocode` が付ける "1:" "2:" …）。
 *
 * 版面だけでは擬似コードを本文と切り分けられない。実測（`algorithm` + `algpseudocode`、
 * 段の中に固定したフロート）で、演算子を含む 1〜4 行目は数式として落ちるのに、
 * `5: end for` と `6: return M` だけが本文に残り、しかも文書の先頭に来るので
 * `\title` の無い PDF では**それが題名**になっていた（一覧にもタブにも `5: end for 6: return M`）。
 *
 * 論文の本文が "12: " のような形で始まることは無いので、この形自体が十分に強い手掛かり。
 * それでも 1 行だけで判断せず、同じ段で隣り合う行にも同じ形があることを求める
 * （擬似コードは必ず複数行あり、偶然の一致はここで消える）。
 */
const PSEUDOCODE_LINE = /^\d{1,3}:\s/;

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

  /**
   * 柱・ノンブルの候補: ページの上端か下端にあって、次の行との間隔が広いもの。
   *
   * 「端の 1 行」ではなく「端に並ぶ**帯**」で見る。fancyhdr の柱は
   * `\fancyhead[L]{…}` と `\fancyhead[R]{…}` が同じ y に左右で並ぶので、
   * 1 行目だけを見ると「すぐ下（＝同じ y）に行がある」ことになり、
   * 間隔が 0 と評価されて柱が柱と判定されない。
   * 実測（pdflatex + fancyhdr の 2 段組）で "Preprint. Under review." が本文に混ざり、
   * ページをまたぐ文が 2 つ、柱を挟んで真っ二つに壊れていた。
   */
  const edgeCandidate = new Set<number>();
  const sameRow = (a: Line, b: Line): boolean =>
    Math.abs(a.y - b.y) <= Math.max(2, Math.min(a.height, b.height) * 0.6);
  for (const [page, pageLines] of byPage) {
    const spacing = stats.get(page)!.spacing;
    const sorted = [...pageLines].sort((a, b) => a.y - b.y);
    /** 端から数えて、同じ y に並ぶ行のかたまり。`step` が 1 なら上端、-1 なら下端。 */
    const edgeBand = (step: 1 | -1): Line[] => {
      const band: Line[] = [];
      for (let i = step === 1 ? 0 : sorted.length - 1; i >= 0 && i < sorted.length; i += step) {
        const line = sorted[i]!;
        if (band.length === 0 || sameRow(band[0]!, line)) band.push(line);
        else break;
      }
      return band;
    };
    for (const step of [1, -1] as const) {
      const band = edgeBand(step);
      if (band.length === 0) continue;
      const next = sorted[step === 1 ? band.length : sorted.length - 1 - band.length];
      if (next !== undefined && Math.abs(next.y - band[0]!.y) <= spacing * 1.2) continue;
      for (const line of band) edgeCandidate.add(line.index);
    }
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

  /**
   * 本文に紛れ込む脚注記号（肩付きの数字・記号）を外すための材料。
   *
   * pdf.js は肩付きの記号もただの文字片として返すので、`…in all remaining experiments.` の
   * 直後に `1` が続いた文字列になる。文の分割器は「終端記号の後ろに空白が要る」ので
   * ここで切れず、実測（pdflatex の 2 段組）では脚注の付いた文とその次の文が
   * 1 枚のカードに同居し、正解 2 文がまとめて取れなくなっていた。
   *
   * 「小さくて上に浮いた数字」だけを手掛かりにすると、本文中の指数（`O(n2)`）まで
   * 消してしまう。そこで**同じページの脚注の番号と一致すること**を条件に加える。
   * 脚注はすでに版面から検出できているので、対応する脚注が無い肩付き数字には手を触れない。
   */
  const footnoteMarks = new Map<number, Set<string>>();
  for (const line of lines) {
    if (!footnote.has(line.index)) continue;
    const mark = /^(\d{1,3}|[*†‡§¶]{1,3})/.exec(line.text)?.[1];
    if (mark === undefined) continue;
    const set = footnoteMarks.get(line.page);
    if (set) set.add(mark);
    else footnoteMarks.set(line.page, new Set([mark]));
  }

  /** 行から脚注記号の文字片を外した写しを返す。外すものが無ければ元の行をそのまま返す。 */
  const withoutFootnoteMarks = (line: Line): Line => {
    const marks = footnoteMarks.get(line.page);
    if (marks === undefined || line.chunks.length < 2) return line;
    const baseY = median(line.chunks.map((chunk) => chunk.y));
    const kept = line.chunks.filter((chunk, at) => {
      if (at === 0) return true; // 行頭の記号は脚注本文そのもの
      const text = chunk.text.trim();
      if (!marks.has(text)) return true;
      if (chunk.h >= line.height * 0.85) return true; // 小さくない＝本文の数字
      // 上へ浮いていなければ本文の一部。浮いていれば肩付きの記号なので外す。
      return chunk.y >= baseY - Math.max(0.3, line.height * 0.05);
    });
    if (kept.length === line.chunks.length) return line;
    return {
      ...line,
      chunks: kept,
      text: kept.map((chunk) => chunk.text).join('').replace(/\s+/g, ' ').trim(),
      left: Math.min(...kept.map((chunk) => chunk.x)),
      right: Math.max(...kept.map((chunk) => chunk.x + chunk.w)),
      height: median(kept.map((chunk) => chunk.h)),
    };
  };

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
          const gap = Math.abs(line.y - previous.y);
          if (gap > spacing * 1.6) break;
          /**
           * 別行立ての構成要素（分数の分子と分母、大きな括弧、行列の段）は、
           * 本文の行送りより明らかに**詰まって**積まれる。字下げは揃わないので、
           * 左端の一致だけを見ていると、真ん中の段（＝式の本体）だけが本文に残る。
           *
           * 実測（pdflatex の 2 段組、`\frac` を含む `equation`）: 分子 `QK⊤` と
           * 分母 `d` は落ちるのに、間の `Attention(Q, K,V ) = softmax √ V, (1)` だけが
           * 本文になり、次の文と 1 枚のカードに同居していた。
           * 段幅の 70% という「短さ」の門も、右にぶら下がる式番号のぶんで通り抜けている。
           */
          const stacked = gap < spacing * 0.8;
          // 本文行は段の左端に揃うので、字下げの揃った行だけが表の続きになりうる。
          if (!stacked && Math.abs(line.left - anchor.left) > 2) break;
          displayBlock.add(line.index);
          previous = line;
        }
      }
    }
  }

  // 擬似コードの行。同じ段で隣り合う行にも行番号があるものだけを塊として落とす。
  const pseudocode = new Set<number>();
  {
    const byIndex = new Map<number, Line>();
    for (const line of lines) if (PSEUDOCODE_LINE.test(line.text)) byIndex.set(line.index, line);
    for (const [index, line] of byIndex) {
      const neighbour = [byIndex.get(index - 1), byIndex.get(index + 1)].find(
        (other) => other !== undefined && other.page === line.page && other.column === line.column,
      );
      if (neighbour !== undefined) pseudocode.add(index);
    }
  }

  /**
   * 参考文献より後ろは本文にしない。ただし**付録が始まったら終わる**。
   *
   * 以前は「TAIL_HEADINGS に最初に当たった行より後ろは全部 reference」だった。
   * ML 系の論文は `\appendix` を `\end{thebibliography}` の後ろに置くのが普通なので、
   * これだと付録の本文が丸ごと `nonBody.kind='reference'` になり、
   * `structure.sentences` に 1 文も入らない。しかも進捗は「34 / 34 文」＝完了と出るので
   * 最後まで気づけず、「参考文献だから訳さない」という**嘘の理由**まで付く。
   * 実測（pdflatex、付録を参考文献の後ろに置いた 2 段組）で 8 文、
   * 1 段組の版で 3 文が、検索にも MCP にも届かない場所へ消えていた。
   */
  const inTail = new Set<number>();
  {
    let tail = false;
    for (const line of lines) {
      const bare = bareHeading(line.text);
      // 見出しらしい大きさか。参考文献の本文は本文より小さく組まれることがあるので、
      // 「本文と同じかそれ以上の大きさ」を見出しの最低条件にする。
      const headingLike = line.text.length <= 60 && line.height >= bodyHeight * 0.98;
      if (headingLike && TAIL_HEADINGS.has(bare) && line.text.length <= 40) {
        tail = true;
        continue; // 見出しの行そのものは従来どおり（見出しとして拾わせる）
      }
      // 付録・限界・倫理声明のような、参考文献の**後ろに置かれる本文**の始まり。
      if (tail && headingLike && (isAppendixHeading(line.text) || (KNOWN_HEADINGS.has(bare) && !TAIL_HEADINGS.has(bare)))) {
        tail = false;
        continue;
      }
      if (tail) inTail.add(line.index);
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

  /**
   * 前付そのもの（表題・著者・所属・連絡先）の行。
   *
   * 「最初の節見出しより前」だけでは広すぎる。`[t]` のフロートは 1 ページ目の段の頭に
   * 載るので、擬似コードや表のセルまでこの範囲に入ってしまう。
   * 前付は**ページの先頭から途切れずに続く**ので、1 ページ目の先頭から
   * 「文として閉じた行」が出るまでを前付とする。表題・著者・所属は文末記号で
   * 終わらないが、アブストラクトの各文は終わる — 見出しの無いアブストラクトを
   * 持つ論文で本文を丸ごと落とさないための歯止めでもある。
   */
  const frontMatterLines = new Set<number>();
  for (const line of lines) {
    if (line.page !== 1 || line.index >= frontMatterUntil) break;
    // 複数ページで繰り返される柱とノンブルは版面の付物。表題の上に出ていても
    // 前付を終わらせない（種類は別のところで決まるので、ここでは読み飛ばす）。
    // 「端にある行」だけで読み飛ばすと、表題そのものが素通りして本文に残る。
    const repeatedOn = repeated.get(line.text.replace(/\d+/g, '#'))?.size ?? 0;
    if (/^\d{1,4}$/.test(line.text) || (edgeCandidate.has(line.index) && repeatedOn >= 2)) continue;
    if (/[.!?]["'’”)\]]?$/.test(line.text)) break;
    frontMatterLines.add(line.index);
  }

  return lines.map((original) => {
    // 肩付きの脚注記号を外した写しで判定する。記号が本文の文字列に残ると、
    // 文末の直後に数字が続いて文が切れなくなる（詳細は footnoteMarks の説明）。
    const line = withoutFootnoteMarks(original);
    const pageStats = stats.get(line.page)!;
    const span = Math.max(1, pageStats.bottom - pageStats.top);
    const relative = (line.y - pageStats.top) / span;
    const nearEdge = relative <= 0.15 || relative >= 0.85;
    // 柱の照合は、記号を外す前の文字列で行う（repeated はそちらで作ってある）。
    const key = original.text.replace(/\d+/g, '#');
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

    if (inTail.has(line.index)) return drop(isPageNumber ? 'pageNumber' : 'reference');
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

    /**
     * 前付の行（表題・著者・所属・連絡先）。
     *
     * これまで落ちていたのは、版面の規則で表や数式に化けた行だけだった。
     * 表題は普通の 1 行なのでどの規則にも当たらず、**本文の 1 文目**として出ていた。
     * 実測（pdflatex の 2 段組）で `order = 0` の文が
     * "Block Sparse Attention for Long Documents Department of Computer Science, …"
     * になり、題名と著者と所属が 1 枚のカードに同居していた。
     *
     * 落とす範囲は「1 ページ目の、最初の節見出しより前」に限る。そのうえで
     * **文として閉じていない行だけ**にする。見出しの無いアブストラクトを持つ論文で
     * 本文を丸ごと落とさないための歯止め — 表題・著者・所属は文末記号で終わらないが、
     * アブストラクトの各文は終わる。
     */
    if (frontMatterLines.has(line.index)) {
      return drop('frontMatter');
    }

    const width = columnWidth.get(`${line.page}:${line.column}`) ?? line.right - line.left;
    // 式番号ぶんを差し引いた実効幅で「短さ」を測る。右端の "(3)" のせいで
    // 数式行が段幅いっぱいになり、数式として落とせていなかった。
    const stripped = line.text.replace(EQUATION_NUMBER, '');
    const effectiveWidth =
      line.text.length === 0 ? 0 : ((line.right - line.left) * stripped.length) / line.text.length;
    const isShort = width > 0 && effectiveWidth < width * 0.7;
    const endsOpen = !/[.!?:;,]$/.test(line.text);

    // 擬似コードの行。版面では本文と見分けが付かないので、行番号の形で決める
    // （説明は PSEUDOCODE_LINE を参照）。数式の判定より先に見る — 塊の中の行が
    // 「演算子のある行だけ数式、残りは本文」と割れると、かえって読めない断片が並ぶ。
    if (pseudocode.has(line.index)) {
      return drop('other');
    }

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
      //
      // ただし直前の行が**隣接しているとき**だけ。上の行との間が空いていれば、
      // そこにあるのは別の要素（フロートの最終行・前の段落）なので、文として
      // 閉じていなくてもこの行とは関係がない。実測（`algorithm` を段の中に固定した
      // 2 段組）で、擬似コードの `6: return M` の直後に来た小見出し
      // `1.2 Cost of the Selection Pass` が -1 で本文に落ち、次の文と癒着していた。
      // 本文と同じ大きさの小見出し（IEEE / ACL 系の体裁）では文字高の +1 が無いので、
      // この -1 がそのまま判定をひっくり返す。
      else if (previous && !/[.!?]$/.test(previous.text)) score -= 1;
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

  /**
   * 探す範囲は「最初の節見出しより前」だけにする。
   *
   * 表題は前付にしかない。範囲を切らずに「1 ページ目でいちばん大きな文字」を取ると、
   * 表題を持たない PDF（技術報告・付録だけの抜き刷り）で**節見出しが題名になる**。
   * 実測（`\title` の無い pdflatex の 2 段組）で題名が
   * "4 Limitations 1 Greedy Block Selection" になり、一覧にもタブにもそれが出ていた。
   * 節見出しより前に何も無ければ、そこで諦めて null を返す方が正しい。
   */
  const frontMatter: Line[] = [];
  for (const line of lines) {
    if (KNOWN_HEADINGS.has(bareHeading(line.text)) || headingNumber(line.text) !== null) break;
    frontMatter.push(line);
  }
  if (frontMatter.length === 0) return null;

  const largest = Math.max(...frontMatter.map((line) => line.height));
  // 本文と同じ大きさしか無いページでは、表題を見分けられない。
  if (largest < body * 1.15) return null;

  const TOLERANCE = 0.9;
  const parts: string[] = [];
  for (const line of frontMatter) {
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

/**
 * 「同じ位置で割れている行」と認める空白の幅を、字送りの何倍で測るか。
 *
 * 左右の段が 1 行に連結されると、その行の中に**柱間そのものの幅の空白**が残る。
 * 語間は両端揃えで伸びても字送りの 1 倍前後なので、1.6 倍あれば語間ではない。
 *
 * ここを厳しく（3 倍などに）すると、`\columnsep` 既定の 10pt（10pt 本文なら
 * 字送りの 2.3 倍）が拾えなくなる — arXiv のプレプリントで最も多い値なので、
 * いちばん見つけたい崩れを取り逃がす。緩めたぶんは「同じ x に何行そろうか」で担保する。
 */
const MERGED_GAP_ADVANCES = 1.6;
/** 空白の位置をまとめる粒度（pt）。両端揃えで柱間の位置は数 pt 揺れる。 */
const MERGED_GAP_BIN = 4;
/**
 * 同じ位置で割れている本文行が、1 ページに何行あったら「段の連結」と言うか。
 *
 * 本当に連結していれば、そのページのほぼ全ての本文行（数十行）が該当する。
 * 一方、偶然そろうもの（本文中に紛れた表の数行、著者名を並べた行）はせいぜい数行。
 * 8 行にしておけば、どちらの側にも十分な余裕がある。
 */
const MERGED_GAP_LINES = 8;

/**
 * 読み順が崩れていないかを、解析結果そのものから点検する。
 *
 * ここで探すのは「2 段組の左右が 1 行に連結された」痕跡。これがこの経路でいちばん重い
 * 壊れ方で、しかも**道具の中では回復できない**（`fix_sentence_boundary` は結合と
 * 文字位置での分割しかできないので、語単位で噛み合った文字列は戻せない）。
 *
 * 手掛かりは版面だけで取れるものにする。段の検出が成功していれば、左段と右段は
 * 別々の行になるので、行の中に柱間ぶんの空白は残らない。逆に検出が失敗して
 * 連結されると、そのページのほぼ全ての本文行が**同じ x** で割れる。
 * だから「同じ位置に大きな空白がある本文行が、1 ページに何行あるか」を数えれば、
 * 段の検出とは独立した方法で連結を見つけられる。
 *
 * 誤検出を避けるための絞り込み:
 *   - 本文の行だけを見る（表・擬似コード・著者行は付物なので最初から外れる）
 *   - 空白の両側に十分な長さの文字があること（行末の字下げや式番号を数えない）
 *   - 空白の位置が版面の中ほどにあること（段間は真ん中付近にしか来ない）
 */
export function assessReadingOrder(lines: readonly ClassifiedLine[]): StructureQuality {
  const clean: StructureQuality = {
    readingOrderRisk: 'low',
    reason: '段の連結など、読み順が崩れている痕跡は見つかりませんでした（崩れが無いことの保証ではありません）。',
  };

  const body = lines.filter((line) => line.role === 'body' && line.chunks.length >= 2);
  if (body.length === 0) return clean;

  const advance = charAdvance(body.flatMap((line) => line.chunks));
  const threshold = Math.max(4, advance * MERGED_GAP_ADVANCES);

  /** ページごとの版面の x 範囲。段間は必ずこの中ほどに来る。 */
  const extent = new Map<number, { min: number; max: number }>();
  for (const line of body) {
    const found = extent.get(line.page);
    if (found === undefined) extent.set(line.page, { min: line.left, max: line.right });
    else {
      found.min = Math.min(found.min, line.left);
      found.max = Math.max(found.max, line.right);
    }
  }

  /** ページ → 空白の位置（ビン）→ その位置で割れている本文行の数。 */
  const gapsByPage = new Map<number, Map<number, number>>();
  for (const line of body) {
    const span = extent.get(line.page)!;
    const width = span.max - span.min;
    if (width <= 0) continue;
    const ordered = [...line.chunks].sort((a, b) => a.x - b.x);
    let before = 0;
    for (let i = 1; i < ordered.length; i++) {
      before += ordered[i - 1]!.text.trim().length;
      const gap = ordered[i]!.x - (ordered[i - 1]!.x + ordered[i - 1]!.w);
      if (gap < threshold) continue;
      // 空白の両側に、ひとまとまりの文章と言える長さがあるか。
      const after = ordered.slice(i).reduce((sum, chunk) => sum + chunk.text.trim().length, 0);
      if (before < 10 || after < 10) continue;
      const center = ordered[i - 1]!.x + ordered[i - 1]!.w + gap / 2;
      const relative = (center - span.min) / width;
      if (relative < 0.2 || relative > 0.8) continue;
      const bins = gapsByPage.get(line.page) ?? new Map<number, number>();
      const bin = Math.round(center / MERGED_GAP_BIN);
      bins.set(bin, (bins.get(bin) ?? 0) + 1);
      gapsByPage.set(line.page, bins);
    }
  }

  const hits: { page: number; count: number }[] = [];
  for (const [page, bins] of gapsByPage) {
    // 隣り合うビンは同じ柱間。1 つ隣まで足して数える。
    let best = 0;
    for (const [bin, count] of bins) best = Math.max(best, count + (bins.get(bin + 1) ?? 0));
    if (best >= MERGED_GAP_LINES) hits.push({ page, count: best });
  }
  if (hits.length === 0) return clean;

  hits.sort((a, b) => a.page - b.page);
  const pages = hits.map((hit) => hit.page);
  const shown = pages.slice(0, 5).join(', ') + (pages.length > 5 ? ' ほか' : '');
  const total = hits.reduce((sum, hit) => sum + hit.count, 0);
  return {
    readingOrderRisk: 'high',
    reason:
      `${shown} ページで、左右の段が 1 行に連結された疑いがあります` +
      `（同じ位置で割れている本文行が ${total} 行）。` +
      '語の順番が入れ替わっている可能性が高く、文の区切りを直しても戻せません。原文と PDF を見比べてください。',
  };
}
