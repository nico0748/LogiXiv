import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSentencesFromChunks, type TextChunk } from '../src/sentences.ts';
import { chunkCharEdges } from '../src/advance.ts';
import { splitSentence } from '../src/edits.ts';
import type { DocumentStructure, PageSize, Rect } from '../src/types.ts';
import { sentenceHash, sentenceId } from '../src/hash.ts';

/**
 * 文の枠の**端**の回帰テスト。
 *
 * pdf.js は 1 行まるごとを 1 個の文字片で返すので、文が行の途中で始まる・終わるとき、
 * 枠は文字片を文の境目で割って作る。以前は文字数の比で割っていたので、
 *   - 語間の伸びた両端揃えの行で、境目が 1〜3 文字ぶん右にずれる（文頭が枠から外れ、
 *     前の文の枠が次の文の頭まで食い込む。実測: pdflatex の 1 段組で 15pt）。
 *   - 和文に欧文の術語が混ざる行で、欧字を全角 1 文字と数えて 2〜4 文字ずれる（実測 44pt）。
 *
 * 文字片の「正解の幅」は、解析器の見積もり（Computer Modern の幅表）とは**別の書体**
 * （Times の幅）で作る。同じ表で作ると、見積もりが当たるのは当然で何も測れない。
 */

const A4: PageSize = { page: 1, width: 595, height: 842 };

/** Times-Roman の送り幅（em）。正解の組版に使う。 */
const TIMES: Record<string, number> = {
  a: 0.444, b: 0.5, c: 0.444, d: 0.5, e: 0.444, f: 0.333, g: 0.5, h: 0.5, i: 0.278, j: 0.278, k: 0.5,
  l: 0.278, m: 0.778, n: 0.5, o: 0.5, p: 0.5, q: 0.5, r: 0.333, s: 0.389, t: 0.278, u: 0.5, v: 0.5,
  w: 0.722, x: 0.5, y: 0.5, z: 0.444, '.': 0.25, ',': 0.25, '[': 0.333, ']': 0.333, '1': 0.5,
};
const timesWidth = (ch: string): number => {
  if (/[　-鿿＀-｠]/u.test(ch)) return 1;
  return TIMES[ch] ?? (/\p{Lu}/u.test(ch) ? 0.667 : 0.5);
};

/**
 * 1 行を組む。`stretch` は両端揃えで語間に足す幅（em）。
 * 返すのは文字片と、各文字の正解の左端 x。
 */
function typeset(text: string, y: number, size: number, stretch = 0): { chunk: TextChunk; xs: number[] } {
  const xs: number[] = [];
  let x = 68;
  for (const ch of text) {
    xs.push(x);
    x += (ch === ' ' ? 0.25 + stretch : timesWidth(ch)) * size;
  }
  xs.push(x);
  return { chunk: { page: 1, text, x: 68, y, w: x - 68, h: size }, xs };
}

function rectOnLine(rects: readonly Rect[], y: number): Rect {
  const rect = rects.find((r) => Math.abs(r.y - y) < 1);
  assert.ok(rect, `y=${y} の行に枠が無い`);
  return rect;
}

test('欧文の両端揃え: 行の途中で終わる文と始まる文の枠の端が、1 文字幅以内で文字に合う', () => {
  const size = 10;
  const line1 = typeset('Most of the engineering effort went into the fused kernel and the scheduler,', 100, size);
  const mid = 'rather than into the rule itself. We expect better summaries to matter more';
  // 語間を 0.25em 伸ばす（両端揃えの典型的な伸び）。
  const line2 = typeset(mid, 112, size, 0.25);
  const line3 = typeset('than a better selection rule.', 124, size);
  const { sentences } = buildSentencesFromChunks([line1.chunk, line2.chunk, line3.chunk], [A4]);
  assert.equal(sentences.length, 2);

  const end = mid.indexOf('.') + 1; // 文末記号の直後
  const start = mid.indexOf('We');
  const trueEnd = line2.xs[end]!;
  const trueStart = line2.xs[start]!;
  const first = rectOnLine(sentences[0]!.rects, 112);
  const second = rectOnLine(sentences[1]!.rects, 112);
  const tol = 0.5 * size; // 1 文字幅
  assert.ok(Math.abs(first.x + first.w - trueEnd) < tol, `文末がずれている: 枠 ${first.x + first.w} / 文字 ${trueEnd}`);
  assert.ok(Math.abs(second.x - trueStart) < tol, `文頭がずれている: 枠 ${second.x} / 文字 ${trueStart}`);
  assert.ok(first.x + first.w <= second.x, '隣の文の枠どうしが重なっている');

  // このテストが本当に効いているか: 文字数の比で割った位置は 1 文字幅を超えてずれる。
  const naive = line2.chunk.x + (line2.chunk.w * start) / mid.length;
  assert.ok(Math.abs(naive - trueStart) > tol, `文字数の比でも当たってしまう（${naive} / ${trueStart}）`);
});

