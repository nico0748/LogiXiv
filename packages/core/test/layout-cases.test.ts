import test from 'node:test';
import assert from 'node:assert/strict';

import { assessCoverage, buildLines, classifyLines, detectColumns } from '../src/layout.ts';
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

// --- 落とした行を捨てずに残す -------------------------------------------

/**
 * `furniture` と判定した行は本文の文には入れないが、捨てもしない。
 *
 * 落とすこと自体は正しくても、落としたことが誰にも見えないと
 * 「まだ訳が来ていないのか、自分が見落としたのか」を区別できない。
 * PDF に見えているものが右に無いなら、無い理由がその場に要る。
 */
test('本文として落とした行を、種類つきで残す', () => {
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 10; i++) chunks.push(measureLine(i, 100 + i * 13));
  chunks.push(chunk(1, 50, 230, 'Information retrieval benefits from'));
  chunks.push(chunk(1, 120, 243, 'Model     Acc     F1'));
  chunks.push(chunk(1, 120, 256, 'Dense     81.2    79.4'));
  chunks.push(chunk(1, 50, 269, 'the same sparsity pattern at every depth.'));
  chunks.push(chunk(1, 50, 282, 'Figure 1: Overview of the proposed pipeline.'.padEnd(49, ' ')));
  chunks.push(chunk(1, 50, 295, 'Darker cells are retained across every head.'));
  for (let i = 0; i < 10; i++) chunks.push(measureLine(i + 20, 308 + i * 13));
  chunks.push(chunk(1, 290, 800, '7', 9));

  const { sentences, nonBody } = buildSentencesFromChunks(chunks, pages(1));
  const kinds = nonBody.map((n) => n.kind);
  assert.deepEqual([...new Set(kinds)].sort(), ['caption', 'pageNumber', 'table'], JSON.stringify(nonBody.map((n) => `${n.kind}:${n.text}`)));

  // 本文の文には入っていない（入れると訳す対象になり、進捗の分母も狂う）。
  const texts = sentences.map((s) => s.text);
  assert.ok(!texts.some((t) => t.includes('81.2')), '表のセルが本文の文に入った');
  assert.ok(!texts.some((t) => t.includes('Overview of the proposed pipeline')), 'キャプションが本文の文に入った');
  // 落とした行は右に出せる形で残っている。
  assert.ok(nonBody.some((n) => n.kind === 'table' && n.text.includes('81.2')), '表のセルが消えた');
  assert.ok(nonBody.some((n) => n.kind === 'pageNumber' && n.text === '7'), 'ノンブルが消えた');
});

test('折り返したキャプションは 1 件にまとまり、矩形も行ごとに付く', () => {
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 10; i++) chunks.push(measureLine(i, 100 + i * 13));
  chunks.push(chunk(1, 50, 230, 'The paragraph ends here.'));
  chunks.push(chunk(1, 50, 243, 'Figure 1: Overview of the proposed pipeline.'.padEnd(49, ' ')));
  chunks.push(chunk(1, 50, 256, 'Darker cells are retained across every head.'));
  for (let i = 0; i < 10; i++) chunks.push(measureLine(i + 20, 269 + i * 13));

  const { nonBody } = buildSentencesFromChunks(chunks, pages(1));
  const captions = nonBody.filter((n) => n.kind === 'caption');
  assert.equal(captions.length, 1, `キャプションが 1 件にまとまっていない: ${JSON.stringify(captions.map((c) => c.text))}`);
  assert.ok(captions[0]!.text.includes('Overview of the proposed pipeline'), captions[0]!.text);
  assert.ok(captions[0]!.text.includes('Darker cells are retained'), `続きの行が落ちた: ${captions[0]!.text}`);
  assert.equal(captions[0]!.rects.length, 2, '行ごとの矩形が付いていない');
});

