import type { NonBodySentence, PageSize, Rect, Sentence, Section, StructureQuality } from './types.ts';
import { sentenceHash, sentenceId, stableId } from './hash.ts';
import { assessReadingOrder, buildLines, classifyLines, type ClassifiedLine } from './layout.ts';

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

const TERMINATORS = new Set(['.', '!', '?', '。', '！', '？']);

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

    const after = text.slice(end);
    // 欧文の文末には空白が要る（"3.14" のような並びを切らない）。CJK の終端記号は空白不要。
    if (after.length > 0 && !/^\s/.test(after) && !/[。！？]/.test(ch)) continue;

    const candidate = text.slice(start, end).trim();
    if (candidate.length > 0) out.push(candidate);
    start = end;
    i = end - 1;
  }
  const tail = text.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out.filter((s) => /\p{L}/u.test(s));
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
function isBinaryOperatorBoundary(segment: Segment, next: string): boolean {
  const buffer = segment.buffer;
  const last = buffer[buffer.length - 1];
  const head = next[0];
  if (last === undefined || head === undefined) return false;
  // 被演算子 → 演算子。手前の被演算子は `last` そのもの。
  if (isOperandEnd(last) && MATH_BINARY.test(head)) return true;
  // 演算子 → 被演算子。演算子の手前に被演算子があるかを見る。
  if (MATH_BINARY.test(last) && isOperandStart(head)) {
    // 空白の幅は**演算子の字高**で測る。空白の側の字高は上付き・下付きだと小さく
    // 出るので（実測: 上付きの直後の空き 1.26pt は、自分の字高 6.97 では 0.18 em に
    // 見えるが、本文の 9.96 では 0.13 em）、そのままでは語間と区別がつかない。
    const em = segment.owners[buffer.length - 1]?.chunk.h ?? 0;
    let i = buffer.length - 2;
    if (i >= 0 && buffer[i] === ' ' && isThinSpace(segment.owners[i], em)) i--;
    return i >= 0 && isOperandEnd(buffer[i]);
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
 * 文字片の一部だけを使ったときは、**文字数の比**で x を按分する。等幅ではないので
 * 境目は数文字ぶんずれるが、行の左半分と右半分が別の文に分かれるという肝心の性質は保たれる。
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
    const x0 = chunk.x + (chunk.w * Math.min(span.from, length)) / length;
    const x1 = chunk.x + (chunk.w * Math.min(span.to, length)) / length;
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
  const lines = classifyLines(buildLines(chunks), pages);
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
      sentences.push({
        id: sentenceId(hash, occurrence),
        hash,
        order: sentences.length,
        page: covered[0]?.chunk.page ?? 1,
        text,
        rects: mergeRects(covered),
        sectionId: block.section,
      });
      lastLineOf.push(covered.length === 0 ? -1 : Math.max(...covered.map((o) => o.line)));
    }
  }

  return {
    sentences,
    sections,
    nonBody: buildNonBody(lines, hyphenEvidence, spacing, sentences, lastLineOf),
    quality: assessReadingOrder(lines),
  };
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
  const segment: Segment = { buffer: '', owners: [] };
  /**
   * 連結後の文字と、その出どころ（文字片・行）を対応づける。
   * `offset` は文字片の本文内の位置。行の継ぎ目に入れる空白は元の文字片に無いので、
   * `from` に -1 を渡して「位置を持たない文字」として記録する（mergeRects が幅から除く）。
   */
  const push = (text: string, chunk: TextChunk, line: number, from: number): void => {
    segment.buffer += text;
    for (let k = 0; k < text.length; k++) {
      segment.owners.push({ chunk, line, offset: from < 0 ? -1 : from + k });
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
      const ratio = spacesAtBoundary(segment.buffer[segment.buffer.length - 1], chunk.text[0], spacing)
        ? 0.22
        : 0.75;
      const separated =
        gap > chunk.h * ratio ||
        // 数式の二項演算子の隣は、隙間が潰れていても空白として読む（理由は関数の説明）。
        isBinaryOperatorBoundary(segment, chunk.text);
      if (previousRight !== null && separated && !segment.buffer.endsWith(' ')) {
        push(' ', chunk, line.index, -1);
      }
      pushChunkText(chunk, line.index, trackingSpaces);
      previousRight = chunk.x + chunk.w;
    }
    // 行の継ぎ目。欧文は語の切れ目でしか折り返さないので空白が要るが、和文には
    // 語の切れ目が無いので、入れると折り返すたびに語の途中が割れる。
    // どちらかは継ぎ目の**両側の文字の種類**で決まる（spacesAtBoundary）。
    const next = lines[li + 1];
    if (
      segment.buffer.length > 0 &&
      !segment.buffer.endsWith(' ') &&
      spacesAtBoundary(segment.buffer[segment.buffer.length - 1], firstCharOf(next), spacing)
    ) {
      push(' ', line.chunks[line.chunks.length - 1]!, line.index, -1);
    }

    // 行末ハイフンの処理。読み順で次に来る行が続きなので、段やページを跨いでいても
    // 結合を検討する（跨いだときだけ "informa- tion" が画面に残る、という妙な
    // 非対称が起きていた）。
    if (!next) continue;
    // ハイフンを含む語全体を取る。"state-of-the-" の末尾から "the" だけを見ると、
    // 文書内の用例 "state-of-the-art" と照合できない。
    const hyphen = HYPHEN_AT_LINE_END.exec(segment.buffer);
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
      segment.buffer = segment.buffer.slice(0, -1);
      segment.owners.length = segment.buffer.length;
    } else {
      // 真のハイフネーション。ハイフンごと落とす。
      // 末尾は正規表現が保証する「ハイフン + 空白」なので、位置は必ず length - 2。
      // （lastIndexOf('-') では U+2010/U+2011 のハイフンを取り逃がす。）
      const cut = segment.buffer.length - 2;
      segment.buffer = segment.buffer.slice(0, cut);
      segment.owners.length = cut;
    }
  }

  return segment;
}
