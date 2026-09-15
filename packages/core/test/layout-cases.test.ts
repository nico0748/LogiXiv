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

test('キャプションの 1 行目が文末で終わっても、2 文目が本文に混ざらない', () => {
  // 実測で壊れていた形。`Figure 1: ... learned on PubMed.` で塊が閉じ、
  // 続きの `Darker cells are retained.` だけが `2.1 Complexity` と `3 Experiments` の
  // 間に本文の文として挿し込まれていた。キャプションが 2 文以上あるのは普通のこと。
  const chunks: TextChunk[] = [
    chunk(1, 50, 100, 'We evaluate the model on the benchmark suite for every seed.'),
    // 段の右端まで届く 1 行目。組版の都合で折り返しただけなので、文末で終わっていても続く。
    chunk(1, 50, 113, 'Figure 1: Block-sparse attention learned on the PubMed split.'),
    // 右端に届かない＝キャプションの最終行。ここで塊が閉じる。
    chunk(1, 50, 126, 'Darker cells are retained across every head of the layer.'),
    chunk(1, 50, 139, 'The results are reported in the next section of the paper.'),
  ];
  const { sentences } = buildSentencesFromChunks(chunks, pages(1));
  const texts = sentences.map((s) => s.text);
  assert.ok(
    !texts.some((t) => t.includes('Darker cells')),
    `キャプションの 2 文目が本文に混ざった: ${JSON.stringify(texts)}`,
  );
  assert.deepEqual(texts, [
    'We evaluate the model on the benchmark suite for every seed.',
    'The results are reported in the next section of the paper.',
  ]);
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

// --- 柱間が既定値（10pt）の 2 段組 ---------------------------------------

/**
 * `\documentclass[twocolumn]{article}` の既定は `\columnsep` = 10pt。
 * 空白帯の下限を絶対値 12pt で持っていた頃は、この既定値がそのまま閾値を下回り、
 * 段組の検出が丸ごと失敗して左右の段が 1 行に連結されていた。
 * 実測（pdflatex の同一原稿）: 柱間 10pt で 56 文中 26 文が破壊、14pt なら 0 件。
 */
test('柱間が 10pt しかない 2 段組でも段を見つける', () => {
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 30; i++) {
    // 左段は x=50..300（両端揃えなので右端まで届く）、右段は x=310 から。段間はちょうど 10pt。
    chunks.push(chunk(1, 50, 100 + i * 13, `Left body line ${i} of the page fills the measure.`.padEnd(50, ' ')));
    chunks.push(chunk(1, 310, 100 + i * 13, `Right body line ${i} of the page fills the measure.`.padEnd(50, ' ')));
  }
  assert.equal(detectColumns(chunks).length, 2, '柱間 10pt の段組を見落とした');

  const { sentences } = buildSentencesFromChunks(chunks, pages(1));
  const merged = sentences.filter((s) => /Left body line \d+ .*Right body line/.test(s.text));
  assert.equal(merged.length, 0, `左右の段が 1 行に連結された: ${JSON.stringify(merged.slice(0, 2).map((s) => s.text))}`);
});

test('語間の空白が縦に揃っただけの 1 段組を 2 段と誤検出しない', () => {
  // 空白帯の下限を絶対値で下げると、ここが段の切れ目に化けて 1 段組の論文が壊れる。
  // 両端揃えで伸びた語間は字送り（ここでは 5pt）を超えない、という関係で弾く。
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 30; i++) {
    const y = 100 + i * 13;
    chunks.push(chunk(1, 50, y, `Left half of body line ${i} here.`.padEnd(30, ' ')));
    // 直前の行は x=200 で終わる。6pt 空けて続きを置く（伸びた語間ぶんの隙間）。
    chunks.push(chunk(1, 206, y, `and the right half of line ${i} runs on.`.padEnd(38, ' ')));
  }
  assert.equal(detectColumns(chunks).length, 1, '語間の空白を段の切れ目と誤検出した');
});

