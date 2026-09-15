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

  // 単一大文字。"J. Doe" のイニシャルか、"we call this method X." のラベルか。
  if (/^[A-Z]$/.test(text[index - 1] ?? '') && !/\p{L}/u.test(text[index - 2] ?? ' ')) {
    const head = wordBefore(text, index - 1);
    if (LABEL_HEADS.has(head)) return true; // ラベルなので文末
    // もう 1 つイニシャルが続く（"J. R. R.") か、直後が大文字始まりの語ならイニシャル扱い。
    if (/^\s*(?:[A-Z]\.|\p{Lu}\p{Ll})/u.test(text.slice(index + 1))) return false;
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
  const pageCount = pages.length > 0 ? pages.length : new Set(chunks.map((c) => c.page)).size;
  const lines = classifyLines(buildLines(chunks), pageCount);
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

  // 本文を読み順（ページ → 段 → 行）に連結しつつ、
  // 連結後の文字位置 → （文字片, 行, 節）の対応表を作る。
  let buffer = '';
  const owners: { chunk: TextChunk; line: number; section: string | null }[] = [];
  let currentSection: string | null = null;

  const push = (text: string, chunk: TextChunk, line: number): void => {
    buffer += text;
    for (let k = 0; k < text.length; k++) owners.push({ chunk, line, section: currentSection });
  };

  const bodyLines = lines.filter((line) => line.role !== 'furniture');

  for (let li = 0; li < bodyLines.length; li++) {
    const line = bodyLines[li]!;

    if (line.role === 'heading') {
      currentSection = registerSection(line.text);
      // 見出しは本文に混ぜない。直前の文をここで区切るため、終端を入れておく。
      if (buffer.length > 0 && !/[.!?。！？]\s*$/.test(buffer)) push('\n', line.chunks[0]!, line.index);
      continue;
    }

    for (const chunk of line.chunks) {
      if (chunk.text.length === 0) continue;
      push(chunk.text, chunk, line.index);
      if (!chunk.text.endsWith(' ')) push(' ', chunk, line.index);
    }

    // 行末ハイフンの処理。次の**本文**行が同じ段にあるときだけ結合を検討する。
    const next = bodyLines[li + 1];
    if (!next || next.role !== 'body' || next.page !== line.page || next.column !== line.column) continue;
    // ハイフンを含む語全体を取る。"state-of-the-" の末尾から "the" だけを見ると、
    // 文書内の用例 "state-of-the-art" と照合できない。
    const hyphen = /((?:\p{L}+-)*\p{L}+)-\s$/u.exec(buffer);
    if (!hyphen) continue;
    const nextWord = /^(\p{L}+)/u.exec(next.text)?.[1];
    if (!nextWord) continue;

    const joined = `${hyphen[1]!}-${nextWord}`.toLowerCase();
    if (inlineHyphenated.has(joined)) {
      // 本来ハイフンを含む複合語。ハイフンを残したまま行を直結する（空白だけ落とす）。
      buffer = buffer.slice(0, -1);
      owners.length = buffer.length;
    } else {
      // 真のハイフネーション。ハイフンごと落とす。
      const cut = buffer.lastIndexOf('-');
      buffer = buffer.slice(0, cut);
      owners.length = cut;
    }
  }

  const occurrences = new Map<string, number>();
  const sentences: Sentence[] = [];
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

  return { sentences, sections };
}
