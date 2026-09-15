/**
 * 「現実の論文らしい」PDF を組み立てる。解析品質の測定用。
 *
 * make-sample-pdf.ts は 1 段組の最小 PDF で、つなぎ目の確認にしか使えない。
 * こちらは学会論文の標準レイアウト（2 段組・ヘッダ・ページ番号・図キャプション・
 * 数式・脚注・参考文献）を再現し、**正解の文リストを一緒に返す**。
 * 正解が分かるので、解析結果を突き合わせて精度を数値で出せる。
 *
 * 依存は増やさない（clone 直後に走ることを優先）。フォントは標準の Helvetica。
 */

export interface PaperSpec {
  pages: number;
  /** 2 段組にするか。false なら 1 段組。columns を指定したときは無視される。 */
  twoColumn?: boolean;
  /** 段数。3 段組を測るために開けてある。 */
  columns?: number;
  /** 柱間の幅（pt）。学会テンプレートは 0.2in = 14.4pt 前後で、検出の限界に近い。 */
  columnGap?: number;
  /** 1 ページ目に段を跨ぐ表題・著者行を置く。 */
  banner?: boolean;
  /**
   * 表題を、**どの段にも跨がらない幅**でページの中央に置く。
   *
   * 段が細いほど中央寄せの表題は中の段にすっぽり収まる。幅だけで「段抜きか」を
   * 決めていると段抜きだと分からず、左の段を全部読み終えた後に表題が現れて
   * **本文の文の途中に刺さる**（実測、multicol の 3 段組）:
   *   `… which we determine independently Three Narrow Columns from inelastic …`
   */
  narrowBanner?: boolean;
  /** 誤分割しやすい言い回し（"温度 T." や "Ph.D." や "[12] Capital"）を混ぜる。 */
  pathological?: boolean;
  /**
   * 本文を両端揃えで組む（語間を伸ばして段の右端ちょうどで終わらせる）。
   * 段間の空白帯が柱間そのものになるので、狭い柱間の検出を実物どおりに測れる。
   */
  justified?: boolean;
  /** ページ中ほどに段抜きの図キャプションを置く（帯の読み順を測る）。 */
  spanFigure?: boolean;
  /** 行末で割れる複合語を仕込む（文書内に 1 回しか出ない形で置く）。 */
  hyphenTraps?: boolean;
  /** 1 行目が文末で終わる図キャプションを置く（2 文目が本文に混ざらないかを測る）。 */
  splitCaption?: boolean;
  /**
   * 本文が図表を参照する段落を置く。折り返しで `Table 3.` が**行頭**に来る形にする。
   *
   * 「本文で表や図を参照する」のは論文で普通の書き方なのに、行頭の `Table 3.` を
   * 図表キャプションと誤認して、その行から続く数行を丸ごと落としていた
   * （実測: pdflatex の 2 段組で 6 文が破壊、うち 1 文は完全に消失）。
   */
  captionReference?: boolean;
  /**
   * 本文の段落の**途中**に、中央寄せの表と別行立て数式を挟む。
   *
   * これまでの合成 PDF は表も数式も段落の切れ目に置いていたので、
   * 「文の途中に表のセルが差し込まれる」という実物の壊れ方を再現できていなかった
   * （実測: `Information retrieval benefits from ★Model Acc F1 …★ the same sparsity …`）。
   */
  inlineDisplay?: boolean;
}

export interface GeneratedPaper {
  pdf: Uint8Array;
  /**
   * 本文として正しく取れてほしい**文**（この順で並ぶのが理想）。
   *
   * ここは 1 要素 = 1 文。測定側で分割器に通し直してはいけない。
   * 通し直すと、分割器のバグがそのまま正解に写って永遠に 100% になる。
   */
  expectedSentences: string[];
  /** 本文として取れて**ほしくない**もの（ページ番号・図キャプション・参考文献など）。 */
  expectedNonBody: string[];
}

