import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addNote,
  applyStructure,
  createDocument,
  editSentenceBoundary,
  mergeSentences,
  progress,
  sentenceEditsOf,
  sentenceHash,
  setTranslation,
  splitSentence,
  undoSentenceEdit,
  type DocumentStructure,
  type Sentence,
} from '../src/index.ts';
import { STRUCTURE_VERSION } from '../src/hash.ts';

function sentence(text: string, order: number, page = 1): Sentence {
  const hash = sentenceHash(text);
  return {
    id: `s_${hash}_0`,
    hash,
    order,
    page,
    text,
    rects: [{ page, x: 10, y: 100 + order * 12, w: text.length * 3, h: 10 }],
    sectionId: 'sec1',
  };
}

function structureOf(texts: string[]): DocumentStructure {
  return {
    version: STRUCTURE_VERSION,
    parser: 'grobid',
    parserNote: 'test',
    parsedAt: new Date(0).toISOString(),
    title: 'T',
    abstract: null,
    pageSizes: [{ page: 1, width: 600, height: 800 }],
    sections: [{ id: 'sec1', title: '1. Introduction', level: 1, order: 0 }],
    sentences: texts.map((text, index) => sentence(text, index)),
  };
}

test('結合すると 1 文になり、通し番号が詰め直される', () => {
  const structure = structureOf(['We propose a method.', 'It is fast.', 'Results follow.']);
  const result = mergeSentences(structure, [structure.sentences[0]!.hash, structure.sentences[1]!.hash]);
  assert.equal(result.structure.sentences.length, 2);
  assert.equal(result.structure.sentences[0]!.text, 'We propose a method. It is fast.');
  assert.deepEqual(
    result.structure.sentences.map((s) => s.order),
    [0, 1],
  );
  assert.equal(result.occurrences, 1);
});

test('同じ本文が複数回出るときは、すべての箇所で同じ区切りになる', () => {
  // 片方だけ結合すると、hash に付く訳が一方にしか出ない状態が生まれる。
  const structure = structureOf(['A B.', 'C D.', 'Filler.', 'A B.', 'C D.']);
  const result = mergeSentences(structure, [sentenceHash('A B.'), sentenceHash('C D.')]);
  assert.equal(result.occurrences, 2);
  assert.deepEqual(
    result.structure.sentences.map((s) => s.text),
    ['A B. C D.', 'Filler.', 'A B. C D.'],
  );
  // 同じ本文なので hash も一致し、訳は 1 回書けば両方に出る。
  assert.equal(result.structure.sentences[0]!.hash, result.structure.sentences[2]!.hash);
  assert.notEqual(result.structure.sentences[0]!.id, result.structure.sentences[2]!.id);
});

test('重なり合う並びは前から順に取り、同じ文を二重に使わない', () => {
  const structure = structureOf(['X.', 'X.', 'X.', 'X.']);
  const hash = sentenceHash('X.');
  const result = mergeSentences(structure, [hash, hash]);
  assert.equal(result.occurrences, 2);
  assert.deepEqual(
    result.structure.sentences.map((s) => s.text),
    ['X. X.', 'X. X.'],
  );
});

test('分割は文字位置で切り、矩形を按分する', () => {
  const structure = structureOf(['First part here. Second part here.']);
  const result = splitSentence(structure, structure.sentences[0]!.hash, [17]);
  assert.deepEqual(
    result.structure.sentences.map((s) => s.text),
    ['First part here.', 'Second part here.'],
  );
  const [left, right] = result.structure.sentences;
  assert.ok(left!.rects.length === 1 && right!.rects.length === 1);
  assert.ok(right!.rects[0]!.x > left!.rects[0]!.x, '後ろの断片は右側に来るはず');
  assert.ok(left!.rects[0]!.w + right!.rects[0]!.w <= structure.sentences[0]!.rects[0]!.w + 0.001);
});

test('文の内側にない分割位置は断る', () => {
  const structure = structureOf(['Only one.']);
  assert.throws(() => splitSentence(structure, structure.sentences[0]!.hash, [0]), /内側/);
  assert.throws(() => splitSentence(structure, structure.sentences[0]!.hash, [999]), /内側/);
});

