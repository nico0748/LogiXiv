import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLines, classifyLines, detectColumns } from '../src/layout.ts';
import { buildSentencesFromChunks, splitIntoSentences, type TextChunk } from '../src/sentences.ts';
import type { PageSize } from '../src/types.ts';

/**
 * 実在するレイアウトで壊れた事例の回帰テスト。
 * すべて、敵対的テストで**実際に再現させた**壊れ方をそのまま固定してある。
 */

const A4: PageSize = { page: 1, width: 595, height: 842 };
const pages = (count: number): PageSize[] =>
  Array.from({ length: count }, (_, i) => ({ ...A4, page: i + 1 }));

function chunk(page: number, x: number, y: number, text: string, size = 10): TextChunk {
  return { page, text, x, y, w: text.length * 5, h: size };
}

/** 2 段組のページ。左段 x=50（幅 210）、右段 x=310。段間は 260..310。 */
function twoColumnPage(page: number, lines: number, startY = 100): TextChunk[] {
  const out: TextChunk[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(chunk(page, 50, startY + i * 13, `Left body line ${i} on page ${page} runs full.`));
    out.push(chunk(page, 310, startY + i * 13, `Right body line ${i} on page ${page} runs full.`));
  }
  return out;
}

const roles = (chunks: TextChunk[], pageCount = 1): Map<string, string> =>
  new Map(classifyLines(buildLines(chunks), pages(pageCount)).map((l) => [l.text, l.role]));

// --- 段組検出 -----------------------------------------------------------

test('段間をまたぐ表が数行あっても段組検出が壊れない', () => {
  for (const spanning of [1, 3, 5]) {
    const chunks = twoColumnPage(1, 30);
    for (let i = 0; i < spanning; i++) {
      // 両段にまたがる表の行。
      chunks.push(chunk(1, 60, 500 + i * 13, 'Method  Accuracy  Latency  Memory  Throughput  Notes'));
    }
    assert.equal(
      detectColumns(chunks).length,
      2,
      `${spanning} 行またぐ表で段組検出が失敗した`,
    );
  }
});

test('1 ページ目が全幅ブロックで潰れても、他ページの段割りを借りて復旧する', () => {
  const chunks: TextChunk[] = [];
  // 1 ページ目: 全幅のタイトル・要旨が 10 行 + 2 段の本文が少し。
  for (let i = 0; i < 10; i++) {
    chunks.push(chunk(1, 50, 100 + i * 13, 'A full width abstract line that spans both columns here.'));
  }
  chunks.push(...twoColumnPage(1, 6, 260));
  // 2〜3 ページ目: 普通の 2 段組。
  chunks.push(...twoColumnPage(2, 30));
  chunks.push(...twoColumnPage(3, 30));

  const lines = buildLines(chunks);
  const bodyColumns = new Set(lines.filter((l) => l.page === 1 && l.column >= 0).map((l) => l.column));
  assert.equal(bodyColumns.size, 2, '1 ページ目が 1 段と判定され、左右の段が混ざっている');

  const mixed = lines.filter((l) => l.text.includes('Left body') && l.text.includes('Right body'));
  assert.equal(mixed.length, 0, `左右の段が 1 行に連結されている: ${mixed.length} 行`);

  // 全幅の要旨は段抜きの帯として、段より先に読まれること。
  const page1 = lines.filter((l) => l.page === 1);
  const lastAbstract = page1.findLastIndex((l) => l.text.startsWith('A full width abstract'));
  const firstBody = page1.findIndex((l) => l.text.includes('Left body'));
  assert.ok(lastAbstract >= 0 && firstBody > lastAbstract, '全幅の要旨が段の後ろに回っている');
  assert.ok(
    page1.filter((l) => l.text.startsWith('A full width abstract')).every((l) => l.column === -1),
    '全幅行が段に押し込まれている',
  );
});

test('段間に中央揃えされた全幅の 1 行が消えない', () => {
  const chunks = twoColumnPage(1, 20);
  // 中心が段間（260..310 の中央 285）に落ちる全幅行。
  chunks.push(chunk(1, 112, 400, 'The proposed system reaches 92.4 accuracy on the benchmark.'));
  const texts = buildLines(chunks).map((l) => l.text);
  assert.ok(
    texts.some((t) => t.includes('The proposed system reaches')),
    '全幅行が黙って消えた',
  );
});

