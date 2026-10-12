import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLines, classifyLines, detectColumns } from '../src/layout.ts';
import { buildSentencesFromChunks, type TextChunk } from '../src/sentences.ts';

/**
 * レイアウト解析の回帰テスト。
 *
 * ここが崩れると 2 段組の論文で左右の段が 1 行に混ざり、対訳が成立しなくなる。
 * 実測では、段組を見ない実装で「正解の文が取れた割合」が 30% まで落ちていた。
 */

/** x, y を指定して 1 行ぶんの文字片を作る。 */
function line(page: number, x: number, y: number, text: string, size = 10): TextChunk {
  return { page, text, x, y, w: text.length * 5, h: size };
}

/**
 * 2 段組のページを組む。左段 x=50、右段 x=320。
 * 実際の論文の段は幅いっぱいまで文字が詰まるので、テキストが短いときは
 * 右端まで埋める詰め物を足す（段の幅を現実に合わせないと段組検出が働かない）。
 */
function twoColumnPage(page: number, left: string[], right: string[]): TextChunk[] {
  const chunks: TextChunk[] = [];
  const pad = (text: string): string => text.padEnd(48, ' ').slice(0, 48);
  left.forEach((text, i) => chunks.push(line(page, 50, 100 + i * 13, pad(text))));
  right.forEach((text, i) => chunks.push(line(page, 320, 100 + i * 13, pad(text))));
  return chunks;
}

test('段間の空白帯から 2 段を検出する', () => {
  const chunks = twoColumnPage(1, ['left one', 'left two', 'left three'], ['right one', 'right two', 'right three']);
  const columns = detectColumns(chunks);
  assert.equal(columns.length, 2, `段の数が違う: ${JSON.stringify(columns)}`);
});

test('1 段組を 2 段と誤検出しない', () => {
  const chunks = [
    'first line of the body text that runs the full width of the page here',
    'second line of the body text that also runs the full width here now',
    'third line of the body text filling the measure as well in this case',
  ].map((text, i) => line(1, 50, 100 + i * 13, text));
  assert.equal(detectColumns(chunks).length, 1);
});

test('左右の段が 1 行に混ざらない', () => {
  const chunks = twoColumnPage(
    1,
    ['Sparse attention reduces cost.', 'It works well in practice.'],
    ['We evaluate on the test.', 'Results are reported here.'],
  );
  const { sentences } = buildSentencesFromChunks(chunks, [{ page: 1, width: 595, height: 842 }]);
  const texts = sentences.map((s) => s.text);
  assert.ok(
    texts.includes('Sparse attention reduces cost.'),
    `左段の文が混ざっている: ${JSON.stringify(texts)}`,
  );
  assert.ok(texts.includes('We evaluate on the test.'), `右段の文が混ざっている: ${JSON.stringify(texts)}`);
  // 読み順は「左段を全部 → 右段」。
  assert.ok(texts.indexOf('It works well in practice.') < texts.indexOf('We evaluate on the test.'));
});

test('複数ページで繰り返す柱とノンブルを本文から外す', () => {
  // 柱は「本文ブロックから一行ぶん以上離れている」ことで見分ける。
  // 本文が数行しかない合成データでは行送りの代表値が取れないので、実際の組み方に近づける。
  const chunks: TextChunk[] = [];
  const pages = [1, 2, 3];
  for (const page of pages) {
    chunks.push(line(page, 50, 30, 'Preprint. Under review.', 8));
    for (let i = 0; i < 12; i++) {
      chunks.push(line(page, 50, 100 + i * 13, `Body line ${i} on page ${page} of the document.`));
    }
    chunks.push(line(page, 290, 800, String(page), 9));
  }
  const { sentences } = buildSentencesFromChunks(
    chunks,
    pages.map((page) => ({ page, width: 595, height: 842 })),
  );
  const texts = sentences.map((s) => s.text);
  assert.ok(!texts.some((t) => t.includes('Preprint')), `柱が本文に混ざっている: ${JSON.stringify(texts.slice(0, 3))}`);
  assert.ok(!texts.some((t) => /^\d+$/.test(t)), 'ノンブルが本文に混ざっている');
  assert.equal(texts.length, 36, '本文の行がすべて文になっていない');
});

test('柱の帯に入る本文の 1 行目を落とさない', () => {
  // 位置だけで判定していた頃は、上端 8% の帯に本文 1 行目が入って消えていた。
  const chunks: TextChunk[] = [];
  const pages = [1, 2];
  for (const page of pages) {
    chunks.push(line(page, 50, 30, 'Preprint. Under review.', 8));
    // 柱のすぐ下から本文が始まる組み方。
    for (let i = 0; i < 12; i++) {
      chunks.push(line(page, 50, 50 + i * 13, `Body line ${i} on page ${page} of the document.`));
    }
  }
  const { sentences } = buildSentencesFromChunks(
    chunks,
    pages.map((page) => ({ page, width: 595, height: 842 })),
  );
  const texts = sentences.map((s) => s.text);
  // 本文の 1 行目は残る。位置の帯だけで判定していた頃はここが消えていた。
  assert.ok(texts.includes('Body line 0 on page 1 of the document.'), JSON.stringify(texts.slice(0, 3)));
  // 柱は本文から一行ぶん以上離れているので落ちる。
  assert.ok(!texts.some((t) => t.includes('Preprint')), JSON.stringify(texts.slice(0, 3)));
});