test('参考文献は 1 エントリごとに 1 件で残す', () => {
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 10; i++) chunks.push(measureLine(i, 100 + i * 13));
  chunks.push(chunk(1, 50, 260, 'References', 11));
  const entries = [
    ['[1] J. Doe and A. Smith. Sparse transformers. In', 'Proc. NeurIPS, 2024.'],
    ['[2] R. Roe. Efficient attention. Journal of ML,', '12(3):45-67, 2025.'],
    ['[3] M. Tanaka. Long documents. In Proc. ICML,', 'pages 12-24, 2023.'],
  ];
  entries.forEach(([head, tail], i) => {
    chunks.push(chunk(1, 50, 286 + i * 26, head!));
    chunks.push(chunk(1, 50, 299 + i * 26, tail!));
  });

  const { sentences, nonBody } = buildSentencesFromChunks(chunks, pages(1));
  const references = nonBody.filter((n) => n.kind === 'reference');
  assert.equal(references.length, 3, `参考文献が 1 件ずつに分かれていない: ${JSON.stringify(references.map((r) => r.text))}`);
  entries.forEach(([head, tail], i) => {
    assert.ok(references[i]!.text.startsWith(head!.slice(0, 3)), references[i]!.text);
    assert.ok(references[i]!.text.includes(tail!.slice(0, 8)), `続きの行が落ちた: ${references[i]!.text}`);
  });
  assert.ok(!sentences.some((s) => s.text.includes('NeurIPS')), '参考文献が本文の文に入った');
});

test('落とした行は afterOrder で本文の文の間に差し込める', () => {
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 6; i++) chunks.push(measureLine(i, 100 + i * 13));
  chunks.push(chunk(1, 50, 178, 'The paragraph ends here.'));
  chunks.push(chunk(1, 50, 191, 'Figure 1: Overview of the proposed pipeline.'.padEnd(49, ' ')));
  // 図版の下には余白が入る。ここを詰めると、キャプションの塊が本文まで伸びる。
  for (let i = 0; i < 6; i++) chunks.push(measureLine(i + 20, 230 + i * 13));

  const { sentences, nonBody } = buildSentencesFromChunks(chunks, pages(1));
  const caption = nonBody.find((n) => n.kind === 'caption');
  assert.ok(caption !== undefined, 'キャプションが残っていない');
  // 直前は「段落の最終行」、直後は次の本文行。
  assert.equal(sentences[caption!.afterOrder]?.text, 'The paragraph ends here.');
  assert.ok(sentences[caption!.afterOrder + 1]?.text.startsWith('Body line 20'), JSON.stringify(sentences[caption!.afterOrder + 1]?.text));
  // ID は本文の文とぶつからない。
  assert.ok(nonBody.every((n) => sentences.every((s) => s.id !== n.id)), 'ID が本文の文とぶつかっている');
});

test('落とした行の位置は、区切りを直しても追える hash でも持つ', () => {
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 6; i++) chunks.push(measureLine(i, 100 + i * 13));
  chunks.push(chunk(1, 50, 178, 'The paragraph ends here.'));
  chunks.push(chunk(1, 50, 191, 'Figure 1: Overview of the proposed pipeline.'.padEnd(49, ' ')));
  for (let i = 0; i < 6; i++) chunks.push(measureLine(i + 20, 230 + i * 13));

  const { sentences, nonBody } = buildSentencesFromChunks(chunks, pages(1));
  const caption = nonBody.find((n) => n.kind === 'caption')!;
  // 通し番号と hash が同じ文を指している。通し番号は文の結合・分割でずれるので、
  // 画面はまず hash で探せる。
  assert.equal(caption.afterHash, sentences[caption.afterOrder]!.hash);
  assert.equal(sentences[caption.afterOrder]!.text, 'The paragraph ends here.');
});

test('付物にした行を 1 行も取りこぼさない', () => {
  // 落とした行が「文にも nonBody にも出てこない」状態を作らないための不変条件。
  // ここが崩れると、PDF に見えているのに右に何も無い行が生まれる。
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 10; i++) chunks.push(measureLine(i, 100 + i * 13));
  chunks.push(chunk(1, 50, 230, 'Information retrieval benefits from'));
  chunks.push(chunk(1, 120, 243, 'Model     Acc     F1'));
  chunks.push(chunk(1, 120, 256, 'Dense     81.2    79.4'));
  chunks.push(chunk(1, 50, 269, 'the same sparsity pattern at every depth.'));
  chunks.push(chunk(1, 50, 282, 'Figure 1: Overview of the proposed pipeline.'.padEnd(49, ' ')));
  chunks.push(chunk(1, 50, 295, 'Darker cells are retained across every head.'));
  for (let i = 0; i < 10; i++) chunks.push(measureLine(i + 20, 320 + i * 13));
  chunks.push(chunk(1, 50, 470, 'References', 11));
  chunks.push(chunk(1, 50, 496, '[1] J. Doe and A. Smith. Sparse transformers. In Proc. NeurIPS, 2024.'));
  chunks.push(chunk(1, 290, 800, '7', 9));

  const lines = classifyLines(buildLines(chunks), pages(1));
  const dropped = lines.filter((l) => l.role === 'furniture' && l.text.trim().length > 0);
  assert.ok(dropped.length >= 5, `付物が足りない: ${dropped.length}`);

  const { nonBody } = buildSentencesFromChunks(chunks, pages(1));
  const kept = nonBody.map((n) => n.text).join(' | ');
  for (const line of dropped) {
    assert.ok(kept.includes(line.text.trim().slice(0, 12)), `落とした行が行方不明: ${JSON.stringify(line.text)}`);
  }
});