test('結合は分割で、分割は結合で、元どおりに戻せる', () => {
  const base = structureOf(['We propose a method.', 'It is fast.', 'Results follow.']);
  const document = createDocument({ structure: base, sourceFileName: 'a.pdf' });

  const merged = editSentenceBoundary(document, {
    type: 'merge',
    hashes: [base.sentences[0]!.hash, base.sentences[1]!.hash],
  });
  assert.equal(merged.applied, true);
  assert.equal(merged.document.structure.sentences.length, 2);
  assert.equal(sentenceEditsOf(merged.document).length, 1);

  const undone = undoSentenceEdit(merged.document);
  assert.equal(undone.applied, true);
  assert.deepEqual(
    undone.document.structure.sentences.map((s) => s.text),
    base.sentences.map((s) => s.text),
  );
  assert.equal(sentenceEditsOf(undone.document).length, 0);

  const split = editSentenceBoundary(document, {
    type: 'split',
    hashes: [base.sentences[0]!.hash],
    offsets: [3],
  });
  assert.equal(split.applied, true);
  assert.equal(split.document.structure.sentences.length, 4);
  const back = undoSentenceEdit(split.document);
  assert.equal(back.applied, true);
  assert.deepEqual(
    back.document.structure.sentences.map((s) => s.text),
    base.sentences.map((s) => s.text),
  );
});

test('当てられない編集は理由付きで断り、文書を変えない', () => {
  const document = createDocument({ structure: structureOf(['A.', 'B.']), sourceFileName: 'a.pdf' });
  const result = editSentenceBoundary(document, { type: 'merge', hashes: [sentenceHash('B.'), sentenceHash('A.')] });
  assert.equal(result.applied, false);
  assert.match(result.reason ?? '', /連続して見つかりません/);
  assert.equal(result.document, document);
});

test('再解析しても区切りの直しは流し直される', () => {
  const base = structureOf(['We propose a method.', 'It is fast.', 'Results follow.']);
  const document = createDocument({ structure: base, sourceFileName: 'a.pdf' });
  const edited = editSentenceBoundary(document, {
    type: 'merge',
    hashes: [base.sentences[0]!.hash, base.sentences[1]!.hash],
  }).document;

  const mergedHash = edited.structure.sentences[0]!.hash;
  const withTranslation = setTranslation(edited, mergedHash, '手法を提案する。これは速い。', { source: 'human' }).document;

  // GROBID が同じ結果を返した想定で、素の構造を当て直す。
  const applied = applyStructure(withTranslation, structureOf(base.sentences.map((s) => s.text)));
  assert.equal(applied.editsReapplied, 1);
  assert.equal(applied.editsDropped, 0);
  assert.equal(applied.document.structure.sentences.length, 2);
  assert.equal(applied.document.structure.sentences[0]!.hash, mergedHash);
  assert.equal(applied.rebound, 1);
  assert.equal(applied.orphaned, 0);
  assert.equal(
    applied.document.annotations.translations[mergedHash]?.text,
    '手法を提案する。これは速い。',
  );
});

test('本文が変わって当てられなくなった編集は記録から外れる', () => {
  const base = structureOf(['Alpha.', 'Beta.']);
  const document = createDocument({ structure: base, sourceFileName: 'a.pdf' });
  const edited = editSentenceBoundary(document, {
    type: 'merge',
    hashes: [base.sentences[0]!.hash, base.sentences[1]!.hash],
  }).document;

  const applied = applyStructure(edited, structureOf(['Gamma.', 'Delta.']));
  assert.equal(applied.editsReapplied, 0);
  assert.equal(applied.editsDropped, 1);
  assert.equal(sentenceEditsOf(applied.document).length, 0);
  assert.equal(applied.document.structure.sentences.length, 2);
});

test('結合しても訳とメモは新しい hash に付け直せる', () => {
  const base = structureOf(['A sentence.', 'Another one.']);
  let document = createDocument({ structure: base, sourceFileName: 'a.pdf' });
  document = setTranslation(document, base.sentences[0]!.hash, '一文目。').document;
  document = addNote(document, base.sentences[0]!.hash, 'ここは訳語に注意', null).document;

  const merged = editSentenceBoundary(document, {
    type: 'merge',
    hashes: [base.sentences[0]!.hash, base.sentences[1]!.hash],
  }).document;

  // 結合後の文はまだ未訳。古い訳は消さずに残す（取り消せば戻るため）。
  const stats = progress(merged);
  assert.equal(stats.uniqueSentences, 1);
  assert.equal(stats.translated, 0);
  assert.equal(merged.annotations.translations[base.sentences[0]!.hash]?.text, '一文目。');

  const restored = undoSentenceEdit(merged).document;
  assert.equal(progress(restored).translated, 1);
  assert.equal(restored.annotations.notes.length, 1);
});
