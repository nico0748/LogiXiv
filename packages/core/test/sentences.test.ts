import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSentencesFromChunks, splitIntoSentences, type TextChunk } from '../src/sentences.ts';
import type { PageSize } from '../src/types.ts';

/**
 * 行と文字片の**継ぎ目に空白を入れるか**の回帰テスト。
 *
 * 和文には語の切れ目に空白が無いので、行の折り返しは語の途中で起きる。
 * 継ぎ目に無条件で空白を入れていた頃は、折り返す文が例外なく壊れていた
 * （実測: xelatex で組んだ和文論文で 27 文中 19 文。画面には
 * 「段落と文の切り 出しを検 討する。」と出ていた）。
 *
 * PDF は要らない。pdf.js が返す文字片の並びを直接組み立てて渡す。
 */

const A4: PageSize = { page: 1, width: 595, height: 842 };
const pages = (count: number): PageSize[] =>
  Array.from({ length: count }, (_, i) => ({ ...A4, page: i + 1 }));

/** 和文の行。1 文字が 1em 進む（和文の字送りはほぼ正方形）。 */
function ja(y: number, text: string, size = 10): TextChunk {
  return { page: 1, text, x: 68, y, w: text.length * size, h: size };
}

/** 欧文の行。字送りは字高の半分ほど。 */
function en(y: number, text: string, size = 10): TextChunk {
  return { page: 1, text, x: 68, y, w: text.length * size * 0.5, h: size };
}

/** 行の並びを文にして、本文の字面だけを返す。 */
function bodyTexts(chunks: TextChunk[]): string[] {
  return buildSentencesFromChunks(chunks, pages(1)).sentences.map((s) => s.text);
}

/** 本文が 1 本の文字列として見えるようにしたもの（どこで割れたかに依存せず中身を見る）。 */
function joined(chunks: TextChunk[]): string {
  return bodyTexts(chunks).join('');
}

test('和文の行折り返しでは、継ぎ目に空白が入らない', () => {
  // 実際に壊れていた版面。1 行 46 文字で折り返し、語の途中で行が変わる。
  const text = joined([
    ja(100, '本稿では、日本語の本文に英語の術語が混ざる論文を対象に、段落と文の切り'),
    ja(114, '出しを検討する。既存の手法は空白で語を区切ることを前提としており、文の境'),
    ja(128, '界を見失う。我々は句点と括弧の対応を手掛かりとする規則を提案した。'),
  ]);

  assert.ok(text.includes('切り出しを検討する。'), `語が割れている: ${text}`);
  assert.ok(text.includes('文の境界を見失う。'), `語が割れている: ${text}`);
  assert.ok(!/[ぁ-んァ-ヶ一-龥、。] [ぁ-んァ-ヶ一-龥、。]/u.test(text), `和文の中に空白が残っている: ${text}`);
});

test('欧文の行折り返しでは、これまでどおり継ぎ目に空白が入る', () => {
  const text = joined([
    en(100, 'We study sentence segmentation for papers whose body text is'),
    en(114, 'written in Japanese, and we report the error rate of the rule'),
    en(128, 'based segmenter on three different Japanese corpora.'),
  ]);

  assert.ok(text.includes('body text is written in Japanese'), `語が繋がってしまった: ${text}`);
  assert.ok(text.includes('the rule based segmenter'), `語が繋がってしまった: ${text}`);
});

test('和文と欧文の境目は、その文書が行の途中で空白を置いているかに合わせる', () => {
  // 空白を置く流儀（LaTeX の和文原稿でいちばん多い書き方）。
  // 行の途中に「たとえば attention や」と空白があるので、境目の折り返しでも空白が要る。
  const spaced = joined([
    ja(100, 'そうした論文では、術語だけが英語のまま残される。たとえば attention や'),
    ja(114, 'transformer といった語は、訳さずにそのまま使われることが普通である。'),
    ja(128, '英語の部分では空白が語の区切りになるが、日本語の部分では現れない。'),
  ]);
  assert.ok(
    spaced.includes('attention や transformer といった語'),
    `空白を置く流儀の文書で境目が詰まった: ${spaced}`,
  );

  // 空白を置かない流儀（xeCJK・LuaTeX-ja を使う原稿）。
  // 行の途中が「attention機構」と詰まっているので、境目の折り返しでも詰めるのが正しい。
  const tight = joined([
    ja(100, 'そうした論文では、術語だけが英語のまま残される。たとえばattention機'),
    ja(114, '構やtransformer系の模型はそのまま表記され、和文と欧文の間に空白は無い。'),
    ja(128, '空白を手掛かりに語を区切る解析器は、この版面では必ず誤ってしまう。'),
  ]);
  assert.ok(
    tight.includes('たとえばattention機構やtransformer系'),
    `空白を置かない流儀の文書で境目に空白が入った: ${tight}`,
  );
});

