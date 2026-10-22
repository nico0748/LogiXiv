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
  /**
   * その行が段の右端まで届いていたか。
   *
   * 届いている＝組版が折り返しただけで、段落はまだ続いている。
   * 届いていない＝段落の最終行（欧文の組版では `\parfillskip` のぶん右が余る）。
   * 文末記号より信用できる手掛かりで、classifyLines は既にこれを計算している。
   *
   * 外へ出すのは、**継ぎ目の印**が使うため。別行立ての数式に本文が丸ごと吸われた文
   * （`The estimator that we analyse in this section is and the weights are chosen …`）は、
   * 式の直前の行が「右端に届いていない」ことでしか見分けられない。
   * 段落の途中に図表が割り込んだだけの文（こちらは欠けていない）では、
   * 割り込みの直前の行は段の右端まで届いている。詳細は sentences.ts の findSeam。
   */
  reachesRight?: boolean;
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
/**
 * 同じ下限を、**文字の大きさ（em）**の何倍かでも測る。小さい方を採る。
 *
 * 字送りだけで測ると和文で破綻する。和文は 1 文字がほぼ 1em 進むので、
 * 10pt 本文で下限が 14.9pt になり、`\documentclass[twocolumn]` の既定
 * `\columnsep` = 10pt がそのまま下回って**段組の検出が丸ごと失敗**する
 * （実測: 和文 2 段組で再現率 9%、左右の段が 1 行に混ざる）。
 * 欧文は字送り 4.4pt 前後なので、同じ 10pt が 2.3 倍あって通っていた。
 *
 * 一方で em は書記系に依らない。柱間は組版の慣習として 0.6em 以上あり、
 * 語間は欧文でも 0.25〜0.33em（両端揃えで伸びても 0.5em 前後）、和文の字間は
 * 0.04em ほどしかない。0.66em は欧文 10pt での従来の下限（字送り 4.4pt × 1.5 =
 * 6.6pt）とほぼ同じ値なので、欧文の挙動を変えずに和文だけを救える。
 */
const MIN_GUTTER_EMS = 0.66;
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
/**
 * 文末の記号。
 *
 * 和文の句点・疑問符・感嘆符を入れておかないと、和文では**どの行も文を閉じていない**
 * ことになる。見出しの合算点では「直前の行が閉じていなければ段落の途中」という
 * 減点が常に効いてしまい、番号の無い和文の見出し（`概要`・`おわりに`）が
 * 本文に落ちて直後の文と癒着する。
 */
const SENTENCE_END = /[.!?。！？]$/;

/**
 * 「語と約物だけでできていて、文末記号で閉じている行」。
 *
 * 数字・等号・添字・括弧・記号が 1 つでも混じれば通らない。短い本文行
 * （段落の最終行）を数式や表と分けるためだけに使う。詳細は looksLikeProse。
 */
const PLAIN_WORDS =
  /^\p{L}[\p{L}\p{M}'’\-]*(?:[ \u00a0,;:]+\p{L}[\p{L}\p{M}'’\-]*)*[.!?]$/u;
/** 文が途中で終わっていない（＝続きがある）ことを否定する記号。読点・中黒も含む。 */
const CLAUSE_END = /[.!?:;,。！？：；、]$/;

/** 柱と見なすための、本文の塊からの隔たり（行送りの何倍か）。 */
const DETACHED_SPACINGS = 3;
/** 「文章として読める」と認めるための、空白を除いた最小の文字数。 */
const PROSE_MIN_CHARS = 25;
/** 和文で同じことを見るときの最小の文字数。1 文字あたりの情報量が多いので短くてよい。 */
const PROSE_MIN_CHARS_CJK = 12;
/** 同じく、小文字の語（和文ならひらがな）の最小個数。数式と表のセルには現れない。 */
const PROSE_MIN_WORDS = 3;

/**
 * 段落の最終行として守るときの、小文字の語の数の下限。
 *
 * 最終行は短い。`published baseline.` のように 2 語しか残らないことがある。
 * 下げたぶんの歯止めは「段の左端にそろっている」「語と約物しか無い」で掛ける
 * （looksLikeProse を参照）。
 */
const PROSE_MIN_WORDS_TAIL = 2;

export interface ColumnRange {
  from: number;
  to: number;
}

const SINGLE_COLUMN: ColumnRange[] = [{ from: -Infinity, to: Infinity }];

/**
 * 配列の最小値・最大値。`Math.min(...array)` は使わない。
 *
 * スプレッドは配列を**引数リスト**に展開するので、要素数が処理系の引数上限
 * （V8 でおよそ 12 万）を超えると `RangeError: Maximum call stack size exceeded` を
 * 投げる。ここに来るのは 1 ページぶんの文字片や 1 行ぶんの文字片で、ふつうは数百だが、
 * 図面を文字で描いた PDF・OCR をかけた紙・1 文字ずつ座標を持つ書き出しでは
 * 1 ページ 10 万片を軽く超える。例外は上まで抜けて「PDF が壊れています」と表示され、
 * **壊れていない PDF を壊れていると誤って伝える**（実測）。
 */
function minOf(values: readonly number[]): number {
  let best = Infinity;
  for (const value of values) if (value < best) best = value;
  return best;
}

function maxOf(values: readonly number[]): number {
  let best = -Infinity;
  for (const value of values) if (value > best) best = value;
  return best;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * 大きい方から数えて `ratio` の位置の値。外れ値（全幅の図表）に引きずられない代表値。
 *
 * **要素が少ないときは必ず最大値を 1 つ飛ばす。** `Math.floor(n * ratio)` は
 * `n` が `1/ratio` に満たないと 0 になり、「外れ値を避ける」はずの代表値が
 * **最大値そのもの**になる。ratio = 0.05 なら 20 行未満、0.1 なら 10 行未満の段が全部そう。
 * 1 段 20 行未満は珍しくない（1 ページの短信、節の始め、表や図の多いページ、
 * 2 段組の最終ページ）。
 *
 * 実測（`\documentclass[twocolumn]`、本文 20 行の 1 ページ）: ノンブル `1` が
 * 段の右端より 7.5pt だけ外にいたため、それが「段の代表的な右端」になり、
 * 段いっぱいの本文行が 0.1pt 足りずに「右端に届いていない」と判定された。
 * その 1 行は文章の歯止め（looksLikeProse）を通れず、別行立ての数式として
 * 落ちて、`The method achieves a substantial improvement over the tion operator to
 * a linear one …` という**原文に無い文**になった。
 *
 * 2 個しかないときに飛ばすと残るのは最小値（＝段落の最終行）なので、3 個からにする。
 */
function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => b - a);
  const floor = ratio > 0 && sorted.length >= 3 ? 1 : 0;
  return sorted[Math.min(sorted.length - 1, Math.max(floor, Math.floor(sorted.length * ratio)))]!;
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
 * 文字の大きさ（em）。pdf.js の文字片の高さは版面の文字サイズにほぼ等しい。
 *
 * 字送りと違って書記系に依らないので、「柱間かどうか」のように
 * 和文でも欧文でも同じ尺度で測りたいものの物差しになる。
 * 断片（3 文字以下）を除くのは charAdvance と同じ理由。
 */
function charHeight(chunks: TextChunk[]): number {
  const heights: number[] = [];
  for (const chunk of chunks) {
    if (chunk.text.length < 4 || chunk.h <= 0) continue;
    heights.push(chunk.h);
  }
  return median(heights);
}

/**
 * 本文の文字高。行数ではなく**文字数**で重みを付ける。
 * 単純な median だと、見出しや参考文献の行数が多い文書で代表値がそちらへ引っ張られ、
 * 本文行が「小さい文字＝脚注」と誤判定される（実際に本文の最終行が消えていた）。
 */