interface Placed {
  text: string;
  x: number;
  y: number; // 左下原点（PDF 座標）
  size: number;
}

/**
 * 本文の型。`n` を差し込んで**一文ずつ異なる文**にする。
 *
 * 同じ文を使い回すと、正規化ハッシュが同じになって注釈が共有され、
 * 「543 文あるのに異なり文は 14 個」という状態になる。そうなると
 * どこか 1 箇所が壊れても別の出現に隠れて、測定が意味を失う。
 */
/** 1 段落 = 文の配列。**正解はここに書いた通りの区切り**で、分割器には通さない。 */
const BODY_TEMPLATES: ((n: number) => string[])[] = [
  (n) => [`Sparse attention reduces the quadratic cost of self-attention in setting ${n}.`],
  (n) => [`We evaluate configuration ${n} on the test.`, 'We then report results in Table 1.'],
  (n) => [`Our block-sparse kernel outperforms the dense baseline by ${n} points overall.`],
  (n) => [`Prior work by Smith et al. introduced a related decomposition in run ${n}.`],
  (n) => [`We report ${n}.14 as the reference value for every experiment in this block.`],
  (n) => [`The state-of-the-art model uses a hierarchical routing scheme with ${n} levels.`],
  (n) => ['We call this variant method X.', `It converges faster than baseline ${n} does.`],
  (n) => [`Does the improvement hold at scale ${n}?`, 'Yes, it holds up to 32k tokens.'],
  (n) => [`Information retrieval benefits from the same sparsity pattern at depth ${n}.`],
  (n) => [`Large systems benefit most from stage ${n}.`, 'Smaller ones see little change.'],
];

/**
 * 誤分割しやすい言い回し。実際の論文に普通に出るのに、素朴な分割器が必ず外す形。
 * 「1 文字の大文字 + ピリオド」「頭字語」「行頭の [12] や (1)」。
 */
const PATHOLOGICAL: ((n: number) => string[])[] = [
  (n) => [`We sweep the temperature T.`, `The results are stable across seed ${n}.`],
  (n) => [`The Ph.D. thesis of Roe covers case ${n}.`, 'We reuse its notation throughout.'],
  (n) => [`The U.S. government funded experiment ${n}.`, 'No other sponsor was involved.'],
  (n) => [`We denote the rank by R.`, `Our method uses it at layer ${n}.`],
  // 箇条書きの中身も 1 文ずつ違えておく。同じ本文が段の端に何度も出ると、
  // 柱の除去（同じ行が複数ページに出たら付物）に巻き込まれ、測っている対象が
  // すり替わってしまう。
  (n) => [
    `Our contributions are as follows for release ${n}.`,
    `(1) We introduce a new block-sparse kernel for GPUs in case ${n}.`,
    `(2) We prove a bound on the approximation error of ${n} percent.`,
    `(3) We release code and trained model checkpoints for run ${n}.`,
  ],
  (n) => [
    `Sparse attention has been studied before, most notably in line ${n}.`,
    `[12] Recent work extends it to long documents in setting ${n} without loss.`,
  ],
];

/**
 * 行末で割れる語の仕掛け。`keep` が true なら本来ハイフンを含む複合語で、
 * 行末で割れてもハイフンが残らなければならない。false は音節で割れた 1 語で、
 * ハイフンごと落として繋がなければならない。
 *
 * ここに置く複合語は**文書内でこの 1 回しか出さない**。行中に用例があると
 * 「文書内に用例があれば残す」という既存の手掛かりだけで通ってしまい、
 * 語形の判定が壊れても測定に出ない（実際、実物の論文で `straight-through` は
 * たまたま用例があって無事、`long-range` は用例が無く `longrange` になっていた）。
 */