// --- インライン数式を含む本文 -------------------------------------------

/**
 * 添字つきの本文行を作る。
 *
 * pdf.js は `Q_1` を「Q」（10pt）と「1」（7.4pt、4pt ほど下）の 2 つの文字片で返す。
 * この「小さくて少し下にある文字片」が本文の行から外れると、短くて字下げされた
 * 独立した行に見えるので、別行立ての数式・表として落ちる。
 */
function withSubscript(y: number, head: string, base: string, sub: string, tail: string): TextChunk[] {
  const headChunk = chunk(1, 50, y, head);
  const baseChunk = chunk(1, headChunk.x + headChunk.w, y, base);
  const subChunk: TextChunk = {
    page: 1,
    text: sub,
    x: baseChunk.x + baseChunk.w,
    // 下がり幅と文字高は実測値（pdflatex の 10pt 本文、Computer Modern）。
    // 小さい方の文字高で測った許容量（7.0 × 0.6 = 4.2pt）をわずかに超えるので、
    // 何もしなければ独立した行になる。
    y: y + 4.5,
    w: sub.length * 4,
    h: 7.0,
  };
  const tailChunk = chunk(1, subChunk.x + subChunk.w, y, tail);
  return [headChunk, baseChunk, subChunk, tailChunk];
}

test('添字は同じ行にまとめる（独立した行にしない）', () => {
  const chunks = withSubscript(100, 'We compare ', 'Q', '1', ' against the dense baseline here.');
  const lines = buildLines(chunks);
  assert.equal(lines.length, 1, `添字が別の行になった: ${JSON.stringify(lines.map((l) => l.text))}`);
  assert.equal(lines[0]!.text, 'We compare Q1 against the dense baseline here.');
});

test('インライン数式を含む本文行を、数式や表として落とさない', () => {
  // 実測（pdflatex の 2 段組）で、同じ文章にインライン数式を入れただけで
  // 本文 4 文がすべて消え、残骸が文法の通る英文に癒着した。
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 8; i++) chunks.push(measureLine(i, 100 + i * 13));
  const body = [
    ['Suppose two shifts ', 'Q', '1', ' and two more induce shared biases.'],
    ['We write the norms as ', 'β', '1', ' and take the member variance.'],
    ['Calibration under ', 'Q', 'i', ' requires the reported variance to match.'],
  ];
  body.forEach((parts, i) => chunks.push(...withSubscript(210 + i * 13, parts[0]!, parts[1]!, parts[2]!, parts[3]!)));
  for (let i = 0; i < 8; i++) chunks.push(measureLine(i + 20, 260 + i * 13));

  const { sentences } = buildSentencesFromChunks(chunks, pages(1));
  const texts = sentences.map((s) => s.text);
  for (const expected of [
    'Suppose two shifts Q1 and two more induce shared biases.',
    'We write the norms as β1 and take the member variance.',
    'Calibration under Qi requires the reported variance to match.',
  ]) {
    assert.ok(texts.includes(expected), `本文が消えた: ${expected} / ${JSON.stringify(texts.slice(7, 13))}`);
  }
});