test('和文と欧文が同じ文書にあっても、欧文の段落の折り返しは空白で繋がる', () => {
  // 和文誌の英文要旨。同じ文書の中で、和文は詰めて、欧文は空けて繋ぐ必要がある。
  const text = joined([
    en(100, 'This paper studies sentence segmentation for papers whose'),
    en(114, 'body text is written in Japanese, and reports the error rate.'),
    ja(140, '和文の学会誌では、本文を日本語で書き、術語だけを欧文のまま残すことが多'),
    ja(154, 'い。空白を手掛かりに語を区切る解析器は、この版面では必ず誤ってしまう。'),
  ]);

  assert.ok(text.includes('papers whose body text is written'), `欧文の継ぎ目が詰まった: ${text}`);
  assert.ok(text.includes('残すことが多い。'), `和文の継ぎ目に空白が入った: ${text}`);
});

test('和文の文字片の継ぎ目は、約物の詰めぶんの隙間では空白にならない', () => {
  // 句読点は半角ぶん空くので、文字片がそこで割れると 0.5em の隙間が開く。
  // 欧文と同じ閾値（字高の 0.22 倍）で見ると、ここが空白に化けて語が割れる。
  const text = joined([
    // 「、」の直後で文字片が割れ、0.5em ぶん空いている。
    { page: 1, text: '本稿では、', x: 68, y: 100, w: 50, h: 10 },
    { page: 1, text: '日本語の本文に英語の術語が混ざる論文を対象とする。', x: 123, y: 100, w: 250, h: 10 },
    ja(114, '既存の手法は空白で語を区切ることを前提としており、文の境界を見失う。'),
    ja(128, '我々は句点と括弧の対応を手掛かりとする単純な規則を提案し、評価した。'),
  ]);

  assert.ok(text.includes('本稿では、日本語の本文に'), `文字片の継ぎ目に空白が入った: ${text}`);
});

test('和文の行末では、行末ハイフンの処理が働かない', () => {
  // `\p{L}` は漢字・かなにも当たるので、守りを入れないと和文の行末で
  // ハイフンが「割れた語のしるし」と読まれ、黙って消える
  // （実測: 「ハイフン-」＋「結合子」→「ハイフン結合子」）。
  const text = joined([
    ja(100, 'この記号は、欧文の複合語をつなぐために使うもので、名前を ハイフン-'),
    ja(114, '結合子と呼ぶ。和文の行末では、語の途中で折り返しても記号は足されない。'),
    ja(128, '我々の実装は、継ぎ目の両側が和文であるときには何も足さず、何も消さない。'),
  ]);

  assert.match(text, /ハイフン-\s?結合子/u, `和文の行末でハイフンが消えた: ${text}`);
});

test('欧文の行末ハイフンは、和文書体の U+2011 でも結合される', () => {
  // 和文書体（Noto Serif CJK JP など）で英文を組むと、行末のハイフンが
  // ASCII の '-' ではなく U+2011（non-breaking hyphen）として取り出される。
  // 和文誌の英文要旨でそのまま起きるので、ここを見ないと "pa‑ pers" が画面に残る。
  const text = joined([
    en(100, 'This paper studies sentence segmentation for scholarly pa‑'),
    en(114, 'pers whose body text is written in Japanese, and it reports'),
    en(128, 'the error rate of a rule based segmenter on three corpora.'),
  ]);

  assert.ok(text.includes('scholarly papers whose'), `行末ハイフンが残っている: ${text}`);
});

test('両端揃えの和文で字間に撒かれた空白（pdf.js の推測）を落とす', () => {
  // pdf.js は字送りが 0.102em を超えると、版面に空白が無くても空白文字を差し込む。
  // 両端揃えの和文は行の伸縮を字間に配るので、狭い段では 1 行の字間すべてが該当する。
  const text = joined([
    { page: 1, text: '和 文 の 学 会 誌 で は、 本 文 を 日 本 語 で 書 き、 術', x: 68, y: 100, w: 236, h: 10 },
    { page: 1, text: '語 だ け を 欧 文 の ま ま 残 す こ と が 多 い。 た と え', x: 68, y: 114, w: 236, h: 10 },
    ja(128, 'ば欧文の術語はそのまま表記され、和文と欧文の間に空白は入らない。'),
    ja(142, '空白を手掛かりに語を区切る解析器は、この版面では必ず誤ってしまう。'),
  ]);

  assert.ok(
    text.includes('和文の学会誌では、本文を日本語で書き、術語だけを欧文のまま残すことが多い。'),
    `字間の空白が残っている: ${text}`,
  );
});

test('和文の本物の空白（著者名や姓と名の区切り）は落とさない', () => {
  // 字間に撒かれた空白と違い、本物の空白は 1 行に 1〜2 個しか現れない。
  // 数と割合の両方で見ているので、ここは残る。
  const text = joined([
    ja(100, 'この規則は、佐藤 花子 と 鈴木 一郎 が二千二十一年に提案したものである。'),
    ja(114, '我々はその規則を、和文と欧文が混ざる版面へ広げることを目的としている。'),
    ja(128, '対象とするのは、学習データも辞書も用意できない場面に限られる。'),
  ]);

  assert.ok(text.includes('佐藤 花子 と 鈴木 一郎'), `本物の空白まで落ちた: ${text}`);
});