const HYPHEN_TRAPS: { left: string; right: string; keep: boolean }[] = [
  { left: 'long', right: 'range', keep: true },
  { left: 'straight', right: 'through', keep: true },
  { left: 'well', right: 'known', keep: true },
  { left: 'sparsi', right: 'fication', keep: false },
  { left: 'differen', right: 'tiable', keep: false },
];

const NON_BODY = [
  'Figure 1: Overview of the proposed pipeline.',
  'Table 1: Accuracy on the held-out split.',
  'y = softmax(QK^T / sqrt(d)) V',
];

/**
 * 本文の段落の途中に挟む、別行立ての表と数式。
 *
 * 表はセルごとに独立した文字片として置く（実際の PDF もそうなる）。
 * 数式は `looksLikeFormula` の英字比率 0.6 の門をわざと通り抜ける形にしてある —
 * 実物の pdflatex 出力でも `y = softmax(QK⊤/ d)V` は 0.63 で通り抜けており、
 * 文字だけを見る判定では落とせないことがここの要点。
 */
const INLINE_TABLE_ROWS = [
  ['Model', 'Acc', 'F1'],
  ['Dense', '81.2', '79.4'],
  ['Ours', '88.7', '86.1'],
];
const INLINE_EQUATION = 'y = softmax(QK^T/d)V';

const REFERENCES = [
  '[1] J. Doe and A. Smith. Sparse transformers. In Proc. NeurIPS, 2024.',
  '[2] R. Roe. Efficient attention. Journal of ML, 12(3):45-67, 2025.',
];

/** 段 1 本ぶんの幅に収まる表題（narrowBanner 用）。 */
const NARROW_BANNER = ['Narrow Columns', 'C. Tester'];

const BANNER = [
  'Block Sparse Attention for Long Documents',
  'Jane Q. Doe, Alan R. Roe, and Mei Tanaka',
];

function escapePdfText(text: string): string {
  return text.replace(/[\\()]/g, (c) => `\\${c}`);
}

/**
 * Helvetica の字送り幅（1000 分率）。行を段幅いっぱいに詰めるのに要る。
 * 標準 14 書体なので PDF にフォントを埋め込まずに済み、依存も増えない。
 */
const HELVETICA_WIDTH = ((): Map<string, number> => {
  const table = new Map<string, number>();
  const put = (chars: string, width: number): void => {
    for (const ch of chars) table.set(ch, width);
  };
  put("'", 191);
  put('|', 260);
  put(' !.,/:;I[]\\ft', 278);
  put('()-`', 333);
  put('{}', 334);
  put('"', 355);
  put('*', 389);
  put('^', 469);
  put('ilj', 222);
  put('cksvxzJ', 500);
  put('0123456789#$_abdeghnopquL?', 556);
  put('+<=>~', 584);
  put('FTZ', 611);
  put('&ABEKSVXY', 667);
  put('CDHNRUw', 722);
  put('GOQ', 778);
  put('Mm', 833);
  put('%', 889);
  put('W', 944);
  put('@', 1015);
  return table;
})();

function helveticaWidth(text: string, size: number): number {
  let total = 0;
  for (const ch of text) total += HELVETICA_WIDTH.get(ch) ?? 556;
  return (total * size) / 1000;
}

/**
 * 字送り幅で折り返す。実際の論文は両端揃えなので、最終行以外はどれも段の右端に届く。
 * `wrap` は文字数で折り返すので、細い字ばかりの行と太い字ばかりの行で右端が
 * 10% 以上ずれ、組版には無い揺れが入る。「右端に届いた行か」を見る場面ではこちらを使う。
 */