test('本文を数式として落とすと、採録率が下がって自分で申告する', () => {
  const lines = classifyLines(buildLines([]), pages(1));
  assert.equal(assessCoverage(lines).coverage, 1, '行が無いときは 1');

  // 正しく落としているもの（中央寄せの数式・表のセル）では下がらない。
  const clean: TextChunk[] = [];
  for (let i = 0; i < 10; i++) clean.push(measureLine(i, 100 + i * 13));
  clean.push(chunk(1, 120, 230, 'y = softmax(QK^T/d)V'));
  clean.push(chunk(1, 280, 230, '(1)'));
  clean.push(chunk(1, 120, 243, 'Model     Acc     F1'));
  for (let i = 0; i < 10; i++) clean.push(measureLine(i + 20, 270 + i * 13));
  const cleanQuality = assessCoverage(classifyLines(buildLines(clean), pages(1)));
  assert.equal(cleanQuality.coverageRisk, 'low', `正しく落としているのに鳴った: ${cleanQuality.coverageReason}`);
  assert.equal(cleanQuality.coverage, 1);

  // 本文の行を無理やり数式として落とすと下がる（人の手で role を書き換えて再現）。
  const broken = classifyLines(buildLines(clean), pages(1)).map((line, i) =>
    i >= 2 && i <= 6 ? { ...line, role: 'furniture' as const, kind: 'formula' as const } : line,
  );
  const brokenQuality = assessCoverage(broken);
  assert.equal(brokenQuality.coverageRisk, 'high', '本文が落ちているのに申告が low');
  assert.ok(brokenQuality.coverage < 0.98, `採録率が下がっていない: ${brokenQuality.coverage}`);
  assert.match(brokenQuality.coverageReason, /本文/, '理由が人に読める形になっていない');
});

test('付録の見出しは見出しとして扱う（中身と 1 文に癒着させない）', () => {
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 8; i++) chunks.push(measureLine(i, 100 + i * 13));
  // \appendix の後ろの \section は "A" で始まる。段幅いっぱいまで伸びることもある。
  chunks.push(chunk(1, 50, 230, 'A Proof of the Obstruction'.padEnd(49, ' '), 14));
  chunks.push(chunk(1, 50, 256, 'Assume the two calibration conditions hold here.'));

  const texts = buildSentencesFromChunks(chunks, pages(1)).sentences.map((s) => s.text);
  assert.ok(
    texts.includes('Assume the two calibration conditions hold here.'),
    `付録の見出しが本文に癒着した: ${JSON.stringify(texts.slice(-2))}`,
  );
});

// --- 段抜きの多い 2 段組 -------------------------------------------------

test('どのページも段抜きだらけでも、文書全体で段を見つける', () => {
  // 実測: アブストラクトに 2 文足しただけ（段抜きが許容 11 行に対して 11 行）で
  // 再現率 100% → 34%。1 ページでも自力で見つかれば借りられるが、
  // どのページにも段抜きがあると借り元が無く、文書全体が 1 段扱いになる。
  const chunks: TextChunk[] = [];
  for (const page of [1, 2]) {
    // 段抜きが行数の 15%（ページ単位の許容）を超えるだけ置く。
    for (let i = 0; i < 14; i++) {
      chunks.push(chunk(page, 50, 80 + i * 13, `A full width abstract line ${i} spanning both columns.`));
    }
    chunks.push(...twoColumnPage(page, 22, 280));
  }

  // ページ単位ではどちらも段を見つけられない（段抜きが 15% を超えている）。
  const page1 = chunks.filter((c) => c.page === 1);
  assert.equal(detectColumns(page1).length, 1, 'この入力ではページ単位で段が見つかってしまう（前提が崩れている）');

  // 行が連結していないこと。文で見ると、左右がどちらも文末記号で終わるせいで
  // 「連結したのに文としては 2 つに割れる」ため、連結を見落とす。
  const lines = buildLines(chunks);
  const merged = lines.filter((l) => l.text.includes('Left body') && l.text.includes('Right body'));
  assert.equal(merged.length, 0, `左右の段が 1 行に連結された: ${JSON.stringify(merged.slice(0, 2).map((l) => l.text))}`);

  // 読み順も見る。連結すると左右が交互になり、段を読み切る順にならない。
  const texts = buildSentencesFromChunks(chunks, pages(2)).sentences.map((s) => s.text);
  const lastLeft = texts.findIndex((t) => t.includes('Left body line 21 on page 1'));
  const firstRight = texts.findIndex((t) => t.includes('Right body line 0 on page 1'));
  assert.ok(lastLeft >= 0 && firstRight >= 0, JSON.stringify(texts.slice(0, 4)));
  assert.ok(lastLeft < firstRight, '左段を読み切る前に右段が来ている（段が連結している）');
});