// --- 本文の途中に挟まる表と別行立て数式 ----------------------------------

/** 段の左端から x=50、幅 245（右端 295）の本文行。段の代表値を決めるために要る。 */
const measureLine = (i: number, y: number): TextChunk =>
  chunk(1, 50, y, `${`Body line ${i} of this paper fills the whole measure`.padEnd(48, ' ').slice(0, 48)}.`);

test('文の途中に挟まった表のセルを本文に混ぜない', () => {
  // 実物の論文で出た壊れ方:
  //   "Information retrieval benefits from ★Model Acc F1 Dense 81.2 79.4★ the same sparsity …"
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 12; i++) chunks.push(measureLine(i, 100 + i * 13));
  chunks.push(chunk(1, 50, 256, 'Information retrieval benefits from'));
  // 中央寄せの表。段の左端から 70pt 入り、右端にも届かない。
  chunks.push(chunk(1, 120, 269, 'Model     Acc     F1'));
  chunks.push(chunk(1, 120, 282, 'Dense     81.2    79.4'));
  chunks.push(chunk(1, 120, 295, 'Ours      88.7    86.1'));
  chunks.push(chunk(1, 50, 308, 'the same sparsity pattern at every depth.'));
  for (let i = 0; i < 12; i++) chunks.push(measureLine(i + 20, 321 + i * 13));

  const { sentences } = buildSentencesFromChunks(chunks, pages(1));
  const texts = sentences.map((s) => s.text);
  assert.ok(
    texts.includes('Information retrieval benefits from the same sparsity pattern at every depth.'),
    `表のセルが文の途中に差し込まれた: ${JSON.stringify(texts.filter((t) => t.includes('Information retrieval')))}`,
  );
  assert.ok(!texts.some((t) => t.includes('81.2')), `表のセルが本文に残った: ${JSON.stringify(texts.filter((t) => t.includes('81.2')))}`);
});

test('中央寄せの数式と右端の式番号を本文に混ぜない', () => {
  // `y = softmax(QK⊤/d)V` は英字比率 0.63 で、文字だけを見る数式判定を通り抜ける。
  // 版面（段の左端から入り、右端には式番号でしか届かない）で落とす。
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 12; i++) chunks.push(measureLine(i, 100 + i * 13));
  chunks.push(chunk(1, 50, 256, 'The attention weights are computed as'));
  chunks.push(chunk(1, 120, 269, 'y = softmax(QK^T/d)V'));
  chunks.push(chunk(1, 280, 269, '(1)')); // 式番号は段の右端にぶら下がる
  chunks.push(chunk(1, 50, 282, 'where the query and key matrices are shared.'));
  for (let i = 0; i < 12; i++) chunks.push(measureLine(i + 20, 295 + i * 13));

  const { sentences } = buildSentencesFromChunks(chunks, pages(1));
  const texts = sentences.map((s) => s.text);
  assert.ok(
    texts.includes('The attention weights are computed as where the query and key matrices are shared.'),
    `数式が文の途中に差し込まれた: ${JSON.stringify(texts.filter((t) => t.includes('attention weights')))}`,
  );
  assert.ok(!texts.some((t) => t.includes('softmax')), `数式が本文に残った: ${JSON.stringify(texts.filter((t) => t.includes('softmax')))}`);
});