/**
 * 数式を含む本文の回帰テスト。
 *
 * どれも `scripts/real-papers/mathheavy.tex` が「この構文は書けない」と避けていた形。
 * ML・統計・物理の論文では普通の書き方なので、避けたままだと計測の網から漏れる。
 * 実測は pdflatex で組んだ標本（Computer Modern と Times の両方）で取った。
 */

/**
 * 数式まじりの 1 行。`x` は**実測値**（pdflatex + mathptmx の PDF から取った座標）を
 * そのまま使う。添字と上付きが重なる位置関係は、この値でしか再現しない。
 */
function measured(y: number, pieces: Array<[string, number, number, number?, number?]>): TextChunk[] {
  return pieces.map(([text, x, w, h, dy]) => ({
    page: 1,
    text,
    x,
    y: y + (dy ?? 0),
    w,
    h: h ?? 9.96,
  }));
}

test('行内の省略記号（. . .）を文の区切りに取らない', () => {
  // `$f_1,\dots,f_M$` は点の**間に細い空き**が入るので、PDF からは ". . ." で出てくる。
  // 連続した ".." だけを見ていた頃は、1 文が "… collection f1, ." と
  // ", fM of predictors …" に割れ、点だけの断片は黙って捨てられていた。
  const split = splitIntoSentences(
    'An ensemble is a collection f1, . . . , fM of predictors fit independently. The next sentence follows.',
  );
  assert.equal(split.length, 2, `文が余計に割れた: ${JSON.stringify(split)}`);
  assert.ok(split[0]!.includes('f1, . . . , fM of predictors'), `本文が欠けた: ${split[0]}`);
});

test('普通の文末の直後に文が続く形は、これまでどおり切れる', () => {
  // 省略記号の守りが広がりすぎて、普通の文が切れなくなっていないことの確認。
  const split = splitIntoSentences('This ends here. Next one starts. A third one closes.');
  assert.equal(split.length, 3, `文が切れなくなった: ${JSON.stringify(split)}`);
});

test('数式の一部の大文字を人名のイニシャルと取り違えない', () => {
  // 文末が `$v/M$.` の形。M の手前が '/' なので「文字ではない＝語の頭」と見なされ、
  // 次の文が SENTENCE_OPENERS に無い語で始まると 1 文に繋がっていた。
  const split = splitIntoSentences(
    'The true error is the squared bias norm plus the member term v/M. Solving for the scalar gives a distinct value.',
  );
  assert.equal(split.length, 2, `文が繋がった: ${JSON.stringify(split)}`);
});

test('人名のイニシャルは、これまでどおり文末にしない', () => {
  // 上の絞り込みで人名が巻き添えになっていないことの確認。
  assert.equal(
    splitIntoSentences('The lead author is J. Doe and the second is M. Tanaka.').length,
    1,
  );
  // 記号としての単一大文字は、次が文頭に立つ語なら文末。
  assert.equal(
    splitIntoSentences('We sweep the temperature T. The results are stable.').length,
    2,
  );
});

test('和文の閉じ括弧は、直前の文に含める', () => {
  // 終端記号の直後の閉じ括弧は前の文に付ける、という既存の規則が欧文の記号しか
  // 知らず、「これは正しい。」の「」」が**次の文の頭**に回っていた。
  //
  // 括弧の中の句点でそもそも切らない（対応を数える）のは別の話で、ここでは直していない。
  // 欧文の引用符 ("He said 'yes.' Then he left.") も同じ挙動なので、揃えてある。
  const split = splitIntoSentences('著者は「これは正しい。」と述べている。');
  assert.equal(split.length, 2, `文の数が変わった: ${JSON.stringify(split)}`);
  assert.equal(split[0], '著者は「これは正しい。」', `閉じ括弧が次の文へ流れた: ${JSON.stringify(split)}`);
  assert.equal(split[1], 'と述べている。');
});

test('添字と上付きを重ねた数式に、余計な空白が入らない', () => {
  // `$\beta_j^2$`。pdf.js は base の italic correction を空白文字として返すが、
  // その位置には下付きが重ねて組まれている。残すと "β j2" になる（pdftotext は "βj2"）。
  const text = joined([
    en(100, 'We first fix the notation that the rest of the argument uses.'),
    ...measured(112, [
      ['Suppose the shared biases have squared norms', 54.0, 202.81],
      [' ', 256.81, 2.69],
      ['β', 259.5, 5.47],
      [' ', 264.97, 1.22],
      ['j', 266.08, 2.05, 7.37, 5.3],
      ['2', 266.19, 3.69, 7.37, -1.0],
      [' ', 269.88, 6.05, 7.37, 5.3],
      ['under the two shifts.', 275.93, 90.0],
    ]),
    en(124, 'The two norms differ, and that is the whole of the obstruction.'),
  ]);

  assert.ok(text.includes('squared norms βj2 under'), `添字のまわりに空白が入った: ${text}`);
});

