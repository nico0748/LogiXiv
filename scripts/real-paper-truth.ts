/**
 * pdflatex で組んだ「本物の論文」の正解（ground truth）を、**LaTeX ソースだけ**から作る。
 *
 * ここがこの測定のいちばん大事な約束ごと。PDF から取り出した結果を正解にしてはいけない
 * （解析器のバグがそのまま正解に写り、何を壊しても 100% が出る）。合成 PDF の
 * make-paper-pdf.ts が「自分が置いた座標」を正解にしていたのと同じ理由で、
 * ここも「自分が書いた原稿」を正解にする。
 *
 * 規約はひとつだけ:
 *
 *   本文の 1 文は `\s{...}` で 1 行に書く。
 *
 * `\s` は `\newcommand{\s}[1]{#1}` なので組版には影響しない。ソースの上から順に
 * 拾えば、それがそのまま「本文として、この順で取れてほしい文」になる。
 *
 * 本文で**ない**もの（柱・表題・著者・キャプション・参考文献・脚注）も、
 * 同じくソースから拾って `expectedNonBody` にする。解析結果にこれらが混ざっていたら
 * 混入として数えるため。
 *
 * `\s{...}` の中で使ってよい LaTeX は下の `toPlainText` が知っているものだけに絞る。
 * 知らない命令が残っていたら例外にする — 黙って `\ref` が消えた正解を作ると、
 * 「正解の方が間違っている」状態になり、測定そのものが嘘になる。
 */

export interface PaperTruth {
  /** 本文として、この順で取れてほしい文。1 要素 = 1 文。 */
  expectedSentences: string[];
  /** 本文として取れて**ほしくない**もの（柱・キャプション・参考文献・表題など）。 */
  expectedNonBody: string[];
}

/**
 * `source` の `open` 位置（`{`）から対応する `}` までの中身を返す。
 * 入れ子の `{}` を数える。`\texttt{...}` が引数に入るので、単純な正規表現では足りない。
 */
function braced(source: string, open: number): { body: string; end: number } | null {
  if (source[open] !== '{') return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '\\') {
      i++; // エスケープされた文字（\{ \} \%）は数に入れない
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { body: source.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** `\name{...}` を全部見つけて、引数の中身を順に返す。 */
function findAll(source: string, name: string): string[] {
  const out: string[] = [];
  const marker = `\\${name}`;
  let at = 0;
  while (true) {
    const found = source.indexOf(marker, at);
    if (found === -1) break;
    // `\s` が `\section` に当たらないよう、直後が英字ならスキップする。
    const after = source[found + marker.length];
    if (after !== undefined && /[A-Za-z]/.test(after)) {
      at = found + marker.length;
      continue;
    }
    // `\fancyhead[L]{...}` のような省略可能引数は読み飛ばす。
    let cursor = found + marker.length;
    while (source[cursor] === ' ') cursor++;
    if (source[cursor] === '[') {
      const close = source.indexOf(']', cursor);
      cursor = close === -1 ? cursor : close + 1;
    }
    const body = braced(source, cursor);
    if (body === null) {
      at = found + marker.length;
      continue;
    }
    out.push(body.body);
    at = body.end;
  }
  return out;
}

/**
 * LaTeX の断片を、PDF に組まれたときの文字列に直す。
 *
 * ここが知らない命令は例外にする（後述）。だから原稿の側で使ってよい命令は、
 * 実質この関数が定義している。少ないほど正解が信用できる。
 */
function toPlainText(input: string, citeNumber: (key: string) => number): string {
  let text = input;

  // 文字装飾は中身だけ残す。入れ子があるので、変化しなくなるまで繰り返す。
  const wrappers = ['emph', 'textit', 'textbf', 'texttt', 'textsc', 'mathrm', 'text'];
  for (let guard = 0; guard < 10; guard++) {
    let changed = false;
    for (const name of wrappers) {
      const marker = `\\${name}{`;
      const at = text.indexOf(marker);
      if (at === -1) continue;
      const body = braced(text, at + marker.length - 1);
      if (body === null) continue;
      text = text.slice(0, at) + body.body + text.slice(body.end);
      changed = true;
    }
    if (!changed) break;
  }

  // 引用。LaTeX 既定の番号引用は "[1]"、複数なら "[1, 2]"。
  text = text.replace(/\\cite\{([^}]*)\}/g, (_all, keys: string) =>
    `[${keys.split(',').map((k) => citeNumber(k.trim())).join(', ')}]`);

  /**
   * `\m{組版する TeX}{PDF に出る字面}` … インライン数式。
   *
   * ML・統計・物理の論文は技術的な段落のほぼ全行にギリシャ文字か添字が入る。
   * 標本にそれが無いと、いちばん重い壊れ方（数式を含む本文行を丸ごと落とす）が
   * 計測の網から漏れる。かといって `$\beta_1$` から字面を機械的に導くのは無理なので、
   * **原稿の側に「紙面にはこう出る」と書いてもらう**。
   *
   * 第 2 引数は解析器の出力から写してはいけない（写すと解析器のバグが正解に写る）。
   * build-real-papers.ts が pdftotext（poppler。この道具とは独立した実装）で
   * 照合するので、食い違えば組版の時点で落ちる。
   */
  for (let guard = 0; guard < 200; guard++) {
    const at = text.indexOf('\\m{');
    if (at === -1) break;
    const first = braced(text, at + 2);
    if (first === null) break;
    const second = braced(text, first.end);
    if (second === null) throw new Error(`\\m{...}{...} の 2 つ目の引数がありません: ${input}`);
    text = text.slice(0, at) + second.body + text.slice(second.end);
  }

  // 単一の記号だけのインライン数式（$d$ など）。中身をそのまま出す。
  // 添字や上付きを含む形は PDF 上の字面が自明でないので、ここでは受け付けない。
  text = text.replace(/\$([A-Za-z0-9 ]+)\$/g, '$1');

  // 約物とエスケープ。
  text = text
    .replace(/\\thanks\{[^}]*\}/g, '')
    .replace(/\\footnote\{[^}]*\}/g, '')
    .replace(/\\footnotemark/g, '')
    .replace(/~/g, ' ')
    .replace(/\\%/g, '%')
    .replace(/\\&/g, '&')
    .replace(/\\_/g, '_')
    .replace(/\\\$/g, '$')
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/``/g, '“')
    .replace(/''/g, '”')
    .replace(/\\\\/g, ' ')
    .replace(/\\and\b/g, ' ')
    .replace(/\\,|\\ |\\;/g, ' ');

  const leftover = /\\[A-Za-z@]+/.exec(text);
  if (leftover !== null) {
    throw new Error(
      `正解に変換できない LaTeX 命令が残っています: ${leftover[0]}\n` +
        `  対象: ${input}\n` +
        '  この命令は scripts/real-paper-truth.ts の toPlainText が知りません。' +
        '原稿側で使わないようにするか、変換規則をここに足してください' +
        '（黙って落とすと「正解の方が間違っている」状態になります）。',
    );
  }

  return text.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