test('1 段組を、重ね合わせでも 2 段と誤検出しない', () => {
  // 全ページを重ねて探す経路は許容を緩めるので、ここが歯止めになる。
  // 1 段組は全ての行が段間をまたぐので、どれだけ緩めても段組にはならない。
  const chunks: TextChunk[] = [];
  for (const page of [1, 2, 3]) {
    for (let i = 0; i < 30; i++) {
      chunks.push(chunk(page, 50, 100 + i * 13, `Body line ${i} on page ${page} runs the full measure here.`));
    }
  }
  const { sentences } = buildSentencesFromChunks(chunks, pages(3));
  assert.equal(sentences.length, 90, `1 段組が割れた: ${sentences.length} 文`);
});

// --- 和文の版面 ---------------------------------------------------------

/**
 * 和文の文字片。**1 文字がほぼ 1em 進む**のが欧文との決定的な違いで、
 * 段の切れ目や見出しの判定を「字送りの何倍」で決めていると、そこが全部ずれる。
 */
function cjkChunk(page: number, x: number, y: number, text: string, size = 10): TextChunk {
  return { page, text, x, y, w: text.length * size, h: size };
}

/** 24 文字（＝段幅 240pt）の和文本文行。段の代表値を決めるために要る。 */
const cjkBody = (page: number, x: number, y: number, n: number): TextChunk => {
  const head = `本文の行${String(n).padStart(2, '０')}は`;
  // 句点まで入れて 24 文字ちょうどにする（句点が切れると全部 1 文に繋がる）。
  return cjkChunk(page, x, y, `${`${head}段の幅いっぱいまで文字が詰まる要素`.slice(0, 23)}。`);
};

test('和文の 2 段組を、柱間が既定の 10pt でも見つける', () => {
  // 和文は 1 文字がほぼ 1em なので、下限を「字送りの 1.5 倍」で決めると
  // 10pt 本文で 14.9pt になり、\columnsep の既定 10pt がそのまま下回る。
  // 実測（xelatex の和文 2 段組）で再現率 9%、左右の段が 1 行に混ざっていた。
  // 段は x=50..290 と x=300..540。柱間はちょうど 10pt（\columnsep の既定）。
  // 1 行は 24 文字＝240pt にそろえる（和文は 1 文字が 1em 進む）。
  const side = (label: string, n: number): string =>
    `${`${label}の段の${String(n).padStart(2, '０')}行目はここから本文が続いていきます`.slice(0, 23)}。`;
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 20; i++) {
    chunks.push(cjkChunk(1, 50, 100 + i * 17, side('左', i)));
    chunks.push(cjkChunk(1, 300, 100 + i * 17, side('右', i)));
  }
  // 前提の確認。1 文字 10pt なので、24 文字ちょうどでないと柱間が 10pt にならない。
  assert.equal([...chunks[0]!.text].length, 24, `行の長さが 24 文字でない: ${chunks[0]!.text}`);
  assert.equal(detectColumns(chunks).length, 2, '和文の柱間 10pt で段を見落とした');

  const lines = buildLines(chunks);
  const merged = lines.filter((l) => l.text.includes('左の段') && l.text.includes('右の段'));
  assert.equal(merged.length, 0, `左右の段が 1 行に連結された: ${JSON.stringify(merged.slice(0, 2).map((l) => l.text))}`);
});

test('和文の参考文献を本文に混ぜない', () => {
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 10; i++) chunks.push(cjkBody(1, 50, 100 + i * 17, i));
  chunks.push(cjkChunk(1, 50, 280, '段落はここで終わる。'));
  chunks.push(cjkChunk(1, 50, 300, '参考文献', 12));
  chunks.push(cjkChunk(1, 50, 330, '[1] 佐藤 花子. 日本語文書における文境界推定. 情報処理学会論文誌, 62(3):512-523, 2021.'));
  chunks.push(cjkChunk(1, 50, 347, '[2] 田中 明. 学術文書の構造解析. 人工知能学会誌, 34(2):88-97, 2019.'));

  const { sentences, nonBody } = buildSentencesFromChunks(chunks, pages(1));
  assert.ok(!sentences.some((s) => s.text.includes('佐藤 花子')), `和文の参考文献が本文に混ざった: ${JSON.stringify(sentences.slice(-3).map((s) => s.text))}`);
  assert.ok(
    nonBody.some((n) => n.kind === 'reference' && n.text.includes('佐藤 花子')),
    `参考文献として残っていない: ${JSON.stringify(nonBody.map((n) => `${n.kind}:${n.text.slice(0, 20)}`))}`,
  );
});