test('上付きだけの数式では、紙面どおりの空白を残す', () => {
  // `$f^\star$` は紙面でも "f ⋆" と空いて見える（pdftotext も同じ）。
  // 重なった添字が無いので、ここの空白を落としてはいけない。
  const text = joined([
    en(100, 'We first fix the notation that the rest of the argument uses.'),
    ...measured(112, [
      ['Each member decomposes into the Bayes predictor', 54.0, 200.0],
      [' ', 254.0, 3.3],
      ['f', 257.3, 4.88],
      [' ', 262.18, 1.07],
      ['⋆', 263.25, 4.08, 6.97, -0.6],
      [' ', 267.33, 2.7, 6.97, -0.6],
      ['and a shared bias term.', 270.03, 95.0],
    ]),
    en(124, 'The shared bias is what the ensemble spread never sees at all.'),
  ]);

  assert.ok(text.includes('predictor f ⋆ and a shared'), `紙面にある空白まで落ちた: ${text}`);
});

test('二項演算子の前後は、行が詰まっていても空白として読む', () => {
  // TeX の medmuskip は縮むので、詰めて組まれた行では隙間が 0.03em まで潰れ、
  // 隙間の閾値（字高の 0.22 倍）に届かない。同じ式が行によって
  // "f ⋆ + b + εm" にも "f ⋆ +b+εm" にもなっていた。
  const text = joined([
    en(100, 'We first fix the notation that the rest of the argument uses.'),
    ...measured(112, [
      ['Each member decomposes into the sum', 54.0, 160.0],
      [' ', 214.0, 3.3],
      ['f', 217.3, 4.88],
      [' ', 222.18, 0.83],
      ['⋆', 223.01, 4.08, 6.97, -0.6],
      [' ', 227.09, 0.83, 6.97, -0.6],
      // ここから先は、行を詰めたぶん medmuskip が潰れて隙間が 0.33pt しかない。
      ['+', 227.92, 7.75],
      ['b', 236.0, 4.28],
      ['+', 240.61, 7.75],
      ['ε', 248.69, 4.65],
      ['m', 253.34, 7.07, 6.97, 4.5],
      [' ', 260.41, 2.88, 6.97, 4.5],
      ['of three parts.', 263.29, 60.0],
    ]),
    en(124, 'The shared bias is what the ensemble spread never sees at all.'),
  ]);

  assert.ok(text.includes('the sum f ⋆ + b + εm of three parts.'), `演算子の前後が詰まった: ${text}`);
});

test('単項の負号には空白を入れない', () => {
  // 二項演算子の守りが広がりすぎて、"$-1$" の負号まで空けていないことの確認。
  const text = joined([
    en(100, 'We first fix the notation that the rest of the argument uses.'),
    ...measured(112, [
      ['The lower bound of the interval is', 54.0, 150.0],
      [' ', 204.0, 3.3],
      ['−', 207.3, 7.75],
      ['1', 215.38, 4.28],
      [' ', 219.66, 3.3],
      ['for every member of the family.', 222.96, 120.0],
    ]),
    en(124, 'The shared bias is what the ensemble spread never sees at all.'),
  ]);

  assert.ok(text.includes('interval is −1 for every'), `負号のあとに空白が入った: ${text}`);
});

/**
 * 計算量の回帰テスト。
 *
 * `joinLines` は塊（見出しで切れる本文のかたまり）の全文を 1 本の文字列に育てながら、
 * 行ごとに末尾を調べる。ここで**塊の全文**に正規表現を当てたり `slice` したりすると、
 * 1 行あたり O(それまでの全文字数) になり、塊全体では O(n²) になる。
 * 見出しは何十行かに 1 つしか無いので、長い原稿ほど 1 本の塊が文書全体まで育つ。
 * 実測（合成 PDF・2 段組）: 60 ページ 21.6 秒、120 ページ 87.9 秒、200 ページ 250 秒。
 * 入力 2 倍で 4 倍＝きれいな二乗だった。
 *
 * 時間そのものを閾値にすると機械の速さでぶれるので、**同じ行数を「1 つの塊」と
 * 「見出しで細かく切った塊」で組ませて比べる**。行数も文字片の数も同じなので、
 * 行の組み立て（layout.ts）にかかる時間は両方から同じだけ引かれて消える。
 * 残るのは「塊が長いこと自体の代償」だけ。二乗なら比が跳ね上がり、線形なら 1 に近づく。
 * 実測: 直す前 20.3 倍 → 直した後 1.1 倍。
 */

const BENCH_WORDS =
  'the ensemble variance under distribution shift never calibrates because a shared bias term remains fixed and the spread never sees it at all'.split(
    ' ',
  );

/**
 * 本文だけの版面を組み立てる。`headingEvery` を指定すると、その行数ごとに見出しを挟む
 * （＝塊がそこで切れる）。行数・文字片の数は挟んでも変わらない。
 */