function bodyTextHeight(lines: readonly Line[]): number {
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

  const minX = minOf(chunks.map((c) => c.x));
  const maxX = maxOf(chunks.map((c) => c.x + c.w));
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

  // 空白帯の下限は、絶対値ではなくこのページの字送りと文字の大きさから決める。
  // 小さい方を採るのは、和文（字送りがほぼ 1em）で下限が跳ね上がるのを防ぐため。
  const minGutter = Math.max(
    MIN_GUTTER_FLOOR,
    Math.min(charAdvance(chunks) * MIN_GUTTER_ADVANCES, charHeight(chunks) * MIN_GUTTER_EMS),
  );

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

/**
 * 全ページの文字片を 1 枚のページに重ねる。x はそのまま、y だけページごとに離す。
 *
 * 離すのは「行」の識別（rowKey）がページをまたいで混ざらないようにするため。
 * x をそのまま使うのは、段の位置を見たいのがまさに x だから。
 */

/** 文書全体で段を探し直すときの許容（段間をまたいでよい行の割合）。緩い順に試す。 */
const POOLED_TOLERANCES = [0.15, 0.3, 0.45];
/** 段組と認めるための、段間をまたがない行の割合。 */
const MIN_NON_CROSSING_RATIO = 0.5;

/**
 * その段割りが本当に段組か。許容を緩めて探したときの歯止め。
 *
 * 段組なら、ほとんどの行は段間をまたがず、またがない行の中に左段の文字も右段の
 * 文字もある。1 段組の文書は**全ての行が段間をまたぐ**ので、どれだけ許容を
 * 緩めてもここで落ちる。ページごとの判定（段抜きの行が少ないこと）とは違う見方を
 * しているので、段抜きの多い 1 ページ目があっても通る。
 */
function looksLikeColumns(ranges: readonly ColumnRange[], chunks: readonly TextChunk[]): boolean {
  const rows = new Set(chunks.map(rowKey));
  if (rows.size === 0) return false;
  const crossing = new Set<number>();
  for (let i = 0; i + 1 < ranges.length; i++) {
    const from = ranges[i]!.to;
    const to = ranges[i + 1]!.from;
    for (const chunk of chunks) {
      if (chunk.x < to && chunk.x + chunk.w > from) crossing.add(rowKey(chunk));
    }
  }
  const notCrossing = [...rows].filter((row) => !crossing.has(row));
  if (notCrossing.length < rows.size * MIN_NON_CROSSING_RATIO) return false;
  const kept = new Set(notCrossing);
  const gutterFrom = ranges[0]!.to;
  const gutterTo = ranges[1]!.from;
  const hasLeft = chunks.some((c) => kept.has(rowKey(c)) && c.x + c.w <= gutterFrom + 1);
  const hasRight = chunks.some((c) => kept.has(rowKey(c)) && c.x >= gutterTo - 1);
  return hasLeft && hasRight;
}

function stackPages(byPage: Map<number, TextChunk[]>): TextChunk[] {
  const out: TextChunk[] = [];
  let offset = 0;
  for (const [, chunks] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    let bottom = 0;
    for (const chunk of chunks) {
      out.push({ ...chunk, y: chunk.y + offset });
      bottom = Math.max(bottom, chunk.y + chunk.h);
    }
    offset += bottom + 100;
  }
  return out;
}

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
  let reference: ColumnRange[] | null = null;
  if (modeCount > 1) {
    const samples = [...perPage.values()].filter((r) => r.length === modeCount);
    reference = [];
    for (let i = 0; i < modeCount; i++) {
      reference.push({
        from: i === 0 ? -Infinity : median(samples.map((r) => r[i]!.from)),
        to: i === modeCount - 1 ? Infinity : median(samples.map((r) => r[i]!.to)),
      });
    }
  } else {
    /**
     * どのページも自力では段を見つけられなかった。**全ページの文字を 1 枚に重ねて**
     * もう一度だけ探す。
     *
     * ページごとの判定は「段間をまたぐ行が全体の 15% 未満」を要求する。
     * 段抜きの表題・著者ブロック・アブストラクト・全幅の表があるページでは
     * ここを超えるので、2 段組の論文でも 1 段と判定される。1 ページでも自力で
     * 見つかれば他のページはそれを借りられるが、**どのページにも段抜きがあると
     * 借り元が無く、文書全体が 1 段扱い**になって左右の段が 1 行に連結される。
     *
     * 実測: アブストラクトに 2 文足しただけ（段抜きが許容 11 行に対して 11 行）で
     * 再現率 100% → 34%。REVTeX 風の体裁では 31〜49%。
     * ページを重ねれば、段抜きの行は全ページぶんの行数に薄まって 15% を下回る。
     * 段の x 位置は 1 本の論文の中でほぼ動かないので、重ねても帯はぼやけない。
     */
    const stacked = stackPages(byPage);
    /**
     * 許容を段階的に緩める。0.15 のままでは、段抜きが「行数の 15%」をわずかに
     * 超えるだけで見つからない（実測: 許容 12 行に対して段抜き 12 行）。
     * 緩めるかわりに、見つかった段割りが本当に段組かどうかを確かめる
     * （`looksLikeColumns`）。1 段組の文書はどれだけ緩めてもここを通らない —
     * 全ての行が段間をまたぐため。
     */
    for (const tolerance of POOLED_TOLERANCES) {
      const pooled = detectColumns(stacked, tolerance);
      if (pooled.length > 1 && looksLikeColumns(pooled, stacked)) {
        reference = pooled;
        break;
      }
    }
  }
  if (reference === null) return perPage;

  // 段数が足りなかったページだけ、緩い許容で代表値を当てはめられるか確かめる。
  for (const [page, ranges] of perPage) {
    if (ranges.length >= reference.length) continue;
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
/** その文字片がどの段に属するか。重なりが最大の段へ必ず割り当てる（段の外を作らない）。 */
function columnOf(chunk: TextChunk, columns: readonly ColumnRange[]): number {
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
  return bestIndex;
}

/** 行番号の帯と認めるための、1 ページあたりの最小個数。 */
const MIN_MARGIN_NUMBERS = 5;

/**
 * 版面の外の余白に振られた行番号を見つける。
 *
 * 査読稿・投稿稿・校正刷り（NeurIPS / ICLR / ACL の投稿稿、学術誌のゲラ）は
 * `\usepackage{lineno}` + `\linenumbers` で組まれる。この道具がいちばん読まれる
 * 対象そのものなのに、行番号が**本文の中に入り込んで全文が壊れていた**。実測:
 *   `We evaluate three configurations on the stan- 4 dard benchmark suite …`
 * 行番号が割り込むので行末ハイフンの結合も効かず、`stan- 4 dard` が画面に残る。
 * さらに、左外の細い帯が段の切れ目に見えて段組の検出そのものが狂っていた。
 *
 * 見分け方は版面だけで足りる。行番号は
 *   - 数字だけの短い文字片で、
 *   - **本文の x 範囲の外**（左または右の余白）にあり、
 *   - 1 ページに何本も並ぶ。
 * ノンブルは本文の x 範囲の**中**（中央や端）に 1 つだけなので、これで外れる。
 */
function findMarginNumbers(byPage: ReadonlyMap<number, TextChunk[]>): Set<TextChunk> {
  const found = new Set<TextChunk>();
  for (const pageChunks of byPage.values()) {
    const numeric = pageChunks.filter((chunk) => /^\d{1,4}$/.test(chunk.text.trim()));
    if (numeric.length < MIN_MARGIN_NUMBERS) continue;
    const rest = pageChunks.filter((chunk) => !/^\d{1,4}$/.test(chunk.text.trim()));
    if (rest.length === 0) continue;
    const textLeft = minOf(rest.map((chunk) => chunk.x));
    const textRight = maxOf(rest.map((chunk) => chunk.x + chunk.w));
    // 余白との隔たりは文字高で測る（版面の寸法に依らない）。
    const gap = median(rest.map((chunk) => chunk.h)) * 0.5;
    const outside = numeric.filter(
      (chunk) => chunk.x + chunk.w <= textLeft - gap || chunk.x >= textRight + gap,
    );
    if (outside.length >= MIN_MARGIN_NUMBERS) for (const chunk of outside) found.add(chunk);

    for (const chunk of findNumberBands(numeric, rest)) found.add(chunk);
  }
  return found;
}

/** 行番号の帯と認める、段差（1 行ごと・5 行ごと）の一致率。 */
const NUMBER_BAND_AGREEMENT = 0.8;
/** 行番号の帯と認める、ページの本文の高さに対する帯の高さの下限。 */
const NUMBER_BAND_SPAN = 0.4;

/**
 * 段間（柱間）に組まれた行番号を見つける。
 *
 * `\usepackage{lineno}` を 2 段組で使うと、番号は段の**外側**ではなく
 * 段と段の間（柱間）に落ちる。これは**ページの本文 x 範囲の内側**なので、
 * 「版面の外にある」という手掛かりでは 1 つも拾えない。
 *
 * 実測（`\documentclass[twocolumn]` + `\linenumbers`、1 ページ 47 行）:
 * 左段の全行が `We evaluate three configurations on the standard suite49` と
 * 番号を飲み込み、行末ハイフンの結合も効かず `Informa-55 tion retrieval` が残った。
 * 右段は番号が右の余白（＝版面の外）にあるので無傷 — 段によって壊れ方が違い、
 * しかも申告は low のままだった。番号が柱間の中央に来る組み方では、
 * 細い帯が段の切れ目を埋めて**段組の検出そのもの**が崩れる。
 *
 * 版面の外かどうかを見ないかわりに、行番号の**並び方**で見分ける:
 *   - 同じ x に縦 1 列に並ぶ（右揃え・左揃えのどちらもあるので両端で試す）
 *   - y の順に値が**等差で増える**（1 行ごとなら 1、`\modulolinenumbers{5}` なら 5）
 *   - ページの本文の高さの 4 割以上にわたって続く
 *   - 本文より**小さい字**で組まれている（lineno の既定は `\tiny`）
 * 表の数値列は、等差で増えることはあっても本文より小さい字では組まないし、
 * ページの高さの 4 割にわたって 5 個以上並ぶこともまずない。
 */
function findNumberBands(numeric: TextChunk[], rest: TextChunk[]): TextChunk[] {
  if (numeric.length < MIN_MARGIN_NUMBERS || rest.length === 0) return [];
  const bodyHeight = median(rest.map((chunk) => chunk.h));
  if (bodyHeight <= 0) return [];
  // 本文より小さい字だけを候補にする。ここが無いと表の数値列と見分けられない。
  const small = numeric.filter((chunk) => chunk.h < bodyHeight * 0.9);
  if (small.length < MIN_MARGIN_NUMBERS) return [];

  const restTop = minOf(rest.map((chunk) => chunk.y));
  const restBottom = maxOf(rest.map((chunk) => chunk.y + chunk.h));
  const minSpan = (restBottom - restTop) * NUMBER_BAND_SPAN;

  // 右揃え・左揃えのどちらでも縦 1 列になるよう、左端と右端の両方で束ねる。
  const bands = new Map<string, TextChunk[]>();
  const put = (key: string, chunk: TextChunk): void => {
    const list = bands.get(key);
    if (list) list.push(chunk);
    else bands.set(key, [chunk]);
  };
  for (const chunk of small) {
    put(`l${Math.round(chunk.x / 2)}`, chunk);
    put(`r${Math.round((chunk.x + chunk.w) / 2)}`, chunk);
  }

  const found: TextChunk[] = [];
  for (const band of bands.values()) {
    if (band.length < MIN_MARGIN_NUMBERS) continue;
    const sorted = [...band].sort((a, b) => a.y - b.y);
    if (maxOf(sorted.map((c) => c.y)) - minOf(sorted.map((c) => c.y)) < minSpan) continue;

    // y の順に値が増えているか。1 つでも戻ったら行番号ではない。
    const values = sorted.map((chunk) => Number(chunk.text.trim()));
    let increasing = true;
    const steps: number[] = [];
    for (let i = 1; i < values.length; i++) {
      const step = values[i]! - values[i - 1]!;
      if (step <= 0) {
        increasing = false;
        break;
      }
      steps.push(step);
    }
    if (!increasing || steps.length === 0) continue;

    // 段差がそろっているか（1 行ごと、または n 行ごと）。
    const counts = new Map<number, number>();
    for (const step of steps) counts.set(step, (counts.get(step) ?? 0) + 1);
    let agreed = 0;
    for (const count of counts.values()) if (count > agreed) agreed = count;
    if (agreed < steps.length * NUMBER_BAND_AGREEMENT) continue;

    for (const chunk of band) found.push(chunk);
  }
  return found;
}

/** ルビと認める、本文の文字高に対する高さの比。 */
const RUBY_HEIGHT_RATIO = 0.65;
/** ルビと認める、1 ページあたりの最小個数。 */
const MIN_RUBY = 2;
/** ルビと認める、本文の行の外へのはみ出しの上限（本文の文字高に対する比）。 */
const RUBY_MAX_OVERHANG = 1.2;
/** ルビの字。読み仮名は仮名でしか組まない。 */
const KANA_ONLY = /^[\p{Script=Hiragana}\p{Script=Katakana}ー]{1,8}$/u;

/**
 * 本文の上に重ねて組まれたルビ（振り仮名）を見つける。
 *
 * 版面と字種だけで決める。ルビは
 *   - **仮名だけ**の短い文字片で（読み仮名を漢字や欧字で振ることはない）、
 *   - 本文よりはっきり**小さく**、
 *   - すぐ下に、**自分の x 範囲を丸ごと含む**本文の文字片があり、
 *   - 縦には本文の字の箱と重ならない（肩付きの添字・脚注記号はここで外れる）、
 *   - 1 ページに 2 つ以上ある。
 *
 * 添字・肩付き記号は本文の字の箱の**中**に入るので、上の 4 つ目で外れる。
 * インライン数式の分子も仮名ではないので 1 つ目で外れる。
 */
function findRubyChunks(byPage: ReadonlyMap<number, TextChunk[]>): Set<TextChunk> {
  const found = new Set<TextChunk>();
  for (const pageChunks of byPage.values()) {
    const bodyHeight = charHeight(pageChunks);
    if (bodyHeight <= 0) continue;
    const candidates = pageChunks.filter(
      (chunk) => chunk.h <= bodyHeight * RUBY_HEIGHT_RATIO && KANA_ONLY.test(chunk.text.trim()),
    );
    if (candidates.length < MIN_RUBY) continue;

    /**
     * 本文の**行**（同じ y に並ぶ本文の大きさの文字片）の左右の端。
     *
     * 1 つの文字片と比べてはいけない。ルビは基底文字の中央に組まれるので、
     * 読みが基底より広いとき（`塊` → `かたまり`）左右にはみ出し、基底の文字片には
     * 半分しか重ならない。行頭・段落頭では基底が行の左端に来るので、
     * 「基底を丸ごと含む」でも「基底と半分以上重なる」でも取り逃がし、
     * 読み仮名がそのまま本文に入っていた（実測:
     * `かたまり塊の大きさと到達可能な処理速度の間に…` / `そ疎な行列の積は、…`）。
     */
    const rows: { y: number; left: number; right: number }[] = [];
    for (const chunk of pageChunks) {
      if (chunk.h < bodyHeight * 0.9) continue;
      const row = rows.find((other) => Math.abs(other.y - chunk.y) <= bodyHeight * 0.3);
      if (row === undefined) rows.push({ y: chunk.y, left: chunk.x, right: chunk.x + chunk.w });
      else {
        row.left = Math.min(row.left, chunk.x);
        row.right = Math.max(row.right, chunk.x + chunk.w);
      }
    }

    const onPage: TextChunk[] = [];
    for (const chunk of candidates) {
      const bottom = chunk.y + chunk.h;
      const carrier = rows.find(
        (row) =>
          // すぐ下にある（重ならず、1 行ぶんの送りには足りない距離）。
          row.y >= bottom - 0.5 &&
          row.y <= bottom + bodyHeight * 0.7 &&
          // その行に重なっていて、行の外へ 1 文字ぶん以上はみ出していない。
          chunk.x < row.right &&
          chunk.x + chunk.w > row.left &&
          chunk.x >= row.left - bodyHeight * RUBY_MAX_OVERHANG &&
          chunk.x + chunk.w <= row.right + bodyHeight * RUBY_MAX_OVERHANG,
      );
      if (carrier !== undefined) onPage.push(chunk);
    }
    if (onPage.length < MIN_RUBY) continue;
    for (const chunk of onPage) found.add(chunk);
  }
  return found;
}

export function buildLines(chunks: TextChunk[]): Line[] {
  const byPage = new Map<number, TextChunk[]>();
  for (const chunk of chunks) {
    if (chunk.text.length === 0) continue;
    const list = byPage.get(chunk.page);
    if (list) list.push(chunk);
    else byPage.set(chunk.page, [chunk]);
  }

  /**
   * 行番号の帯は、行を組み立てる前に**丸ごと外す**。
   *
   * 版面に印刷された座標の目盛りであって、読む対象ではない（ノンブルと違って
   * 1 ページに何十個も並ぶので、付物として並べても画面が埋まるだけ）。
   * 残すと、左外の細い帯が段の切れ目に見えて段組の検出が狂い、さらに番号が
   * 本文の行の中に割り込んで全文が壊れる。詳細は findMarginNumbers。
   */
  const marginNumbers = findMarginNumbers(byPage);
  if (marginNumbers.size > 0) {
    for (const [page, pageChunks] of byPage) {
      byPage.set(page, pageChunks.filter((chunk) => !marginNumbers.has(chunk)));
    }
  }

  /**
   * ルビ（振り仮名）も、行を組み立てる前に**丸ごと外す**。
   *
   * ルビは本文の**すぐ上に重ねて**組まれるので、行にまとめる段で本文の行に紛れ込む。
   * 実測（XeLaTeX の和文、`\ooalign` で組んだルビ）:
   *   `そ かく かたまり本論文では疎な注意機構の核について論じる。`
   *     ← 1 行ぶんのルビが全部**文の先頭に固まる**（別の行になった場合）
   *   `そ本手法の中心となる考え方は、…`
   *     ← 別の行のルビが**次の文の頭**に付く（前の行に吸われた場合）
   * どちらも原文に無い文字列が本文に入る。ルビは 7 文字あることもあるので
   * 「置き場所を間違えた断片」（4 文字以下）の網にも掛からず、印も申告も出ない。
   *
   * ノンブルや行番号と同じ扱いで捨てる。読み仮名は版面に印刷された読みの補助で、
   * 訳す対象の文ではない（付物として並べても 1〜2 文字の断片が画面を埋めるだけ）。
   */
  const ruby = findRubyChunks(byPage);
  if (ruby.size > 0) {
    for (const [page, pageChunks] of byPage) {
      byPage.set(page, pageChunks.filter((chunk) => !ruby.has(chunk)));
    }
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

    /**
     * 幅で段間をまたいでいなくても、**他のどの段の先頭よりも上にある**行は前付。
     *
     * 段が細いほど、中央寄せの表題は中の段にすっぽり収まってしまう。実測
     * （multicol の 3 段組）で `Three Narrow Columns` が段 1 の中に収まり、
     * 段 0 を読み終えた後に現れて**本文の文の途中に刺さった**:
     *   `… which we determine independently Three Narrow Columns from inelastic …`
     * 紙の上では誰が見てもページの頭にあるので、読み順は「どの段より上か」で決まる。
     *
     * 他の段に本文がある場合だけ見る（1 段しかなければ帯に分ける意味が無い）。
     * 行 1 本ぶん以上の隔たりを求めるのは、段の頭がわずかに揃わない版面で
     * 本文の 1 行目を前付に取られないため。
     */
    const banner = new Set<TextChunk>();
    const gap = median(pageChunks.map((chunk) => chunk.h));
    // 上から順に剥がす。柱を 1 本剥がすと、その下にあった表題が「どの段よりも上」に
    // なる、という具合に段階的に決まるので、変化が止まるまで繰り返す。
    // （柱・表題・著者・所属で 4 段が上限。それ以上は前付ではない。）
    for (let pass = 0; pass < 4; pass++) {
      const columnTop = new Map<number, number>();
      for (const chunk of pageChunks) {
        if (crossesGutter(chunk) || banner.has(chunk)) continue;
        const index = columnOf(chunk, columns);
        const top = columnTop.get(index);
        if (top === undefined || chunk.y < top) columnTop.set(index, chunk.y);
      }
      if (columnTop.size <= 1) break;
      let changed = false;
      for (const chunk of pageChunks) {
        if (crossesGutter(chunk) || banner.has(chunk)) continue;
        const own = columnOf(chunk, columns);
        let aboveAll = true;
        for (const [index, top] of columnTop) {
          if (index === own) continue;
          if (chunk.y + chunk.h > top - gap) aboveAll = false;
        }
        if (aboveAll) {
          banner.add(chunk);
          changed = true;
        }
      }
      if (!changed) break;
    }
    for (const chunk of banner) fullWidthRows.add(rowKey(chunk));

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
        let tolerance = Math.max(2, Math.min(chunk.h, current?.height ?? chunk.h) * 0.6);

        /**
         * 添字・上付きは、**その行の一部**であって別の行ではない。
         *
         * pdf.js は `Q_1` を「Q」と「1」の 2 つの文字片で返す。添字は本文より
         * 小さく（10pt に対して 7pt）、ベースラインが 4pt ほど下がるので、
         * 小さい方の文字高で測った許容量（7 × 0.6 = 4.2pt）をわずかに超えて
         * **独立した行**になっていた。そうなると「短くて字下げされていて機能語も
         * 文末記号も無い行」に見えるので、別行立ての数式・表として落ちる。
         * しかも `displayBlock` の塊まとめが、上下の本文行まで道連れにする。
         * 実測（pdflatex の 2 段組）で、インライン数式を入れただけの同じ文章が
         * 4 文とも消え、残骸が文法の通る英文に癒着した。
         *
         * 許容量は**行の側の文字高**で測り直す。ただし「小さい文字片が行の文字の
         * 並びに続いている」ときだけ — 少し上に浮いている柱やノンブルは、
         * 行の x 範囲から離れているので、この条件で外れる。
         */
        if (current !== null) {
          /**
           * 行の代表的な文字高は `current.height`（＝行を作った文字片の高さ）では
           * 測れない。上付きが行の先頭に来ると、その 7.4pt が行の高さになり、
           * 同じ行の添字（7.4pt）が「小さくない」ことになって外れてしまう。
           * 実測（pdflatex の 2 段組）で `f_m = f^\star + b + \varepsilon_m` の
           * `⋆` が行を作り、添字 `m` が 2 つとも別の行に落ちて本文から消えた。
           * これまでに入った文字片のいちばん大きい高さを行の高さとみなす。
           */
          const lineHeight = maxOf(current.chunks.map((c) => c.h));
          const right = maxOf(current.chunks.map((c) => c.x + c.w));
          const left = minOf(current.chunks.map((c) => c.x));
          const adjacent = chunk.x >= left - lineHeight && chunk.x <= right + lineHeight;
          // 0.65 は実測値。添字だけなら 0.45 で足りるが、`\beta_i^2` のように
          // 上付きと添字が同居すると添字がさらに下がる（10pt の行で 6.2pt）。
          if (chunk.h < lineHeight * 0.85 && adjacent) tolerance = Math.max(tolerance, lineHeight * 0.65);
        }

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
    for (const chunk of inColumns) buckets[columnOf(chunk, columns)]!.push(chunk);

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
    line.left = minOf(line.chunks.map((c) => c.x));
    line.right = maxOf(line.chunks.map((c) => c.x + c.w));
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
  // 和文の見出し語。欧文と違って大文字という手掛かりが無く、本文と同じ大きさで
  // 組まれる小見出しもあるので、語そのものを知らないと拾えない。知らなかった頃は
  // 見出しが本文に落ちて直後の文と癒着していた（実測: `4 実装実装は…`）。
  '概要', '要旨', 'はじめに', '序論', '緒言', '背景', '関連研究', '従来研究',
  '提案手法', '手法', '提案', '方法', '実装', '実験', '実験設定', '評価', '結果',
  '考察', '議論', '制限', '限界', '結論', 'おわりに', 'まとめ', '今後の課題',
  '参考文献', '文献', '引用文献', '謝辞', '付録', '補遺',
]);

/** ここから後ろは本文として扱わない見出し。 */
const TAIL_HEADINGS = new Set([
  'references', 'bibliography', 'acknowledgments', 'acknowledgements',
  '参考文献', '文献', '引用文献', '謝辞',
]);

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
 *
 * 続く 1 文字は `\p{Lu}` だけでなく `\p{Lo}`（大文字・小文字の区別が無い文字）も見る。
 * 和文誌では引用先も和文で、`[1] 佐藤 花子 …` の形になる。欧文の大文字しか
 * 見ていなかったときは、和文の参考文献がまるごと本文に混ざっていた。
 */
const REFERENCE_ENTRY = /^\[\d+\]\s*[\p{Lu}\p{Lo}]/u;
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

/** 塊の穴埋めで一度に拾ってよい行数の上限。 */
const FILL_MAX_LINES = 3;

/** 逐語ブロックと認める最小の行数。 */
const MIN_VERBATIM_LINES = 4;
/**
 * コードの地の文になる記号。括弧・等号・コロン・下線・スラッシュなど。
 *
 * 箇条書き・用語定義・引用・表のセルはこれを 1 つも持たない。
 * 句点・読点・ハイフンは本文にも普通に出るので入れない。
 */
const CODE_SYMBOLS = /[(){}[\];:=@#$%&*_/\\|<>"']/g;
/** 1 行が「記号を含む」と認める個数。 */
const MIN_CODE_SYMBOLS = 2;
/** 逐語ブロックと認める、記号を含む行の割合。 */
const MIN_CODE_LINE_RATIO = 0.6;
/**
 * 逐語ブロックと認める、数式として読める行の割合の上限。
 *
 * 別行立ての数式の塊を「逐語」と呼ばないための門。ただし**コードの行も
 * 半分近くは数式として読める**（`scores = q @ k.transpose(-1, -2)` は英字比率 0.47）。
 * 0.5 にしていたときは、本文がタイトルだけでコードが主体の PDF で
 * 先頭の 3 行だけ塊から外れ、タイトルがコードの 1 行目と 1 文になっていた。
 */
const MAX_FORMULA_LINE_RATIO = 0.7;

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
  if (SENTENCE_END.test(body)) return false;
  const operators = (body.match(/[=+\-*/^_<>|∑∏∫√≈≤≥±×·≠∈∀∃]/gu) ?? []).length;
  if (operators === 0) return false;
  const letters = (body.match(/\p{L}/gu) ?? []).length;
  return letters / body.length < 0.6;
}

/**
 * 付録の見出し（"A Proof of the Obstruction" / "B.1 Details"）。
 *
 * 本体の節は数字で始まるが、`\appendix` の後ろは英字 1 文字になる。数字しか見ていない
 * 頃は、付録の見出しが本文として扱われ、**付録の中身がその見出しと 1 文に癒着**して
 * いた（実測: "A Proof of the Obstruction Assume the two calibration conditions …"）。
 * 単独ではただの "A …" と区別が付かないので、見出しの合算点の 1 点ぶんとして使う。
 */
const APPENDIX_HEADING = /^[A-Z](?:\.\d+)*\.?\s+\p{Lu}/u;

/**
 * 先頭の章番号（"3.1 Ablation" → [3, 1]）。
 *
 * 番号の後ろは `\p{Lu}`（欧文の大文字）だけでなく `\p{Lo}`（大文字・小文字の
 * 区別が無い文字）も見る。和文の見出しは `4 実装` のように漢字が続くので、
 * 大文字しか見ていなかったときは番号つきの見出しがすべて本文に落ちていた。
 */
function headingNumber(text: string): number[] | null {
  const match = /^(\d+(?:\.\d+)*)\.?\s+[\p{Lu}\p{Lo}]/u.exec(text);
  if (match) return match[1]!.split('.').map((part) => Number.parseInt(part, 10));
  const roman = romanHeading(text);
  return roman === null ? null : [roman];
}

/**
 * IEEE 系の節見出し（`I. INTRODUCTION` / `IV. RESULTS`）のローマ数字。
 *
 * IEEEtran の節見出しはローマ数字＋小型大文字で、本文と同じ大きさで中央に組まれる。
 * アラビア数字しか見ていなかった頃は、節見出しがすべて「表のセル」として落ち、
 * 1 ページ目に節見出しが無い扱いになって**前付（表題・著者・所属）が丸ごと本文に残っていた**。
 * 実測（IJCNN の論文）で、表題の 2 行目 `via Oja’s Plasticity` が最初の節の名前になり、
 * 著者の所属が本文の文として並んでいた。
 *
 * 人名のイニシャル（`V. Kumar`）や文頭の `I. e.` と取り違えないよう、
 * 数字の後ろが**小文字を含まない**（小型大文字の見出し語）ときだけ見出しとみなす。
 */
function romanHeading(text: string): number | null {
  const match = /^([IVX]{1,5})\.\s+(\p{Lu}[^\p{Ll}]{2,})$/u.exec(text.trim());
  if (!match) return null;
  const value = romanValue(match[1]!);
  // 節の数としてありえる範囲だけ（`XX.` のような略号を拾わない）
  return value !== null && value >= 1 && value <= 20 ? value : null;
}

function romanValue(numeral: string): number | null {
  const digits: Record<string, number> = { I: 1, V: 5, X: 10 };
  let total = 0;
  for (let i = 0; i < numeral.length; i++) {
    const value = digits[numeral[i]!]!;
    const next = digits[numeral[i + 1] ?? ''] ?? 0;
    total += value < next ? -value : value;
  }
  // 正規の書き方に戻して一致しなければ、ローマ数字ではない（`IIX` など）
  const canonical = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];
  const back = 'X'.repeat(Math.floor(total / 10)) + (canonical[total % 10] ?? '');
  return back === numeral ? total : null;
}

/**
 * 要旨・キーワードが見出しを立てずに段落の頭に入っている行（`Abstract—Recurrent …`、
 * `Index Terms—…`、`Keywords: …`）。IEEE・Springer の体裁では要旨の見出しが独立した行にならない。
 * 前付の終わりの目印に使う。
 */
const RUN_IN_ABSTRACT = /^(?:abstract|index terms|keywords|key words)\s*[—–:.-]/i;

/**
 * 見出しの語だけを取り出す（番号と約物を落とす）。
 *
 * 残す文字に漢字・かな・長音符を含めるのを忘れると、和文の見出しが空文字になって
 * `KNOWN_HEADINGS` の照合が必ず外れる（`4 実装` → `実装` → `''`）。
 */
function bareHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/^\d+(\.\d+)*\.?\s*/, '')
    // IEEE のローマ数字の節番号（`iv. results` → `results`）
    .replace(/^[ivx]{1,5}\.\s+/, '')
    .replace(/[^a-z \p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/gu, '')
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
      top: minOf(ys),
      bottom: maxOf(ys),
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
  /**
   * そのうち、本文の塊から**3 行ぶん以上**離れているもの。
   *
   * 柱は天地の余白に組まれるので、本文の塊とはそれだけ離れる。段の先頭に来る
   * 節見出しは本文と 1〜2 行ぶんしか離れないので、ここで見分けられる。
   *
   * 「同じ柱が複数ページに出ていること」だけを条件にしていたときは、
   * 1 ページ目が plain（柱なし）の 2 ページ論文で柱が 1 回しか現れず、落とせずに
   * **本文の文の途中へ挟まっていた**（実測: `ページの変` ＋ `情報処理学会論文誌` ＋
   * `わり目で…`）。ページをまたぐ文の真ん中に別の文字列が入るので、
   * 読む側には「原文がそう書いてある」ようにしか見えない。
   */
  const detachedFromBody = new Set<number>();
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
      // 本文の塊から 3 行ぶん以上離れているか（説明は detachedFromBody を参照）。
      if (next !== undefined && Math.abs(next.y - band[0]!.y) > spacing * DETACHED_SPACINGS) {
        for (const line of band) detachedFromBody.add(line.index);
      }
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
      left: minOf(kept.map((chunk) => chunk.x)),
      right: maxOf(kept.map((chunk) => chunk.x + chunk.w)),
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
    return !SENTENCE_END.test(previous.text);
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
    const stillOpen = (line: Line): boolean => reachesRight(line) || !SENTENCE_END.test(line.text);
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
  /**
   * その行が「文章」として読めるか。
   *
   * 落としてよい行（別行立ての数式・表のセル・擬似コード）と、落としてはいけない行
   * （インライン数式が入っているだけの本文）を分ける、最後の歯止め。
   *
   * ML・統計・物理の論文は、技術的な段落のほぼ全行にギリシャ文字か添字が入る。
   * 「数式らしさ」や「版面」だけで落とすと本文が丸ごと消える。実測（pdflatex の
   * 2 段組）で、同じ文章にインライン数式を入れただけで 4 文すべてが消え、
   * 残骸が `2 Same prose with inline Greek which proves the claim.` という
   * **文法の通る英文**に癒着した。もっともらしいので、訳を読む側には
   * 「論文がそう書いてある」としか見えない。消える方がまだ気付ける。
   *
   * 見るのは版面と語の両方:
   *   - 機能語がある（the / of / and …）。数式にも表のセルにもまず無い。
   *   - 小文字の語が 3 つ以上ある。数式と表は大文字・記号・数字が多い。
   *   - 段の右端まで届いている（＝組版が折り返しただけの行）か、文末記号で閉じている。
   *     別行立ての数式も表のセルも擬似コードも、段の右端には届かない。
   */
  /** 文章として読める行か（定義は looksLikeProse を参照）。 */
  /** 文章として読める行か。定義は looksLikeProse（採録率の物差しと同じもの）。 */
  /** その行が段の左端にそろっているか（段落の最終行を守るために使う）。 */
  const atColumnLeft = (line: Line): boolean => {
    const left = columnLeft.get(`${line.page}:${line.column}`);
    return left !== undefined && Math.abs(line.left - left) <= 2;
  };
  const readsAsProse = (line: Line): boolean =>
    looksLikeProse(line, reachesRight(line), atColumnLeft(line));

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
      if (SENTENCE_END.test(stripped)) return false;
      // 文章として読める行は、組版が折り返した本文。別行立ての要素ではありえない。
      // 「段の右端に届く」だけを条件にしてはいけない — 別行立ての数式も、
      // 右にぶら下がる式番号のぶんで段の右端まで届く。
      if (readsAsProse(line)) return false;
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
          // 文章として読める行は、塊の続きではなく本文。ここで止める。
          // この歯止めが無いと、添字が独立した行になった数ページぶんの本文が
          // 「詰まって積まれている」という理由だけで道連れに落ちる。
          if (readsAsProse(line)) break;
          const stacked = gap < spacing * 0.8;
          // 本文行は段の左端に揃うので、字下げの揃った行だけが表の続きになりうる。
          if (!stacked && Math.abs(line.left - anchor.left) > 2) break;
          displayBlock.add(line.index);
          previous = line;
        }
      }
    }

    /**
     * 塊の**穴埋め**。上下を塊に挟まれた 1 行だけの取りこぼしを拾う。
     *
     * 別行立ての塊は行送りが不揃いなので、塊の伸ばし方（上の繰り返し）が
     * 「間隔が広い」という理由で途中で止まることがある。すると塊の中の行が
     * **一行おきに**本文に残り、読めない断片が対訳に並ぶ。
     * 実測（`rotating` の `sidewaystable`、ページごと回った表）:
     *   `Memory Latency Accuracy Patternblock-4block-8dense`
     * という文が本文として出ていた。
     *
     * 本文を落とさないよう、条件はきつくする。上下がどちらも塊で、
     *   - 段幅に対して短く、
     *   - 句読点で閉じておらず、
     *   - 機能語を 1 つも持たず（`and therefore` のような繋ぎの行を守る）、
     *   - 語が 3 つ以下
     * のときだけ塊に入れる。表の見出しのセル（`Memory` / `Accuracy`）はこれに当たる。
     */
    const byColumn = new Map<string, Line[]>();
    for (const line of lines) {
      const key = `${line.page}:${line.column}`;
      const list = byColumn.get(key);
      if (list) list.push(line);
      else byColumn.set(key, [line]);
    }
    for (const columnLines of byColumn.values()) {
      // 字形の取れなかった行（空文字列）は素通しする。挟まれているかどうかの判定で
      // これを数えると、間に 1 つ挟まっただけで穴埋めが効かなくなる。
      const sorted = [...columnLines].sort((a, b) => a.y - b.y).filter((line) => line.text.trim().length > 0);
      /** 塊の縁。別行立ての行そのものか、その図表のキャプション。 */
      const edge = (line: Line | undefined): boolean =>
        line !== undefined && (displayBlock.has(line.index) || isCaption(line.text));
      /** 塊の続きとして拾ってよい行か（本文を落とさないよう条件はきつくする）。 */
      const fillable = (line: Line): boolean => {
        const text = line.text.trim();
        if (text.length === 0 || CLAUSE_END.test(text)) return false;
        // 見出しは塊の続きではない。番号つきの節見出しは短くて機能語も句読点も無いので、
        // ここで外さないと図表に挟まれた節見出しが丸ごと消える
        // （実測: `1 Setting` が表として落ち、節が 1 つ減っていた）。
        if (KNOWN_HEADINGS.has(bareHeading(text)) || headingNumber(text) !== null) return false;
        if (line.height > bodyHeight * 1.12) return false;
        // `and therefore` のような繋ぎの行を守る。
        if (FUNCTION_WORDS.test(text)) return false;
        if ((text.match(/\S+/g) ?? []).length > 3) return false;
        const width = columnWidth.get(`${line.page}:${line.column}`) ?? 0;
        return width > 0 && line.right - line.left < width * 0.7;
      };

      let i = 0;
      while (i < sorted.length) {
        if (displayBlock.has(sorted[i]!.index)) {
          i++;
          continue;
        }
        let j = i;
        while (j < sorted.length && !displayBlock.has(sorted[j]!.index)) j++;
        const run = sorted.slice(i, j);
        if (
          run.length > 0 &&
          run.length <= FILL_MAX_LINES &&
          edge(sorted[i - 1]) &&
          edge(sorted[j]) &&
          run.every(fillable)
        ) {
          for (const line of run) displayBlock.add(line.index);
        }
        i = j + 1;
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
   * **本文の文字高**。逐語ブロックの判定だけに使う。
   *
   * `bodyTextHeight` は文字数で重み付けするので、コードの塊が本文より字数の多い
   * ページでは**コードの字高が「本文の字高」になる**（実測: 本文 4 行・
   * `lstlisting` 18 行のページで 9.96pt ではなく 8.97pt が選ばれた）。
   * ここは「文章として読める行」だけで測り直す。
   */
  const proseHeight = (() => {
    const weight = new Map<number, number>();
    for (const line of lines) {
      if (!readsAsProse(line)) continue;
      const bucket = Math.round(line.height * 2) / 2;
      weight.set(bucket, (weight.get(bucket) ?? 0) + line.text.length);
    }
    let best = 0;
    let most = 0;
    for (const [height, chars] of weight) {
      if (chars > most) {
        most = chars;
        best = height;
      }
    }
    return best || bodyHeight;
  })();

  /**
   * 逐語ブロック（`lstlisting` / `verbatim` / `minted`）の行。
   *
   * `algorithmic` は行番号 `1:` の形で塊として落とせるが、`listings` と `verbatim` には
   * その手掛かりが無い。行ごとに独立して判定すると `looksLikeFormula` の
   * 「英字比率 0.6 未満」という条件を**一行おきに**跨いでコードが `body` と `formula` に
   * 割れ、**直後の本文段落までコード断片と 1 文になる**。実測（`verbatim` の Python 13 行）:
   *
   *   `def sparse_attention(q, k, v, pattern): scores = scores / math.sqrt(...) … return out
   *    We measured the runtime of this implementation on a single accelerator and …`
   *
   * 申告は 3 つとも low なので、読む側には「原文がそう書いてある」としか見えない。
   *
   * **字の大きさで見分けてはいけない。** `listings` は `\ttfamily\small` で組むのが
   * ふつうだが、LaTeX 標準の `verbatim` は**本文と同じ大きさ**の `\ttfamily` なので
   * 高さの差がゼロ。逆に、字を小さくしただけの箇条書き・用語定義・引用
   * （`{\small \begin{itemize}` の貢献一覧など）は高さの差で通ってしまい、
   * **読者がいちばん訳を欲しがる本文**が「訳しません」として消えた
   * （実測: `t/bullets.pdf` の 5 項目、`t/deflist2.pdf` の用語定義 5 件、
   * `t/quote2.pdf` の引用 5 行。しかも逐語ブロックは定義上「文章として読めない行」
   * だけで出来ているので、採録率は原理的に 1 のままで申告も出ない）。
   *
   * 見るのは**塊としての形**:
   *   - 文章として読めない行が 4 行以上続く
   *   - 文末記号で閉じる行が 1 つも無い（句点を打つ箇条書きはここで外れる）
   *   - 右端がばらけている（両端揃えの要旨・引用はここで外れる）
   *   - **記号を含む行が 6 割以上**（`()[]{}=:;_@/` など。コードの地の文。
   *     箇条書き・用語定義・引用・表のセルはこれを 1 つも持たない）
   *   - 数式として読める行が半分以下（別行立ての数式の塊を逐語と呼ばないため）
   * 空行（行番号だけの行、字形の取れなかった行）は塊を切らない — 切ると
   * 1 行ずつの断片に割れて、この判定そのものが働かない。
   */
  const verbatim = new Set<number>();
  {
    const byColumn = new Map<string, Line[]>();
    for (const line of lines) {
      const key = `${line.page}:${line.column}`;
      const list = byColumn.get(key);
      if (list) list.push(line);
      else byColumn.set(key, [line]);
    }
    for (const columnLines of byColumn.values()) {
      const sorted = [...columnLines].sort((a, b) => a.y - b.y);
      /** 空行は塊を切らない（行番号だけの行・字形の取れなかった行）。 */
      const blank = (line: Line): boolean => line.text.trim().length === 0;
      /** 文章として読めない行。この歯止めが本文を守る。 */
      const coded = (line: Line): boolean => !blank(line) && !readsAsProse(line);

      /**
       * 右端がばらけているか。**両端揃えの塊（要旨・引用）を外すための門。**
       * 組版が折り返した段落はどの行も同じ右端で終わるが、コードは 1 行ごとに
       * 長さが違う。この条件が無いと `\small` の要旨が丸ごと落ちる
       * （実測: onecolumn の Abstract 3 行）。
       */
      const scattered = (run: readonly Line[]): boolean => {
        const counts = new Map<number, number>();
        for (const line of run) {
          const key = Math.round(line.right / 2);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        let most = 0;
        for (const count of counts.values()) if (count > most) most = count;
        return most < run.length * 0.5;
      };

      /**
       * 記号を含む行の割合。**箇条書き・用語定義・引用を外すための門。**
       *
       * コードは括弧・等号・コロン・下線・スラッシュが地の文になる。
       * 貢献一覧（`• A block sparse attention kernel`）も用語定義
       * （`Block a contiguous span of keys`）も引用（`attention is all you need`）も
       * これを**1 つも持たない**。字の大きさや機能語の有無より確実に分かれる
       * （`• A block sparse attention kernel` には機能語が 1 つも無い）。
       */
      const codeLike = (run: readonly Line[]): boolean => {
        let withSymbols = 0;
        let formulaic = 0;
        for (const line of run) {
          const text = line.text.trim();
          if ((text.match(CODE_SYMBOLS) ?? []).length >= MIN_CODE_SYMBOLS) withSymbols++;
          if (looksLikeFormula(text)) formulaic++;
        }
        return (
          withSymbols >= run.length * MIN_CODE_LINE_RATIO &&
          formulaic <= run.length * MAX_FORMULA_LINE_RATIO
        );
      };

      let i = 0;
      while (i < sorted.length) {
        const start = sorted[i]!;
        if (!coded(start)) {
          i++;
          continue;
        }
        const height = start.height;
        const run: Line[] = [];
        let end = i;
        for (let j = i; j < sorted.length; j++) {
          const line = sorted[j]!;
          // 空行と、塊の字よりさらに小さい行（行番号・字形の取れなかった行）は素通し。
          if (blank(line) || line.height < height * 0.7) continue;
          if (!coded(line) || Math.abs(line.height - height) > height * 0.05) break;
          run.push(line);
          end = j;
        }
        // 文末記号で閉じる行が 1 つでもあれば文章の塊。コードの行はそう終わらない。
        const closes = run.some((line) => SENTENCE_END.test(line.text.trim()));
        if (run.length >= MIN_VERBATIM_LINES && !closes && scattered(run) && codeLike(run)) {
          for (let k = i; k <= end; k++) verbatim.add(sorted[k]!.index);
          i = end + 1;
        } else {
          i++;
        }
      }
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
   * IEEE の小節（`A. FORCE learning` / `B. Learning algorithms`）。ローマ数字の節の中で
   * A, B, C … と順に並ぶ。英字 1 文字の見出しは付録（`A Proof …`）や人名のイニシャルと
   * 形が同じなので、**ローマ数字の節見出しの後ろで連番になっているときだけ**数える。
   */
  let lastLetter = -1;
  for (const line of [...lines].sort((a, b) => a.index - b.index)) {
    if (romanHeading(line.text) !== null) {
      lastLetter = 0;
      continue;
    }
    if (lastLetter < 0) continue;
    const letter = /^([A-Z])\.\s+\p{Lu}/u.exec(line.text);
    if (!letter || line.text.length > 80 || CLAUSE_END.test(line.text)) continue;
    const code = letter[1]!.charCodeAt(0) - 64;
    if (code === lastLetter + 1) {
      monotonic.add(line.index);
      lastLetter = code;
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
    // 見出しを立てない要旨（`Abstract—…`）も、そこで前付が終わる目印になる
    if (KNOWN_HEADINGS.has(bareHeading(line.text)) || headingNumber(line.text) !== null || RUN_IN_ABSTRACT.test(line.text)) {
      frontMatterUntil = line.index;
      break;
    }
  }

  /**
   * 表題の行。1 ページ目の先頭で、本文よりはっきり大きな文字で組まれた行のかたまり。
   *
   * 表題は前付の一部だが、前付の範囲（frontMatterUntil）は節見出しが見つからないと決まらない。
   * 見出しの形を知らない体裁で範囲が空になると、表題が本文に残るうえ、
   * **2 行目以降が大きな文字ゆえに節見出しとして拾われる**（実測: `via Oja’s Plasticity` が節の名前になった）。
   * 表題は文字の大きさだけで見分けられるので、範囲とは別に必ず落とす。
   */
  const titleLines = new Set<number>(
    titleBlock(lines.filter((line) => line.page === 1 && !edgeCandidate.has(line.index)), bodyHeight).map((line) => line.index),
  );

  const frontMatterLines = new Set<number>(titleLines);
  for (const line of lines) {
    if (line.page !== 1 || line.index >= frontMatterUntil) break;
    if (RUN_IN_ABSTRACT.test(line.text)) break;
    // 複数ページで繰り返される柱とノンブルは版面の付物。表題の上に出ていても
    // 前付を終わらせない（種類は別のところで決まるので、ここでは読み飛ばす）。
    // 「端にある行」だけで読み飛ばすと、表題そのものが素通りして本文に残る。
    const repeatedOn = repeated.get(line.text.replace(/\d+/g, '#'))?.size ?? 0;
    if (/^\d{1,4}$/.test(line.text) || (edgeCandidate.has(line.index) && repeatedOn >= 2)) continue;
    // 文末記号は和文（。！？）も見る。ここを欧文だけにしていると、
    // 和文のアブストラクトが前付として丸ごと落ちる。
    if (/[.!?。！？]["'’”)\]）」』]?$/.test(line.text)) break;
    frontMatterLines.add(line.index);
  }

  /**
   * この行が、版面の規則だけで**すでに付物と分かっている**か。
   *
   * 見出しの合算点で「直前の行が文を閉じていない＝段落の途中」を見るときに要る。
   * 直前が付物なら、そこに続いている文は無いので、その減点は当たらない。
   */
  const knownFurniture = (index: number): boolean =>
    inTail.has(index) ||
    footnote.has(index) ||
    continuation.has(index) ||
    frontMatterLines.has(index) ||
    displayBlock.has(index) ||
    pseudocode.has(index) ||
    verbatim.has(index);

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
      reachesRight: reachesRight(line),
      role: 'furniture' as const,
      // 参考文献の各エントリと各キャプションは、続きの行と束ねずに 1 件ずつ出す。
      startsBlock: isCaption(line.text) || REFERENCE_ENTRY.test(line.text),
      // 版面の規則でしか落ちなかった行（表・数式・その他）が前付の位置にあるなら、
      // それは著者行や所属。柱・ノンブル・キャプション・参考文献は、
      // 1 ページ目にあっても種類がはっきりしているのでそのままにする。
      kind:
        (line.index < frontMatterUntil || titleLines.has(line.index)) && (kind === 'table' || kind === 'formula' || kind === 'other')
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
    // 1 回しか出ない柱（1 ページ目が plain の 2 ページ論文）は、本文の塊から
    // 離れていることで見分ける。前付は種類がはっきりしているのでここでは扱わない。
    if (
      nearEdge &&
      edgeCandidate.has(line.index) &&
      pageCount >= 2 &&
      (seenOn >= 2 || (detachedFromBody.has(line.index) && !frontMatterLines.has(line.index)))
    ) {
      return drop(isPageNumber ? 'pageNumber' : 'runningHead');
    }
    /**
     * 端に出る数字だけの行はノンブル。1 ページでも落としてよい。
     *
     * ただし**天地の端の帯に出ているもの**（edgeCandidate）に限る。`nearEdge` は
     * 「ページの上下 15%」という緩い位置しか見ていないので、本文が短いページでは
     * 5〜6 行目でも `nearEdge` になる。
     *
     * ここを閉めないと、インライン `\frac` の**分母が置き場所を間違えて**
     * 独立した行になったときに、それが「ノンブル」として落ちる。ノンブルは
     * 種類のはっきりした付物なので継ぎ目の印の相手にならず、
     * 分母を失った文（実測: `η∥∇F ∥2 ≥ η2(1 − δ)ζ2/4, as claimed.` — 本来は η/2）も、
     * 余った数字を受け取った文も、**印が付かないまま**並ぶ。
     * 落ちた断片は「本文だったかもしれないもの」として残さなければならない。
     */
    if (isPageNumber && edgeCandidate.has(line.index)) {
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
    const endsOpen = !CLAUSE_END.test(line.text);

    // 擬似コードの行。版面では本文と見分けが付かないので、行番号の形で決める
    // （説明は PSEUDOCODE_LINE を参照）。数式の判定より先に見る — 塊の中の行が
    // 「演算子のある行だけ数式、残りは本文」と割れると、かえって読めない断片が並ぶ。
    if (pseudocode.has(line.index) || verbatim.has(line.index)) {
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
      /**
       * **本文より低くて短い断片は「表」ではない。**
       *
       * 分数の分子・分母、添字、∑ の上下の限界は、演算子を 1 つも含まないことが多い
       * （`4` / `t` / `nμ` / `M` / `k`）。演算子の有無だけで決めていたので、
       * インライン分数の分母が落ちると画面が「本文として取り出せなかった**表**が
       * 挟まっています」と言っていた。**PDF に表は無い**ので、読む側が探しに行く羽目になる。
       * 数式の断片は数式と呼ぶ。
       */
      const fragment =
        line.height < proseHeight * FRAGMENT_HEIGHT_RATIO &&
        stripped.replace(/\s+/g, '').length <= FRAGMENT_MAX_CHARS;
      return drop(
        fragment || /[=+\-*/^_<>|∑∏∫√≈≤≥±×·≠∈∀∃]/u.test(stripped) ? 'formula' : 'table',
      );
    }

    // 見出しは弱い手掛かりの合算で決める。単独の規則には必ず反例がある
    // （番号だけを見ると箇条書きが見出しになり、文字高だけを見ると
    //  参考文献の多い論文で本文が見出しになる）。
    /**
     * 幅の門は「短いこと」だけでは足りない。段幅ちょうどまで伸びた見出しがある
     * （実測: 付録の見出し `A Proof of the Obstruction` が段幅の 71%。門は 70%）。
     * 本文より明らかに大きい文字で組まれていれば、幅に関わらず見出しの候補にする —
     * 本文の行がその大きさで組まれることはない。落ちると見出しが次の文と癒着し、
     * 付録の中身が見出しごと 1 枚のカードに入る。
     */
    const headingCandidate = isShort || line.height > bodyHeight * 1.12;
    if (headingCandidate && endsOpen && line.text.length <= 80) {
      const previous = previousLine.get(line.index);
      let score = 0;
      if (KNOWN_HEADINGS.has(bareHeading(line.text))) score += 2;
      if (line.height > bodyHeight * 1.12) score += 1;
      if (monotonic.has(line.index)) score += 1;
      if (APPENDIX_HEADING.test(line.text)) score += 1;
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
      //
      // 直前の行が**本文でない**ときも、この減点は当たらない。表題・著者・所属や
      // 図表キャプション・参考文献は文末記号で終わらないが、そこに「続いている文」は
      // 無い。実測（和文 1 段組）で、著者行の直後に来た `概要` が -1 で本文に落ち、
      // 要旨の 1 文目と 1 文に癒着していた（`…文境界の推定概要本稿では、…`）。
      // 直前が節見出しそのもの（`II. METHODS` の直後の `A. FORCE learning`）のときも当たらない。
      else if (
        previous &&
        !knownFurniture(previous.index) &&
        !SENTENCE_END.test(previous.text) &&
        !(KNOWN_HEADINGS.has(bareHeading(previous.text)) || headingNumber(previous.text) !== null)
      )
        score -= 1;
      if (score >= 2) return { ...line, reachesRight: reachesRight(line), role: 'heading' as const };
    }

    return { ...line, reachesRight: reachesRight(line), role: 'body' as const };
  });
}



/**
 * 「文章として読める行か」の判定。
 *
 * 落としてよい行（別行立ての数式・表のセル・擬似コード）と、落としてはいけない行
 * （インライン数式が入っているだけの本文）を分ける、最後の歯止め。
 * **落とさないための歯止めと、失われた量を数える物差しが、同じ 1 つの定義を使う。**
 * 別々に書くと、直したつもりの穴が計測をすり抜ける。
 *
 * ML・統計・物理の論文は、技術的な段落のほぼ全行にギリシャ文字か添字が入る。
 * 「数式らしさ」や「版面」だけで落とすと本文が丸ごと消える。実測（pdflatex の
 * 2 段組）で、同じ文章にインライン数式を入れただけで 4 文すべてが消え、残骸が
 * `2 Same prose with inline Greek which proves the claim.` という**文法の通る
 * 英文**に癒着した。もっともらしいので、訳を読む側には「論文がそう書いてある」と
 * しか見えない。消える方がまだ気付ける。
 *
 * 見るのは版面と語の両方:
 *   - 機能語がある（the / of / and …）。数式にも表のセルにもまず無い。
 *   - 小文字の語が 3 つ以上ある。数式と表は大文字・記号・数字が多い。
 *   - 段の右端まで届いている（＝組版が折り返しただけの行）か、文末記号で閉じている。
 *     別行立ての数式も表のセルも擬似コードも、段の右端には届かない。
 */
function looksLikeProse(line: Line, reachesRight: boolean, atColumnLeft: boolean): boolean {
  const text = line.text;
  const squeezed = text.replace(/\s+/g, '');
  if (!(reachesRight || SENTENCE_END.test(text.trim()))) return false;

  // 欧文: 機能語があり、小文字の語が 3 つ以上ある。
  if (
    squeezed.length >= PROSE_MIN_CHARS &&
    FUNCTION_WORDS.test(text) &&
    (text.match(/\b\p{Ll}{2,}\b/gu) ?? []).length >= PROSE_MIN_WORDS
  ) {
    return true;
  }

  /**
   * 欧文の短い行: **段の左端にそろい**、語と約物だけでできていて、文末記号で閉じている。
   *
   * 機能語（the / of / and）を必須にすると、**段落の最終行**が守れない。
   * 最終行は短いので機能語が 1 つも無いことがふつうにあり、語数も 2 つまで落ちる。
   * 実測（`\vspace{-0.6em}` で式を本文に寄せた 2 段組）: 段落の最後の行
   * `published baseline.` が別行立ての塊に吸われ、
   * `The method achieves a substantial improvement over the strongest Sparse
   * attention reduces the quadratic cost …` という**原文に無い、しかも文法の通る
   * 文**になった。申告は 3 つとも low のまま。もっともらしいので読む側には気付けない。
   *
   * 語数を 2 つまで下げるかわりに、条件を 2 つ足して別行立てと分ける:
   *   - **段の左端にそろっている。** 別行立ての数式も表も中央寄せか字下げなので、
   *     段の左端ちょうどには来ない（来る組み方 — fleqn — でも字下げが入る）。
   *   - **語と約物しか無い。** 等号・不等号・添字・数字・括弧が 1 つでもあれば通らない。
   *     `A = 11 12, b = x2.` も `Dense 81.2 79.4` も `Model Acc F1` も外れる。
   */
  if (
    atColumnLeft &&
    PLAIN_WORDS.test(text.trim()) &&
    (text.match(/\b\p{Ll}{2,}\b/gu) ?? []).length >= PROSE_MIN_WORDS_TAIL
  ) {
    return true;
  }

  /**
   * 和文: ひらがなが 3 文字以上ある。
   *
   * 和文には機能語を空白で切り出す手掛かりも大文字小文字も無いので、欧文の条件では
   * どの和文行も「文章ではない」ことになり、落としてはいけない行を守る歯止めも、
   * 失われた量を数える物差しも、和文では一度も働かない。
   * ひらがなは助詞と活用語尾にしか使わない — 別行立ての数式にも表のセルにも
   * まず現れないので、これだけで本文かどうかが決まる。
   * 1 文字の情報量が多いので、長さの下限は欧文より短くてよい。
   */
  if (
    squeezed.length >= PROSE_MIN_CHARS_CJK &&
    (text.match(/\p{Script=Hiragana}/gu) ?? []).length >= PROSE_MIN_WORDS
  ) {
    return true;
  }
  return false;
}

/**
 * 段ごとの代表的な右端と左端を取り直して、「その行は文章として読めるか」を返す関数を作る。
 *
 * classifyLines の中にも同じ判定がある。こちらは行だけを受け取る外向きの入口
 * （assessCoverage）のために作り直す — assessReadingOrder も同じやり方をしている。
 * 落としてよいかの歯止めと、失われた量の物差しは**同じ定義**でなければならない。
 */
function proseTestOf(lines: readonly ClassifiedLine[]): (line: Line) => boolean {
  const rights = new Map<string, number[]>();
  const widths = new Map<string, number[]>();
  const lefts = new Map<string, number[]>();
  for (const line of lines) {
    const key = `${line.page}:${line.column}`;
    const r = rights.get(key);
    if (r) r.push(line.right);
    else rights.set(key, [line.right]);
    const w = widths.get(key);
    if (w) w.push(line.right - line.left);
    else widths.set(key, [line.right - line.left]);
    const l = lefts.get(key);
    if (l) l.push(line.left);
    else lefts.set(key, [line.left]);
  }
  const right = new Map<string, number>();
  for (const [key, values] of rights) right.set(key, percentile(values, 0.05));
  const width = new Map<string, number>();
  for (const [key, values] of widths) width.set(key, percentile(values, 0.1));
  const left = new Map<string, number>();
  for (const [key, values] of lefts) left.set(key, median(values));
  return (line: Line): boolean => {
    const key = `${line.page}:${line.column}`;
    const edge = right.get(key);
    const span = width.get(key);
    if (edge === undefined || span === undefined || span <= 0) return false;
    const reaches = line.right >= edge - Math.max(2, span * 0.03);
    const start = left.get(key);
    const atLeft = start !== undefined && Math.abs(line.left - start) <= 2;
    return looksLikeProse(line, reaches, atLeft);
  };
}

/** これを下回ったら「本文を落としている疑い」を申告する。 */
const MIN_COVERAGE = 0.98;

/**
 * 版面の規則だけで落とした種類。ここに入るものは「本文かもしれない」。
 *
 * 柱・ノンブル・キャプション・参考文献・脚注・前付は、位置や書き出しの形という
 * **構造の手掛かり**で決めているので、落としたことに確信がある。
 * 数式・表・擬似コードは版面の見え方だけで決めているので、外れることがある。
 */
const UNCERTAIN_KINDS = new Set<NonBodyKind>(['formula', 'table', 'other']);

/**
 * その種類は「版面の規則だけで落とした」ものか。
 *
 * 柱・ノンブル・キャプション・参考文献・脚注・前付は、位置や書き出しの形という
 * 構造の手掛かりで決めているので、落としたことに確信がある。数式・表・擬似コードは
 * 版面の見え方だけで決めているので外れることがあり、**本文の一部**だったかもしれない。
 * 文に印を付けるかどうかの判断でも同じ線引きを使う（sentences.ts から参照）。
 */
/** 置き場所を間違えた断片と認める、文字数の上限。 */
const FRAGMENT_MAX_CHARS = 4;
/** 置き場所を間違えた断片と認める、本文の文字高に対する高さの比。 */
const FRAGMENT_HEIGHT_RATIO = 0.95;
/** 置き場所を間違えた断片と認める、隣の行との距離（本文の文字高に対する比）。 */
const FRAGMENT_GAP_RATIO = 1.1;

/**
 * 「落ちた断片」ではなく「**置き場所を間違えた断片**」を見つける。
 *
 * 継ぎ目の印は、版面の規則で**落とした**行と文の矩形を比べて立てている。
 * ところが断片は落ちるとは限らない。隣の本文の矩形に**取り込まれる**方が多い。
 * 数学の論文ではインライン `\frac` が普通なので、件数はこちらの方が多くなる。
 *
 * 実測（レビュアーの本文 136 文）: 欠落 5 件（印 5）／移動 6 件（印 2）。
 * 2 段組にインライン `\frac` を 4 つ置いた論文では、分母 4 つが**全部**動き、
 * そのうち 2 つには印が付かなかった:
 *   - `[48] … ≥ η2(1 − δ)ζ2, as claimed.` が `/4` を失い、
 *     `[49] The constant 1/4 is not t 4 optimised.` が余った `4` と `t` を受け取った。
 *     受け取った側の断片の高さは 8.91、本文は 9.96。
 *   - `min nμ imax`（分母 `nμ` が "minimax" に突き刺さった）、`uncompressed M cost`。
 *
 * 見分け方は矩形だけ:
 *   - 本文の文字高より**低い**（8.91 / 9.96 = 0.89 なので 0.85 では届かない）
 *   - 文字数が数文字しかない（分子・分母・添字・大きな演算子の記号）
 *   - **隣の本文行の x 範囲の内側**にある（段の外へはみ出した行番号や式番号は外れる）
 *   - 隣の本文行との距離が 1 行ぶんに満たない（＝行と行の間に押し込まれている）
 *
 * 高さの門を 0.95 まで緩めるかわりに、残り 3 つを全部満たすことを求める。
 * 4 文字以下で本文の字より低く、しかも隣の行の内側に 1 行ぶん未満の距離で
 * 収まっている行は、組版の結果としては本文の行になりえない。
 *
 * 返すのは**行の番号**。どの文に印を付けるかは、行と文の対応を持っている側
 * （sentences.ts の findSeam）が決める。
 */
export function findDisplacedFragments(lines: readonly ClassifiedLine[]): Set<number> {
  const found = new Set<number>();
  if (lines.length === 0) return found;
  const bodyHeight = bodyTextHeight(lines);
  if (bodyHeight <= 0) return found;

  const byColumn = new Map<string, ClassifiedLine[]>();
  for (const line of lines) {
    const key = `${line.page}:${line.column}`;
    const list = byColumn.get(key);
    if (list) list.push(line);
    else byColumn.set(key, [line]);
  }

  for (const columnLines of byColumn.values()) {
    const sorted = [...columnLines].sort((a, b) => a.y - b.y);
    for (let i = 0; i < sorted.length; i++) {
      const line = sorted[i]!;
      if (line.role !== 'body') continue;
      const squeezed = line.text.replace(/\s+/g, '');
      if (squeezed.length === 0 || squeezed.length > FRAGMENT_MAX_CHARS) continue;
      if (line.height >= bodyHeight * FRAGMENT_HEIGHT_RATIO) continue;

      for (const neighbour of [sorted[i - 1], sorted[i + 1]]) {
        if (neighbour === undefined || neighbour.role !== 'body') continue;
        if (neighbour.height < bodyHeight * FRAGMENT_HEIGHT_RATIO) continue;
        // 隣の行の x 範囲の内側か。1pt は組版の端数。
        if (line.left < neighbour.left - 1 || line.right > neighbour.right + 1) continue;
        // 行と行の間に押し込まれているか（1 行ぶんの送りには足りない距離）。
        if (Math.abs(line.y - neighbour.y) > bodyHeight * FRAGMENT_GAP_RATIO) continue;
        found.add(line.index);
        break;
      }
    }
  }
  return found;
}

export function isUncertainKind(kind: NonBodyKind | undefined): boolean {
  return UNCERTAIN_KINDS.has(kind ?? 'other');
}

/**
 * 「何が失われたかを数える」物差し。
 *
 * `assessMergedColumns` は**生き残った本文行**を走査するので、落とされた行は
 * 検出器の入力に一度も入らない。消去は原理的に検出できない。だから別建てで、
 * 「行になった文字のうち、行き先の説明が付いた割合」を測る。
 *
 * 誤検出を出さないことを最優先にしてある。正しく落としているもの（参考文献・柱・
 * ノンブル・図表キャプション・脚注・前付）は失われた側に数えない。版面の規則だけで
 * 落とした行も、**文章として読めなければ**数えない（別行立ての数式・表のセル・
 * 擬似コードは、落として正しい）。数えるのは「文章として読めるのに、数式や表として
 * 落とした行」だけ。
 *
 * 実測: 正しく取れている論文 5 本（1 段組・2 段組・擬似コード・定理・アルゴリズム）で
 * いずれも 100.0%。本文が消えていた 3 本で 77.7% / 70.5% / 93.9%。
 * 閾値 98% は、この間に十分な余裕をもって引ける位置。
 */
export function assessCoverage(lines: readonly ClassifiedLine[]): {
  coverage: number;
  coverageRisk: 'low' | 'high';
  coverageReason: string;
} {
  const squeeze = (text: string): number => text.replace(/\s+/g, '').length;
  const readsAsProse = proseTestOf(lines);

  let total = 0;
  let lost = 0;
  const pages = new Set<number>();
  for (const line of lines) {
    const size = squeeze(line.text);
    total += size;
    if (line.role !== 'furniture') continue;
    if (!UNCERTAIN_KINDS.has(line.kind ?? 'other')) continue;
    if (!readsAsProse(line)) continue;
    lost += size;
    pages.add(line.page);
  }

  const coverage = total === 0 ? 1 : (total - lost) / total;
  if (coverage >= MIN_COVERAGE) {
    return {
      coverage,
      coverageRisk: 'low',
      coverageReason:
        '本文として読める行を数式や表として落とした形跡はありませんでした（欠落が無いことの保証ではありません）。',
    };
  }
  const shown = [...pages].sort((a, b) => a - b);
  const list = shown.slice(0, 5).join(', ') + (shown.length > 5 ? ' ほか' : '');
  return {
    coverage,
    coverageRisk: 'high',
    coverageReason:
      `${list} ページで、文章として読める行を数式や表として落としている疑いがあります` +
      `（本文の ${Math.round((1 - coverage) * 100)}% 相当、${lost} 文字）。` +
      '消えた文が残りの文と繋がって、もっともらしい別の文になっている可能性があります。原文と PDF を見比べてください。',
  };
}

/**
 * 解析結果の確からしさ。読み順の崩れと、本文の欠落を別々に見る。
 *
 * 名前が `assessReadingOrder` のままなのは、呼び出し側（sentences.ts）から見て
 * 「解析の自己申告を作る入口」がここ 1 つだから。中身は 2 本の独立した物差し。
 */
export function assessReadingOrder(lines: readonly ClassifiedLine[]): StructureQuality {
  return { ...assessMergedColumns(lines), ...assessCoverage(lines) };
}

/**
 * 1 ページ目の表題の行（読む順に並べたもの）。見つからなければ空。
 *
 * 表題は前付にしかないので、探すのは「最初の節見出し（または見出しを立てない要旨）より前」だけ。
 * そこでいちばん大きな文字の行から始めて、**同じ大きさの行を、行送りが続くかぎり**拾う。
 * 間に挟まる小さな行は読み飛ばす — Frontiers のように左に細い段（編集者・受理日）を置く体裁では、
 * 表題の 1 行目と 2 行目の間にその段の行が y の順で割り込む。そこで打ち切っていた頃は
 * 表題の 2 行目以降が大きな文字ゆえに**節見出しとして拾われていた**（実測: `extraction of slowly
 * time-varying` 以下 4 行が節の名前になった）。
 *
 * 本文と同じ大きさの文字しか無ければ表題は見分けられないので、空を返す。
 */
function titleBlock(firstPage: readonly Line[], body: number): Line[] {
  if (body <= 0) return [];
  const sorted = [...firstPage].filter((line) => line.text.trim().length > 0).sort((a, b) => a.y - b.y || a.left - b.left);
  const front: Line[] = [];
  for (const line of sorted) {
    if (KNOWN_HEADINGS.has(bareHeading(line.text)) || headingNumber(line.text) !== null || RUN_IN_ABSTRACT.test(line.text)) break;
    front.push(line);
  }
  if (front.length === 0) return [];
  const largest = maxOf(front.map((line) => line.height));
  if (largest < body * 1.15) return [];

  const TOLERANCE = 0.9;
  const block: Line[] = [];
  for (const line of front) {
    const big = line.height >= largest * TOLERANCE;
    if (block.length === 0) {
      // 表題は文末記号で終わらない。大きな文字でも文として閉じた行は本文（本文が 1〜2 行しか無い文書など）
      if (big && !SENTENCE_END.test(line.text.trim())) block.push(line);
      else if (big) return [];
      continue;
    }
    // 行送りが大きく空いたら、そこから先は表題ではない（著者名・要旨）
    if (line.y - block[block.length - 1]!.y > largest * 2.2) break;
    if (big) block.push(line);
  }
  return block;
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
  // 縦書きの付物（arXiv の左余白の `arXiv:2302.12173v2 [cs.CR] 5 May 2023`）は表題にならない。
  // 文字片の外接矩形が縦に長く、文字高が大きく見えるので、混ぜると表題の座を奪う。
  const firstPage = chunks.filter((chunk) => chunk.page === 1 && chunk.rotated !== true);
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
  const parts = titleBlock(lines, body).map((line) => line.text.trim());

  const title = parts.join(' ').replace(/\s+/g, ' ').trim();
  // 短すぎるもの（柱やページ番号）と、長すぎるもの（表題ではない何か）は使わない。
  if (title.length < 8 || title.length > 300) return null;
  return title;
}

/**
 * 「同じ位置で割れている行」と認める空白の幅を、字送りの何倍で測るか。
 *
 * 左右の段が 1 行に連結されると、その行の中に**柱間そのものの幅の空白**が残る。
 * 語間は両端揃えで伸びても字送りの 1 倍前後なので、1.35 倍あれば語間ではない。
 * 1.6 倍にしていたときは、柱間 6pt（字送りの 1.45 倍）の版で連結が起きているのに
 * 申告が low のまま、再現率 24% で黙って通っていた。1.35 に下げても、実測した
 * 26 本の PDF（1 段組・両端揃えで語間を極端に伸ばした版を含む）で誤って鳴ったものは無い。
 *
 * ここを厳しく（3 倍などに）すると、`\columnsep` 既定の 10pt（10pt 本文なら
 * 字送りの 2.3 倍）が拾えなくなる — arXiv のプレプリントで最も多い値なので、
 * いちばん見つけたい崩れを取り逃がす。緩めたぶんは「同じ x に何行そろうか」で担保する。
 */
const MERGED_GAP_ADVANCES = 1.35;
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
function assessMergedColumns(lines: readonly ClassifiedLine[]): StructureQuality {
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
