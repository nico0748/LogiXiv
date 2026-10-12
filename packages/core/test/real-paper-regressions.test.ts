import test from 'node:test';
import assert from 'node:assert/strict';

import { assessReadingOrder, buildLines, classifyLines } from '../src/layout.ts';
import { buildSentencesFromChunks, type TextChunk } from '../src/sentences.ts';
import type { PageSize } from '../src/types.ts';

/**
 * pdflatex で組んだ**実物の論文**（scripts/real-papers/）を `npm run measure` に入れて
 * 初めて見えた壊れ方の回帰テスト。
 *
 * どれも、合成 PDF 14 シナリオが全部 100% のまま素通りしていたもの。
 * 合成 PDF は自分で座標を置くので、自分が想定した壊れ方しか再現できない。
 * ここに置く入力は、実物で観測した版面をそのまま座標に写したもの。
 *
 * 実物そのものの数字は `npm run measure` が見る（PDF と正解はリポジトリに入れてある）。
 * こちらは pdflatex が無い環境でも走るよう、同じ形を文字片で組み直してある。
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

// --- 段抜きの行が文字片に割れる ------------------------------------------

/**
 * pdf.js は 1 行を 1 個の文字片で返すとは限らない。両端揃えで語間が伸びた箇所、
 * 書体の切り替わり（インライン数式・\texttt）、脚注記号の前後で切れる。
 *
 * 段抜きの行がそうして割れると、段間をまたぐ断片だけが「段抜き」に、
 * 残りは「段の中の行」に振り分けられ、読み順が帯 → 段の順なので
 * 行の左半分が右半分より**後ろ**に回る。実物（pdflatex の 2 段組・段抜き
 * アブストラクト）で、1 つの文の中で語が入れ替わっていた。
 */
test('段抜きの行が文字片に割れても、左右が入れ替わらない', () => {
  const chunks: TextChunk[] = [];
  // 段抜きのアブストラクト。最後の 1 行だけが 2 つの文字片に割れていて、
  // 左の断片は段間に届かない（＝そのままだと段の中の行に見える）。
  chunks.push(chunk(1, 50, 100, 'A full width abstract line that spans both columns here.'));
  chunks.push(chunk(1, 50, 113, 'Another full width abstract line that spans both columns.'));
  chunks.push(chunk(1, 50, 126, 'training and inference.'));
  chunks.push(chunk(1, 165, 126, 'Training with the sparse kernel reaches the same loss.'));
  chunks.push(...twoColumnPage(1, 20, 160));
  chunks.push(...twoColumnPage(2, 30));

  const lines = buildLines(chunks);
  const torn = lines.filter((l) => l.text.includes('training and inference'));
  assert.equal(torn.length, 1, `段抜きの行が 2 本に割れたまま: ${JSON.stringify(torn.map((l) => l.text))}`);
  // 語の並びが紙の上と同じか（左の断片が先、右の断片が後）。
  const left = torn[0]!.text.indexOf('training and inference');
  const right = torn[0]!.text.indexOf('Training with the sparse kernel');
  assert.ok(left >= 0 && right > left, `段抜きの行の左右が入れ替わっている: ${JSON.stringify(torn[0]!.text)}`);
});

// --- 参考文献の後ろに置かれた付録 ----------------------------------------

/**
 * ML 系の論文は `\appendix` を `\end{thebibliography}` の後ろに置く。
 * 「参考文献の見出しより後ろは全部 reference」という切り方だと、付録の本文が
 * 丸ごと `nonBody` に落ち、`sentences` に 1 文も入らない。
 * しかも進捗は「34 / 34 文」＝完了と出るので、最後まで気づけない。
 */