function benchChunks(lines: number, headingEvery: number): { chunks: TextChunk[]; pages: PageSize[] } {
  const chunks: TextChunk[] = [];
  const out: PageSize[] = [];
  const perPage = 40;
  for (let i = 0; i < lines; i++) {
    const page = Math.floor(i / perPage) + 1;
    if (out.length < page) out.push({ page, width: 595, height: 842 });
    const y = 60 + (i % perPage) * 18;
    if (headingEvery > 0 && i % headingEvery === headingEvery - 1) {
      chunks.push({ page, text: `${Math.floor(i / headingEvery) + 1} Section Heading Here`, x: 68, y, w: 120, h: 14 });
      continue;
    }
    const words: string[] = [];
    for (let w = 0; w < 11; w++) words.push(BENCH_WORDS[(i * 7 + w) % BENCH_WORDS.length]!);
    // 3 行に 1 行は行末ハイフンで終わらせる（末尾の切り詰めを通す道）。
    words[words.length - 1] = i % 3 === 2 ? 'informa-' : `${words[words.length - 1]!}.`;
    let x = 68;
    for (const word of words) {
      const w = word.length * 4.6;
      chunks.push({ page, text: word, x, y, w, h: 10 });
      x += w + 2.4;
    }
  }
  return { chunks, pages: out };
}

/** 2 回まわして速いほうを採る（他のプロセスに邪魔された回を捨てるため）。 */
function fastest(chunks: TextChunk[], pages: PageSize[]): number {
  let best = Infinity;
  for (let run = 0; run < 2; run++) {
    const started = process.hrtime.bigint();
    buildSentencesFromChunks(chunks, pages);
    best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
  }
  return best;
}

test('見出しの無い長い塊でも、塊の長さに二乗で効かない', () => {
  const LINES = 1500;
  const single = benchChunks(LINES, 0);
  const split = benchChunks(LINES, 20);

  // 交互に測る。片方だけが冷えた状態で測られないように。
  const warm = fastest(split.chunks, split.pages);
  const one = fastest(single.chunks, single.pages);
  const many = Math.min(warm, fastest(split.chunks, split.pages));

  // 二乗だと、塊が 20 倍長いぶんそのまま効く（実測 20.3 倍）。線形なら 1 倍前後。
  assert.ok(
    one < many * 3,
    `塊を 1 つにしただけで ${(one / many).toFixed(1)} 倍に伸びた（1 つ: ${one.toFixed(0)}ms / 分割: ${many.toFixed(0)}ms）`,
  );
});

test('64 文字を超える複合語が行末で割れても、全文に当てたときと同じ結果になる', () => {
  // 行末ハイフンの照合は塊の末尾だけを切り出して当てている。切り出す窓は 64 文字から
  // 倍々に広げるので、窓より長い複合語でちゃんと広がることを固定しておく。
  const compound = 'extremely-long-hyphenated-compound-that-exceeds-the-initial-window-size-';
  assert.ok(compound.length > 64, '窓を広げる必要がある長さになっていない');

  const text = joined([
    en(100, 'We first fix the notation that the rest of the argument uses here.'),
    en(114, `The parameter is named ${compound}`),
    en(128, 'value in the configuration file that ships with the reference code.'),
    en(142, 'The shared bias is what the ensemble spread never sees at all here.'),
  ]);

  // 元からハイフンを含む複合語なので、ハイフンは残したまま直結する。
  assert.ok(text.includes(`${compound}value in the configuration`), `複合語の繋ぎ方が変わった: ${text}`);
});

/**
 * 壊れた入力で落ちない／遅くならないことの回帰テスト。
 *
 * どちらも「読める PDF なのに解析が失敗する（しかも画面には『PDF が壊れています』と出る）」
 * という形で見つかったもの。文末記号が 1 つも無い文書も、空白を含まない行が続く文書も、
 * 実際にある（OCR で句点が落ちた稿、終止符を使わない言語、本文と判定されたデータ列）。
 */

/** 終端記号を 1 つも含まない版面。1 行 54 字。 */
function noTerminatorChunks(lines: number): { chunks: TextChunk[]; pages: PageSize[] } {
  const chunks: TextChunk[] = [];
  const pages: PageSize[] = [];
  const line = 'ACGTGGCATTACGGTTACCGGATTACAGGCATTACGGTTACCGGATTACAGGCA';
  for (let i = 0; i < lines; i++) {
    const page = Math.floor(i / 45) + 1;
    if (pages.length < page) pages.push({ page, width: 612, height: 792 });
    chunks.push({ page, text: line, x: 54, y: 100 + (i % 45) * 14, w: 400, h: 10 });
  }
  return { chunks, pages };
}

test('文末記号が 1 つも無い長い文書でも、解析が落ちない', () => {
  // `Math.max(...covered.map(…))` はスプレッドで配列を引数に展開するので、文 1 つの
  // 文字数が引数の上限を超えると RangeError で落ちていた。実測では 1 行 54 字の PDF で
  // 2400 行（約 53 ページ）から落ち、画面には「PDF が壊れています」と出ていた。
  const { chunks, pages } = noTerminatorChunks(3000);
  const result = buildSentencesFromChunks(chunks, pages);
  assert.ok(result.sentences.length > 0, '文が 1 つも取れていない');
});