/** `\bibitem{key}` の並び順から引用番号を決める。LaTeX 自身と同じ規則。 */
function citeNumbers(source: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const match of source.matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^}]*)\}/g)) {
    const key = match[1]!.trim();
    if (!map.has(key)) map.set(key, map.size + 1);
  }
  return map;
}

/** 参考文献の各エントリの本文（`\bibitem` の次の行から、次の `\bibitem` まで）。 */
function bibliographyEntries(source: string, cite: (key: string) => number): string[] {
  const out: string[] = [];
  const lines = source.split('\n');
  let current: string[] | null = null;
  let number = 0;
  for (const line of lines) {
    const start = /^\s*\\bibitem(?:\[[^\]]*\])?\{/.test(line);
    if (start) {
      if (current !== null) out.push(current.join(' '));
      number++;
      current = [`[${number}]`];
      continue;
    }
    if (current === null) continue;
    if (/^\s*\\end\{thebibliography\}/.test(line)) {
      out.push(current.join(' '));
      current = null;
      continue;
    }
    if (line.trim().length > 0) current.push(line.trim());
  }
  if (current !== null) out.push(current.join(' '));
  return out.map((entry) => toPlainText(entry, cite));
}

/**
 * LaTeX ソースから正解を取り出す。
 *
 * コメント行（`%` で始まる行）は先に落とす。本文の説明をコメントで書いてあるので、
 * 拾うと正解が汚れる。
 */
export function extractTruth(source: string): PaperTruth {
  const stripped = source
    .split('\n')
    .map((line) => line.replace(/(^|[^\\])%.*$/, '$1'))
    .join('\n');

  const numbers = citeNumbers(stripped);
  const cite = (key: string): number => {
    const found = numbers.get(key);
    if (found === undefined) throw new Error(`\\cite{${key}} に対応する \\bibitem がありません`);
    return found;
  };

  // --- 本文 ---------------------------------------------------------------
  // `\s{...}` は 1 行 1 文で書く決まりなので、行単位で拾う。
  const expectedSentences: string[] = [];
  for (const line of stripped.split('\n')) {
    const at = line.indexOf('\\s{');
    if (at === -1) continue;
    const body = braced(line, at + 2);
    if (body === null) throw new Error(`\\s{...} が 1 行で閉じていません: ${line}`);
    const text = toPlainText(body.body, cite);
    if (text.length > 0) expectedSentences.push(text);
  }

  // --- 本文でないもの -----------------------------------------------------
  const expectedNonBody: string[] = [];
  const add = (text: string): void => {
    const plain = toPlainText(text, cite);
    if (plain.length > 0) expectedNonBody.push(plain);
  };

  for (const title of findAll(stripped, 'title')) add(title);
  // 著者ブロックは `\\` と `\and` で行に割れるので、行ごとに 1 件にする。
  for (const author of findAll(stripped, 'author')) {
    for (const part of author.split(/\\\\|\\and\b/)) add(part);
  }
  for (const caption of findAll(stripped, 'caption')) add(caption);
  for (const note of findAll(stripped, 'footnote')) add(note);
  for (const note of findAll(stripped, 'thanks')) add(note);
  for (const head of [...findAll(stripped, 'fancyhead'), ...findAll(stripped, 'fancyfoot')]) {
    if (/\\thepage/.test(head)) continue; // ノンブルは数字そのものなので照合に使えない
    add(head);
  }
  for (const entry of bibliographyEntries(stripped, cite)) expectedNonBody.push(entry);

  return { expectedSentences, expectedNonBody };
}