test('参考文献の後ろに置かれた付録は、本文として残る', () => {
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 12; i++) {
    chunks.push(chunk(1, 50, 100 + i * 13, `Body sentence number ${i} of the main text here.`));
  }
  chunks.push(chunk(1, 50, 280, 'References', 13));
  chunks.push(chunk(1, 50, 300, '[1] J. Doe and A. Smith. Sparse transformers. In Proc. NeurIPS, 2024.'));
  chunks.push(chunk(1, 50, 313, '[2] R. Roe. Efficient attention. Journal of ML, 12(3):45-67, 2025.'));
  chunks.push(chunk(1, 50, 345, 'A Additional Sweeps', 13));
  chunks.push(chunk(1, 50, 372, 'This appendix reports the sweeps that did not fit.'));
  chunks.push(chunk(1, 50, 385, 'The smallest two benchmarks saturate at eight blocks.'));
  chunks.push(chunk(1, 50, 417, 'B Implementation Notes', 13));
  chunks.push(chunk(1, 50, 444, 'The kernel is launched once per head and batch element.'));

  const { sentences, nonBody } = buildSentencesFromChunks(chunks, pages(1));
  const texts = sentences.map((s) => s.text);
  for (const expected of [
    'This appendix reports the sweeps that did not fit.',
    'The smallest two benchmarks saturate at eight blocks.',
    'The kernel is launched once per head and batch element.',
  ]) {
    assert.ok(texts.includes(expected), `付録の本文が消えた: ${expected}`);
  }
  // 参考文献はこれまでどおり落ちる。
  assert.ok(!texts.some((t) => t.includes('Sparse transformers')), '参考文献が本文に混ざった');
  assert.ok(
    nonBody.some((n) => n.kind === 'reference' && n.text.includes('Sparse transformers')),
    '参考文献が消えた',
  );
  // 付録に「参考文献だから」という嘘の理由が付いていない。
  assert.ok(
    !nonBody.some((n) => n.text.includes('This appendix reports')),
    '付録が nonBody（参考文献）に落ちている',
  );
});

// --- 左右に分かれた柱 ----------------------------------------------------

/**
 * fancyhdr の柱は `\fancyhead[L]` と `\fancyhead[R]` が同じ y に左右で並ぶ。
 * 「ページの先頭の 1 行」だけを見ると、すぐ下（＝同じ y）に行があるので
 * 間隔が 0 と評価され、柱が柱と判定されない。
 * 実物では柱が本文に混ざり、ページをまたぐ文が真っ二つに壊れていた。
 */
test('左右に分かれた柱は、両方とも柱として落ちる', () => {
  const chunks: TextChunk[] = [];
  for (const page of [1, 2, 3]) {
    chunks.push(chunk(page, 50, 60, 'Preprint. Under review.', 9));
    chunks.push(chunk(page, 400, 60, 'Block Sparse Attention', 9));
    chunks.push(...twoColumnPage(page, 25, 110));
  }

  const { sentences, nonBody } = buildSentencesFromChunks(chunks, pages(3));
  const texts = sentences.map((s) => s.text);
  assert.ok(!texts.some((t) => t.includes('Preprint')), `左の柱が本文に混ざった: ${JSON.stringify(texts.slice(0, 3))}`);
  assert.ok(!texts.some((t) => t.includes('Block Sparse Attention')), '右の柱が本文に混ざった');
  for (const head of ['Preprint. Under review.', 'Block Sparse Attention']) {
    assert.ok(
      nonBody.some((n) => n.kind === 'runningHead' && n.text === head),
      `柱が柱として残っていない: ${head}`,
    );
  }
});

// --- 表題と著者 ----------------------------------------------------------

/**
 * 表題は普通の 1 行なので版面の規則のどれにも当たらず、**本文の 1 文目**として
 * 出ていた。実物では order = 0 の文が「表題 + 所属 3 件」になり、一覧にも
 * ヘッダーにも「Claude にこう言う」のコピー文にもそれが出ていた。
 */