test('和文の番号つき見出しを、直後の文と癒着させない', () => {
  // headingNumber が「番号の後ろは欧文の大文字」しか見ていなかったとき、
  // `4 実装` が本文に落ちて `4 実装実装は…` という 1 文になっていた。
  // 和文誌の小見出しは本文とほとんど同じ大きさで、上の余白も 1 行ぶん程度しかない。
  // 文字の大きさと行間だけでは拾えないので、見出しの語そのものを知る必要がある。
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 10; i++) chunks.push(cjkBody(1, 50, 100 + i * 17, i));
  chunks.push(cjkChunk(1, 50, 290, '4 実装', 11));
  chunks.push(cjkChunk(1, 50, 310, '実装は外部の依存を持たない。'));
  for (let i = 0; i < 6; i++) chunks.push(cjkBody(1, 50, 327 + i * 17, i + 20));

  const { sentences, sections } = buildSentencesFromChunks(chunks, pages(1));
  assert.ok(
    sentences.some((s) => s.text === '実装は外部の依存を持たない。'),
    `見出しが本文と癒着した: ${JSON.stringify(sentences.map((s) => s.text).filter((t) => t.includes('実装')))}`,
  );
  assert.ok(sections.some((s) => s.title.includes('実装')), `和文の見出しを節として拾えていない: ${JSON.stringify(sections.map((s) => s.title))}`);
});

test('和文の表題を前付として落とす（要旨の 1 文目と癒着させない）', () => {
  // 「概要」は本文と同じ大きさで、上の余白も 1 行ぶんしかない。見出しの語を
  // 知らないと本文になり、その手前の表題も前付にならずに要旨と 1 文へ癒着する。
  const chunks: TextChunk[] = [];
  chunks.push(cjkChunk(1, 120, 80, '日本語の本文を含む論文における文境界の推定', 17));
  chunks.push(cjkChunk(1, 200, 115, '坂比賀 悠真', 12));
  chunks.push(cjkChunk(1, 50, 135, '概要'));
  chunks.push(cjkChunk(1, 50, 152, '本稿では、日本語の本文に英語の術語が混ざる論文を対象とする。'));
  for (let i = 0; i < 10; i++) chunks.push(cjkBody(1, 50, 169 + i * 17, i));

  const { sentences, nonBody } = buildSentencesFromChunks(chunks, pages(1));
  assert.ok(
    sentences.some((s) => s.text === '本稿では、日本語の本文に英語の術語が混ざる論文を対象とする。'),
    `表題が要旨の 1 文目と癒着した: ${JSON.stringify(sentences.slice(0, 2).map((s) => s.text))}`,
  );
  assert.ok(
    nonBody.some((n) => n.kind === 'frontMatter' && n.text.includes('文境界の推定')),
    `表題が前付として残っていない: ${JSON.stringify(nonBody.map((n) => `${n.kind}:${n.text.slice(0, 16)}`))}`,
  );
});

test('1 回しか出ない柱を、本文の文の途中に挟まない', () => {
  // 1 ページ目が plain（柱なし）の 2 ページ論文では柱が 1 回しか現れない。
  // 「複数ページに出ていること」だけを条件にしていると落とせず、ページをまたぐ
  // 文の真ん中に柱が入る（実測: `ページの変` ＋ `情報処理学会論文誌` ＋ `わり目で…`）。
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 12; i++) chunks.push(cjkBody(1, 50, 100 + i * 17, i));
  chunks.push(cjkChunk(1, 50, 304, 'ページをまたぐ文はここで終'));
  // 2 ページ目。柱は本文の塊から 3 行ぶん以上離れた天の余白にある。
  chunks.push(cjkChunk(2, 50, 18, '情報処理学会論文誌'));
  chunks.push(cjkChunk(2, 50, 100, 'わらずに続く。'));
  for (let i = 0; i < 12; i++) chunks.push(cjkBody(2, 50, 117 + i * 17, i + 20));

  const { sentences, nonBody } = buildSentencesFromChunks(chunks, pages(2));
  assert.ok(
    sentences.some((s) => s.text === 'ページをまたぐ文はここで終わらずに続く。'),
    `柱が文の途中に挟まった: ${JSON.stringify(sentences.filter((s) => s.text.includes('ページをまたぐ')).map((s) => s.text))}`,
  );
  assert.ok(nonBody.some((n) => n.kind === 'runningHead'), `柱が柱として残っていない: ${JSON.stringify(nonBody.map((n) => `${n.kind}:${n.text}`))}`);
});