function packByWidth(text: string, width: number, size: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const next = current.length === 0 ? word : `${current} ${word}`;
    if (current.length > 0 && helveticaWidth(next, size) > width) {
      lines.push(current);
      current = word;
      continue;
    }
    current = next;
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * 1 行に収まる幅で語を折り返す。行末でハイフネーションが起きるよう、
 * 長い語は意図的にハイフンで割る。
 */
function wrap(text: string, maxChars: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= maxChars) {
      current += ` ${word}`;
      continue;
    }
    // 残りが少なければ語をハイフンで割る（真のハイフネーション）。
    const room = maxChars - current.length - 1;
    if (room >= 4 && word.length >= 7 && /^[A-Za-z]+$/.test(word)) {
      lines.push(`${current} ${word.slice(0, room - 1)}-`);
      current = word.slice(room - 1);
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

export function makePaperPdf(spec: PaperSpec): GeneratedPaper {
  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 50;
  const columnGap = spec.columnGap ?? 20;
  const columns = spec.columns ?? (spec.twoColumn ? 2 : 1);
  const columnWidth = (pageWidth - margin * 2 - columnGap * (columns - 1)) / columns;
  const charsPerLine = Math.floor(columnWidth / 5.0); // Helvetica 10pt のおおよその幅
  const lineHeight = 13;
  const bodyTop = pageHeight - margin - 30;
  const bodyBottom = margin + 30;
  const linesPerColumn = Math.floor((bodyTop - bodyBottom) / lineHeight);

  const expectedSentences: string[] = [];
  const expectedNonBody: string[] = [];

  // --- 段組に配置する ---------------------------------------------------
  const placedByPage = new Map<number, Placed[]>();
  let page = 1;
  let column = 0;
  let line = 0;
  let placedLines = 0;
  // 表題を置くと 1 ページ目の段が短くなる。
  const bannerLines = spec.banner || spec.narrowBanner ? BANNER.length + 1 : 0;


  const linesIn = (atPage: number): number => linesPerColumn - (atPage === 1 ? bannerLines : 0);
  const topOf = (atPage: number): number => bodyTop - (atPage === 1 ? bannerLines * lineHeight : 0);

  /**
   * ページを横帯に割る。段抜きの図表があるページは、その行で帯が切れる。
   * 紙の上の読み順は「帯 → 段 → 行」なので、正解の並びもその順で積む。
   */
  const spanRow = (atPage: number): number | null =>
    spec.spanFigure && atPage === 2 ? Math.floor(linesIn(atPage) / 2) : null;
  const bandsOf = (atPage: number): { from: number; to: number }[] => {
    const cut = spanRow(atPage);
    if (cut === null) return [{ from: 0, to: linesIn(atPage) }];
    return [
      { from: 0, to: cut },
      { from: cut + 1, to: linesIn(atPage) },
    ];
  };
  let band = 0;

  /**
   * 1 行ぶんを置く。`parts` は同じ行に並ぶ断片で、`indent` は段の左端からの字下げ（pt）。
   * 中央寄せの表のセルや、右端にぶら下がる式番号を置くために要る。
   */
  const pushParts = (parts: { text: string; indent: number }[], size: number): void => {
    if (line >= bandsOf(page)[band]!.to) {
      column++;
      if (column >= columns) {
        column = 0;
        band++;
        if (band >= bandsOf(page).length) {
          page++;
          band = 0;
        }
      }
      line = bandsOf(page)[band]!.from;
    }
    const x = margin + column * (columnWidth + columnGap);
    const y = topOf(page) - line * lineHeight;
    const list = placedByPage.get(page) ?? [];
    for (const part of parts) list.push({ text: part.text, x: x + part.indent, y, size });
    placedByPage.set(page, list);
    line++;
    placedLines++;
  };

  const pushLine = (text: string, size: number): void => {
    pushParts([{ text, indent: 0 }], size);
  };

  /**
   * 1 行を**両端揃え**で置く（語間を伸ばして段の右端ちょうどで終わらせる）。
   *
   * 文字数で折り返すと行末が最大 10pt ほど余るので、段間の空白帯が
   * 「柱間 + 行末の余り」に見えてしまう。柱間 10pt の版を測りたいのに
   * 実質 20pt を測ることになり、狭い柱間の検出は測定の網から漏れる。
   * 実際の組版どおり右端まで届かせれば、空白帯の幅は柱間そのものになる。
   */
  const pushJustified = (text: string, size: number, stretch: boolean): void => {
    const words = text.split(' ').filter((word) => word.length > 0);
    if (words.length === 0) return;
    const natural = words.reduce((sum, word) => sum + helveticaWidth(word, size), 0);
    const normal = helveticaWidth(' ', size);
    const room = (columnWidth - natural) / Math.max(1, words.length - 1);
    // 語が 1 つしかない行や、伸ばす余地の無い行は自然な語間のまま置く。
    const space = stretch && words.length > 1 && room > normal ? room : normal;
    let cursor = 0;
    const parts = words.map((word) => {
      const part = { text: word, indent: cursor };
      cursor += helveticaWidth(word, size) + space;
      return part;
    });
    pushParts(parts, size);
  };

  /** 段落 1 つぶんの本文行を置く。両端揃えのときは最終行だけ伸ばさない。 */
  const pushParagraph = (text: string): void => {
    if (!spec.justified) {
      for (const wrapped of wrap(text, charsPerLine)) pushLine(wrapped, 10);
      return;
    }
    const packed = packByWidth(text, columnWidth, 10);
    packed.forEach((packedLine, index) => pushJustified(packedLine, 10, index < packed.length - 1));
  };

  /**
   * 要求されたページ数ぶんの**行**を実際に流し込む。
   * 「何ブロック作るか」で決めると、内容が少ないときに 1 ページに収まってしまい、
   *  ページをまたぐ挙動（柱の除去、段の送り）が測定できない。
   */
  const capacity = spec.pages * columns * linesPerColumn;
  const reserve = 8; // 参考文献のぶん
  const sectionTitles = ['1. Introduction', '2. Method', '3. Results', '4. Discussion', '5. Conclusion'];
  let block = 0;
  let sectionIndex = 0;

  /**
   * 1 段落を流し込む。正解には**段落ではなく文を 1 つずつ**積む。
   * 段落をそのまま積んで測定側で割り直すと、分割器のバグが正解に写ってしまう。
   */
  /** 箇条書きの項目は行頭から始まる（"[12]" や "(1)" が行頭に来る形を測るため）。 */
  const ENUMERATED = /^[[(]\d+[\])]/;

  const emit = (sentences: string[], kind: 'head' | 'body' | 'nonbody'): void => {
    if (kind === 'head') {
      pushLine(sentences.join(' '), 11);
      return;
    }
    // 箇条書きの項目だけは独立した行に置く。段落に混ぜてしまうと行頭に来ず、
    // 「行頭の [12] を参考文献と誤認して丸ごと捨てる」不具合を測れない。
    let run: string[] = [];
    const flush = (): void => {
      if (run.length === 0) return;
      pushParagraph(run.join(' '));
      run = [];
    };
    for (const sentence of sentences) {
      if (ENUMERATED.test(sentence)) {
        flush();
        pushParagraph(sentence);
      } else {
        run.push(sentence);
      }
      if (kind === 'body') expectedSentences.push(sentence);
      else expectedNonBody.push(sentence);
    }
    flush();
  };

  /**
   * 行末ハイフンの仕掛けを置く。折り返し任せだと割れる位置が運になるので、
   * 行はこちらで割って置く（`wrap` は語の途中でしか割らないため、
   * 複合語のハイフンを行末に持ってこられない）。
   */
  const emitHyphenTrap = (trap: (typeof HYPHEN_TRAPS)[number], n: number): void => {
    const head = `We compare the ${trap.left}-`;
    const tail = `${trap.right} variant against the dense baseline in run ${n}.`;
    // 正解は「人が紙面で読む通りの 1 文」。複合語ならハイフン付き、
    // 音節で割れた語ならハイフン無しで繋がった形。
    expectedSentences.push(`We compare the ${trap.left}${trap.keep ? '-' : ''}${tail}`);
    pushLine(head, 10);
    for (const wrapped of wrap(tail, charsPerLine)) pushLine(wrapped, 10);
  };

  /**
   * 1 行目がちょうど段の右端で文末になる図キャプションを置く。
   *
   * 実際の論文は両端揃えなので、折り返した行はどれも段の右端に届く。
   * ここも**字送り幅**で詰めて同じ状態を作る（文字数で詰めると、細い字ばかりの行と
   * 太い字ばかりの行で右端が 10% 以上ずれ、「右端に届いた行か」を見る解析側の
   * 判定に、実際の組版には無い揺れが入ってしまう）。
   */
  const emitSplitCaption = (): void => {
    // 短い語を並べておくと、語単位で詰めても右端の近くまで埋まる。
    // 段数を変えてもどこで切れても文として読める形にしてある。
    const pool = 'Figure 3: Block-sparse maps for the PubMed, arXiv and PMC sets of abstracts'.split(' ');
    let first = '';
    for (const word of pool) {
      const next = first.length === 0 ? word : `${first} ${word}`;
      if (helveticaWidth(`${next}.`, 10) > columnWidth) break;
      first = next;
    }
    first = first.replace(/,$/, '');
    // 続きは 2 文にしておく。1 文だけだと、塊が閉じてしまっても混入は 1 件で、
    // 表題ありの層で元から 1 件出ているぶんに紛れて門番をすり抜ける。
    const rest = ['Darker cells are retained across every head.', 'The mask is recomputed once per epoch.'];
    // 混入を文単位で数えられるよう、正解にも 1 文ずつ渡す。
    expectedNonBody.push(`${first}.`, ...rest);
    // 1 行目は上で段幅ちょうどまで詰めてあるので、折り返しは必ずピリオドの直後で起きる。
    for (const packed of packByWidth(`${first}. ${rest.join(' ')}`, columnWidth, 10)) pushLine(packed, 10);
  };

  /**
   * 文の**途中**に別行立ての表と数式を挟む。
   *
   * 正解は「紙面で人が読む 1 文」＝表や数式を飛ばして繋がった文。
   * 解析側が表のセルを本文として拾えば、この文は見つからず（再現率が落ち）、
   * セルを含む別の文が混入として数えられる。
   */
  const emitInlineDisplay = (n: number): void => {
    // --- 文の途中に表を挟む ---
    const head = `Information retrieval benefits from`;
    const tail = `the same sparsity pattern at every depth in run ${n}.`;
    expectedSentences.push(`${head} ${tail}`);
    pushLine(head, 10);
    // 表は段の中央に寄せる。セルの間隔は段幅から決める（段数を変えても崩れない）。
    const cellWidth = columnWidth * 0.18;
    const tableLeft = (columnWidth - cellWidth * 3) / 2;
    for (const row of INLINE_TABLE_ROWS) {
      pushParts(
        row.map((text, i) => ({ text, indent: tableLeft + i * cellWidth })),
        10,
      );
      expectedNonBody.push(row.join(' '));
    }
    for (const wrapped of wrap(tail, charsPerLine)) pushLine(wrapped, 10);

    // --- 文の途中に別行立て数式を挟む ---
    const before = `The attention weights of run ${n} are computed as`;
    const after = `where the query and key matrices are shared across every head in run ${n}.`;
    expectedSentences.push(`${before} ${after}`);
    pushLine(before, 10);
    // 数式は中央寄せ、式番号だけ段の右端にぶら下げる（実際の別行立て数式と同じ形）。
    const number = `(${(n % 9) + 1})`;
    pushParts(
      [
        { text: INLINE_EQUATION, indent: (columnWidth - helveticaWidth(INLINE_EQUATION, 10)) / 2 },
        { text: number, indent: columnWidth - helveticaWidth(number, 10) },
      ],
      10,
    );
    expectedNonBody.push(`${INLINE_EQUATION} ${number}`);
    for (const wrapped of wrap(after, charsPerLine)) pushLine(wrapped, 10);
  };

  /**
   * 本文が図表を参照する段落を置く。**行頭に `Table 3.` / `Figure 4.` が来る**形にする。
   *
   * 参照の手前の行は「文の途中で折り返しただけの行」なので、実際の組版どおり
   * 段の右端まで届いていなければならない。そこで語を段幅いっぱいまで詰め、
   * `Table 3.` がもうその行に入らなくなったところで打ち切る。こうすると
   * 折り返しが必ず参照の直前で起き、段数を変えても同じ状況が作れる。
   *
   * 語の取り方が段幅で決まるので、打ち切られた文は英語として少し不自然になる。
   * ここで測りたいのは版面の状況なので、それで構わない。
   */
  const emitCaptionReference = (n: number, kind: 'Table' | 'Figure'): void => {
    const pool =
      `We evaluate configuration ${n} on the held-out split and on the validation split, ` +
      `and we then report every single number that we measured in`;
    const reference = `${kind} ${n}.`;
    const headLines: string[] = [];
    let current = '';
    for (const word of pool.split(' ')) {
      const next = current.length === 0 ? word : `${current} ${word}`;
      if (helveticaWidth(next, 10) > columnWidth) {
        headLines.push(current);
        current = word;
      } else {
        current = next;
      }
      // この行にもう参照が入らないなら、折り返しはここで起きる。
      if (helveticaWidth(`${current} ${reference}`, 10) > columnWidth) break;
    }
    headLines.push(current);

    const rest = [
      `Our block-sparse kernel outperforms the dense baseline by ${n} points overall.`,
      `Smaller models see little change at scale ${n}.`,
    ];
    // 紙面で人が読む区切り。参照は手前の行から続く 1 文の末尾になる。
    expectedSentences.push(`${headLines.join(' ')} ${reference}`, ...rest);
    // 頭の行はどれも文の途中なので、両端揃えで右端まで届かせる。
    for (const headLine of headLines) pushJustified(headLine, 10, true);
    pushParagraph(`${reference} ${rest.join(' ')}`);
  };

  const paragraphs = spec.pathological ? [...BODY_TEMPLATES, ...PATHOLOGICAL] : BODY_TEMPLATES;
  let trapsDone = false;
  let splitCaptionDone = false;
  let inlineDisplays = 0;
  let captionReferences = 0;

  while (placedLines < capacity - reserve) {
    if (block % 3 === 0 && sectionIndex < sectionTitles.length) {
      emit([sectionTitles[sectionIndex]!], 'head');
      sectionIndex++;
    }
    for (let i = 0; i < 3; i++) {
      const index = block * 3 + i;
      emit(paragraphs[index % paragraphs.length]!(index), 'body');
      if (placedLines >= capacity - reserve) break;
    }
    if (spec.hyphenTraps && !trapsDone && block === 0) {
      trapsDone = true;
      HYPHEN_TRAPS.forEach((trap, index) => emitHyphenTrap(trap, index));
    }
    if (spec.splitCaption && !splitCaptionDone && block === 1) {
      splitCaptionDone = true;
      emitSplitCaption();
    }
    // 表と数式は 1 箇所だけだと、たまたまその段だけ壊れなかったときに測定が素通りする。
    // 段・ページをまたいで何度か置く。
    // 表と図の両方で測る。段・ページをまたいで何度か置く。
    if (spec.captionReference && captionReferences < 4 && block % 3 === 1) {
      emitCaptionReference(block, captionReferences % 2 === 0 ? 'Table' : 'Figure');
      captionReferences++;
    }
    if (spec.inlineDisplay && inlineDisplays < 3 && block % 4 === 1) {
      inlineDisplays++;
      emitInlineDisplay(block);
    }
    if (block % 3 === 2 && placedLines < capacity - reserve) {
      // 図・表・数式を順に回す。ここを固定の添字にしていたので、
      // キャプションが一度も PDF に置かれず、混入の判定が効いていなかった。
      emit([NON_BODY[(block / 3) % NON_BODY.length | 0]!], 'nonbody');
    }
    block++;
  }

  // 参考文献は最後に固めて置く。
  emit(['References'], 'head');
  for (const reference of REFERENCES) emit([reference], 'nonbody');

  // ヘッダとページ番号を全ページに足す。
  const totalPages = Math.max(page, 1);
  for (let p = 1; p <= totalPages; p++) {
    const list = placedByPage.get(p) ?? [];
    list.push({ text: 'Preprint. Under review.', x: margin, y: pageHeight - margin + 4, size: 8 });
    list.push({ text: String(p), x: pageWidth / 2, y: margin - 10, size: 9 });
    placedByPage.set(p, list);
    expectedNonBody.push(String(p));
  }
  expectedNonBody.push('Preprint. Under review.');

  // ページ中ほどの段抜きキャプション。上で空けておいた行にちょうど置く。
  if (spec.spanFigure && totalPages >= 2) {
    // 本当に段を跨ぐ幅にする。柱間に届かない幅だと、ただの段内キャプションになり
    // 「帯で読み順が変わる」ことを測れない。
    const caption =
      'Figure 2: A wide figure spanning both columns of the page, shown here with a caption that runs the full width.';
    const cut = Math.floor(linesIn(2) / 2);
    const list = placedByPage.get(2) ?? [];
    list.push({ text: caption, x: margin, y: topOf(2) - cut * lineHeight, size: 9 });
    placedByPage.set(2, list);
    expectedNonBody.push(caption);
  }

  /**
   * どの段にも跨がらない、中央寄せの表題。段の中に収まるので「幅」では見分けられない。
   * 紙の上ではページの頭にあるので、読み順は「どの段よりも上か」で決まる。
   */
  if (spec.narrowBanner) {
    const list = placedByPage.get(1) ?? [];
    // 段 1 本ぶんの幅に収まる短い表題にする。長い表題は段間をまたいでしまい、
    // 「幅では見分けられない」という測りたい状況にならない。
    NARROW_BANNER.forEach((text, index) => {
      const size = index === 0 ? 16 : 11;
      const x = (pageWidth - helveticaWidth(text, size)) / 2;
      list.push({ text, x, y: bodyTop - index * lineHeight, size });
    });
    placedByPage.set(1, list);
    for (const text of NARROW_BANNER) expectedNonBody.push(text);
  }

  // 段を跨ぐ表題と著者行。1 ページ目の段はそのぶん下から始まっている。
  if (spec.banner) {
    const list = placedByPage.get(1) ?? [];
    BANNER.forEach((text, index) => {
      list.push({ text, x: margin + 40, y: bodyTop - index * lineHeight, size: index === 0 ? 16 : 11 });
    });
    placedByPage.set(1, list);
    for (const text of BANNER) expectedNonBody.push(text);
  }

  // --- PDF を組む -------------------------------------------------------
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };
  add('placeholder-catalog');
  add('placeholder-pages');
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const pageIds: number[] = [];
  for (let p = 1; p <= totalPages; p++) {
    const items = placedByPage.get(p) ?? [];
    const parts = ['BT'];
    let lastSize = 0;
    for (const item of items) {
      if (item.size !== lastSize) {
        parts.push(`/F1 ${item.size} Tf`);
        lastSize = item.size;
      }
      parts.push(`1 0 0 1 ${item.x.toFixed(2)} ${item.y.toFixed(2)} Tm`);
      parts.push(`(${escapePdfText(item.text)}) Tj`);
    }
    parts.push('ET');
    const content = parts.join('\n');
    const contentId = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
          `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
  }

  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return {
    pdf: new Uint8Array(Buffer.from(pdf, 'latin1')),
    expectedSentences,
    expectedNonBody,
  };
}