// --- 付物の除去 ---------------------------------------------------------

test('版面が詰まっていても柱を落とす（行送りの 1.2 倍で判定）', () => {
  const chunks: TextChunk[] = [];
  for (const page of [1, 2, 3]) {
    // 柱は本文の 24pt 上。行送りは 13pt なので、1.8 倍（23.4pt）では境界だった。
    chunks.push(chunk(page, 50, 60, 'Proceedings of the 2026 Conference', 8));
    for (let i = 0; i < 20; i++) {
      chunks.push(chunk(page, 50, 84 + i * 13, `Body line ${i} on page ${page} of this paper.`));
    }
  }
  const { sentences } = buildSentencesFromChunks(chunks, pages(3));
  assert.ok(!sentences.some((s) => s.text.includes('Proceedings')), '柱が本文に混ざっている');
  assert.ok(sentences.some((s) => s.text.includes('Body line 0 on page 1')), '本文の 1 行目が消えた');
});

test('用紙サイズが混在しても、通常ページのフッターを落とす', () => {
  const chunks: TextChunk[] = [];
  const sizes: PageSize[] = [];
  for (const page of [1, 2, 3]) {
    sizes.push({ page, width: 595, height: 842 });
    for (let i = 0; i < 20; i++) {
      chunks.push(chunk(page, 50, 100 + i * 13, `Body line ${i} on page ${page} of this paper.`));
    }
    chunks.push(chunk(page, 50, 700, 'Proceedings of the 2026 Conference, page 1', 8));
  }
  // 4 ページ目だけ縦長（付録の大判図）。
  sizes.push({ page: 4, width: 595, height: 1400 });
  for (let i = 0; i < 20; i++) {
    chunks.push(chunk(4, 50, 100 + i * 13, `Appendix line ${i} of the long page here.`));
  }

  const { sentences } = buildSentencesFromChunks(chunks, sizes);
  assert.ok(!sentences.some((s) => s.text.includes('Proceedings')), 'フッターが本文に混ざっている');
});

test('段の下端にある小さい文字の脚注を落とす', () => {
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 20; i++) {
    chunks.push(chunk(1, 50, 100 + i * 13, `Body line ${i} of the first column here.`));
  }
  chunks.push(chunk(1, 50, 380, 'The dataset licence differs per split.', 8));
  chunks.push(chunk(1, 50, 391, 'Licence details are in the appendix.', 8));

  const { sentences } = buildSentencesFromChunks(chunks, [A4]);
  assert.ok(!sentences.some((s) => s.text.includes('licence')), '脚注が本文に混ざっている');
  assert.ok(sentences.some((s) => s.text.includes('Body line 19')), '本文の最終行が消えた');
});

// --- 数式とキャプション -------------------------------------------------

test('右端に式番号がある別行立て数式を落とす', () => {
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 12; i++) {
    chunks.push(chunk(1, 50, 100 + i * 13, `Body line ${i} that fills the measure completely.`));
  }
  // 数式 + 右端の式番号。行幅は段いっぱいになる。
  chunks.push(chunk(1, 120, 270, 'y = Wx + b'));
  chunks.push(chunk(1, 265, 270, '(3)'));
  chunks.push(chunk(1, 50, 283, 'The optimizer compresses the hidden states in run 7.'));

  const { sentences } = buildSentencesFromChunks(chunks, [A4]);
  assert.ok(
    sentences.some((s) => s.text === 'The optimizer compresses the hidden states in run 7.'),
    `数式が次の文と連結している: ${JSON.stringify(sentences.map((s) => s.text).slice(-3))}`,
  );
  assert.ok(!sentences.some((s) => s.text.includes('y = Wx')), '数式が本文に残っている');
});