test('文末記号が無くても、1 枚のカードに収まらない巨大な文を作らない', () => {
  // 落ちなくなっても、18 万字の文が 1 枚のカードとして出てくると画面にも MCP にも渡せない
  // （対訳は 1 文ずつ、という前提そのものが崩れる）。上限で割る。
  const { chunks, pages } = noTerminatorChunks(3000);
  const { sentences } = buildSentencesFromChunks(chunks, pages);

  const longest = Math.max(...sentences.map((s) => s.text.length));
  assert.ok(longest <= 4_000, `1 文が ${longest} 字ある（上限 4,000 字）`);
  // 割っただけで、文字は 1 つも落としていないこと。
  const joinedLength = sentences.reduce((sum, s) => sum + s.text.length, 0);
  assert.ok(joinedLength > 3000 * 50, `本文が失われている（${joinedLength} 字しか残っていない）`);
  // ハイライトの矩形も文ごとに収まっていること。
  const widest = Math.max(...sentences.map((s) => s.rects.length));
  assert.ok(widest <= 200, `1 文の矩形が ${widest} 個ある`);
});

/** 空白を含まない「欧字とハイフンだけ」の行。行末もハイフンで終わる。 */
function hyphenOnlyChunks(lines: number): { chunks: TextChunk[]; pages: PageSize[] } {
  const chunks: TextChunk[] = [];
  const pages: PageSize[] = [];
  const text = `${'alpha-beta-gamma-delta-epsilon-zeta-eta-theta-iota-kappa'.slice(0, 59)}-`;
  for (let i = 0; i < lines; i++) {
    const page = Math.floor(i / 45) + 1;
    if (pages.length < page) pages.push({ page, width: 612, height: 792 });
    chunks.push({ page, text, x: 54, y: 100 + (i % 45) * 14, w: text.length * 4.5, h: 10 });
  }
  return { chunks, pages };
}

/** 同じ文字数の普通の散文（こちらは線形と分かっているので、物差しに使う）。 */
function proseChunks(lines: number): { chunks: TextChunk[]; pages: PageSize[] } {
  const words = 'the ensemble variance under distribution shift never calibrates because a shared bias term remains fixed and'.split(' ');
  const chunks: TextChunk[] = [];
  const pages: PageSize[] = [];
  for (let i = 0; i < lines; i++) {
    const page = Math.floor(i / 45) + 1;
    if (pages.length < page) pages.push({ page, width: 612, height: 792 });
    const picked: string[] = [];
    let n = 0;
    for (let w = 0; n < 52; w++) {
      const word = words[(i * 7 + w) % words.length]!;
      picked.push(word);
      n += word.length + 1;
    }
    const text = `${picked.join(' ')} informa-`;
    chunks.push({ page, text, x: 54, y: 100 + (i % 45) * 14, w: text.length * 4.5, h: 10 });
  }
  return { chunks, pages };
}

test('ハイフンだらけの入力でも、塊の長さに二乗で効かない', () => {
  // 行末ハイフンで繋ぐたびに継ぎ目の空白が消えるので、空白を含まない行が続くと
  // 「欧字とハイフンの並び」が行をまたいで伸び続ける。窓を無制限に広げていた頃は、
  // その並びが塊全体まで育って二乗が戻っていた（実測 10 万字 4.4 秒、80 万字 275 秒）。
  //
  // 時間の絶対値はぶれるので、**同じ文字数の散文**を物差しにする。散文の側は線形と
  // 分かっているので、比が跳ね上がったらハイフン側だけが二乗に戻ったということ。
  const LINES = 1700; // 約 10 万字
  const hy = hyphenOnlyChunks(LINES);
  const pr = proseChunks(LINES);

  const run = (input: { chunks: TextChunk[]; pages: PageSize[] }): number => {
    let best = Infinity;
    for (let i = 0; i < 2; i++) {
      const started = process.hrtime.bigint();
      buildSentencesFromChunks(input.chunks, input.pages);
      best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
    }
    return best;
  };
  run(pr); // 先に一度回して暖めておく
  const prose = run(pr);
  const hyphen = run(hy);

  // 実測: 直す前 26 倍 → 直した後 1.5 倍。
  assert.ok(
    hyphen < prose * 4,
    `ハイフンだらけの入力だけが ${(hyphen / prose).toFixed(1)} 倍遅い（ハイフン: ${hyphen.toFixed(0)}ms / 散文: ${prose.toFixed(0)}ms）`,
  );
});

/**
 * 継ぎ目の印の回帰テスト。
 *
 * 印には**対称形**がある。断片は落ちるとは限らない:
 *   - 落ちた断片 … 本文から消える。落とした行との矩形の比較で拾う。
 *   - 移動した断片 … 隣の本文行に押し込まれ、そのまま文の一部になる。落ちていないので
 *     落とした行しか見ない実装には**永遠に映らない**。
 * 実測（レビュアーの 136 文）では欠落 5 件に対し移動 6 件で、移動のほうが多かった。
 */

const SEAM_PAGE: PageSize = { page: 1, width: 612, height: 792 };

