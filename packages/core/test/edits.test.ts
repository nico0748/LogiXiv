import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addNote,
  applyStructure,
  createDocument,
  deriveEdit,
  documentTitle,
  editSentenceBoundary,
  mergeSentences,
  migrateDocument,
  progress,
  sentenceEditsOf,
  sentenceHash,
  setTranslation,
  skipSentences,
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

test('当てられなくなった編集は外れた印が付くだけで、元の構造に戻せば復活する', () => {
  // 捨てていた頃は、解析方式を変えた時点で区切り直しが記録ごと消え、
  // 「元の方式に戻せば戻ります」という案内が嘘になっていた。
  // 訳す前に区切りを直せと勧めている以上、手を入れた人ほど失う壊れ方だった。
  const base = structureOf(['Alpha.', 'Beta.']);
  const document = createDocument({ structure: base, sourceFileName: 'a.pdf' });
  const edited = editSentenceBoundary(document, {
    type: 'merge',
    hashes: [base.sentences[0]!.hash, base.sentences[1]!.hash],
  }).document;
  assert.equal(edited.structure.sentences.length, 1);

  const applied = applyStructure(edited, structureOf(['Gamma.', 'Delta.']));
  assert.equal(applied.editsReapplied, 0);
  assert.equal(applied.editsDropped, 1);
  assert.equal(applied.document.structure.sentences.length, 2);
  // 記録は残り、外れていることが分かる。
  const kept = sentenceEditsOf(applied.document);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.detached, true);

  // 元の構造に戻すと、同じ手順がもう一度当たる。
  const back = applyStructure(applied.document, structureOf(['Alpha.', 'Beta.']));
  assert.equal(back.editsReapplied, 1);
  assert.equal(back.editsDropped, 0);
  assert.equal(back.document.structure.sentences.length, 1);
  assert.equal(sentenceEditsOf(back.document)[0]!.detached, false);
});