test('記号の多い本文を数式と誤判定しない', () => {
  const body = [
    'we set a = 0.1, b = 0.9, and c = 0.99 for all runs',
    'The ratio a/b is fixed to 2 x 10^-4',
    'the F1 score is 82.1 +- 0.3 over 5 seeds',
  ];
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 12; i++) {
    chunks.push(chunk(1, 50, 100 + i * 13, `Body line ${i} that fills the measure completely.`));
  }
  body.forEach((text, i) => chunks.push(chunk(1, 50, 260 + i * 13, text)));

  const classified = roles(chunks);
  for (const text of body) {
    assert.equal(classified.get(text), 'body', `本文が落とされた: ${text}`);
  }
  // 本物の数式は落ちる。
  assert.equal(roles([...chunks, chunk(1, 120, 320, 'y = Wx + b')]).get('y = Wx + b'), 'furniture');
});

test('出版社ごとのキャプション書式を落とし、本文の "Figure 1 shows" は残す', () => {
  const captions = [
    'Figure 1: Overview of the proposed pipeline.',
    'Fig. 2 Overview of the routing module and its inputs.',
    'FIGURE 3 Accuracy as a function of context length.',
    'Table 1 Accuracy on the heldout split for all systems.',
    'Figure 4 | Latency measured on a single accelerator.',
    'Table 2. Ablation over the routing temperature.',
  ];
  const body = 'Figure 1 shows that the routing module is the bottleneck.';
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 12; i++) {
    chunks.push(chunk(1, 50, 100 + i * 13, `Body line ${i} that fills the measure completely.`));
  }
  captions.forEach((text, i) => chunks.push(chunk(1, 50, 260 + i * 13, text)));
  chunks.push(chunk(1, 50, 350, body));

  const classified = roles(chunks);
  for (const caption of captions) {
    assert.equal(classified.get(caption), 'furniture', `キャプションが本文に残った: ${caption}`);
  }
  assert.equal(classified.get(body), 'body', '本文の "Figure 1 shows" がキャプション扱いになった');
});

// --- 見出し -------------------------------------------------------------

test('段落の途中の番号つき箇条書きを見出しにしない', () => {
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 12; i++) {
    chunks.push(chunk(1, 50, 100 + i * 13, `Body line ${i} that fills the measure completely.`));
  }
  // 直前の行が閉じていない = 段落の途中。
  chunks.push(chunk(1, 50, 260, 'Our pipeline has three stages, namely'));
  const items = ['1. Data collection', '2. Model training', '3. Human evaluation'];
  items.forEach((text, i) => chunks.push(chunk(1, 50, 273 + i * 13, text)));

  const classified = roles(chunks);
  for (const item of items) {
    assert.equal(classified.get(item), 'body', `箇条書きが見出しに化けた: ${item}`);
  }
});

test('全幅キャプションがあっても本文行が見出しに化けない', () => {
  const chunks: TextChunk[] = [];
  // 全幅のキャプション（段幅の 2 倍）。
  chunks.push(chunk(1, 50, 90, 'Figure 1: Overview of the proposed pipeline and all of its inputs and outputs.'));
  for (let i = 0; i < 12; i++) {
    chunks.push(chunk(1, 50, 110 + i * 13, `Body line ${i} that fills the measure here.`));
  }
  chunks.push(chunk(1, 50, 280, '2. Second, we prune the attention heads by'));

  const classified = roles(chunks);
  assert.equal(
    classified.get('2. Second, we prune the attention heads by'),
    'body',
    '全幅キャプションで段幅の見積もりが壊れ、本文行が見出しになった',
  );
});

test('番号が飛んでいる行は見出しにしない', () => {
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 12; i++) {
    chunks.push(chunk(1, 50, 100 + i * 13, `Body line ${i} that fills the measure completely.`));
  }
  chunks.push(chunk(1, 50, 260, '1. Introduction', 12));
  chunks.push(chunk(1, 50, 273, 'Body text under the first section here.'));
  chunks.push(chunk(1, 50, 286, '7. Suddenly Jumping Number', 10));

  const classified = roles(chunks);
  assert.equal(classified.get('1. Introduction'), 'heading');
  assert.equal(classified.get('7. Suddenly Jumping Number'), 'body');
});

// --- サイクル5：測り方を厳しくして見えた壊れ方 --------------------------