test('表題と著者と所属は、本文の文にしない', () => {
  const chunks: TextChunk[] = [];
  chunks.push(chunk(1, 140, 60, 'Block Sparse Attention for Long Documents', 17));
  chunks.push(chunk(1, 200, 90, 'Jane Q. Doe, Alan R. Roe, and Mei Tanaka', 12));
  chunks.push(chunk(1, 160, 108, 'Northern Institute of Technology', 12));
  chunks.push(chunk(1, 280, 140, 'Abstract', 10));
  chunks.push(chunk(1, 50, 160, 'Transformer models spend most of their compute on attention.'));
  chunks.push(chunk(1, 50, 173, 'We introduce a block sparse attention kernel here.'));
  for (let i = 0; i < 12; i++) {
    chunks.push(chunk(1, 50, 200 + i * 13, `Body sentence number ${i} of the main text here.`));
  }

  const { sentences, nonBody } = buildSentencesFromChunks(chunks, pages(1));
  const texts = sentences.map((s) => s.text);
  assert.ok(!texts.some((t) => t.includes('Block Sparse Attention for Long')), `表題が本文の文になった: ${texts[0]}`);
  assert.ok(!texts.some((t) => t.includes('Jane Q. Doe')), '著者行が本文の文になった');
  assert.ok(
    nonBody.some((n) => n.kind === 'frontMatter' && n.text.includes('Block Sparse Attention for Long')),
    '表題が消えた（落とすだけで残していない）',
  );
  // 見出しの後ろのアブストラクトは本文として残る（前付として巻き込まない）。
  assert.ok(
    texts.includes('Transformer models spend most of their compute on attention.'),
    'アブストラクトの本文まで前付として落ちた',
  );
});

// --- 擬似コード ----------------------------------------------------------

/**
 * `algorithm` + `algpseudocode` のフロート。演算子を含む行は数式として落ちるのに、
 * `5: end for` と `6: return M` だけが本文に残る。実物では、それが文書の先頭に来るので
 * `\title` の無い PDF では**それが題名**になっていた。
 */
test('擬似コードの行は、演算子が無くても本文に混ざらない', () => {
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 10; i++) {
    chunks.push(chunk(1, 50, 100 + i * 13, `Body sentence number ${i} of the main text here.`));
  }
  chunks.push(chunk(1, 50, 250, 'Algorithm 1 Greedy block selection'));
  chunks.push(chunk(1, 56, 265, '1: M = 0'));
  chunks.push(chunk(1, 56, 278, '2: for each query block i do'));
  chunks.push(chunk(1, 56, 291, '3: S = TopK(q, K, k)'));
  chunks.push(chunk(1, 56, 304, '4: M = M + S'));
  chunks.push(chunk(1, 56, 317, '5: end for'));
  chunks.push(chunk(1, 56, 330, '6: return M'));
  for (let i = 0; i < 10; i++) {
    chunks.push(chunk(1, 50, 360 + i * 13, `Later sentence number ${i} of the main text here.`));
  }

  const { sentences, nonBody } = buildSentencesFromChunks(chunks, pages(1));
  const texts = sentences.map((s) => s.text);
  for (const fragment of ['end for', 'return M', 'for each query block']) {
    assert.ok(!texts.some((t) => t.includes(fragment)), `擬似コードが本文に混ざった: ${fragment}`);
  }
  assert.ok(nonBody.some((n) => n.text.includes('return M')), '擬似コードが消えた');
});

/**
 * フロートの直後に来る小見出し。直前の行（擬似コードの最終行）が文として
 * 閉じていないので「段落の途中」と見なされて減点され、見出しから本文に落ちていた。
 * 本文と同じ大きさの小見出し（IEEE / ACL 系の体裁）では文字高の加点が無いので、
 * この減点がそのまま判定をひっくり返す。
 */
