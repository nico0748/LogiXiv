import type {
  NonBodyKind,
  NonBodySentence,
  PageSize,
  Rect,
  Sentence,
  SentenceSeam,
  Section,
  StructureQuality,
} from './types.ts';
import { sentenceHash, sentenceId, stableId } from './hash.ts';
import { chunkCharEdges } from './advance.ts';
import {
  assessReadingOrder,
  buildLines,
  classifyLines,
  findDisplacedFragments,
  isUncertainKind,
  type ClassifiedLine,
} from './layout.ts';

/**
 * GROBID が使えないときのフォールバック経路。
 * PDF から取れた文字片（pdf.js の TextItem 相当）を受け取り、行→文の順に組み立てる。
 * 2 段組・数式・脚注では GROBID に明確に負ける。UI には必ずその旨を出すこと。
 */
export interface TextChunk {
  page: number;
  text: string;
  /** 左上原点の矩形。 */
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * ページの中で回っている文字（図の y 軸ラベル、\rotatebox の注記）。
   *
   * 版面の縦書きは本文ではない。横書きと同じに扱うと、縦に並んだ文字が
   * 同じ y の 1 行として畳まれ、本文と 1 文に繋がる
   * （`Accuracy on the held-out validation splitThroughput in tokens per second Sparse …`）。
   * matplotlib や pgfplots をベクタで貼った図の軸ラベルはこの形なので、
   * 図のある論文で普通に起きる。
   */
  rotated?: boolean;
  /**
   * 等幅書体（verbatim・listings）で組まれた文字片。
   *
   * 文の枠を文字片の途中で割るとき、文字ごとの幅の見積もりを切り替えるのに使う
   * （advance.ts）。プロポーショナルの見積もりを当てると、`i` と `m` が同じ幅の
   * コードの行で境目がずれる。
   */
  mono?: boolean;
}

/**
 * 文末とみなさない略語。**単語として完全一致**で照合する。
 * 以前は「ピリオド直前 12 文字の endsWith」で見ていたため、'st' が best/test/first に、
 * 'ms' が systems/terms/algorithms に当たって、学術英語の大半の文が結合していた。
 */
const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'al', 'cf', 'vs', 'fig', 'figs', 'eq', 'eqs', 'ref', 'refs',
  'sec', 'secs', 'tab', 'tabs', 'approx', 'vol', 'vols', 'pp', 'ca', 'resp', 'est',
  'dr', 'prof', 'mr', 'ms', 'mrs', 'st', 'inc', 'ltd', 'dept', 'univ', 'etc', 'ibid', 'vs',
]);

/** 直後に数字が続くときだけ略語として扱うもの（"No. 3" と "…is a no." を区別する）。 */
const ABBREVIATIONS_BEFORE_NUMBER = new Set(['no', 'nos', 'p', 'pp', 'ch', 'chap', 'eq', 'fig', 'tab', 'sec', 'vol', 'art']);

/**
 * 「〜 X.」で終わる文を人名イニシャルと誤認しないための、直前に来る一般名詞。
 * 論文では "we call this method X." "results are in group A." が普通に出る。
 */
const LABEL_HEADS = new Set([
  'method', 'methods', 'model', 'models', 'group', 'groups', 'class', 'classes', 'case', 'cases',
  'type', 'types', 'variant', 'variants', 'dataset', 'datasets', 'algorithm', 'algorithms',
  'table', 'figure', 'appendix', 'section', 'condition', 'conditions', 'set', 'sets',
  'strategy', 'strategies', 'setting', 'settings', 'task', 'tasks', 'baseline', 'baselines',
  'system', 'systems', 'version', 'versions', 'option', 'options', 'scheme', 'schemes',
]);

/**
 * 大文字で始まるが、人名の姓ではありえない語。
 *
 * "温度 T. The results are stable." の `T.` を人名イニシャルと誤認しないために要る。
 * 直前の名詞の白名簿（LABEL_HEADS）だけで見ていた頃は、白名簿に載っていない
 * 普通の理系散文（"the rank by R." "the graph G." "the batch size to B."）が
 * ことごとく次の文と繋がっていた。
 */
const SENTENCE_OPENERS = new Set([
  'the', 'we', 'our', 'this', 'these', 'those', 'it', 'its', 'they', 'their', 'there',
  'in', 'on', 'at', 'for', 'to', 'as', 'by', 'with', 'from', 'after', 'before', 'during',
  'however', 'thus', 'therefore', 'hence', 'moreover', 'furthermore', 'finally', 'first',
  'second', 'third', 'next', 'then', 'both', 'each', 'all', 'if', 'when', 'while', 'since',
  'although', 'because', 'note', 'here', 'results', 'result', 'training', 'testing', 'using',
  'given', 'let', 'more', 'most', 'such', 'unlike', 'similarly', 'conversely', 'instead',
  'consider', 'assume', 'suppose', 'recall', 'empirically', 'formally', 'importantly',
  'unfortunately', 'crucially', 'overall', 'together', 'again', 'once', 'every', 'no', 'not',
  'a', 'an', 'one', 'two', 'three', 'any', 'some', 'many', 'few', 'several', 'other', 'another',
]);

/** "U.S." "N.A.S.A." "Ph.D." のような、点を含む頭字語。 */
const DOTTED_ACRONYM = /^(?:\p{L}{1,3}\.)+\p{L}{1,3}$/u;

/**
 * 文末記号。
 *
 * 全角のピリオド `．`（U+FF0E）が要る。和文の学会誌は句読点を `。、` ではなく
 * **`．，`** で組むものが多く（情報処理学会・電子情報通信学会の標準表記）、
 * これが入っていないと**節まるごとが 1 文**になる（実測: 3,648 字・矩形 96 個の
 * カードが 1 枚、画面には「0 / 1 文」）。ASCII の `.` 側の規則は「直後に空白」を
 * 求めるので、空白の無い和文では絶対に当たらない。
 *
 * 読点（`，` `、`）は入れない。文は終わっていない。
 * `；` `：` `・` も入れない — 和文でも欧文でも文の切れ目ではない
 * （長い文を割るときの候補としては BREAK_AFTER で使う）。
 */
const TERMINATORS = new Set(['.', '!', '?', '。', '．', '！', '？']);

/** 空白を後ろに要求しない文末記号（全角・和文の約物）。和文には語間の空白が無い。 */
const CJK_TERMINATOR = /[。．！？]/u;

/**
 * 英語の学術文向けの文分割。
 *
 * 方針として、迷ったときは**切る側**に倒してある。切りすぎは画面上ですぐ分かり、
 * 将来の手動結合 UI で直せるが、切れなさすぎ（2 文が 1 枚のカードに同居する）は
 * 対訳の 1 対 1 対応そのものを壊すため。
 */
export function splitIntoSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!TERMINATORS.has(ch)) continue;

    // 終端記号の直後に続く閉じ括弧・引用符は前の文に含める。
    // 和文の閉じ括弧も同じ（「…である。」の「」」が次の文の頭になっていた）。
    let end = i + 1;
    while (end < text.length && /[)\]}"'’”」』〉》】〕）］｝]/.test(text[end]!)) end++;

    if (ch === '.' && !isSentenceEndingPeriod(text, i)) continue;
    // 全角のピリオドも、数字に挟まれていれば小数点（「０．５」「２．１ 提案手法」）。
    // 半角と全角は別の文字なので、欧文の "1.5" や "Fig." には一切触れない。
    if (ch === '．' && DIGIT.test(text[i - 1] ?? '') && DIGIT.test(text[i + 1] ?? '')) continue;

    const after = text.slice(end);
    // 欧文の文末には空白が要る（"3.14" のような並びを切らない）。CJK の終端記号は空白不要。
    if (after.length > 0 && !/^\s/.test(after) && !CJK_TERMINATOR.test(ch)) continue;

    pushSentence(out, text.slice(start, end).trim());
    start = end;
    i = end - 1;
  }
  pushSentence(out, text.slice(start).trim());
  return out.filter((s) => /\p{L}/u.test(s));
}

/**
 * 1 つの文として扱う長さの上限。
 *
 * 文末記号が 1 つも無い文書はある（OCR でテキスト層の句点が落ちた稿、終止符を使わない
 * 言語、本文と判定されたデータ列やコードの付録）。そういう文書では**塊まるごとが 1 文**に
 * なり、実測で 34 ページの PDF から「1 文が 18 万字・矩形 1800 個」のカードが 1 枚出ていた。
 * これは画面にも MCP にも渡せない — 対訳は 1 文ずつという前提そのものが崩れるし、
 * 1 回のやり取りに載る量も超える。
 *
 * だから上限で切る。4,000 字にしたのは:
 *   - 実在の論文でいちばん長い文が 144 字（計測に使っている実物 7 本の正解より）。
 *     28 倍の余裕があるので、ふつうの文書では一度も当たらない。
 *   - この道具が既に「1 回のやり取りに載せる文字数」として使っている値と同じ
 *     （MCP の MAX_QUERY_CHARS）。
 */
const MAX_SENTENCE_CHARS = 4_000;

/** 半角・全角の数字。 */
const DIGIT = /[0-9\uFF10-\uFF19]/u;

/**
 * この文字の**後ろ**でなら割ってよい、という和文の約物。
 *
 * 和文には語間の空白が無いので、空白だけを探すと語の途中で割れる
 * （実測: `…到達可能な処` / `理速度の…`）。読点・中黒・閉じ括弧の後ろは、
 * 紙面でも意味でも切れ目になっている。
 */
const BREAK_AFTER = /[、，。．！？；：・）」』】〕》〉｝］]/u;

/**
 * 文を 1 つ足す。長すぎるものは上限で割る。
 *
 * 割る位置は、上限の手前 1/8 まで遡って**切れ目**を探す。切れ目は 3 種類:
 *   - 空白（欧文の語の切れ目）
 *   - 和文の約物の直後（読点・閉じ括弧。BREAK_AFTER）
 *   - 和文と欧文の境目（術語の頭や末尾で切れる）
 * どれも見つからなければ上限ちょうどで切る。欧文では空白しか当たらないので、
 * 欧文の割り方は前と変わらない（和文の約物も字種の境目も、欧文には現れない）。
 */
