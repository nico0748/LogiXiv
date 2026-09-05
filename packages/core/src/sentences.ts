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

/** 文末とみなさない略語。ピリオドの後ろが大文字でも切らない。 */
const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'et al', 'cf', 'vs', 'fig', 'figs', 'eq', 'eqs', 'ref', 'refs',
  'sec', 'tab', 'approx', 'no', 'vol', 'pp', 'ca', 'resp', 'dr', 'prof', 'mr', 'ms', 'mrs', 'st',
]);

const TERMINATORS = new Set(['.', '!', '?', '。', '！', '？']);

/**
 * 英語の学術文向けの文分割。
 * 「ピリオド＋空白＋大文字」を基本に、略語・小数・単一大文字イニシャル・
 * 閉じ括弧や引用符の後置きを例外として扱う。
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
    // 文末の後には空白が要る（"3.14" のような並びを切らない）。
    if (after.length > 0 && !/^\s/.test(after) && !/^[。！？]/.test(ch)) continue;

    const candidate = text.slice(start, end).trim();
    if (candidate.length > 0) out.push(candidate);
    start = end;
    i = end - 1;
  }
  const tail = text.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out.filter((s) => /\p{L}/u.test(s));
}

function isSentenceEndingPeriod(text: string, index: number): boolean {
  // 小数点・バージョン番号。
  if (/\d/.test(text[index - 1] ?? '') && /\d/.test(text[index + 1] ?? '')) return false;
  // 単一大文字のイニシャル ("J. Doe")。
  const prev2 = text[index - 2] ?? ' ';
  if (/[A-Z]/.test(text[index - 1] ?? '') && !/\p{L}/u.test(prev2)) return false;
  // 略語。
  const before = text.slice(Math.max(0, index - 12), index).toLowerCase();
  for (const abbr of ABBREVIATIONS) {
    if (before.endsWith(abbr)) return false;
  }
  // 省略記号は 1 文の途中とみなす。
  if (text[index + 1] === '.') return false;
  if (text[index - 1] === '.') return false;
  return true;
}

interface Line {
  page: number;
  chunks: TextChunk[];
  y: number;
}

/** y 座標の近い文字片を 1 行にまとめる。閾値は文字高の 60%。 */
function groupIntoLines(chunks: TextChunk[]): Line[] {
  const byPage = new Map<number, TextChunk[]>();
  for (const chunk of chunks) {
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
        current = { page, chunks: [item], y: item.y };
        lines.push(current);
      }
    }
  }
  for (const line of lines) line.chunks.sort((a, b) => a.x - b.x);
  return lines;
}

function mergeRects(chunks: TextChunk[]): Rect[] {
  const byLine = new Map<string, TextChunk[]>();
  for (const chunk of chunks) {
    const key = `${chunk.page}:${Math.round(chunk.y)}`;
    const list = byLine.get(key);
    if (list) list.push(chunk);
    else byLine.set(key, [chunk]);
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
 * 文字片から文を組み立てる。行末ハイフネーションはここで結合する。
 * 見出しは検出しないので sections は常に空（GROBID 経路との差が UI で分かるようにする）。
 */
export function buildSentencesFromChunks(chunks: TextChunk[], _pages: PageSize[]): FallbackResult {
  const lines = groupIntoLines(chunks);

  // 行を連結しつつ、連結後の文字位置 → 文字片 の対応表を作る。
  let buffer = '';
  const owners: TextChunk[] = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    for (const chunk of line.chunks) {
      const text = chunk.text;
      for (let k = 0; k < text.length; k++) owners.push(chunk);
      buffer += text;
      if (!text.endsWith(' ')) {
        buffer += ' ';
        owners.push(chunk);
      }
    }
    // 行末ハイフンは次の行と直結する。
    if (/-\s$/.test(buffer)) {
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

    const covered = [...new Set(owners.slice(from, to))];
    const hash = sentenceHash(raw);
    const occurrence = occurrences.get(hash) ?? 0;
    occurrences.set(hash, occurrence + 1);
    sentences.push({
      id: sentenceId(hash, occurrence),
      hash,
      order: sentences.length,
      page: covered[0]?.page ?? 1,
      text: raw,
      rects: mergeRects(covered),
      sectionId: null,
    });
  }

  return { sentences, sections: [] };
}