test('隣の本文行に押し込まれた断片を抱えた文に、継ぎ目の印が付く', () => {
  // インライン `\frac` の分母や添字は、落ちずに隣の本文行へ入ることが多い
  // （実測: `The constant 1/4 is not t 4 optimised.` の 4 と t）。
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 14; i++) {
    chunks.push({ page: 1, text: `The constant is not optimised in line ${i} of this page.`, x: 50, y: 100 + i * 13, w: 250, h: 9.96 });
  }
  // 行と行の間に押し込まれた断片。段の左端に来るので字下げも無く、**本文の行として残る**。
  chunks.push({ page: 1, text: '4', x: 51, y: 106.5, w: 5, h: 8.91 });

  const { sentences } = buildSentencesFromChunks(chunks, [SEAM_PAGE]);
  const holder = sentences.find((s) => s.text.startsWith('4 '));
  assert.ok(holder !== undefined, `断片を抱えた文が見つからない: ${sentences.map((s) => s.text.slice(0, 20)).join(' / ')}`);
  assert.ok(holder.seam !== undefined, '移動した断片を抱えた文に印が付いていない');
  // 断片が 1 文字だと、文中のどこに・どういう関係で入るかが分からない。
  // 「抜けたのはここ: 4」と出しても読む側には何も渡せないので、本文は渡さず
  // 印と矩形だけ残す（「無いことが分かる」のと「継ぎ直せる」は別の話）。
  assert.equal(holder.seam.texts, undefined, `継ぎ直せない断片が本文として渡っている: ${JSON.stringify(holder.seam.texts)}`);
  assert.equal(holder.seam.rects.length, 1, '抜けている場所を指す矩形が無い');
  // 他の文には付かないこと（誤爆 0 が絶対条件）。
  assert.equal(sentences.filter((s) => s.seam !== undefined).length, 1, '印が余計な文にも付いた');
});

test('段落の途中に表が挟まっただけの文には、継ぎ目の印を付けない', () => {
  // こちらは本文が欠けていない。表の手前の行が**段の右端まで届いている**ことで、
  // 「段落がそこで切れた」形（別行立てが文の続きを持っている）と見分ける。
  const chunks: TextChunk[] = [];
  const closed = 'The ensemble variance under distribution shift never calibrates at all here.';
  const open = 'The ensemble variance under distribution shift never calibrates and so';
  for (let i = 0; i < 5; i++) chunks.push({ page: 1, text: closed, x: 50, y: 100 + i * 14, w: 400, h: 10 });
  chunks.push({ page: 1, text: open, x: 50, y: 170, w: 400, h: 10 });
  chunks.push({ page: 1, text: '16 12.4 88.9', x: 150, y: 190, w: 80, h: 10 });
  chunks.push({ page: 1, text: '64 1.9 88.7', x: 150, y: 204, w: 80, h: 10 });
  chunks.push({ page: 1, text: '256 0.4 85.1', x: 150, y: 218, w: 80, h: 10 });
  for (let i = 0; i < 6; i++) chunks.push({ page: 1, text: closed, x: 50, y: 240 + i * 14, w: 400, h: 10 });

  const { sentences } = buildSentencesFromChunks(chunks, [SEAM_PAGE]);
  const marked = sentences.filter((s) => s.seam !== undefined);
  assert.equal(marked.length, 0, `割り込んだだけの表で印が付いた: ${marked.map((s) => s.text.slice(0, 40)).join(' / ')}`);
});

test('1 行を 2 文が共有していても、すれ違っただけの別行立てには印が付かない', () => {
  // 規則 1 は矩形の重なりで見るが、重なり量の下限が無く、比べる相手も**行の帯**だった。
  // そのため、行の右半分に**すれ違っただけ**の式が、その行の左半分の文にも印を付けていた。
  // すれ違いの大きさは実測に合わせてある（theorem-display で発火していたのは 0.03pt）。
  // 縦は帯、横は文の矩形で見て、どちらにも下限を置く。
  const chunks: TextChunk[] = [];
  const body = [
    'We first fix the notation that the rest of the argument uses in full here.',
    'The estimator that we analyse in this section is defined over the sample.',
    'Alpha runs all the way to the end of this line. Beta starts here and runs on.',
    'The shared bias term is what the ensemble spread never sees at all in practice.',
    'Any procedure whose members share a systematic error has the same obstruction.',
  ];
  const ys = [100, 116, 132, 168, 184];
  body.forEach((text, i) => chunks.push({ page: 1, text, x: 54, y: ys[i]!, w: 400, h: 10 }));
  // 3 行目（y=132..142）の右半分に、0.03pt だけ重なる別行立ての式。
  chunks.push({ page: 1, text: 'x2 + y2 = z2', x: 260, y: 141.97, w: 70, h: 9 });
  chunks.push({ page: 1, text: '(2)', x: 420, y: 141.97, w: 20, h: 9 });

  const { sentences } = buildSentencesFromChunks(chunks, [SEAM_PAGE]);
  const marked = sentences.filter((s) => s.seam !== undefined).map((s) => s.text);
  assert.deepEqual(marked, [], `すれ違っただけで印が付いた: ${marked.join(' / ')}`);
});