function pushSentence(out: string[], candidate: string): void {
  if (candidate.length <= MAX_SENTENCE_CHARS) {
    if (candidate.length > 0) out.push(candidate);
    return;
  }
  let at = 0;
  while (candidate.length - at > MAX_SENTENCE_CHARS) {
    let cut = at + MAX_SENTENCE_CHARS;
    const floor = cut - Math.floor(MAX_SENTENCE_CHARS / 8);
    for (let i = cut; i > floor; i--) {
      const before = candidate[i - 1]!;
      const here = candidate[i]!;
      if (/\s/.test(before) || BREAK_AFTER.test(before) || isCjk(before) !== isCjk(here)) {
        cut = i;
        break;
      }
    }
    const piece = candidate.slice(at, cut).trim();
    if (piece.length > 0) out.push(piece);
    at = cut;
  }
  const rest = candidate.slice(at).trim();
  if (rest.length > 0) out.push(rest);
}

/**
 * index の直前にある「語」を取り出す（"e.g" のようにドットを含む形も拾う）。
 * 直前の空白は読み飛ばす — "method X." の判定で "method" まで遡る必要があるため。
 */
function wordBefore(text: string, index: number): string {
  const match = /([\p{L}\p{N}.]+)\s*$/u.exec(text.slice(Math.max(0, index - 32), index));
  return (match?.[1] ?? '').toLowerCase();
}