test('普通の理系散文の "T." "R." "G." を人名イニシャルと誤認しない', () => {
  // 直前の名詞の白名簿でしか判定していなかったので、白名簿に無い語は全部繋がっていた。
  for (const [text, expected] of [
    ['We sweep the temperature T. The results are stable.', 2],
    ['We denote the rank by R. Our method uses it.', 2],
    ['Consider the graph G. Each node has a label.', 2],
    ['We fix the batch size to B. Training then proceeds.', 2],
    // 本物のイニシャルは繋がったまま。
    ['Work by J. Doe and A. Smith is relevant.', 1],
    ['Prior work by Smith et al. introduced a decomposition.', 1],
  ] as const) {
    assert.equal(splitIntoSentences(text).length, expected, text);
  }
});

test('点を含む頭字語で文を割らない', () => {
  assert.deepEqual(splitIntoSentences('The U.S. government funded it. Done.'), [
    'The U.S. government funded it.',
    'Done.',
  ]);
  assert.deepEqual(splitIntoSentences('The Ph.D. thesis of Roe covers case 9. Next.'), [
    'The Ph.D. thesis of Roe covers case 9.',
    'Next.',
  ]);
  assert.equal(splitIntoSentences('The N.A.S.A. mission failed. We retry.').length, 2);
});

test('行頭の "(1)" や "[12]" の箇条書きを参考文献として捨てない', () => {
  const chunks: TextChunk[] = [
    chunk(1, 50, 100, 'Our contributions are as follows in this paper.'),
    chunk(1, 50, 113, '(1) We introduce a new block-sparse kernel for GPUs.'),
    chunk(1, 50, 126, '(2) We prove a bound on the approximation error.'),
    chunk(1, 50, 139, '[12] Recent work extends it to long documents nicely.'),
    // 本物の参考文献は落とす（西暦や掲載誌が手掛かり）。
    chunk(1, 50, 152, '[1] J. Doe. Sparse transformers. In Proc. NeurIPS, 2024.'),
  ];
  const { sentences } = buildSentencesFromChunks(chunks, pages(1));
  const texts = sentences.map((s) => s.text);
  assert.ok(texts.some((t) => t.startsWith('(1) We introduce')), '箇条書き (1) が消えた');
  assert.ok(texts.some((t) => t.startsWith('(2) We prove')), '箇条書き (2) が消えた');
  assert.ok(texts.some((t) => t.startsWith('[12] Recent work')), '本文の [12] が消えた');
  assert.ok(!texts.some((t) => t.includes('NeurIPS')), '本物の参考文献が本文に混ざった');
});

test('折り返したキャプションの続きの行も本文にしない', () => {
  const chunks: TextChunk[] = [
    chunk(1, 50, 100, 'We evaluate the model on the benchmark suite.'),
    chunk(1, 50, 113, 'Figure 1: Overview of the proposed'),
    chunk(1, 50, 126, 'pipeline.'),
    chunk(1, 50, 139, 'The results are reported in the next section.'),
  ];
  const { sentences } = buildSentencesFromChunks(chunks, pages(1));
  const texts = sentences.map((s) => s.text);
  assert.ok(!texts.some((t) => t.includes('pipeline.')), 'キャプションの続きが本文に残った');
  assert.equal(texts.length, 2);
});

test('段幅いっぱいの数式も落とす（幅で門を作らない）', () => {
  // 段が狭いほど数式は段幅いっぱいになる。幅を条件にすると 3 段組で軒並み本文に混ざる。
  const chunks: TextChunk[] = [
    chunk(1, 50, 100, 'We define the attention operator as follows.'),
    chunk(1, 50, 113, 'y = softmax(QK^T / sqrt(d)) V + b'),
    chunk(1, 50, 126, 'The operator is applied at every layer.'),
  ];
  const { sentences } = buildSentencesFromChunks(chunks, pages(1));
  assert.ok(!sentences.some((s) => s.text.includes('softmax')), '数式が本文に混ざった');
  assert.equal(sentences.length, 2);
});