test('フロートの直後に来た小見出しは、次の文と癒着しない', () => {
  const chunks: TextChunk[] = [];
  chunks.push(chunk(1, 50, 100, '1 Greedy Block Selection', 14));
  for (let i = 0; i < 8; i++) {
    chunks.push(chunk(1, 50, 130 + i * 13, `Body sentence number ${i} of the main text here.`));
  }
  chunks.push(chunk(1, 56, 250, '1: M = 0'));
  chunks.push(chunk(1, 56, 263, '2: for each query block i do'));
  chunks.push(chunk(1, 56, 276, '5: end for'));
  chunks.push(chunk(1, 56, 289, '6: return M'));
  // 小見出しは本文と同じ大きさ。上に 1 行ぶん以上の空きがある。
  chunks.push(chunk(1, 50, 318, '1.2 Cost of the Selection Pass'));
  chunks.push(chunk(1, 50, 334, 'The selection pass compares every query summary here.'));
  for (let i = 0; i < 8; i++) {
    chunks.push(chunk(1, 50, 347 + i * 13, `Later sentence number ${i} of the main text here.`));
  }

  const { sentences, sections } = buildSentencesFromChunks(chunks, pages(1));
  assert.ok(
    sections.some((s) => s.title === '1.2 Cost of the Selection Pass'),
    `小見出しが節として拾われていない: ${JSON.stringify(sections.map((s) => s.title))}`,
  );
  const texts = sentences.map((s) => s.text);
  assert.ok(
    texts.includes('The selection pass compares every query summary here.'),
    `小見出しが次の文に癒着した: ${JSON.stringify(texts.filter((t) => t.includes('selection pass')))}`,
  );
});

// --- 別行立ての数式（分数） ----------------------------------------------

/**
 * `\frac` を含む `equation` は、分子・本体・分母が別々の行として出てくる。
 * 字下げの揃った行だけを塊にしていると、真ん中の本体だけが本文に残り、
 * 次の文と 1 枚のカードに同居する。右にぶら下がる式番号のせいで
 * 「段幅の 70% 未満」という短さの門も通り抜けてしまう。
 */
test('分数を含む別行立ての数式は、分子分母と一緒に落ちる', () => {
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 10; i++) {
    chunks.push(chunk(1, 50, 100 + i * 13, `Body sentence number ${i} of the main text here.`));
  }
  // 分子・本体・分母。行送り（13）より詰まって積まれる。
  chunks.push(chunk(1, 200, 243, 'QK'));
  chunks.push(chunk(1, 120, 250, 'Attn(Q, K,V ) = smx     V,'));
  chunks.push(chunk(1, 285, 250, '(1)'));
  chunks.push(chunk(1, 205, 257, 'd'));
  for (let i = 0; i < 10; i++) {
    chunks.push(chunk(1, 50, 283 + i * 13, `Later sentence number ${i} of the main text here.`));
  }

  const { sentences, nonBody } = buildSentencesFromChunks(chunks, pages(1));
  const texts = sentences.map((s) => s.text);
  assert.ok(!texts.some((t) => t.includes('Attn(Q')), `数式の本体が本文に混ざった: ${JSON.stringify(texts.filter((t) => t.includes('Attn')))}`);
  assert.ok(nonBody.some((n) => n.text.includes('Attn(Q')), '数式が消えた');
});

// --- 脚注記号 ------------------------------------------------------------

/**
 * 肩付きの脚注番号は、pdf.js からはただの文字片として出てくる。
 * `…in all remaining experiments.` の直後に `1` が続いた文字列になるので、
 * 「終端記号の後ろに空白が要る」文分割の規則でそこが切れず、
 * 脚注の付いた文とその次の文が 1 枚のカードに同居していた。
 */
test('肩付きの脚注番号は、本文の文字列から外れる', () => {
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 8; i++) {
    chunks.push(chunk(1, 50, 100 + i * 13, `Body sentence number ${i} of the main text here.`));
  }
  chunks.push(chunk(1, 50, 204, 'We use sixteen retained blocks in all experiments.'));
  chunks.push(chunk(1, 295, 203, '1', 7));
  chunks.push(chunk(1, 50, 217, 'We also vary the block size between sixteen and two.'));
  for (let i = 0; i < 6; i++) {
    chunks.push(chunk(1, 50, 230 + i * 13, `Later sentence number ${i} of the main text here.`));
  }
  // 段の下端に続く、本文より小さい文字の塊＝脚注。その下にノンブル。
  chunks.push(chunk(1, 50, 321, '1The sweep for the two smallest benchmarks is in the appendix.', 8));
  chunks.push(chunk(1, 290, 800, '7', 9));

  const { sentences } = buildSentencesFromChunks(chunks, pages(1));
  const texts = sentences.map((s) => s.text);
  assert.ok(
    texts.includes('We use sixteen retained blocks in all experiments.'),
    `脚注記号が本文の文にくっついた: ${JSON.stringify(texts.filter((t) => t.includes('sixteen retained')))}`,
  );
  assert.ok(
    texts.includes('We also vary the block size between sixteen and two.'),
    '脚注記号のせいで次の文が切れなかった',
  );
});

