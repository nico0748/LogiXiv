import type { PageSize, Rect, Sentence, Section } from './types.ts';
import { sentenceHash, sentenceId } from './hash.ts';

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

interface Line {
  page: number;
  /** 行の識別子。矩形をまとめる単位でもある。 */
  index: number;
  chunks: TextChunk[];
  y: number;
}

/** y 座標の近い文字片を 1 行にまとめる。閾値は文字高の 60%。 */
function groupIntoLines(chunks: TextChunk[]): Line[] {
  const byPage = new Map<number, TextChunk[]>();
  for (const chunk of chunks) {
    if (chunk.text.length === 0) continue;
    const list = byPage.get(chunk.page);
    if (list) list.push(chunk);
    else byPage.set(chunk.page, [chunk]);
  }

  const lines: Line[] = [];
  for (const [page, items] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    items.sort((a, b) => a.y - b.y || a.x - b.x);
    let current: Line | null = null;
    for (const item of items) {
      const tolerance = Math.max(2, item.h * 0.6);
      if (current && Math.abs(item.y - current.y) <= tolerance) {
        current.chunks.push(item);
      } else {
        current = { page, index: lines.length, chunks: [item], y: item.y };
        lines.push(current);
      }
    }
  }
  for (const line of lines) line.chunks.sort((a, b) => a.x - b.x);
  return lines;
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
function collectInlineHyphenated(lines: Line[]): Set<string> {
  const seen = new Set<string>();
  for (const line of lines) {
    const text = line.chunks.map((c) => c.text).join('');
    for (const match of text.matchAll(/\p{L}+(?:-\p{L}+)+/gu)) {
      seen.add(match[0].toLowerCase());
    }
  }
  return seen;
}

/**
 * 文字片から文を組み立てる。
 * 見出しは検出しないので sections は常に空（GROBID 経路との差が UI で分かるようにする）。
 */
export function buildSentencesFromChunks(chunks: TextChunk[], _pages: PageSize[]): FallbackResult {
  const lines = groupIntoLines(chunks);
  const inlineHyphenated = collectInlineHyphenated(lines);

  // 行を連結しつつ、連結後の文字位置 → （文字片, 行）の対応表を作る。
  let buffer = '';
  const owners: { chunk: TextChunk; line: number }[] = [];

  const push = (text: string, chunk: TextChunk, line: number): void => {
    buffer += text;
    for (let k = 0; k < text.length; k++) owners.push({ chunk, line });
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    for (const chunk of line.chunks) {
      if (chunk.text.length === 0) continue;
      push(chunk.text, chunk, line.index);
      if (!chunk.text.endsWith(' ')) push(' ', chunk, line.index);
    }

    // 行末ハイフンの処理。次の行の先頭が英字のときだけ結合を検討する。
    const nextLine = lines[li + 1];
    if (!nextLine || nextLine.page !== line.page) continue;
    // ハイフンを含む語全体を取る。"state-of-the-" の末尾から "the" だけを見ると、
    // 文書内の用例 "state-of-the-art" と照合できない。
    const hyphen = /((?:\p{L}+-)*\p{L}+)-\s$/u.exec(buffer);
    if (!hyphen) continue;
    const nextText = nextLine.chunks.map((c) => c.text).join('').trimStart();
    const nextWord = /^(\p{L}+)/u.exec(nextText)?.[1];
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
    const hash = sentenceHash(raw);
    const occurrence = occurrences.get(hash) ?? 0;
    occurrences.set(hash, occurrence + 1);
    sentences.push({
      id: sentenceId(hash, occurrence),
      hash,
      order: sentences.length,
      page: covered[0]?.chunk.page ?? 1,
      text: raw,
      rects: mergeRects(covered),
      sectionId: null,
    });
  }

  return { sentences, sections: [] };
}