test('和文に欧文の術語が混ざる行: 句点の位置で枠が割れる', () => {
  const size = 10;
  const line1 = typeset('学術論文の多くは英語で書かれているが、国内の学会誌には日本語のものも多い。', 100, size);
  const mid = 'そうした論文では、術語だけが英語のまま残される。たとえば attention や transformer';
  const line2 = typeset(mid, 114, size);
  const line3 = typeset('といった語は、訳さずにそのまま使われる。', 128, size);
  const { sentences } = buildSentencesFromChunks([line1.chunk, line2.chunk, line3.chunk], [A4]);
  assert.equal(sentences.length, 3);

  const stop = mid.indexOf('。') + 1;
  const first = rectOnLine(sentences[1]!.rects, 114);
  const second = rectOnLine(sentences[2]!.rects, 114);
  const tol = 0.5 * size; // 半角 1 文字（全角の半分）
  assert.ok(Math.abs(first.x + first.w - line2.xs[stop]!) < tol, `句点の後ろがずれている: ${first.x + first.w} / ${line2.xs[stop]}`);
  assert.ok(Math.abs(second.x - line2.xs[stop]!) < tol, `次の文の頭がずれている: ${second.x} / ${line2.xs[stop]}`);

  const naive = line2.chunk.x + (line2.chunk.w * stop) / mid.length;
  assert.ok(Math.abs(naive - line2.xs[stop]!) > tol, '文字数の比でも当たってしまう');
});

test('等幅の文字片は、空白も含めて 1 文字ずつ同じ幅で割る', () => {
  const text = 'x = f(i); y = g(mm).';
  const chunk: TextChunk = { page: 1, text, x: 10, y: 0, w: text.length * 6, h: 10, mono: true };
  const edges = chunkCharEdges(chunk);
  for (let i = 0; i <= text.length; i++) assert.ok(Math.abs(edges[i]! - (10 + i * 6)) < 1e-9);
});

test('字形の幅の見積もりは文字片の幅ちょうどに収まり、単調に増える', () => {
  for (const text of ['A learned summary [1].', 'たとえば attention や', 'ﬁnd x', '\u{20B9F}字', '']) {
    const chunk: TextChunk = { page: 1, text, x: 5, y: 0, w: 123.4, h: 10 };
    const edges = chunkCharEdges(chunk);
    assert.equal(edges.length, text.length + 1);
    assert.equal(edges[0], 5);
    if (text.length > 0) assert.ok(Math.abs(edges[text.length]! - 128.4) < 1e-9);
    for (let i = 1; i < edges.length; i++) assert.ok(edges[i]! >= edges[i - 1]!);
  }
});

test('文の手動分割も、字形の幅の比で枠を割る（和文と欧文が混ざる文）', () => {
  const size = 10;
  const text = 'これは attention を使う。次の文である。';
  const line = typeset(text, 100, size);
  const hash = sentenceHash(text);
  const structure: DocumentStructure = {
    version: 1,
    parser: 'fallback',
    parserNote: '',
    parsedAt: '2026-01-01T00:00:00.000Z',
    title: null,
    abstract: null,
    pageSizes: [A4],
    sections: [],
    sentences: [
      {
        id: sentenceId(hash, 0),
        hash,
        order: 0,
        page: 1,
        text,
        rects: [{ page: 1, x: line.chunk.x, y: 100, w: line.chunk.w, h: size }],
        sectionId: null,
      },
    ],
  } as DocumentStructure;
  const cut = text.indexOf('。') + 1;
  const outcome = splitSentence(structure, hash, [cut]);
  const [left, right] = outcome.structure.sentences;
  assert.ok(left && right);
  const tol = 0.5 * size;
  assert.ok(Math.abs(left.rects[0]!.x + left.rects[0]!.w - line.xs[cut]!) < tol, `前半の右端: ${left.rects[0]!.x + left.rects[0]!.w} / ${line.xs[cut]}`);
  assert.ok(Math.abs(right.rects[0]!.x - line.xs[cut]!) < tol, `後半の左端: ${right.rects[0]!.x} / ${line.xs[cut]}`);
});