// --- 読み順の自己申告 ----------------------------------------------------

/**
 * 「簡易解析」バッジの一択では、完璧に取れた文書と 3 分の 1 しか取れていない文書に
 * 同じものが出る。崩れを直せなくても、崩れていると分かれば読む側は原文を見に行ける。
 *
 * ここでは段の検出が丸ごと失敗する版面（全幅の行が多すぎて空白帯が見つからず、
 * 借りられる他ページも無い 1 ページ文書）を作り、自己申告が high になることを見る。
 */
test('左右の段が連結された文書は、読み順が怪しいと自分で申告する', () => {
  const chunks: TextChunk[] = [];
  // 全幅の行を多めに置いて、段間の空白帯を潰す。
  //
  // 段抜きが本文の行数を上回るところまで置く。ここが本文より少ないと、
  // 文書全体で段を探し直す経路（resolveColumns の重ね合わせ）が段を見つけてしまい、
  // そもそも連結が起きない＝この試験の前提が崩れる。実際に崩れたので 16 行から増やした。
  for (let i = 0; i < 26; i++) {
    chunks.push(chunk(1, 50, 80 + i * 13, `A full width abstract line number ${i} spanning both columns.`));
  }
  // 本物の 2 段組の本文。左段 50..260、右段 310..520（段間 50pt）。
  for (let i = 0; i < 20; i++) {
    chunks.push(chunk(1, 50, 300 + i * 13, `Left body line ${i} keeps running here.`));
    chunks.push(chunk(1, 310, 300 + i * 13, `Right body line ${i} keeps running too.`));
  }

  const lines = classifyLines(buildLines(chunks), pages(1));
  const merged = lines.filter((l) => l.text.includes('Left body') && l.text.includes('Right body'));
  assert.ok(merged.length >= 8, `この入力では段が連結していない（前提が崩れている）: ${merged.length} 行`);

  const quality = assessReadingOrder(lines);
  assert.equal(quality.readingOrderRisk, 'high', `連結しているのに申告が low: ${quality.reason}`);
  assert.match(quality.reason, /段/, '理由が人に読める形になっていない');
});

test('段がきれいに取れている文書には、読み順の警告を出さない', () => {
  // 段組・段抜きのアブストラクト・柱・ノンブルが揃った、崩れていない版面。
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 6; i++) {
    chunks.push(chunk(1, 50, 80 + i * 13, `A full width abstract line number ${i} spanning both columns.`));
  }
  for (const page of [1, 2, 3]) {
    chunks.push(chunk(page, 50, 60, 'Preprint. Under review.', 9));
    chunks.push(...twoColumnPage(page, 25, page === 1 ? 180 : 100));
    chunks.push(chunk(page, 290, 800, String(page), 9));
  }

  const lines = classifyLines(buildLines(chunks), pages(3));
  const quality = assessReadingOrder(lines);
  assert.equal(
    quality.readingOrderRisk,
    'low',
    `崩れていない文書に警告が出た（誤検出）: ${quality.reason}`,
  );
});

/** 合成 14 シナリオも実物 3 本も、この申告が low のまま通ることを `npm run measure` が見ている。 */
test('簡易解析の結果には、読み順の自己申告が必ず付く', () => {
  const chunks = [...twoColumnPage(1, 20), ...twoColumnPage(2, 20)];
  const { quality } = buildSentencesFromChunks(chunks, pages(2));
  assert.ok(quality !== undefined, '自己申告が付いていない');
  assert.ok(['low', 'high'].includes(quality.readingOrderRisk), '申告の値が想定外');
  assert.ok(quality.reason.length > 0, '理由が空');
});