test('段を跨ぐ行は帯として、その位置で読まれる', () => {
  // 重なりが最大の段に入れると、ほぼ対称な全幅行は必ず右段が勝ち、
  // 左段を読み終えた後に現れて右段の 1 文目と癒着する。
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 6; i++) chunks.push(chunk(1, 50, 100 + i * 13, `Left top line ${i} of the page.`));
  for (let i = 0; i < 6; i++) chunks.push(chunk(1, 310, 100 + i * 13, `Right top line ${i} of the page.`));
  chunks.push(chunk(1, 50, 190, 'Figure 2: A wide figure spanning both of the columns on this page.'));
  for (let i = 0; i < 6; i++) chunks.push(chunk(1, 50, 210 + i * 13, `Left bottom line ${i} of the page.`));
  for (let i = 0; i < 6; i++) chunks.push(chunk(1, 310, 210 + i * 13, `Right bottom line ${i} of the page.`));

  const lines = buildLines(chunks);
  const order = lines.map((l) => l.text);
  const at = (needle: string): number => order.findIndex((t) => t.includes(needle));
  assert.ok(at('Left top line 0') < at('Right top line 0'), '帯の中は左段が先');
  assert.ok(at('Right top line 5') < at('Figure 2'), '段抜きの行が帯の頭より前に出ている');
  assert.ok(at('Figure 2') < at('Left bottom line 0'), '段抜きの行が次の帯より後ろに回った');
  assert.ok(at('Left bottom line 5') < at('Right bottom line 0'), '下の帯でも左段が先');
  assert.equal(lines.find((l) => l.text.includes('Figure 2'))?.column, -1);
});

test('大きな見出しが、少し上にある小さな柱を吸い込まない', () => {
  const chunks: TextChunk[] = [
    chunk(1, 50, 60, 'Preprint. Under review.', 8),
    chunk(1, 50, 66, 'Block Sparse Attention for Long Documents', 16),
  ];
  const lines = buildLines(chunks);
  assert.equal(lines.length, 2, '小さな行が大きな行に吸い込まれた');
});

test('段やページを跨いだ行末ハイフンも解決する', () => {
  // 跨いだときだけ "informa- tion" が画面に残る、という非対称が起きていた。
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 6; i++) chunks.push(chunk(1, 50, 100 + i * 13, `Left line ${i} of the page here.`));
  // 左段の最終行で語が割れ、続きは右段の先頭行にある（実際の 2 段組でよく起きる）。
  chunks.push(chunk(1, 50, 178, 'We evaluate the model on a large informa-'));
  chunks.push(chunk(1, 310, 100, 'tion retrieval task without any loss.'));
  for (let i = 0; i < 6; i++) chunks.push(chunk(1, 310, 113 + i * 13, `Right line ${i} of the page here.`));

  const { sentences } = buildSentencesFromChunks(chunks, pages(1));
  assert.ok(
    sentences.some((s) => s.text.includes('information retrieval task')),
    `段を跨いだハイフネーションが残っている: ${JSON.stringify(sentences.map((s) => s.text).slice(-3))}`,
  );
  assert.ok(!sentences.some((s) => /\p{L}-\s+\p{L}/u.test(s.text)), '画面にハイフンの残骸が出る');
});

test('見出しは前の文をそこで打ち切る', () => {
  const chunks: TextChunk[] = [
    chunk(1, 50, 100, 'The model is robust across seeds and it is stable'),
    chunk(1, 50, 113, 'in every run we tried'),
    chunk(1, 50, 140, 'Results', 13),
    chunk(1, 50, 166, 'We now describe the main experimental findings.'),
  ];
  const { sentences } = buildSentencesFromChunks(chunks, pages(1));
  assert.ok(
    !sentences.some((s) => s.text.includes('in every run we tried We now describe')),
    `見出しを跨いだ文ができている: ${JSON.stringify(sentences.map((s) => s.text))}`,
  );
});

test('書体が変わるだけの文字片の境目で語を割らない', () => {
  const chunks: TextChunk[] = [
    { page: 1, text: 'We de', x: 50, y: 100, w: 25, h: 10 },
    { page: 1, text: 'fine', x: 75, y: 100, w: 18, h: 10 },
    { page: 1, text: ' the operator below and use it everywhere.', x: 93, y: 100, w: 190, h: 10 },
  ];
  const { sentences } = buildSentencesFromChunks(chunks, pages(1));
  assert.equal(sentences[0]?.text, 'We define the operator below and use it everywhere.');
});