/**
 * 和文の「，．」表記の回帰テスト。
 *
 * 情報処理学会・電子情報通信学会の標準表記で、和文論文の相当な割合がこれ。
 * 全角のピリオドが文末記号に入っていなかった頃は、**節まるごとが 1 文**になり
 * （実測: 3,648 字・矩形 96 個のカードが 1 枚、画面には「0 / 1 文」）、
 * さらに長すぎる文の上限が発火して `…到達可能な処` / `理速度の…` と語の途中で切れていた。
 */

test('和文の全角ピリオド（．）で文が切れる', () => {
  const split = splitIntoSentences(
    '本論文では疎な注意機構の核について論じる．実験では，塊の大きさと処理速度の釣り合いを測った．' +
      '提案手法は精度を保ったまま遅延を削減できることを示す．',
  );
  assert.equal(split.length, 3, `文が切れていない: ${JSON.stringify(split)}`);
  assert.equal(split[0], '本論文では疎な注意機構の核について論じる．');
  // 全角の読点（，）では切らない。文は終わっていない。
  assert.ok(split[1]!.includes('実験では，塊の大きさ'), `読点で切れた: ${split[1]}`);
});

test('数字に挟まれた全角ピリオドは、小数点として扱う', () => {
  // 「０．５」「２．１ 提案手法」。節番号と小数のどちらもこの形になる。
  const split = splitIntoSentences('測定値は０．５であった．２．１ 節で述べた条件を使う．');
  assert.equal(split.length, 2, `小数点で切れた: ${JSON.stringify(split)}`);
  assert.ok(split[0]!.includes('０．５'), `小数が割れた: ${split[0]}`);
});

test('欧文の小数点と略語は、全角の対応を足しても従来どおり', () => {
  // 半角と全角は別の文字なので、ここには一切触れていないことの確認。
  assert.equal(splitIntoSentences('The value is 1.5 in every run. The next sentence follows.').length, 2);
  assert.equal(splitIntoSentences('We report this in Fig. 2 of the appendix.').length, 1);
});

test('句点の無い和文を上限で割るとき、語の途中では切らない', () => {
  // 和文には語間の空白が無いので、空白だけを探すと必ず語の途中で切れる。
  // 読点・約物の直後と、和文と欧文の境目でなら切ってよい。
  const clause = '実験では固定の記憶容量の下で塊の大きさと到達可能な処理速度の釣り合いを測り、';
  const text = clause.repeat(200); // 上限の 4,000 字をはるかに超える。終端記号は 1 つも無い
  const split = splitIntoSentences(text);
  assert.ok(split.length > 1, '上限で割られていない');
  for (const piece of split.slice(0, -1)) {
    assert.ok(piece.endsWith('、'), `語の途中で切れた: …${piece.slice(-12)}`);
  }
  assert.equal(split.join(''), text.replace(/、$/, '、'), '割っただけのはずが字面が変わった');
});

test('継ぎ直せない断片や空白だけの断片は、印の本文に入れない', () => {
  // 行番号つきのコードでは、空白だけの文字片が空文字列として残り、画面には
  // 「抜けたのはここ: … / / out = out_proj ( out ) / /」と区切りだけが並んでいた。
  const chunks: TextChunk[] = [];
  for (let i = 0; i < 9; i++) {
    chunks.push({ page: 1, text: `The constant is not optimised in line ${i} of this page.`, x: 50, y: 100 + i * 13, w: 250, h: 9.96 });
  }
  // 文末で閉じない行。ここから次の段落の頭まで、1 文が擬似コードをまたぐ。
  chunks.push({ page: 1, text: 'The listing below shows how the projection is', x: 50, y: 217, w: 250, h: 9.96 });
  // 落ちる擬似コード。読める行のあいだに、空白だけの行が挟まっている。
  chunks.push({ page: 1, text: 'out = out_proj ( out )', x: 120, y: 236, w: 110, h: 8.5 });
  chunks.push({ page: 1, text: '   ', x: 120, y: 249, w: 110, h: 8.5 });
  chunks.push({ page: 1, text: 'return out', x: 120, y: 262, w: 60, h: 8.5 });
  for (let i = 0; i < 10; i++) {
    chunks.push({ page: 1, text: `The constant is not optimised in line ${i + 20} of this page.`, x: i === 0 ? 62 : 50, y: 280 + i * 13, w: 250, h: 9.96 });
  }

  const { sentences } = buildSentencesFromChunks(chunks, [SEAM_PAGE]);
  const holder = sentences.find((s) => s.text.startsWith('The listing below'));
  assert.ok(holder?.seam !== undefined, '擬似コードをまたいだ文に印が付いていない');
  assert.deepEqual(
    holder.seam.texts,
    ['out = out_proj ( out )', 'return out'],
    `空白だけの断片が本文に入っている: ${JSON.stringify(holder.seam.texts)}`,
  );
});