test('外れている区切り直しは「直前の編集を取り消す」の対象にならない', () => {
  // 当たってもいない場所を切ってしまうため。名指しなら記録だけ捨てられる。
  const base = structureOf(['Alpha.', 'Beta.']);
  const document = createDocument({ structure: base, sourceFileName: 'a.pdf' });
  const edited = editSentenceBoundary(document, {
    type: 'merge',
    hashes: [base.sentences[0]!.hash, base.sentences[1]!.hash],
  }).document;
  const detached = applyStructure(edited, structureOf(['Gamma.', 'Delta.'])).document;

  const nothing = undoSentenceEdit(detached);
  assert.equal(nothing.applied, false);
  assert.equal(sentenceEditsOf(nothing.document).length, 1);

  const dropped = undoSentenceEdit(detached, sentenceEditsOf(detached)[0]!.id);
  assert.equal(dropped.applied, true);
  assert.equal(sentenceEditsOf(dropped.document).length, 0);
  // 構造には触れていない。
  assert.equal(dropped.document.structure.sentences.length, 2);
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

// --- サイクル4 の批評で見つかった壊れ方 --------------------------------

test('単語の途中で割っても、取り消すと元の本文に戻る', () => {
  // 戻すときに空白 1 個を決め打ちすると "me thod." になり、別の本文になってしまう。
  const base = structureOf(['We propose a fast method.', 'Next.']);
  let document = createDocument({ structure: base, sourceFileName: 'a.pdf' });
  const originalHash = base.sentences[0]!.hash;
  document = setTranslation(document, originalHash, '高速な手法を提案する。', { source: 'human' }).document;

  const split = editSentenceBoundary(document, { type: 'split', hashes: [originalHash], offsets: [20] });
  assert.equal(split.applied, true);
  assert.deepEqual(
    split.document.structure.sentences.slice(0, 2).map((s) => s.text),
    ['We propose a fast me', 'thod.'],
  );

  const back = undoSentenceEdit(split.document);
  assert.equal(back.applied, true);
  assert.equal(back.document.structure.sentences[0]!.text, 'We propose a fast method.');
  assert.equal(back.document.structure.sentences[0]!.hash, originalHash);
  assert.equal(progress(back.document).translated, 1);
});

test('サロゲートペアの内側では切らない', () => {
  const text = 'The gene \u{1D538}BC is expressed.';
  const base = structureOf([text]);
  const document = createDocument({ structure: base, sourceFileName: 'a.pdf' });
  // 'The gene ' の直後が 𝔸（2 単位）。10 はその内側を指す。
  const split = editSentenceBoundary(document, { type: 'split', hashes: [base.sentences[0]!.hash], offsets: [10] });
  assert.equal(split.applied, true);
  const joined = split.document.structure.sentences.map((s) => s.text).join('');
  assert.ok(!/[\uD800-\uDFFF]/.test(joined.replace(/\u{1D538}/gu, '')), '孤立したサロゲートが残っている');
  assert.equal(undoSentenceEdit(split.document).document.structure.sentences[0]!.text, text);
});

test('再解析で綴りが変わっても、取り消しは正しい位置で切る', () => {
  // フォールバックの "block- sparse" と GROBID の "block-sparse" は同じ hash になるが長さが違う。
  const fallback = structureOf(['We use block- sparse attention.', 'It is fast.']);
  const document = createDocument({ structure: fallback, sourceFileName: 'a.pdf' });
  const merged = editSentenceBoundary(document, {
    type: 'merge',
    hashes: [fallback.sentences[0]!.hash, fallback.sentences[1]!.hash],
  }).document;

  const grobid = structureOf(['We use block-sparse attention.', 'It is fast.']);
  assert.equal(grobid.sentences[0]!.hash, fallback.sentences[0]!.hash, '前提: 正規化すると同じ hash');

  const applied = applyStructure(merged, grobid);
  assert.equal(applied.editsReapplied, 1);

  const undone = undoSentenceEdit(applied.document);
  assert.equal(undone.applied, true);
  assert.deepEqual(
    undone.document.structure.sentences.map((s) => s.text),
    ['We use block-sparse attention.', 'It is fast.'],
  );
});

test('結合の取り消しは、元から在った同じ本文の文を巻き込まない', () => {
  const base = structureOf(['Step one.', 'Step two.', 'Unrelated.', 'Step one. Step two.']);
  let document = createDocument({ structure: base, sourceFileName: 'a.pdf' });
  const preexisting = base.sentences[3]!.hash;
  document = setTranslation(document, preexisting, '手順 1。手順 2。', { source: 'human' }).document;

  const merged = editSentenceBoundary(document, {
    type: 'merge',
    hashes: [base.sentences[0]!.hash, base.sentences[1]!.hash],
  });
  assert.equal(merged.occurrences, 1);

  const back = undoSentenceEdit(merged.document);
  assert.deepEqual(
    back.document.structure.sentences.map((s) => s.text),
    ['Step one.', 'Step two.', 'Unrelated.', 'Step one. Step two.'],
  );
  assert.equal(progress(back.document).translated, 1, '元から在った文の訳が外れている');
});

test('段組の左右にまたがる矩形は 1 本にまとめない', () => {
  const base = structureOf(['Left side.', 'Right side.']);
  base.sentences[0]!.rects = [{ page: 1, x: 60, y: 400, w: 230, h: 12 }];
  base.sentences[1]!.rects = [{ page: 1, x: 320, y: 400, w: 230, h: 12 }];
  const merged = mergeSentences(base, [base.sentences[0]!.hash, base.sentences[1]!.hash]);
  assert.equal(merged.structure.sentences[0]!.rects.length, 2, '柱間を跨いで 1 本になっている');
});

test('正規化規則が変わっても、原文から編集記録を作り直せる', () => {
  // deriveEdit が原文だけから hash と取り消し情報を導けることを直接確かめる。
  const derived = deriveEdit('merge', ['We propose a method.', 'It is fast.']);
  assert.deepEqual(derived.hashes, [sentenceHash('We propose a method.'), sentenceHash('It is fast.')]);
  assert.equal(derived.undo.hashes[0], sentenceHash('We propose a method. It is fast.'));
  assert.deepEqual(derived.undo.offsets, ['We propose a method.'.length + 1]);

  const splitDerived = deriveEdit('split', ['We propose a fast method.'], [20]);
  assert.deepEqual(splitDerived.undo.hashes, [sentenceHash('We propose a fast me'), sentenceHash('thod.')]);
  assert.deepEqual(splitDerived.undo.joiners, ['']);
});

test('正規化規則が変わっても、記録した区切りは再解析で流し直せる', () => {
  // v1 の hash を持つ古い保存データを作り、移行 → 再解析まで通す。
  const texts = ['We propose a method.', 'It is fast.'];
  const base = structureOf(texts);
  const edited = editSentenceBoundary(createDocument({ structure: base, sourceFileName: 'a.pdf' }), {
    type: 'merge',
    hashes: [base.sentences[0]!.hash, base.sentences[1]!.hash],
  }).document;

  // 構造だけ v1 に落とし、記録の hash も当時の別物にする（＝対応表では引けない状態）。
  const stale = {
    ...edited,
    structure: { ...edited.structure, version: STRUCTURE_VERSION - 1 },
    annotations: {
      ...edited.annotations,
      sentenceEdits: (edited.annotations.sentenceEdits ?? []).map((edit) => ({
        ...edit,
        hashes: edit.hashes.map(() => '0000000000000000'),
        undo: { ...edit.undo!, hashes: ['1111111111111111'] },
      })),
    },
  };

  const migrated = migrateDocument(stale);
  assert.equal(migrated.migrated, true);
  const applied = applyStructure(migrated.document, structureOf(texts));
  assert.equal(applied.editsReapplied, 1, '移行後に区切りの直しが当たらなくなっている');
  assert.equal(applied.document.structure.sentences.length, 1);
});

// --- サイクル5 の批評で見つかった壊れ方 --------------------------------

test('結合の取り消しは、手前にある同じ本文ではなく編集した箇所をほどく', () => {
  // 件数だけを上限にすると、手前の同文をほどいて編集した方はそのまま残る。
  const base = structureOf(['Step one. Step two.', 'Filler.', 'Step one.', 'Step two.']);
  let document = createDocument({ structure: base, sourceFileName: 'a.pdf' });
  document = setTranslation(document, base.sentences[0]!.hash, '手順 1。手順 2。', { source: 'human' }).document;

  const merged = editSentenceBoundary(document, {
    type: 'merge',
    hashes: [base.sentences[2]!.hash, base.sentences[3]!.hash],
  });
  assert.equal(merged.applied, true);

  const back = undoSentenceEdit(merged.document);
  assert.deepEqual(
    back.document.structure.sentences.map((s) => s.text),
    ['Step one. Step two.', 'Filler.', 'Step one.', 'Step two.'],
  );
  assert.equal(progress(back.document).translated, 1, '手前の文の訳が外れている');
});

test('分割の取り消しも、手前にある同じ並びを巻き込まない', () => {
  const base = structureOf(['alpha', 'beta', 'Filler.', 'alphabeta']);
  const document = createDocument({ structure: base, sourceFileName: 'a.pdf' });
  const split = editSentenceBoundary(document, {
    type: 'split',
    hashes: [base.sentences[3]!.hash],
    offsets: [5],
  });
  assert.equal(split.applied, true);
  const back = undoSentenceEdit(split.document);
  assert.deepEqual(
    back.document.structure.sentences.map((s) => s.text),
    ['alpha', 'beta', 'Filler.', 'alphabeta'],
  );
});

test('再解析で綴りが変わったら、分割は文字位置ではなく断片の一致で当て直す', () => {
  const fallback = structureOf(['We use block- sparse attention. It is fast.', 'Tail.']);
  let document = createDocument({ structure: fallback, sourceFileName: 'a.pdf' });
  const split = editSentenceBoundary(document, {
    type: 'split',
    hashes: [fallback.sentences[0]!.hash],
    offsets: ['We use block- sparse attention.'.length],
  });
  assert.equal(split.applied, true);
  document = split.document;
  const [left, right] = document.structure.sentences;
  document = setTranslation(document, left!.hash, '前半', { source: 'human' }).document;
  document = setTranslation(document, right!.hash, '後半', { source: 'human' }).document;
  assert.equal(progress(document).translated, 2);

  // GROBID がハイフンを解決した綴りを返す。正規化すると同じ hash だが 1 文字短い。
  const grobid = structureOf(['We use block-sparse attention. It is fast.', 'Tail.']);
  const applied = applyStructure(document, grobid);
  assert.equal(applied.editsReapplied, 1);
  assert.deepEqual(
    applied.document.structure.sentences.map((s) => s.text),
    ['We use block-sparse attention.', 'It is fast.', 'Tail.'],
  );
  assert.equal(progress(applied.document).translated, 2, '再解析で訳がはぐれている');
});

test('断片を作り直せない編集は、当てずっぽうに切らずに記録から外れる', () => {
  const base = structureOf(['One two three four.', 'Tail.']);
  const document = createDocument({ structure: base, sourceFileName: 'a.pdf' });
  const split = editSentenceBoundary(document, {
    type: 'split',
    hashes: [base.sentences[0]!.hash],
    offsets: [8],
  }).document;

  const applied = applyStructure(split, structureOf(['Totally different text here.', 'Tail.']));
  assert.equal(applied.editsReapplied, 0);
  assert.equal(applied.editsDropped, 1);
  assert.deepEqual(
    applied.document.structure.sentences.map((s) => s.text),
    ['Totally different text here.', 'Tail.'],
  );
});

test('件数の記録が無い古い編集は、1 か所だけ戻す', () => {
  const base = structureOf(['Step one.', 'Step two.', 'Filler.', 'Step one.', 'Step two.']);
  const document = createDocument({ structure: base, sourceFileName: 'a.pdf' });
  const merged = editSentenceBoundary(document, {
    type: 'merge',
    hashes: [base.sentences[0]!.hash, base.sentences[1]!.hash],
  }).document;
  assert.equal(merged.structure.sentences.length, 3);

  // occurrences も at も持たない、この修正より前に保存された記録を模す。
  const legacy = {
    ...merged,
    annotations: {
      ...merged.annotations,
      sentenceEdits: (merged.annotations.sentenceEdits ?? []).map((edit) => ({
        ...edit,
        undo: { hashes: edit.undo!.hashes, offsets: edit.undo!.offsets, joiners: edit.undo!.joiners },
      })),
    },
  };
  const back = undoSentenceEdit(legacy);
  assert.equal(back.applied, true);
  assert.equal(back.document.structure.sentences.length, 4, '戻しすぎている');
});

test('繋ぎ文字は元の空白をそのまま持つ', () => {
  const base = structureOf(['alpha\tbeta gamma.']);
  const document = createDocument({ structure: base, sourceFileName: 'a.pdf' });
  const split = editSentenceBoundary(document, {
    type: 'split',
    hashes: [base.sentences[0]!.hash],
    offsets: [6],
  });
  assert.equal(split.applied, true);
  const back = undoSentenceEdit(split.document);
  assert.equal(back.document.structure.sentences[0]!.text, 'alpha\tbeta gamma.');
});

test('段組の柱間（12pt）は結合しても 1 本の枠にならない', () => {
  for (const [height, gap] of [
    [9, 20],
    [11, 20],
    [13, 20],
    [12, 12],
  ] as const) {
    const base = structureOf(['Left side.', 'Right side.']);
    base.sentences[0]!.rects = [{ page: 1, x: 50, y: 400, w: 237, h: height }];
    base.sentences[1]!.rects = [{ page: 1, x: 287 + gap, y: 400, w: 237, h: height }];
    const merged = mergeSentences(base, [base.sentences[0]!.hash, base.sentences[1]!.hash]);
    assert.equal(merged.structure.sentences[0]!.rects.length, 2, `h=${height} gap=${gap} で柱間を跨いだ`);
  }
});

// --- サイクル6：進捗の数え方 --------------------------------------------

test('訳の付いた文は「訳さない」に記録しない', () => {
  // 記録しても未訳は 1 件も減らないので、「n 件を対象外にした」という返事だけが嘘になる。
  const base = structureOf(['Alpha.', 'Beta.']);
  let document = createDocument({ structure: base, sourceFileName: 'a.pdf' });
  document = setTranslation(document, base.sentences[0]!.hash, 'アルファ。').document;

  const result = skipSentences(document, [base.sentences[0]!.hash, base.sentences[1]!.hash], 'other');
  assert.equal(result.applied, 1);
  assert.deepEqual(result.alreadyTranslated, [base.sentences[0]!.hash]);

  const stats = progress(result.document);
  assert.equal(stats.translated + stats.skipped + stats.remaining, stats.uniqueSentences);
});

test('訳と「訳さない」が両方付いた古いデータでも、合計が文数を超えない', () => {
  const base = structureOf(['Alpha.', 'Beta.', 'Gamma.']);
  const document = createDocument({ structure: base, sourceFileName: 'a.pdf' });
  const hash = base.sentences[0]!.hash;
  const legacy = {
    ...document,
    annotations: {
      ...document.annotations,
      translations: {
        [hash]: { sentenceHash: hash, text: 'アルファ。', revisedByHuman: false, source: 'claude' as const, updatedAt: new Date().toISOString() },
      },
      skipped: { [hash]: { sentenceHash: hash, reason: 'other', at: new Date().toISOString() } },
    },
  };
  const stats = progress(legacy);
  assert.equal(stats.translated + stats.skipped + stats.remaining, stats.uniqueSentences);
});

test('題名はファイル名ではなく本文から取る', () => {
  const withTitle = structureOf(['Body sentence here.']);
  withTitle.title = 'A Real Paper Title';
  assert.equal(documentTitle(withTitle, '2401.01234v2.pdf'), 'A Real Paper Title');

  // 簡易解析では title が取れないことがある。1 文目が表題らしければそれを使う。
  const fallback = structureOf(['Block Sparse Attention for Long Documents', 'Body sentence here.']);
  fallback.title = null;
  assert.equal(documentTitle(fallback, '2401.01234v2.pdf'), 'Block Sparse Attention for Long Documents');

  // 本文にしか見えないものは題名にしない（句点で終わる・短すぎる）。
  const body = structureOf(['We present a method.']);
  body.title = null;
  assert.equal(documentTitle(body, '2401.01234v2.pdf'), '2401.01234v2');
});

// --- 割り込んだ断片の取り除き（drop） -------------------------------------

/**
 * はじめて使った研究者が詰まった形。本文 1 文の**真ん中**に、図の枠内文字と表の行が
 * 割り込んでいる。merge と split には「中身を取り除く」操作が無いので、
 * 「3 つに split → 真ん中を skip → 前後を merge」を試して
 * `指定された文が連続して見つかりません` で行き止まりになった（skip しても
 * 文の列からは消えないため）。英語 1 文が日本語では半端な 2 文のまま確定した。
 */
const INTRUDED_HEAD = 'The expert count is E = 64 and';
const INTRUDED_JUNK =
  '(schematic of the two-branch layer) Model Active In-domain Shifted Dense 1.3B 100% 61.2 54.8 GRR (ours) 18% 59.7 51.6';
const INTRUDED_TAIL = 'k = 2 unless stated otherwise, and the residual fraction is rho = 0.25.';
const INTRUDED = `${INTRUDED_HEAD} ${INTRUDED_JUNK} ${INTRUDED_TAIL}`;

/** 割り込みを 3 つに割ったところまで進めた文書を作る。 */
function intrudedDocument() {
  const document = createDocument({
    fileName: 'x.pdf',
    structure: { ...structureOf(['Before.', INTRUDED, 'After.']), nonBody: [] },
  });
  const split = editSentenceBoundary(document, {
    type: 'split',
    hashes: [sentenceHash(INTRUDED)],
    offsets: [INTRUDED.indexOf(INTRUDED_JUNK), INTRUDED.indexOf(INTRUDED_TAIL)],
  });
  assert.equal(split.applied, true, split.reason);
  return split.document;
}

test('割り込んだ断片を取り除くと、前後が隣り合って 1 文に戻せる', () => {
  let document = intrudedDocument();
  assert.equal(document.structure.sentences.length, 5);

  // 取り除く。ここが無かったせいで、この先の merge が
  // 「指定された文が連続して見つかりません」で拒否されていた。
  const dropped = editSentenceBoundary(document, {
    type: 'drop',
    hashes: [document.structure.sentences[2]!.hash],
  });
  assert.equal(dropped.applied, true, dropped.reason);
  document = dropped.document;
  assert.equal(document.structure.sentences.length, 4);

  // 前後が隣り合ったので、既存の merge がそのまま通る。
  const merged = editSentenceBoundary(document, {
    type: 'merge',
    hashes: [document.structure.sentences[1]!.hash, document.structure.sentences[2]!.hash],
  });
  assert.equal(merged.applied, true, merged.reason);
  document = merged.document;

  assert.equal(document.structure.sentences.length, 3);
  assert.equal(document.structure.sentences[1]!.text, `${INTRUDED_HEAD} ${INTRUDED_TAIL}`);
  assert.deepEqual(sentenceEditsOf(document).map((edit) => edit.type), ['split', 'drop', 'merge']);
});

test('取り除いた断片は消えず、訳さないものとして本文の間に残る', () => {
  // この道具の一貫した方針は「PDF には見えているのに右に無い」を作らないこと。
  let document = intrudedDocument();
  const junkHash = document.structure.sentences[2]!.hash;
  document = editSentenceBoundary(document, { type: 'drop', hashes: [junkHash] }).document;

  const nonBody = document.structure.nonBody ?? [];
  assert.equal(nonBody.length, 1, '取り除いた断片が残っていない');
  assert.equal(nonBody[0]!.text, INTRUDED_JUNK);
  assert.equal(nonBody[0]!.hash, junkHash);
  // 画面が本文の間の正しい位置に差し込めること。afterHash は直前に残った本文の文。
  assert.equal(nonBody[0]!.afterHash, document.structure.sentences[1]!.hash);
  assert.equal(nonBody[0]!.afterOrder, 1);
  // 訳す対象からは外れる（進捗の分母が狂わない）。
  assert.ok(!document.structure.sentences.some((s) => s.hash === junkHash));
});

test('取り除きを取り消すと、本文の元の位置へ戻る', () => {
  let document = intrudedDocument();
  const before = document.structure.sentences.map((s) => s.text);
  const junkHash = document.structure.sentences[2]!.hash;
  document = editSentenceBoundary(document, { type: 'drop', hashes: [junkHash] }).document;

  const undone = undoSentenceEdit(document);
  assert.equal(undone.applied, true, undone.reason);
  document = undone.document;

  assert.deepEqual(document.structure.sentences.map((s) => s.text), before, '元の並びに戻っていない');
  assert.equal((document.structure.nonBody ?? []).length, 0, '訳さないものの側に残骸がある');
  assert.equal(sentenceEditsOf(document).length, 1, '記録が残ったまま');
});

test('split → drop → merge の 3 手順は、取り消すと 1 文ずつ元に戻る', () => {
  let document = intrudedDocument();
  document = editSentenceBoundary(document, { type: 'drop', hashes: [document.structure.sentences[2]!.hash] }).document;
  document = editSentenceBoundary(document, {
    type: 'merge',
    hashes: [document.structure.sentences[1]!.hash, document.structure.sentences[2]!.hash],
  }).document;

  for (let i = 0; i < 3; i++) {
    const undone = undoSentenceEdit(document);
    assert.equal(undone.applied, true, `${i + 1} 回目の取り消しが効かない: ${undone.reason}`);
    document = undone.document;
  }
  assert.deepEqual(
    document.structure.sentences.map((s) => s.text),
    ['Before.', INTRUDED, 'After.'],
    '取り消し切っても元の文に戻らない',
  );
  assert.equal((document.structure.nonBody ?? []).length, 0);
});

test('取り除きは再解析をまたいで保たれる', () => {
  let document = intrudedDocument();
  document = editSentenceBoundary(document, { type: 'drop', hashes: [document.structure.sentences[2]!.hash] }).document;
  document = editSentenceBoundary(document, {
    type: 'merge',
    hashes: [document.structure.sentences[1]!.hash, document.structure.sentences[2]!.hash],
  }).document;
  document = setTranslation(document, document.structure.sentences[1]!.hash, {
    text: '専門家の数は E = 64 であり…',
    engine: 'test',
    model: 'test',
  }).document;

  // 解析し直しても、同じ形の構造が返ってくる（人の直しは記録から流し直される）。
  const again = applyStructure(document, { ...structureOf(['Before.', INTRUDED, 'After.']), nonBody: [] });
  assert.equal(again.editsReapplied, 3);
  assert.equal(again.editsDropped, 0);
  assert.equal(again.document.structure.sentences[1]!.text, `${INTRUDED_HEAD} ${INTRUDED_TAIL}`);
  assert.equal((again.document.structure.nonBody ?? [])[0]!.text, INTRUDED_JUNK, '断片が再解析で消えた');
  assert.equal(again.rebound, 1, '結合した文の訳が外れた');
});

test('取り除きは同じ本文のすべての箇所に効く', () => {
  // merge / split と揃える（訳は本文のハッシュに付くので、片方だけ違うと説明がつかない）。
  const document = createDocument({
    fileName: 'x.pdf',
    structure: { ...structureOf(['Body one.', 'Model Active In-domain.', 'Body two.', 'Model Active In-domain.']), nonBody: [] },
  });
  const result = editSentenceBoundary(document, {
    type: 'drop',
    hashes: [sentenceHash('Model Active In-domain.')],
  });
  assert.equal(result.applied, true, result.reason);
  assert.equal(result.occurrences, 2);
  assert.deepEqual(result.document.structure.sentences.map((s) => s.text), ['Body one.', 'Body two.']);
  assert.equal((result.document.structure.nonBody ?? []).length, 2);

  const undone = undoSentenceEdit(result.document);
  assert.equal(undone.applied, true, undone.reason);
  assert.deepEqual(undone.document.structure.sentences.map((s) => s.text), [
    'Body one.',
    'Model Active In-domain.',
    'Body two.',
    'Model Active In-domain.',
  ]);
});

test('本文が 1 文も残らない取り除きは断る', () => {
  const document = createDocument({ fileName: 'x.pdf', structure: { ...structureOf(['Only one.']), nonBody: [] } });
  const result = editSentenceBoundary(document, { type: 'drop', hashes: [sentenceHash('Only one.')] });
  assert.equal(result.applied, false);
  assert.match(result.reason ?? '', /すべて無くなる/);
});