test('1 ページしかない文書では柱を落とさない（判定できないため）', () => {
  const chunks = [line(1, 50, 30, 'Preprint. Under review.', 8), line(1, 50, 100, 'Body sentence here.')];
  const { sentences } = buildSentencesFromChunks(chunks, [{ page: 1, width: 595, height: 842 }]);
  assert.equal(sentences.length, 3, JSON.stringify(sentences.map((s) => s.text)));
});

test('番号つき見出しを節として拾い、本文の文にはしない', () => {
  const chunks = [
    line(1, 50, 100, '1. Introduction', 11),
    line(1, 50, 120, 'Sparse attention reduces cost.'),
    line(1, 50, 140, '2. Method', 11),
    line(1, 50, 160, 'We use block-sparse kernels.'),
  ];
  const { sentences, sections } = buildSentencesFromChunks(chunks, [{ page: 1, width: 595, height: 842 }]);
  assert.deepEqual(
    sections.map((s) => s.title),
    ['1. Introduction', '2. Method'],
  );
  assert.deepEqual(
    sentences.map((s) => s.text),
    ['Sparse attention reduces cost.', 'We use block-sparse kernels.'],
  );
  assert.equal(sentences[0]!.sectionId, sections[0]!.id);
  assert.equal(sentences[1]!.sectionId, sections[1]!.id);
});

test('見出しが直前の文とつながらない', () => {
  const chunks = [
    line(1, 50, 100, 'A sentence without a terminator'),
    line(1, 50, 120, '2. Method', 11),
    line(1, 50, 140, 'The next body sentence.'),
  ];
  const { sentences } = buildSentencesFromChunks(chunks, [{ page: 1, width: 595, height: 842 }]);
  assert.ok(
    !sentences.some((s) => s.text.includes('Method') && s.text.includes('terminator')),
    JSON.stringify(sentences.map((s) => s.text)),
  );
});

test('図表キャプションと参考文献を本文から外す', () => {
  const chunks = [
    line(1, 50, 100, 'Body sentence one.'),
    line(1, 50, 120, 'Figure 1: Overview of the proposed pipeline.'),
    line(1, 50, 140, 'Table 2: Accuracy on the held-out split.'),
    line(1, 50, 160, 'Body sentence two.'),
    line(1, 50, 180, 'References', 11),
    line(1, 50, 200, '[1] J. Doe. Sparse transformers. NeurIPS, 2024.'),
    line(1, 50, 220, 'Roe, R. Efficient attention. JMLR, 2025.'),
  ];
  const { sentences } = buildSentencesFromChunks(chunks, [{ page: 1, width: 595, height: 842 }]);
  assert.deepEqual(
    sentences.map((s) => s.text),
    ['Body sentence one.', 'Body sentence two.'],
  );
});

test('別行立ての数式を本文から外す', () => {
  // 本文行は段の幅いっぱい、数式行は短い、という実際の組み方に合わせる。
  const chunks = [
    line(1, 50, 100, 'We define the attention operator as follows for all layers of the network.'),
    line(1, 180, 120, 'y = softmax(QK^T / sqrt(d)) V'),
    line(1, 50, 140, 'Large systems benefit most from this change across every benchmark tested.'),
  ];
  const { sentences } = buildSentencesFromChunks(chunks, [{ page: 1, width: 595, height: 842 }]);
  assert.deepEqual(
    sentences.map((s) => s.text),
    [
      'We define the attention operator as follows for all layers of the network.',
      'Large systems benefit most from this change across every benchmark tested.',
    ],
  );
});

test('演算子を含む普通の本文は数式と誤判定しない', () => {
  const chunks = [
    line(1, 50, 100, 'Accuracy improved from 80% to 92% when d = 64 was used.'),
    line(1, 50, 120, 'The next sentence follows here.'),
  ];
  const { sentences } = buildSentencesFromChunks(chunks, [{ page: 1, width: 595, height: 842 }]);
  assert.equal(sentences.length, 2, JSON.stringify(sentences.map((s) => s.text)));
});

test('段をまたぐ行末ハイフネーションを結合しない', () => {
  // 左段の最終行が "informa-" で終わり、右段の先頭が別の文で始まる。
  const chunks = twoColumnPage(1, ['We use informa-'], ['Different column starts here.']);
  const { sentences } = buildSentencesFromChunks(chunks, [{ page: 1, width: 595, height: 842 }]);
  assert.ok(
    !sentences.some((s) => s.text.includes('informaDifferent')),
    JSON.stringify(sentences.map((s) => s.text)),
  );
});

test('行の分類が buildLines の順序（ページ→段→行）を保つ', () => {
  const chunks = [...twoColumnPage(2, ['p2 left.'], ['p2 right.']), ...twoColumnPage(1, ['p1 left.'], ['p1 right.'])];
  const classified = classifyLines(buildLines(chunks), [{ page: 1, width: 595, height: 842 }, { page: 2, width: 595, height: 842 }]);
  assert.deepEqual(
    classified.map((l) => l.text.trim()),
    ['p1 left.', 'p1 right.', 'p2 left.', 'p2 right.'],
  );
});
