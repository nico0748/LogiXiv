import type { PageSize, Rect, Sentence, Section } from './types.ts';
import { sentenceHash, sentenceId, stableId } from './hash.ts';
import { buildLines, classifyLines, type ClassifiedLine } from './layout.ts';

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
    let end = i + 1;
    while (end < text.length && /[)\]}"'’”]/.test(text[end]!)) end++;

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
  // 小数点・バージョン番号・省略記号。
  if (/\d/.test(text[index - 1] ?? '') && /\d/.test(text[index + 1] ?? '')) return false;
  if (text[index + 1] === '.' || text[index - 1] === '.') return false;

  const word = wordBefore(text, index);

  // 'al' が入っているので "et al." もここで止まる。
  if (ABBREVIATIONS.has(word)) return false;
  if (ABBREVIATIONS_BEFORE_NUMBER.has(word) && /^\s*\d/.test(text.slice(index + 1))) return false;

  // 頭字語（"the U.S. government"）。続く語が小文字なら文の途中で確定。
  // 続く語が大文字始まりなら、そこで文が終わっている方が自然なので通常の判定に落とす。
  if (DOTTED_ACRONYM.test(word) && !/^\s*\p{Lu}/u.test(text.slice(index + 1))) return false;

  // 単一大文字。"J. Doe" のイニシャルか、"we sweep the temperature T." の記号か。
  if (/^[A-Z]$/.test(text[index - 1] ?? '') && !/\p{L}/u.test(text[index - 2] ?? ' ')) {
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
 * 矩形は行単位でまとめる。以前は `Math.round(y)` の一致で束ねていたため、
 * 同じ行でも y が丸め境界をまたぐと矩形が 2 つに割れてハイライトが二重になっていた。
 */
function mergeRects(owners: { chunk: TextChunk; line: number }[]): Rect[] {
  const byLine = new Map<number, TextChunk[]>();
  for (const { chunk, line } of owners) {
    const list = byLine.get(line);
    if (list) {
      if (!list.includes(chunk)) list.push(chunk);
    } else {
      byLine.set(line, [chunk]);
    }
  }
  const rects: Rect[] = [];
  for (const list of byLine.values()) {
    const page = list[0]!.page;
    const x0 = Math.min(...list.map((c) => c.x));
    const y0 = Math.min(...list.map((c) => c.y));
    const x1 = Math.max(...list.map((c) => c.x + c.w));
    const y1 = Math.max(...list.map((c) => c.y + c.h));
    rects.push({ page, x: round(x0), y: round(y0), w: round(x1 - x0), h: round(y1 - y0) });
  }
  return rects.sort((a, b) => a.page - b.page || a.y - b.y);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface FallbackResult {
  sentences: Sentence[];
  sections: Section[];
}

/**
 * 行末ハイフンを落として良いかの判断材料。
 * 同じ文書の**行の途中**に "block-sparse" のような形で現れるハイフン付き複合語を集めておき、
 * 行末で割れた語がそれに一致するならハイフンを残す。
 * 辞書を持たずに "state-of-the-art" を守り、"informa-" + "tion" は結合できる。
 */
function collectInlineHyphenated(lines: ClassifiedLine[]): Set<string> {
  const seen = new Set<string>();
  for (const line of lines) {
    // 行末のハイフンは「割れた語」なので用例として数えない。数えると
    // 「割れた語は必ず用例あり」になり、ハイフンが永久に残る。
    const text = line.text.replace(/-\s*$/, '');
    for (const match of text.matchAll(/\p{L}+(?:-\p{L}+)+/gu)) {
      seen.add(match[0].toLowerCase());
    }
  }
  return seen;
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
  const inlineHyphenated = collectInlineHyphenated(lines);

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
   * 本文を読み順（ページ → 段 → 行）に連結しつつ、
   * 連結後の文字位置 →（文字片, 行, 節）の対応表を作る。
   *
   * 見出しで**段落の塊を切る**。以前は区切り文字を 1 つ挟むだけだったが、
   * 分割器は改行を空白として畳むので、見出しの手前で切れていない文が
   * 見出しの次の文と 1 枚のカードに同居していた（しかも節の帰属まで狂う）。
   */
  interface Segment {
    buffer: string;
    owners: { chunk: TextChunk; line: number; section: string | null }[];
  }
  const segments: Segment[] = [{ buffer: '', owners: [] }];
  let currentSection: string | null = null;

  const push = (text: string, chunk: TextChunk, line: number): void => {
    const segment = segments[segments.length - 1]!;
    segment.buffer += text;
    for (let k = 0; k < text.length; k++) segment.owners.push({ chunk, line, section: currentSection });
  };

  const bodyLines = lines.filter((line) => line.role !== 'furniture');

  for (let li = 0; li < bodyLines.length; li++) {
    const line = bodyLines[li]!;

    if (line.role === 'heading') {
      currentSection = registerSection(line.text);
      // 見出しは本文に混ぜない。ここで塊を切る（跨いだ文を作らないため）。
      if (segments[segments.length - 1]!.buffer.trim().length > 0) segments.push({ buffer: '', owners: [] });
      continue;
    }

    let previousRight: number | null = null;
    for (const chunk of line.chunks) {
      if (chunk.text.length === 0) continue;
      // 文字片の境目に無条件で空白を入れると、書体が変わるだけの箇所（斜体・合字・
      // カーニング）で語が割れる。実際に隙間があるときだけ空白を入れる。
      const gap = previousRight === null ? Infinity : chunk.x - previousRight;
      if (previousRight !== null && gap > chunk.h * 0.22) {
        const segment = segments[segments.length - 1]!;
        if (!segment.buffer.endsWith(' ')) push(' ', chunk, line.index);
      }
      push(chunk.text, chunk, line.index);
      previousRight = chunk.x + chunk.w;
    }
    {
      const segment = segments[segments.length - 1]!;
      if (segment.buffer.length > 0 && !segment.buffer.endsWith(' ')) {
        push(' ', line.chunks[line.chunks.length - 1]!, line.index);
      }
    }

    // 行末ハイフンの処理。読み順で次に来る**本文**行が続きなので、
    // 段やページを跨いでいても結合を検討する（跨いだときだけ "informa- tion" が
    // 画面に残る、という妙な非対称が起きていた）。
    const next = bodyLines[li + 1];
    if (!next || next.role !== 'body') continue;
    // ハイフンを含む語全体を取る。"state-of-the-" の末尾から "the" だけを見ると、
    // 文書内の用例 "state-of-the-art" と照合できない。
    const segment = segments[segments.length - 1]!;
    const hyphen = /((?:\p{L}+-)*\p{L}+)-\s$/u.exec(segment.buffer);
    if (!hyphen) continue;
    const nextWord = /^(\p{L}+)/u.exec(next.text)?.[1];
    if (!nextWord) continue;

    const joined = `${hyphen[1]!}-${nextWord}`.toLowerCase();
    if (inlineHyphenated.has(joined)) {
      // 本来ハイフンを含む複合語。ハイフンを残したまま行を直結する（空白だけ落とす）。
      segment.buffer = segment.buffer.slice(0, -1);
      segment.owners.length = segment.buffer.length;
    } else {
      // 真のハイフネーション。ハイフンごと落とす。
      const cut = segment.buffer.lastIndexOf('-');
      segment.buffer = segment.buffer.slice(0, cut);
      segment.owners.length = cut;
    }
  }

  const occurrences = new Map<string, number>();
  const sentences: Sentence[] = [];
  for (const { buffer, owners } of segments) {
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
      sectionId: covered[0]?.section ?? null,
    });
  }
  }

  return { sentences, sections };
}