test('字下げされた箇条書きと段落の最終行は本文のまま残す', () => {
  // 別行立ての判定を「字下げ」や「短さ」だけで決めると、ここが消える。
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 12; i++) chunks.push(measureLine(i, 100 + i * 13));
  chunks.push(chunk(1, 75, 256, '(1) We introduce a new block-sparse kernel.'));
  chunks.push(chunk(1, 75, 269, '(2) We prove a bound on the error.'));
  chunks.push(chunk(1, 50, 282, 'The paragraph ends here.'));
  for (let i = 0; i < 12; i++) chunks.push(measureLine(i + 20, 295 + i * 13));

  const texts = buildSentencesFromChunks(chunks, pages(1)).sentences.map((s) => s.text);
  for (const expected of [
    '(1) We introduce a new block-sparse kernel.',
    '(2) We prove a bound on the error.',
    'The paragraph ends here.',
  ]) {
    assert.ok(texts.includes(expected), `本文が落ちた: ${expected} / ${JSON.stringify(texts.slice(11, 17))}`);
  }
});

// --- 本文が図表を参照する（行頭に "Table 3." が来る） --------------------

/**
 * 本文で表や図を参照するのは論文で普通の書き方なのに、折り返しの都合で
 * `Table 3.` が行頭に来た瞬間、その行がキャプションと誤認され、続きの行まで
 * 巻き込んで本文が消えていた。実測（pdflatex の 2 段組・柱間 14pt）で
 * 本文 3 行が落ち、6 文が破壊、うち 1 文は出力から完全に消失していた。
 */
test('行頭に来た図表参照をキャプションと誤認しない', () => {
  // 段の代表値がぶれないよう、どの行も本文と同じ幅（49 文字ぶん）に揃えておく。
  for (const reference of ['Table 3. Our block-sparse kernel wins.', 'Figure 2. The gain holds at every scale.']) {
    const chunks: TextChunk[] = [];
    for (let i = 0; i < 10; i++) chunks.push(measureLine(i, 100 + i * 13));
    // 直前の行は段の右端まで届いたまま、文の途中で折り返している。
    chunks.push(chunk(1, 50, 230, 'We then report every number in'.padEnd(49, ' ')));
    chunks.push(chunk(1, 50, 243, reference.padEnd(49, ' ')));
    chunks.push(chunk(1, 50, 256, 'Smaller models see little change here.'));
    for (let i = 0; i < 10; i++) chunks.push(measureLine(i + 20, 269 + i * 13));

    const texts = buildSentencesFromChunks(chunks, pages(1)).sentences.map((s) => s.text);
    const head = reference.slice(0, reference.indexOf('.') + 1); // "Table 3." / "Figure 2."
    assert.ok(
      texts.some((t) => t.includes(`report every number in ${head}`)),
      `図表参照の行が落ちた: ${JSON.stringify(texts.filter((t) => t.includes('report every number')))}`,
    );
    assert.ok(
      texts.includes('Smaller models see little change here.'),
      `参照の続きの行まで巻き込んで落ちた: ${JSON.stringify(texts.slice(10, 14))}`,
    );
  }
});

test('段落の切れ目から始まる本物の図表キャプションは今までどおり落とす', () => {
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 10; i++) chunks.push(measureLine(i, 100 + i * 13));
  // 段落の最終行（右端まで届かない）。このあとに来るのは本物のキャプション。
  chunks.push(chunk(1, 50, 230, 'The paragraph ends here.'));
  // キャプションの 1 行目は段の右端まで届く（両端揃えで折り返した行）。
  chunks.push(chunk(1, 50, 243, 'Figure 1: Overview of the proposed pipeline.'.padEnd(49, ' ')));
  chunks.push(chunk(1, 50, 256, 'Darker cells are retained across every head.'));
  for (let i = 0; i < 10; i++) chunks.push(measureLine(i + 20, 282 + i * 13));

  const texts = buildSentencesFromChunks(chunks, pages(1)).sentences.map((s) => s.text);
  assert.ok(!texts.some((t) => t.includes('Overview of the proposed pipeline')), `キャプションが本文に混ざった: ${JSON.stringify(texts.slice(9, 13))}`);
  assert.ok(!texts.some((t) => t.includes('Darker cells are retained')), 'キャプションの 2 行目が本文に混ざった');
  assert.ok(texts.includes('The paragraph ends here.'), '段落の最終行が落ちた');
});