function isSentenceEndingPeriod(text: string, index: number): boolean {
  // 小数点・バージョン番号。
  if (/\d/.test(text[index - 1] ?? '') && /\d/.test(text[index + 1] ?? '')) return false;

  /**
   * 省略記号。`\dots` / `\ldots` は点の**間に細い空き**を入れて組むので、PDF から
   * 取り出すと ". . ." のように空白を挟んだ点の並びになる。連続した ".." だけを
   * 見ていた頃は、"f1, . . . , fM" の点がそれぞれ文末と判定され、1 文が
   * "… collection f1, ." と ", fM of predictors …" に割れていた。しかも点だけの
   * 断片は文字を含まないので最後に黙って捨てられ、本文が消えていた。
   *
   * 空白は 2 つまでに絞る。離れた位置の点まで省略記号と見ると、"end. . Next" のような
   * 普通の並びで文が切れなくなる。
   */
  if (/^ {0,2}\./.test(text.slice(index + 1, index + 4))) return false;
  if (/\. {0,2}$/.test(text.slice(Math.max(0, index - 3), index))) return false;

  const word = wordBefore(text, index);

  // 'al' が入っているので "et al." もここで止まる。
  if (ABBREVIATIONS.has(word)) return false;
  if (ABBREVIATIONS_BEFORE_NUMBER.has(word) && /^\s*\d/.test(text.slice(index + 1))) return false;

  // 頭字語（"the U.S. government"）。続く語が小文字なら文の途中で確定。
  // 続く語が大文字始まりなら、そこで文が終わっている方が自然なので通常の判定に落とす。
  if (DOTTED_ACRONYM.test(word) && !/^\s*\p{Lu}/u.test(text.slice(index + 1))) return false;

  /**
   * 単一大文字。"J. Doe" のイニシャルか、"we sweep the temperature T." の記号か。
   *
   * 大文字の**手前は空白か行頭に限る**。「文字でなければよい」としていた頃は、
   * 数式の一部が人名のイニシャルに化けていた: 文末の `$v/M$.` が "v/M." と組まれると、
   * M の手前が '/'（文字ではない）なので単一大文字と見なされ、次の文が
   * SENTENCE_OPENERS に無い語で始まると 1 文に繋がっていた
   * （実測: "… + v/M. Solving for the scalar gives …" が 1 枚のカードに同居）。
   * 人名のイニシャルは必ず語の頭に立つので、この絞り込みで落ちるものは無い。
   */
  const beforeCapital = text[index - 2];
  if (/^[A-Z]$/.test(text[index - 1] ?? '') && (beforeCapital === undefined || /\s/.test(beforeCapital))) {
    const head = wordBefore(text, index - 1);
    if (LABEL_HEADS.has(head)) return true; // ラベルなので文末
    // もう 1 つイニシャルが続くなら人名で確定（"J. R. R. Tolkien"）。
    if (/^\s*[A-Z]\./.test(text.slice(index + 1))) return false;
    // 大文字始まりの語が続く場合。文頭に立つ語なら文末、そうでなければ姓とみなす。
    const nextWord = /^\s*(\p{Lu}[\p{L}']*)/u.exec(text.slice(index + 1))?.[1]?.toLowerCase();
    if (nextWord && !SENTENCE_OPENERS.has(nextWord)) return false;
  }

  return true;
}

/**
 * 空白を入れずに続けてよい文字（漢字・かな・全角の約物）。
 *
 * 和文には語の切れ目に空白が無いので、行の折り返しは**語の途中**で起きる。
 * 継ぎ目に空白を入れると、折り返すたびに語が割れる
 * （実測: xelatex で組んだ和文論文で「切り 出し」「境 界」。折り返す文は例外なく壊れた）。
 *
 * ハングルはここに入れない。同じ「CJK」でも朝鮮語は分かち書きをするので、
 * 行の継ぎ目には欧文と同じく空白が要る。
 * U+3000（全角空白）も入れない。あれは空白そのものなので、空白として扱ってよい。
 *
 * Script ではなく **Script_Extensions**（`scx`）で引く。長音符「ー」（U+30FC）や
 * 中黒「・」（U+30FB）、繰り返し記号「々」（U+3005）は Script=Common なので、
 * `Script=Katakana` では拾えない。実測: これを取り逃がしていたとき、
 * 「コーパス」「データ」「パーセント」の長音符が**和文と欧文の境目**に数えられ、
 * 和文の文書が「空白を置かない流儀」に倒れていた（境目 30 件中 16 件が長音符）。
 */
const CJK_CHAR = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\u3001-\u303F\uFF01-\uFF9F\uFFE0-\uFFE6]/u;

function isCjk(ch: string | undefined): boolean {
  return ch !== undefined && CJK_CHAR.test(ch);
}

/**
 * 和文と欧文の境目に空白を置く文書か。
 *
 * 行の継ぎ目からは「元が空白付きだったか」を知る手立てが無い（行末の空白は組版で消える）。
 * しかも正解は流儀で割れる:
 *
 *   - LaTeX の和文原稿は `たとえば attention や` と**空白を置く**ことが多い。
 *     この流儀では、境目で折り返したら空白を入れるのが正しい。
 *   - xeCJK・LuaTeX-ja を使う原稿は `\texttt{attention}機構` と**置かない**。
 *     和欧文間の空き（xkanjiskip）は組版が入れる見た目の空きで、文字としての空白は無い。
 *     この流儀では、入れると字面が書き換わる。
 *
 * どちらが正しいかは文書ごとに違うので、**同じ文書の行の途中**の書き方に合わせる。
 * 行の途中なら折り返しが絡まないので、紙面に出ている空白がそのまま書き手の流儀になる。
 * 行末ハイフンを文書内の用例で決めている（collectHyphenEvidence）のと同じ考え方。
 */
interface ScriptSpacing {
  /** 行の途中に現れた「和文と欧文の境目」のうち、空白があったもの。 */
  spaced: number;
  /** 同じく、空白が無かったもの。 */
  tight: number;
}

/**
 * 片側だけが和文の境目か。
 *
 * 欧文側は**文字**に限る（数字・括弧・記号は数えない）。流儀が分かれるのは
 * 欧文の術語をどう置くかだけで、それ以外は和文の論文でもまず空白を置く
 * （「費用がかかる [2]。」「図 1 に示す」）。混ぜて数えると、どちらの流儀も測れない。
 */
function isScriptBoundary(left: string, right: string): boolean {
  const leftCjk = isCjk(left);
  if (leftCjk === isCjk(right)) return false;
  return /\p{L}/u.test(leftCjk ? right : left);
}

function collectScriptSpacing(lines: readonly ClassifiedLine[]): ScriptSpacing {
  let spaced = 0;
  let tight = 0;
  for (const line of lines) {
    // 本文だけを数える。見出しの "1 はじめに" の空白は LaTeX が節番号の後ろに入れたもので、
    // 書き手の流儀ではない（これを数えると、空白を置かない文書まで「置く流儀」に倒れる）。
    if (line.role !== 'body') continue;
    const text = line.text;
    for (let i = 1; i < text.length; i++) {
      if (text[i] === ' ') {
        const after = text[i + 1];
        if (after !== undefined && isScriptBoundary(text[i - 1]!, after)) spaced++;
        i++;
        continue;
      }
      if (isScriptBoundary(text[i - 1]!, text[i]!)) tight++;
    }
  }
  return { spaced, tight };
}

/**
 * 継ぎ目に空白が入る文書か（行の継ぎ目・文字片の継ぎ目のどちらでも使う）。
 *
 * 両側が欧文なら入る（語の切れ目で折り返すので、元は空白だった）。
 * 両側が和文なら入らない（語の切れ目に空白が無いので、折り返しは語の途中で起きる）。
 * 片側だけ和文なら、その文書の流儀に合わせる（ScriptSpacing 参照）。
 * どちらかが分からないときは入る側に倒す — 欧文の挙動をここで変えないため。
 */
function spacesAtBoundary(
  left: string | undefined,
  right: string | undefined,
  spacing: ScriptSpacing,
): boolean {
  if (left === undefined || right === undefined) return true;
  const leftCjk = isCjk(left);
  const rightCjk = isCjk(right);
  if (!leftCjk && !rightCjk) return true;
  if (leftCjk && rightCjk) return false;
  // 和文と欧文の境目。欧文側が**文字**のときだけ、その文書の流儀に合わせる。
  // 数字・括弧・記号との境目は空白を入れる側に倒す — 術語を詰めて書く和文の論文でも、
  // 引用番号や図表番号の前には空白を置く（「費用がかかる [2]。」「表 2 の形」）。
  if (!/\p{L}/u.test(leftCjk ? right : left)) return true;
  return spacing.spaced >= spacing.tight;
}

/**
 * その行の「和文どうしの間の空白」が、pdf.js が字間から作った偽物か。
 *
 * pdf.js は字送りが 0.102em（TRACKING_SPACE_FACTOR）を超えると、PDF に空白文字が
 * 無くても空白を差し込む。両端揃えの和文は行の伸縮を字間に配るので、狭い段では
 * 1 行のほぼ全部の字間がこれを超える。実測（和文 2 段組）:
 *   「和 文 の 学 会 誌 で は、 本 文 を 日 本 語 で 書 き、 術」
 * これは文字片の**中**に入るので、継ぎ目の判断（spacesAtBoundary）では取れない。
 *
 * ただし和文にも本物の空白はある（著者名「坂比賀 悠真」、参考文献の姓と名）。
 * 偽物は行の字間に**軒並み**入るのが特徴なので、個数と割合の両方で見る。
 * 本物は 1 行に 1〜2 個で、空白の無い字間が周りに何十個も並ぶ。
 */
function hasTrackingSpaces(text: string): boolean {
  let spaced = 0;
  let tight = 0;
  for (let i = 1; i < text.length; i++) {
    if (!isCjk(text[i - 1])) continue;
    if (text[i] === ' ') {
      if (isCjk(text[i + 1])) spaced++;
    } else if (isCjk(text[i])) {
      tight++;
    }
  }
  return spaced >= 3 && spaced >= (spaced + tight) * 0.25;
}

/**
 * 数式の二項演算子・関係子。
 *
 * TeX は被演算子に挟まれたこれらの前後を medmuskip / thickmuskip で組む。
 * ASCII の '-' は入れない（複合語のハイフンに当たってしまう）。数式の負号は
 * PDF では U+2212 で出てくるので、そちらだけを見る。
 */
const MATH_BINARY =
  /[+−±∓×÷⋅∘⊕⊖⊗⊙=≠≈≡∼≃≅≺≻<>≤≥∈∉⊂⊃⊆⊇∪∩∧∨→←↔⇒⇐⇔↦]/u;

/**
 * 被演算子として立ちうる文字か（左側・右側）。
 *
 * 英数字に限れない。`$f^\star + b$` の左側は上付きの「⋆」で終わるし、
 * 添字・記号で終わる式はいくらでもある。逆に、演算子そのもの・空白・句読点・
 * 開き括弧の直後に立つ演算子は**単項**なので（TeX の mathbin と同じ規則）、
 * そこは除く。これで "$-1$" の負号には空白を入れない。
 */
const NOT_OPERAND_END = /[\s([{,;:.!?]/u;
const NOT_OPERAND_START = /[\s)\]},;:.!?]/u;

function isOperandEnd(ch: string | undefined): boolean {
  return ch !== undefined && !NOT_OPERAND_END.test(ch) && !MATH_BINARY.test(ch);
}

function isOperandStart(ch: string | undefined): boolean {
  return ch !== undefined && !NOT_OPERAND_START.test(ch) && !MATH_BINARY.test(ch);
}

/**
 * 文字片の継ぎ目が、数式の二項演算子のすぐ隣か。
 *
 * TeX の medmuskip は `4mu plus 2mu minus 4mu` で、**縮む**。行を詰めて組んだ行では
 * 0.03em まで潰れ、隙間の閾値（字高の 0.22 倍）に届かない。実測: 同じ
 * `$f^\star + b + \varepsilon_m$` が、行によって "f ⋆ + b + εm" にも
 * "f ⋆ +b+εm" にもなっていた（Computer Modern で 22 行中 4 行）。
 * 同じ式が組み方しだいで違う字面になると、ハッシュも変わって訳が付かない。
 * だから隙間の大きさではなく**文字の種類**で決める。組み方に依らず同じ字面になり、
 * pdftotext（poppler。この道具とは独立した実装）とも一致する。
 *
 * 二項か単項かは TeX と同じ規則で見る — 演算子の手前に被演算子があれば二項。
 * 手前が語間の空白なら、そこで散文が終わって数式が始まっているので単項
 * （実測: "the interval is $-1$ for every" が "is − 1 for every" になっていた）。
 */
function isBinaryOperatorBoundary(
  builder: TextBuilder,
  owners: readonly CharOwner[],
  next: string,
): boolean {
  const last = charFromEnd(builder, 0);
  const head = next[0];
  if (last === undefined || head === undefined) return false;
  // 被演算子 → 演算子。手前の被演算子は `last` そのもの。
  if (isOperandEnd(last) && MATH_BINARY.test(head)) return true;
  // 演算子 → 被演算子。演算子の手前に被演算子があるかを見る。
  if (MATH_BINARY.test(last) && isOperandStart(head)) {
    // 空白の幅は**演算子の字高**で測る。空白の側の字高は上付き・下付きだと小さく
    // 出るので（実測: 上付きの直後の空き 1.26pt は、自分の字高 6.97 では 0.18 em に
    // 見えるが、本文の 9.96 では 0.13 em）、そのままでは語間と区別がつかない。
    const em = owners[builder.length - 1]?.chunk.h ?? 0;
    let back = 1;
    if (charFromEnd(builder, back) === ' ' && isThinSpace(owners[builder.length - 1 - back], em)) {
      back++;
    }
    return isOperandEnd(charFromEnd(builder, back));
  }
  return false;
}

/**
 * 連結後のその 1 文字が、**語間ではない**細い空白か。
 *
 * 演算子の手前の空白を読み飛ばしてよいかの判断に使う。読み飛ばす相手は 2 つ:
 * 自分で入れた空白（継ぎ目の空白。位置を持たないので offset が負）と、
 * 数式の空き。語間の空白まで読み飛ばすと、散文の直後に来る負号が二項演算子に化ける。
 *
 * 数式の空きと語間は**幅**で見分く。TeX の語間は詰めても 0.17em を下回らない
 * （Times で 0.25em plus 0.15 minus 0.0833、Computer Modern はもっと広い）。
 * 一方 medmuskip は 4mu plus 2mu minus 4mu で、詰まった行では 0.08em まで潰れる。
 * 実測: 語間 0.222em に対し、詰まった行の medmuskip は 0.119em だった。
 */
function isThinSpace(owner: CharOwner | undefined, em: number): boolean {
  if (owner === undefined) return false;
  if (owner.offset < 0) return true; // 自分で入れた継ぎ目の空白
  const { chunk } = owner;
  return chunk.text === ' ' && em > 0 && chunk.w < em * 0.15;
}

/**
 * 紙面が空いていない空白の文字片。
 *
 * pdf.js は italic correction のような小さな送りも空白文字として返す。多くの場合は
 * それで正しい（"f ⋆" は紙面でも空いて見える）が、**下付きと上付きを重ねて組む**形
 * （`$\beta_i^2$`）では話が変わる。italic correction が効くのは上付きだけで、
 * 下付きはその空白の位置に重ねて置かれる。空白として残すと、下付きと上付きの
 * どちらが先に並ぶかで "β i2" にも "βi 2" にも転ぶ
 * （実測: Times の同じ式 22 回で 13 回が "βi 2"、9 回が "β i2"）。
 * pdftotext（poppler。この道具とは独立した実装）は "βi2" を返す。
 *
 * 見分けるのは**積んであるかどうか**。空白のすぐ右から始まる文字片の中に、
 * 高さ（ベースライン）が違うのに x 範囲が重なる組があれば、それが下付きと上付きで、
 * 手前の空白は上付きのぶんの送りでしかない。上付きだけの `$f^\star$` には
 * 積まれた組が無いので、"f ⋆" の空白はそのまま残る。
 */
function stackedScriptSpaces(chunks: readonly TextChunk[]): Set<TextChunk> {
  const out = new Set<TextChunk>();
  for (const space of chunks) {
    if (space.w <= 0 || space.text.trim().length > 0) continue;
    // 空白の右端から始まる（か、その中に食い込む）文字片だけを見る。
    const at: TextChunk[] = [];
    for (const other of chunks) {
      if (other === space || other.w <= 0 || other.text.trim().length === 0) continue;
      if (other.x <= space.x + space.w + 0.5 && other.x + other.w > space.x) at.push(other);
    }
    for (let a = 0; a < at.length && !out.has(space); a++) {
      for (let b = a + 1; b < at.length; b++) {
        const first = at[a]!;
        const second = at[b]!;
        // 同じ高さに並んでいるだけなら積んでいない。
        if (Math.abs(first.y - second.y) < 0.5) continue;
        const overlap =
          Math.min(first.x + first.w, second.x + second.w) - Math.max(first.x, second.x);
        if (overlap > 0) {
          out.add(space);
          break;
        }
      }
    }
  }
  return out;
}

/** 次の行の最初の文字。行の継ぎ目に空白が要るかの判断に使う。 */
function firstCharOf(line: ClassifiedLine | undefined): string | undefined {
  if (line === undefined) return undefined;
  const text = line.text.trimStart();
  if (text.length > 0) return text[0];
  // line.text は空白を畳んだ後の字面。空になる行（記号だけの行）は文字片から拾う。
  for (const chunk of line.chunks) {
    const trimmed = chunk.text.trimStart();
    if (trimmed.length > 0) return trimmed[0];
  }
  return undefined;
}

/**
 * 連結後の 1 文字が、どの文字片のどの位置から来たかの記録。
 * `offset` は文字片の本文内の位置。行の継ぎ目に入れる空白は元の文字片に無いので -1 を入れ、
 * 幅の計算には使わない（無い文字の幅を数えると矩形が文字片の外へはみ出す）。
 */
interface CharOwner {
  chunk: TextChunk;
  line: number;
  offset: number;
}

/** 文字片のうち、この文が実際に使った文字位置の範囲 [from, to)。 */
interface ChunkSpan {
  line: number;
  from: number;
  to: number;
}

/**
 * 矩形は行単位でまとめる。以前は `Math.round(y)` の一致で束ねていたため、
 * 同じ行でも y が丸め境界をまたぐと矩形が 2 つに割れてハイライトが二重になっていた。
 *
 * まとめる範囲は**その文が実際に占めた x 範囲だけ**にする。以前は行に触れた文字片の
 * 外接矩形をそのまま使っていたので、文が行の途中で終わると、その行が前後どちらの文にも
 * 行いっぱいの幅で入っていた。pdf.js は 1 行まるごとを 1 個の文字片で返すことが普通に
 * あるため、2 文が同一の矩形を持ち、PDF を押しても隣の文が選ばれる（しかも後から
 * 描かれた文に完全に覆われて、二度と選べない文まで出る）。
 *
 * 文字片の一部だけを使ったときは、**字形の幅の見積もり**で x を按分する（advance.ts）。
 * 以前は文字数の比だったので、語間の伸びた両端揃えの行や、和文に欧文が混ざる行で
 * 境目が 1〜4 文字ずれ、文頭が枠から外れる／前の文の枠が次の文の頭まで食い込んでいた。
 * 文字ごとの正確な x は pdf.js の TextItem には無い（取るには文字単位で組版し直すしかない）。
 */
function mergeRects(owners: CharOwner[]): Rect[] {
  // 文字片ごとに、この文が覆った文字位置の範囲を集める。
  const spans = new Map<TextChunk, ChunkSpan>();
  for (const { chunk, line, offset } of owners) {
    let span = spans.get(chunk);
    if (!span) {
      span = { line, from: Infinity, to: -Infinity };
      spans.set(chunk, span);
    }
    if (offset < 0) continue; // 継ぎ目の空白。位置を持たないので範囲には数えない。
    if (offset < span.from) span.from = offset;
    if (offset + 1 > span.to) span.to = offset + 1;
  }

  interface Band {
    page: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }
  const byLine = new Map<number, Band>();
  for (const [chunk, span] of spans) {
    // 継ぎ目の空白しか含まない文字片は、この文の本文をひと文字も持たない。
    if (span.to <= span.from || chunk.text.length === 0) continue;
    const length = chunk.text.length;
    const edges = chunkCharEdges(chunk);
    const x0 = edges[Math.min(span.from, length)]!;
    const x1 = edges[Math.min(span.to, length)]!;
    const band = byLine.get(span.line);
    if (band) {
      band.x0 = Math.min(band.x0, x0);
      band.x1 = Math.max(band.x1, x1);
      band.y0 = Math.min(band.y0, chunk.y);
      band.y1 = Math.max(band.y1, chunk.y + chunk.h);
    } else {
      byLine.set(span.line, { page: chunk.page, x0, y0: chunk.y, x1, y1: chunk.y + chunk.h });
    }
  }

  const rects: Rect[] = [];
  for (const band of byLine.values()) {
    // 幅ではなく**両端**を丸める。幅を丸めると、隣り合う文の矩形が丸め誤差のぶんだけ
    // 重なることがあり、「重ならない」という今回の修正の要点が境目で崩れる。
    const x = round(band.x0);
    const y = round(band.y0);
    // 端の差を取ってから丸め直す。差は既に 0.01 の倍数なので、丸めても端は動かない
    // （x + w は round(band.x1) のまま）。浮動小数の桁あふれを書き出さないためだけの処理。
    rects.push({ page: band.page, x, y, w: round(round(band.x1) - x), h: round(round(band.y1) - y) });
  }
  return rects.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface FallbackResult {
  sentences: Sentence[];
  sections: Section[];
  /** 本文として扱わなかった行。訳の対象ではないが、画面には出せるように残す。 */
  nonBody: NonBodySentence[];
  /**
   * 解析結果がどれくらい怪しいかの自己申告。
   *
   * 「簡易解析」というバッジだけでは、完璧に取れた文書と 3 分の 1 しか取れていない
   * 文書に同じものが出る。崩れを直せなくても、崩れていると分かれば読む側は動ける。
   */
  quality: StructureQuality;
}

/** 連結した文字列と、1 文字ずつの出どころ。 */
interface Segment {
  buffer: string;
  owners: CharOwner[];
}

/**
 * 連結中の文字列。**末尾しか触らない**ので、1 本の文字列ではなく断片の配列で持つ。
 *
 * なぜ配列か。`buffer += text` で伸ばしながら `buffer.slice(0, -1)` で末尾を削ると、
 * V8 は繋いだだけの文字列（rope）を毎回**平坦化**するので、1 回の削りが
 * O(塊の長さ) になる。行末ハイフンは何十行かに 1 回出るから、塊全体では O(n²)。
 * 実測（合成 PDF・2 段組）: joinLines の自分の時間が 60 ページで 372ms、
 * 120 ページで 2023ms（入力 2 倍で 5.4 倍）。
 *
 * 断片の配列にすると、末尾の削りも末尾の読み取りも触る量が定数で済む。
 * 1 本の文字列に直すのは、塊を組み終えた最後の 1 回だけ。
 */
interface TextBuilder {
  parts: string[];
  length: number;
}

function appendText(builder: TextBuilder, text: string): void {
  if (text.length === 0) return;
  builder.parts.push(text);
  builder.length += text.length;
}

/** 末尾から `back` 文字目（0 が最後の 1 文字）。範囲外なら undefined。 */
function charFromEnd(builder: TextBuilder, back: number): string | undefined {
  let remaining = back;
  for (let i = builder.parts.length - 1; i >= 0; i--) {
    const part = builder.parts[i]!;
    if (remaining < part.length) return part[part.length - 1 - remaining];
    remaining -= part.length;
  }
  return undefined;
}

/** 末尾から `count` 文字を落とす。 */
function truncateText(builder: TextBuilder, count: number): void {
  let remaining = count;
  while (remaining > 0 && builder.parts.length > 0) {
    const last = builder.parts[builder.parts.length - 1]!;
    if (last.length <= remaining) {
      builder.parts.pop();
      remaining -= last.length;
    } else {
      builder.parts[builder.parts.length - 1] = last.slice(0, last.length - remaining);
      remaining = 0;
    }
  }
  builder.length -= count - remaining;
}

/** 末尾の `count` 文字（足りなければ全部）。 */
function tailString(builder: TextBuilder, count: number): string {
  if (count >= builder.length) return builder.parts.join('');
  const collected: string[] = [];
  let remaining = count;
  for (let i = builder.parts.length - 1; i >= 0 && remaining > 0; i--) {
    const part = builder.parts[i]!;
    if (part.length <= remaining) {
      collected.push(part);
      remaining -= part.length;
    } else {
      collected.push(part.slice(part.length - remaining));
      remaining = 0;
    }
  }
  collected.reverse();
  return collected.join('');
}

/** 行末ハイフンの照合で、末尾から遡ってよい文字（欧字・和字とハイフン）。 */
const LETTER_OR_HYPHEN = /[\p{L}\-\u2010\u2011]/u;
/** 代用対の片割れ。1 つの文字を半分だけ見ても欧字と分からないので、並びの一部として扱う。 */
const SURROGATE_HALF = /[\uD800-\uDFFF]/;

/**
 * 行末ハイフンの照合に使う窓の上限（文字）。
 *
 * 上限が無いと、**空白を含まない「欧字とハイフンだけの行」が続く入力**で窓が塊全体まで
 * 育ち、二乗が戻る。行末ハイフンで繋ぐたびに空白が消えるので、並びが行をまたいで
 * 伸び続けるため。実測（1 行 60 字・全行が行末ハイフン）: 10 万字 4.4 秒、20 万字 17.3 秒、
 * 40 万字 68.3 秒、80 万字 275 秒（入力 2 倍で 4 倍）。同じ量の散文は 0.17／0.43／0.98／1.9 秒。
 *
 * 256 字にしたのは、**実在の複合語がそこまで長くならない**から。
 * 照合相手の用例（HyphenEvidence）は行の中から拾った複合語なので、それ自体が
 * 行の長さ（1 段組でも 100 字ほど）で頭打ちになる。窓がそれを超えていれば、
 * 一致するものはもう無い。判定に使う残りの手掛かり（末尾の字種・語形・
 * 「ハイフンを含むか」）も、256 字の末尾で答えが変わらない
 * — 行末ハイフンまで届く並びは必ずハイフンを含むので、切り詰めても「含む」のまま。
 */
const HYPHEN_WINDOW_LIMIT = 256;

/**
 * 行末ハイフンの照合に使う、末尾の窓。
 *
 * 一致しうる範囲（末尾の「欧字とハイフンの並び」）が丸ごと収まるまで窓を倍々に広げる。
 * 収まったかどうかは、**その並びが窓の先頭まで届いているか**で見る。窓の先頭の 1 文字が
 * 欧字かどうかで見てはいけない — 散文は 8 割が欧字なので、たまたま語の途中で切れた
 * というだけで窓が倍々に広がり続ける（実測: この見方だと窓が数千文字まで育ち、
 * tailString と正規表現だけで全体の 4 割を使っていた）。
 *
 * 広げ終わった窓に当てた結果は、塊の全文に当てたときと 1 文字も変わらない
 * （理由は joinLines の中に書いた）。
 */
function tailWindow(builder: TextBuilder): string {
  let size = 64;
  for (;;) {
    const window = tailString(builder, size);
    if (window.length < size) return window; // 塊の全文を取り切った
    // 末尾の空白は数えない（`[-‐‑]\s$` の `\s` はここで確定している）。
    let i = window.length - 2;
    while (i >= 0 && (LETTER_OR_HYPHEN.test(window[i]!) || SURROGATE_HALF.test(window[i]!))) i--;
    if (i >= 0) return window; // 並びが窓の先頭まで届いていない＝収まっている
    if (size >= HYPHEN_WINDOW_LIMIT) return window;
    size = Math.min(size * 2, HYPHEN_WINDOW_LIMIT);
  }
}

/** 1 文字がハイフンか。 */
const HYPHEN_CHAR = /[-\u2010\u2011]/;

/**
 * 行末ハイフンを落として良いかの判断材料。
 *
 * `hyphenated` は、同じ文書の**行の途中**に "block-sparse" の形で現れるハイフン付き複合語。
 * `compoundPrefixes` はその**ハイフンで切った前側**（"state-of-the-art" なら
 * "state" と "state-of" と "state-of-the"）。複合語の途中で行が割れても照合できる。
 * `words` は、同じ文書に**ハイフン無しの 1 語として**現れた語。
 *
 * 用例だけで決めていた頃は、文書内に 1 回しか出ない複合語が行末で割れると
 * ハイフンごと落ちていた（実測: 2 段組の論文で `long-range` → `longrange`。
 * 同じ論文の `straight-through` は、たまたま行中の用例があったので無事だった＝
 * 論文ごとに当たり外れが変わる）。用例は依然として最も強い手掛かりなので捨てず、
 * 語形の判定（`decideLineEndHyphen`）で足りないぶんを補う。
 */
interface HyphenEvidence {
  hyphenated: Set<string>;
  compoundPrefixes: Set<string>;
  words: Set<string>;
}

/** 語の切り出し。アポストロフィを含む形（don't）も 1 語として拾う。 */
const WORD_TOKEN = /\p{L}+(?:['’]\p{L}+)*/gu;

/**
 * ハイフンとして扱う文字。
 *
 * ASCII の '-' だけを見ていると、和文書体で組んだ欧文が取り逃がされる。
 * 実測: Noto Serif CJK JP で英文要旨を組むと、行末のハイフンは U+2011
 * （non-breaking hyphen）として取り出され、"pa‑ pers" が画面にそのまま残っていた。
 * normalizeSentence は U+2010/U+2011 を '-' に寄せるのでハッシュは合うが、
 * 画面に出る字面は壊れたままになる。
 */
const HYPHEN_CHARS = /[\u2010\u2011]/g;

/** 行末のハイフン（と、その手前のハイフン付き複合語）。末尾の空白まで含めて照合する。 */
const HYPHEN_AT_LINE_END = /((?:\p{L}+[-\u2010\u2011])*\p{L}+)[-\u2010\u2011]\s$/u;

function collectHyphenEvidence(lines: ClassifiedLine[]): HyphenEvidence {
  const hyphenated = new Set<string>();
  const compoundPrefixes = new Set<string>();
  const words = new Set<string>();
  let previousBroke = false;
  for (const line of lines) {
    // ハイフンの種類は先に畳む。用例の照合は ASCII の '-' でしか行わないので、
    // ここで寄せておかないと「行末で割れた語」の検出そのものが外れる。
    const flattened = line.text.replace(HYPHEN_CHARS, '-');
    const broken = /-\s*$/.test(flattened);
    // 行末のハイフンは「割れた語」なので用例として数えない。数えると
    // 「割れた語は必ず用例あり」になり、ハイフンが永久に残る。
    const text = flattened.replace(/-\s*$/, '');
    for (const match of text.matchAll(/\p{L}+(?:-\p{L}+)+/gu)) {
      const compound = match[0].toLowerCase();
      hyphenated.add(compound);
      const parts = compound.split('-');
      for (let i = 1; i < parts.length; i++) compoundPrefixes.add(parts.slice(0, i).join('-'));
    }

    // 単独語の語彙。割れた語の**断片**を混ぜてはいけない（"informa" や "tion" が
    // 「文書に出る語」になると、語形の判定がそれを複合語の片割れと見てしまう）。
    const tokens = [...text.matchAll(WORD_TOKEN)].map((m) => m[0]);
    const from = previousBroke ? 1 : 0; // 直前の行が割れていれば、先頭の語はその続き
    const to = broken ? tokens.length - 1 : tokens.length; // 行末で割れていれば、末尾の語は断片
    for (let i = from; i < to; i++) words.add(tokens[i]!.toLowerCase());
    previousBroke = broken;
  }
  return { hyphenated, compoundPrefixes, words };
}

/**
 * 行末ハイフンの右側が接尾辞（それ単独では語にならない拘束形態素）か。
 *
 * "informa-" + "tion" のような**音節で割れた 1 語**を確実に繋ぐための門。
 * 実在の複合語でここに当たるものは、まず無い（"-based" "-aware" "-level" は入れていない）。
 */
const BOUND_SUFFIX =
  /^(?:s|es|ed|ing|ings|er|ers|est|ly|ion|ions|tion|tions|sion|sions|ment|ments|ness|ity|ities|ance|ence|ancy|ency|able|ible|ive|ives|ous|ful|less|ism|ist|ists|ize|ized|izes|izing|ization|al|ally|ic|ics|ical|ate|ated|ates|ating|ary|ory|ure|ures|age|ages|ant|ent|ship|hood|wise|ward|wards|ial|ual|ular|tive|sive|tial|cial|tory|tories|ian|ians)$/;

/** 母音を含むか。含まない断片（"str" "ph"）は単語ではありえない。 */
const HAS_VOWEL = /[aeiouy]/;

/** 末尾が子音 2 つ以上か。 */
const ENDS_IN_CLUSTER = /[^aeiouy]{2}$/;

/**
 * 行末ハイフンを残すか（true）、ハイフンごと落として繋ぐか（false）。
 *
 * 辞書は持てない（コアは無依存）ので、**文書内の統計**と**語形**だけで決める。
 * 強い手掛かりから順に見て、決まらなければ「繋ぐ」に倒す — 論文の行末ハイフンは
 * 大半が本物のハイフネーションなので、既定値を逆にすると "informa-tion" が量産される。
 *
 * 語形の決め手は「左側が子音 2 つ以上で終わるか」。欧文のハイフネーションは
 * 音節の切れ目で起きるので、子音連続の**直後**では、まず割れない
 * （"con-straint" とは割るが "cons-traint" とは割らない）。逆に複合語の前側は
 * 独立した語なので子音で終わってよい（long, block, cross, self, short, straight…）。
 *
 * 実測（TeX の hyphenation pattern で割った 1240 点と、実在の複合語 120 点）:
 *   - 語形だけ … 複合語を 27% 拾い、ハイフネーションを 2.6% 誤って残す。
 *   - 連結形が文書内に 1 語として出る、を足す … 誤って残すのが 0%（2.6% → 0）。
 *     誤りの中身は downstream / hardware / throughput / transformer のような
 *     続けて綴る複合語で、論文なら別の場所に 1 語で出る。
 *   - 両側が文書内に単独語として出る、を足す … 複合語を 78% 拾う（27% → 78%）。
 */
function decideLineEndHyphen(left: string, right: string, evidence: HyphenEvidence): boolean {
  const joined = `${left}-${right}`.toLowerCase();
  // 完全一致だけでなく、用例の**前側**とも照合する。"state-of-the-art" が行中にあるとき、
  // "state-" で割れた行の joined は "state-of" にしかならず、完全一致では拾えない。
  if (evidence.hyphenated.has(joined) || evidence.compoundPrefixes.has(joined)) return true;

  // 数字・大文字が絡む形（"CNN-based" "Transformer-XL" "3-layer"）。
  // 欧文のハイフネーションはこれらをまたがないので、無条件で残してよい。
  if (/[\p{Lu}\p{N}]$/u.test(left) || /^[\p{Lu}\p{N}]/u.test(right)) return true;

  /**
   * 左側が 1 文字。TeX は語の頭から 1 文字だけ残して割ることをしない
   * （`\lefthyphenmin` は 2 以上）ので、こう見えたら**本物のハイフン**。
   * 実測（multicol の 3 段組）で `x-ray` が `xray` になっていた。
   */
  if (left.length === 1) return true;

  // 左側に既にハイフンがある（"state-of-the-" + "art"）。
  // TeX は明示のハイフンより後ろを音節で割らないので、こう見えたということは
  // 明示のハイフンの位置で折り返したということ。用例が 1 つも無い
  // "state-of-the-art" が "state-of-theart" になっていたのはこの経路。
  if (left.includes('-')) return true;

  // ここから先はハイフンを含まない語同士の判定（上でハイフン入りは片付いている）。
  const head = left.toLowerCase();
  const tail = right.toLowerCase();

  // 連結形が文書内に 1 語として出るなら、割れていたのはその語。
  // "with-" + "out" → without、"trans-" + "former" → transformer。
  if (evidence.words.has(`${head}${tail}`)) return false;

  // 右側が拘束形態素なら、複合語ではありえない。
  if (BOUND_SUFFIX.test(tail)) return false;

  // 左側が、文書内の別の複合語でも前側に立っているなら複合語の前側
  // （"self-supervised" が行中にあれば "self-" + "attention" も複合語）。
  if (evidence.compoundPrefixes.has(head)) return true;

  // 両側とも、文書内に単独の語として出ている。
  // 短い語は前置詞・接頭辞と区別できないので 4 文字以上に限る。
  if (head.length >= 4 && tail.length >= 4 && evidence.words.has(head) && evidence.words.has(tail)) {
    return true;
  }

  // 語形だけの判定。左側が子音連続で終わる（＝音節の切れ目ではない）。
  if (head.length >= 3 && tail.length >= 3 && HAS_VOWEL.test(head) && HAS_VOWEL.test(tail)) {
    if (ENDS_IN_CLUSTER.test(head)) return true;
  }

  return false;
}

/**
 * 文字片から文を組み立てる。
 *
 * 手順は「段を見つける → 行にする → 行の役割を決める → 本文だけ連結して文に割る」。
 * 段を見ずに y だけで行をまとめていた頃は、2 段組の論文で左右の段が 1 行に混ざり、
 * 正解の文が取れた割合が 60%（1 段組）から 30%（2 段組）まで落ちていた。
 */
export function buildSentencesFromChunks(chunks: TextChunk[], pages: PageSize[]): FallbackResult {
  // 回っている文字は本文の行組みに入れない（理由は TextChunk.rotated に書いた）。
  // 捨てるのではなく、行き先の分かる付物として残す — 「PDF には見えているのに
  // 右に無い」を作らないため、というのは落とした行と同じ理屈。
  const rotatedChunks = chunks.filter((chunk) => chunk.rotated === true);
  const lines = classifyLines(
    buildLines(rotatedChunks.length > 0 ? chunks.filter((chunk) => chunk.rotated !== true) : chunks),
    pages,
  );
  const hyphenEvidence = collectHyphenEvidence(lines);
  // 和文と欧文の境目に空白を置く文書かどうかは、文書ごとに違う。
  // 行を繋ぐ前に、その文書自身の書き方を数えておく。
  const spacing = collectScriptSpacing(lines);

  const sections: Section[] = [];
  const sectionIds = new Set<string>();
  const registerSection = (title: string): string => {
    let disambiguator = 0;
    let id = stableId('sec', title);
    while (sectionIds.has(id)) {
      disambiguator++;
      id = stableId('sec', title, disambiguator);
    }
    sectionIds.add(id);
    sections.push({ id, title, level: 1, order: sections.length });
    return id;
  };

  /**
   * 本文の塊。見出しで**切る**。
   *
   * 以前は区切り文字を 1 つ挟むだけだったが、分割器は改行を空白として畳むので、
   * 見出しの手前で切れていない文が見出しの次の文と 1 枚のカードに同居していた
   * （しかも節の帰属まで狂う）。節は塊の中で変わらないので、塊ごとに持つ。
   *
   * 付物の行は塊を**切らない**。切ると、本文の途中に挟まった表や数式のところで
   * 文が 2 つに割れる（"Information retrieval benefits from" と
   * "the same sparsity pattern at every depth." が別のカードになる）。
   */
  interface Block {
    lines: ClassifiedLine[];
    section: string | null;
    hasText: boolean;
  }
  const blocks: Block[] = [{ lines: [], section: null, hasText: false }];

  for (const line of lines) {
    if (line.role === 'furniture') continue;
    const current = blocks[blocks.length - 1]!;
    if (line.role === 'heading') {
      const section = registerSection(line.text);
      // 見出しは本文に混ぜない。ここで塊を切る（跨いだ文を作らないため）。
      if (current.hasText) blocks.push({ lines: [], section, hasText: false });
      else current.section = section;
      continue;
    }
    current.lines.push(line);
    if (line.text.trim().length > 0) current.hasText = true;
  }

  const occurrences = new Map<string, number>();
  const sentences: Sentence[] = [];
  /** 文ごとに、その文が最後に触れた行の番号。付物を読み順に差し込むときに使う。 */
  const lastLineOf: number[] = [];
  const byIndex = new Map<number, ClassifiedLine>(lines.map((line) => [line.index, line]));
  /**
   * 置き場所を間違えた断片（落ちてはいないが、隣の本文行に押し込まれたもの）。
   * 落とした行と矩形を比べるだけでは映らないので、行の番号で持つ。詳細は layout.ts。
   */
  const displaced = findDisplacedFragments(lines);
  /**
   * 版面の規則だけで落とした行。文に印を付けるかどうかの相手はこれだけ。
   *
   * **ページごとに引けるようにしておく。** 文ごとに全部を舐めると
   * 「文の数 × 落とした行の数」になり、これも二乗の形（別行立ての式が多い論文ほど効く。
   * 200 ページの合成 PDF で 13,772 文 × 1,509 行 = 2,000 万回）。
   * 文が触るページは 1〜2 枚なので、ページで引けば触る量が定数に落ちる。
   */
  const droppedByPage = new Map<number, ClassifiedLine[]>();
  for (const line of lines) {
    if (line.role !== 'furniture' || !isUncertainKind(line.kind)) continue;
    const list = droppedByPage.get(line.page);
    if (list) list.push(line);
    else droppedByPage.set(line.page, [line]);
  }

  for (const block of blocks) {
    const { buffer, owners } = joinLines(block.lines, hyphenEvidence, spacing);
    let cursor = 0;
    for (const raw of splitIntoSentences(buffer)) {
      const at = buffer.indexOf(raw, cursor);
      const from = at === -1 ? cursor : at;
      const to = from + raw.length;
      cursor = to;

      const covered = owners.slice(from, to);
      const text = raw.replace(/\s+/g, ' ').trim();
      if (text.length === 0) continue;
      const hash = sentenceHash(text);
      const occurrence = occurrences.get(hash) ?? 0;
      occurrences.set(hash, occurrence + 1);
      const sentence: Sentence = {
        id: sentenceId(hash, occurrence),
        hash,
        order: sentences.length,
        page: covered[0]?.chunk.page ?? 1,
        text,
        rects: mergeRects(covered),
        sectionId: block.section,
      };
      const seam = findSeam(covered, sentence.rects, byIndex, droppedByPage, displaced);
      if (seam !== null) sentence.seam = seam;
      sentences.push(sentence);
      lastLineOf.push(lastLineOfOwners(covered));
    }
  }

  // 回っている文字は、種類の分かる付物として並べる（画面では「本文以外（訳しません）」）。
  // 図の軸ラベルなので、ページの先頭に置けば「この図の中にこういう字がある」と分かる。
  const rotatedNonBody: NonBodySentence[] = [];
  for (const chunk of rotatedChunks) {
    const text = chunk.text.trim();
    if (text.length === 0) continue;
    const hash = sentenceHash(text);
    const anchor = [...sentences].reverse().find((sentence) => sentence.page <= chunk.page);
    rotatedNonBody.push({
      id: `nb_rot_${hash}_${rotatedNonBody.length}`,
      hash,
      order: rotatedNonBody.length,
      page: chunk.page,
      text,
      rects: [{ page: chunk.page, x: chunk.x, y: chunk.y, w: chunk.w, h: chunk.h }],
      sectionId: anchor?.sectionId ?? null,
      kind: 'other',
      afterOrder: anchor?.order ?? -1,
      afterHash: anchor?.hash ?? null,
    });
  }

  const nonBody = buildNonBody(lines, hyphenEvidence, spacing, sentences, lastLineOf);
  return {
    sentences,
    sections,
    nonBody: rotatedNonBody.length > 0 ? [...nonBody, ...rotatedNonBody] : nonBody,
    quality: assessReadingOrder(lines),
  };
}

/**
 * その文が「本文として採らなかった行と重なる位置で」組み立てられたかを調べる。
 *
 * 文書単位のバッジでは足りない。実測（ML 理論の論文、本文 52 文）で、正しく取れた
 * 46 文と、原文と内容が違う 6 文が同じ顔で並んだ。読む側が知りたいのは
 * 「この文書は怪しい」ではなく「**どの文か**」。
 *
 * 見るのは**矩形だけ**で、新しい当て推量は入れない:
 *
 *   1. 落とした行が、この文の**行の内側**にある（矩形が重なる）。
 *      Σ の上下の添字や分数の分子・分母は、本文の行と同じ帯の中に入り込む。
 *      実測: `such that 1M∥∇F(x) − ∇F (x)∥2 ≤ ζ2 for all x.` の直下に落ちた
 *      `Mm=1 m` が消えて、∇F_m が ∇F になり**仮定の意味が変わった**。
 *   2. 落とした行を**またいで**、この文の行が前後に分かれている。
 *      ただし、またいだ先が段落の頭（字下げがある）のときだけ印を付ける。
 *      実測: 補題の式を飛ばして `For all t larger than t0 = ⌈2/δ⌉ we have` が
 *      次の段落の `The proof is deferred to Appendix A` と 1 文になっていた。
 *      字下げを見るのは、別行立ての式や表を正しく飛ばして**同じ段落が続く**場合
 *      （`Information retrieval benefits from ▮ the same sparsity pattern …`）に
 *      印を付けないため — そちらは文として欠けていない。
 *
 * 種類は `formula` / `table` / `other` に限る。柱・ノンブル・キャプション・参考文献は
 * 構造の手掛かりで落としていて、本文の一部だったということが無い。
 */
function findSeam(
  covered: readonly CharOwner[],
  ink: readonly Rect[],
  byIndex: ReadonlyMap<number, ClassifiedLine>,
  droppedByPage: ReadonlyMap<number, readonly ClassifiedLine[]>,
  displaced: ReadonlySet<number>,
): SentenceSeam | null {
  const used = [...new Set(covered.map((owner) => owner.line))].sort((a, b) => a - b);
  if (used.length === 0) return null;
  const first = used[0]!;
  const last = used[used.length - 1]!;

  /** この文が占めた行。矩形の比較はここが相手。 */
  const bands = used
    .map((index) => byIndex.get(index))
    .filter((line): line is ClassifiedLine => line !== undefined);
  if (bands.length === 0) return null;
  const pages = new Set(bands.map((line) => line.page));

  // 行ごとに「その行で文が占めた左右の端」を出しておく（規則 1 で使う）。
  const bandInk: BandInk[] = bands.map((body) => {
    let left = Infinity;
    let right = -Infinity;
    for (const rect of ink) {
      if (rect.page !== body.page) continue;
      // 同じ行の矩形か（縦に重なっているか）で対応づける。
      if (rect.y + rect.h <= body.y || rect.y >= body.y + body.height) continue;
      if (rect.x < left) left = rect.x;
      if (rect.x + rect.w > right) right = rect.x + rect.w;
    }
    // 対応する矩形が無い行（継ぎ目の空白しか持たない行）は、行の帯をそのまま使う。
    return right > left ? { line: body, left, right } : { line: body, left: body.left, right: body.right };
  });

  const kinds: NonBodyKind[] = [];
  const rects: Rect[] = [];
  const texts: string[] = [];

  /**
   * 置き場所を間違えた断片を、この文が**本文として抱えて**いないか。
   *
   * ここが継ぎ目の印の**対称形**。断片は落ちるとは限らない。
   *   - 落ちた断片 … 本文から消える。下の規則 1・2（落とした行との矩形の比較）で拾う。
   *   - 移動した断片 … 隣の本文行に押し込まれ、そのまま文の一部になる。
   *     落ちていないので**検出器の入力に一度も入らない**。矩形を比べるだけでは永遠に映らない。
   * 実測（レビュアーの 136 文）: 欠落 5 件に対し移動 6 件。数学の論文はインライン
   * `\frac` が普通なので、分母や添字が隣の行に入る**移動のほうが多い**
   * （`The constant 1/4 is not t 4 optimised.` ← 分母の 4 と添字の t がここへ移った）。
   * 落ちた側だけを見る実装に戻さないこと。
   */
  for (const body of bands) {
    if (!displaced.has(body.index)) continue;
    const kind = body.kind ?? 'other';
    if (!kinds.includes(kind)) kinds.push(kind);
    rects.push({
      page: body.page,
      x: round(body.left),
      y: round(body.y),
      w: round(body.right - body.left),
      h: round(body.height),
    });
    texts.push(body.text);
  }

  // ページの昇順 → ページ内は行の順。落とした行を全部舐めていた頃と同じ並びになる
  // （`lines` はページ → 段 → y の順に並んでいるため）。
  for (const page of [...pages].sort((a, b) => a - b)) {
    for (const line of droppedByPage.get(page) ?? []) {
      // 1. 行の内側に入り込んでいるか（矩形が重なる）。
      //    読み順の番号ではなく**版面の位置**で見る。添字の行は本文の行より後ろに
      //    並ぶことがあるので、番号の範囲だけで探すと取り逃がす（実測: ∇F_m の
      //    添字 `Mm=1 m` が文の最終行より後ろの番号にいて、印が付かなかった）。
      const inside = bandInk.some((band) => overlapsBand(band, line));

      // 2. またいだ先が段落の頭か（字下げがある）。
      let jumped = false;
      if (!inside && line.index > first && line.index < last) {
        const after = bands.find((body) => body.index > line.index);
        const before = [...bands].reverse().find((body) => body.index < line.index);
        if (after !== undefined && before !== undefined && after.column === before.column) {
          const indented = after.left > before.left + Math.max(2, after.height * 0.4);
          /**
           * 字下げが無くても、**またいだ手前の行が段の右端に届いていない**なら印を付ける。
           * 段落は右端まで組まれてから折り返すので、右が余っている行は「そこで段落が
           * 切れた」行 — 別行立ての要素がその続きを持っている。
           *
           * 実測: `The estimator that we analyse in this section is` の直後に式 (1) が来て、
           * `… is and the weights are chosen so that …` という**文法の壊れた、原文に
           * 無い文**になっていた。次の行に字下げは無いので、字下げだけを見る規則では
           * 印が付かない。式が文の目的語になる「… is given by (1), where …」は
           * 論文でいちばん多い形。
           *
           * `formula` に絞るのは実測の結果。絞らないと、段落の途中に表が割り込んだだけの
           * 文（こちらは欠けていない）5 件に印が付き、既存テストも落ちた。
           */
          jumped = indented || (before.reachesRight === false && line.kind === 'formula');
        }
      }
      if (!inside && !jumped) continue;

      const kind = line.kind ?? 'other';
      if (!kinds.includes(kind)) kinds.push(kind);
      rects.push({
        page: line.page,
        x: round(line.left),
        y: round(line.y),
        w: round(line.right - line.left),
        h: round(line.height),
      });
      // 落とした行の**本文**も持たせる。矩形だけだと、読む側にできるのは
      // 「この文は飛ばす」しかない。落ちたのが補題の主張そのものだったときに、
      // 飛ばしてよいかどうかを決める材料が無い。文字列があれば継ぎ直せる。
      texts.push(line.text);
    }
  }
  if (rects.length === 0) return null;

  /**
   * 落ちた行の本文は、**読む側が継ぎ直せるときだけ**渡す。
   *
   * 空白だけの文字片は捨てる。行番号つきのコードでは空文字列が 10 個入り、画面には
   * 「抜けたのはここ: … / / out = out_proj ( out ) / /」と区切りだけが並んでいた。
   *
   * そのうえで、**1 つも読める断片が無いなら `texts` ごと落とす**。インライン分数の
   * 分母や添字は 1〜2 文字の断片にしかならず（実測: `["4"]` `["c"]` `["δ","2"]`）、
   * 文中のどこに・どういう関係で入るかが分からないので、「抜けたのはここ: 4」と
   * 出しても読む側には何も渡せない。矩形と印は残るので「ここが欠けている」ことは
   * 伝わる — **無いことが分かる**のと、**継ぎ直せる**のは別の話で、texts は後者のためにある。
   *
   * 読める断片が 1 つでもあれば、短いものも一緒に残す。同じ式の一部なので、
   * 長いほうと並べて初めて意味を持つ（`["μˆ = n∑wizi, (1)", "i=1"]` の `i=1`）。
   */
  const usable = texts.filter((text) => text.trim().length > 0);
  const readable = usable.some((text) => text.replace(/\s+/g, '').length >= MIN_SEAM_TEXT_CHARS);
  return readable ? { kinds, rects, texts: usable } : { kinds, rects };
}

/**
 * その文が最後に触れた行の番号。
 *
 * `Math.max(...covered.map(…))` と書いてはいけない。スプレッドは**配列を引数に展開する**ので、
 * 要素数が引数の上限（V8 では実測 12.5 万、ワーカースレッドでは約 50 万）を超えると
 * `RangeError: Maximum call stack size exceeded` で落ちる。`covered` は文 1 つの**文字数**
 * なので、文末記号が 1 つも無い文書（OCR で句点が落ちた稿、終止符を使わない言語、
 * 本文と判定された付録のデータ列）では簡単に超える。実測: 1 行 54 字の PDF で
 * 2400 行＝約 53 ページから落ち、しかも画面には「PDF が壊れているか、PaperLens が
 * 扱えない作りのファイルです」と出ていた（壊れていない）。
 */
function lastLineOfOwners(covered: readonly CharOwner[]): number {
  let last = -1;
  for (const owner of covered) if (owner.line > last) last = owner.line;
  return last;
}

/**
 * 落とした行が、その文の**インク**にどれだけ重なっているかの下限（短いほうに対する比）。
 *
 * 下限が無かった頃は、**すれ違っただけ**で印が付いていた。実測（theorem-display）で
 * 縦の重なりが 0.03pt（低いほうの字高の 0.3%）の組み合わせが発火していた。
 *
 * 本物の重なりは、いちばん浅いもので 0.14（総和の添字 `m=1` が本文行の帯に 1pt
 * 食い込む形。既存テスト『落とした行が文の内側にあるとき、その文に印を付ける』）、
 * 深いもので 0.28〜0.50。0.05 で切ると、すれ違い（0.003）とは 15 倍、
 * いちばん浅い本物とは 2.9 倍の隔たりがある。**上げすぎると本物が落ちる** —
 * 0.15 にしたら上の既存テストが落ちた。
 */
const MIN_SEAM_OVERLAP = 0.05;

/**
 * 文が占めた行と、その行で**文が実際に占めた左右の端**。
 *
 * 縦は行の帯で見る。文の矩形（mergeRects の結果）は上付き・下付きを含む外接なので、
 * 行より背が高くなることがあり、そのまま縦に使うと隣の行の式にまで当たる
 * （実測: これで 3 段組と twocolumn に誤爆が 1 件ずつ出た）。
 *
 * 横は**文の矩形**で見る。行の帯で見ていた頃は、1 行を 2 文が共有しているとき
 * （"… ends here. Beta starts here." が 1 行に収まる形）、右半分に落ちた式が
 * **左半分の文にも**印を付けていた。文の矩形は mergeRects が文字数で按分しているので、
 * その文が紙面のどこを占めていたかを持っている。
 */
interface BandInk {
  line: ClassifiedLine;
  left: number;
  right: number;
}

/**
 * 落ちた行の本文を「読める」と認める最小の文字数（空白を除く）。
 *
 * 実測の分かれ目そのもの。継ぎ直せた例はいちばん短いもので `Mm=1 m`（6 字）、
 * 継ぎ直せなかった例は `4` `c` `δ` `nμ`（1〜2 字）。3 字で切ると両者が分かれる。
 */
const MIN_SEAM_TEXT_CHARS = 3;

/** 落とした行が、その帯（縦）と文のインク（横）に実際に重なっているか。 */
function overlapsBand(band: BandInk, line: ClassifiedLine): boolean {
  const body = band.line;
  if (body.page !== line.page) return false;
  const height = Math.min(line.height, body.height);
  if (height <= 0) return false;
  const overlapY = Math.min(line.y + line.height, body.y + body.height) - Math.max(line.y, body.y);
  if (overlapY < height * MIN_SEAM_OVERLAP) return false;
  const width = Math.min(line.right - line.left, band.right - band.left);
  if (width <= 0) return false;
  const overlapX = Math.min(line.right, band.right) - Math.max(line.left, band.left);
  return overlapX >= width * MIN_SEAM_OVERLAP;
}

/**
 * 本文として扱わなかった行を、捨てずに読み順つきで組み立てる。
 *
 * 落とすこと自体は正しくても（参考文献を訳す必要はない）、落としたことが
 * 誰にも見えないと「まだ訳が来ていないのか、自分が見落としたのか」を区別できない。
 * はじめて使った人の言葉: 「ヘッダーは 26 / 27 文 と出るので、完了したように見えます」。
 *
 * ここで返すものは `sentences` には入れない。入れると訳す対象になり、進捗の分母も
 * 狂う。画面が「（訳さない：参考文献）」として並べるための材料としてだけ持つ。
 */
function buildNonBody(
  lines: readonly ClassifiedLine[],
  evidence: HyphenEvidence,
  spacing: ScriptSpacing,
  sentences: readonly Sentence[],
  lastLineOf: readonly number[],
): NonBodySentence[] {
  // 紙面の 1 かたまり（折り返したキャプション 1 つ、参考文献 1 エントリ）に束ねる。
  // 行ごとに 1 件にすると "pipeline." のような断片が並び、かえって読めない。
  const groups: ClassifiedLine[][] = [];
  for (const line of lines) {
    if (line.role !== 'furniture') continue;
    const current = groups[groups.length - 1];
    const previous = current?.[current.length - 1];
    const continues =
      previous !== undefined &&
      previous.page === line.page &&
      previous.column === line.column &&
      previous.kind === line.kind &&
      // 間に本文の行が挟まっていたら別のかたまり。
      line.index === previous.index + 1 &&
      // 参考文献の次のエントリや次のキャプションは、そこで区切る
      // （参考文献 3 件が 1 件に束ねられて画面に出てしまう）。
      line.startsBlock !== true &&
      Math.abs(line.y - previous.y) <= Math.max(4, previous.height * 2.2);
    if (continues) current!.push(line);
    else groups.push([line]);
  }

  const out: NonBodySentence[] = [];
  const occurrences = new Map<string, number>();
  // かたまりは行番号の順に並ぶので、本文側の走査位置も前へ戻らない。
  let cursor = 0;
  for (const group of groups) {
    const { buffer, owners } = joinLines(group, evidence, spacing);
    const text = buffer.replace(/\s+/g, ' ').trim();
    if (text.length === 0) continue;
    const firstLine = group[0]!.index;
    while (cursor < sentences.length && lastLineOf[cursor]! < firstLine) cursor++;
    const afterOrder = cursor - 1;
    const hash = sentenceHash(text);
    const occurrence = occurrences.get(hash) ?? 0;
    occurrences.set(hash, occurrence + 1);
    out.push({
      // 本文の文と ID がぶつからないよう、別の接頭辞を使う
      // （同じ文字列が本文にも付物にも出ることはある）。
      id: occurrence === 0 ? `nb_${hash}` : `nb_${hash}_${occurrence}`,
      hash,
      order: out.length,
      page: owners[0]?.chunk.page ?? group[0]!.page,
      text,
      rects: mergeRects(owners),
      // 直前の本文の文と同じ節に置く。画面で節の中の正しい位置に差し込める。
      sectionId: afterOrder >= 0 ? (sentences[afterOrder]?.sectionId ?? null) : null,
      kind: group[0]!.kind ?? 'other',
      afterOrder,
      afterHash: afterOrder >= 0 ? (sentences[afterOrder]?.hash ?? null) : null,
    });
  }
  return out;
}

/**
 * 行の並びを 1 本の文字列に連結し、連結後の 1 文字ずつの出どころを記録する。
 *
 * 本文の塊にも付物の塊にも使う。行の組み立て方（文字片の継ぎ目に空白を入れるか、
 * 行末のハイフンを残すか）は、本文でも図表キャプションでも同じでよい。
 */
function joinLines(
  lines: readonly ClassifiedLine[],
  evidence: HyphenEvidence,
  spacing: ScriptSpacing,
): Segment {
  // 連結中の本文は**断片の配列**で持つ（TextBuilder の説明に、なぜ 1 本の文字列だと
  // O(n²) になるかを書いた）。1 本の文字列に直すのは最後の 1 回だけ。
  const builder: TextBuilder = { parts: [], length: 0 };
  const owners: CharOwner[] = [];
  /**
   * 連結後の文字と、その出どころ（文字片・行）を対応づける。
   * `offset` は文字片の本文内の位置。行の継ぎ目に入れる空白は元の文字片に無いので、
   * `from` に -1 を渡して「位置を持たない文字」として記録する（mergeRects が幅から除く）。
   */
  const push = (text: string, chunk: TextChunk, line: number, from: number): void => {
    appendText(builder, text);
    for (let k = 0; k < text.length; k++) {
      owners.push({ chunk, line, offset: from < 0 ? -1 : from + k });
    }
  };

  /**
   * 文字片の本文を押し込む。`tracking` が立っている行では、和文どうしの間の空白を
   * 落とす（pdf.js が字間から作った偽物なので、残すと語の途中が割れる）。
   */
  const pushChunkText = (chunk: TextChunk, line: number, tracking: boolean): void => {
    if (!tracking) {
      push(chunk.text, chunk, line, 0);
      return;
    }
    let from = 0;
    for (let i = 0; i < chunk.text.length; i++) {
      if (chunk.text[i] !== ' ') continue;
      if (!isCjk(chunk.text[i - 1]) || !isCjk(chunk.text[i + 1])) continue;
      push(chunk.text.slice(from, i), chunk, line, from);
      from = i + 1;
    }
    push(chunk.text.slice(from), chunk, line, from);
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const trackingSpaces = hasTrackingSpaces(line.text);
    const stacked = stackedScriptSpaces(line.chunks);

    let previousRight: number | null = null;
    for (const chunk of line.chunks) {
      if (chunk.text.length === 0) continue;
      // 下付きと上付きを重ねて組んだ位置の空白。紙面は空いていないので字面にも出さない。
      // previousRight は進めない（この空白の幅は下付きが占めている）。
      if (stacked.has(chunk)) continue;
      // 文字片の境目に無条件で空白を入れると、書体が変わるだけの箇所（斜体・合字・
      // カーニング）で語が割れる。実際に隙間があるときだけ空白を入れる。
      //
      // 和文どうしの境目では閾値を上げる。和文は 1 文字ぶん（ほぼ 1em）進むので、
      // 約物の詰め（句読点は半角ぶん空く）や字間の伸縮だけで欧文の空白 1 個ぶんを超える。
      // 実測した和文 PDF では、本物の空白は pdf.js が空白文字として返してくるので、
      // 隙間から推測する必要がそもそも無い。
      const gap = previousRight === null ? Infinity : chunk.x - previousRight;
      const lastChar = charFromEnd(builder, 0);
      const ratio = spacesAtBoundary(lastChar, chunk.text[0], spacing) ? 0.22 : 0.75;
      const separated =
        gap > chunk.h * ratio ||
        // 数式の二項演算子の隣は、隙間が潰れていても空白として読む（理由は関数の説明）。
        isBinaryOperatorBoundary(builder, owners, chunk.text);
      if (previousRight !== null && separated && lastChar !== ' ') {
        push(' ', chunk, line.index, -1);
      }
      pushChunkText(chunk, line.index, trackingSpaces);
      previousRight = chunk.x + chunk.w;
    }
    // 行の継ぎ目。欧文は語の切れ目でしか折り返さないので空白が要るが、和文には
    // 語の切れ目が無いので、入れると折り返すたびに語の途中が割れる。
    // どちらかは継ぎ目の**両側の文字の種類**で決まる（spacesAtBoundary）。
    const next = lines[li + 1];
    const endChar = charFromEnd(builder, 0);
    if (
      builder.length > 0 &&
      endChar !== ' ' &&
      spacesAtBoundary(endChar, firstCharOf(next), spacing)
    ) {
      push(' ', line.chunks[line.chunks.length - 1]!, line.index, -1);
    }

    // 行末ハイフンの処理。読み順で次に来る行が続きなので、段やページを跨いでいても
    // 結合を検討する（跨いだときだけ "informa- tion" が画面に残る、という妙な
    // 非対称が起きていた）。
    if (!next) continue;

    /**
     * ハイフンを含む語全体を取る。"state-of-the-" の末尾から "the" だけを見ると、
     * 文書内の用例 "state-of-the-art" と照合できない。
     *
     * 照合は**末尾の語だけ**に当てる。HYPHEN_AT_LINE_END は `$` で閉じているだけで
     * `^` が無いので、塊の全文に当てると V8 は先頭から全位置を試す。つまり 1 行つき
     * O(それまでの全文字数)、塊全体で O(n²)。塊は見出しでしか切れないので、見出しの
     * 少ない原稿ほど 1 本のバッファが文書全体まで育つ。実測（合成 PDF・2 段組）:
     * buildSentencesFromChunks の 60 ページ 21.6 秒のうち、この 1 行だけで大半を使い、
     * 120 ページでは 87.9 秒（入力 2 倍で 4.1 倍＝きれいな二乗）だった。
     *
     * 末尾だけで足りる理由: 一致する範囲は `((?:\p{L}+[-‐‑])*\p{L}+)[-‐‑]\s$` なので、
     * 最後の空白の手前は**欧字とハイフンだけ**で埋まっている。つまり一致は必ず
     * 「末尾から数えて、欧字でもハイフンでもない文字が現れるまで」の中に収まる。
     * その並びを切り出してから当てれば、結果は全文に当てたときと 1 文字も変わらない。
     */
    // 窓を作る前に、当たりようがない行を弾く（正規表現の `[-‐‑]\s$` そのもの）。
    // 行末がハイフンで終わる行は全体の数 % しかないので、ここでほとんどが落ちる。
    const endsWhite = charFromEnd(builder, 0);
    if (endsWhite === undefined || !/\s/.test(endsWhite)) continue;
    const hyphenChar = charFromEnd(builder, 1);
    if (hyphenChar === undefined || !HYPHEN_CHAR.test(hyphenChar)) continue;
    const hyphen = HYPHEN_AT_LINE_END.exec(tailWindow(builder));
    if (!hyphen) continue;
    const nextWord = /^(\p{L}+)/u.exec(next.text)?.[1];
    if (!nextWord) continue;
    // 和文には行末ハイフネーションが無い（語の途中で折り返すときに記号を足さない）。
    // `\p{L}` は漢字・かなにも当たるので、ここで明示的に降りないと、
    // 和文の隣に立った欧文の複合語を勝手に繋いだり落としたりしてしまう。
    const left = hyphen[1]!;
    if (isCjk(left[left.length - 1]) || isCjk(nextWord[0])) continue;

    if (decideLineEndHyphen(left.replace(HYPHEN_CHARS, '-'), nextWord, evidence)) {
      // 本来ハイフンを含む複合語。ハイフンを残したまま行を直結する（空白だけ落とす）。
      truncateText(builder, 1);
    } else {
      // 真のハイフネーション。ハイフンごと落とす。
      // 末尾は正規表現が保証する「ハイフン + 空白」なので、落とすのは必ず 2 文字。
      truncateText(builder, 2);
    }
    owners.length = builder.length;
  }

  // ここで初めて 1 本の文字列にする。途中で `slice` していた頃は、削るたびに
  // 塊の全文が平坦化されていた（TextBuilder の説明を参照）。
  return { buffer: builder.parts.join(''), owners };
}
