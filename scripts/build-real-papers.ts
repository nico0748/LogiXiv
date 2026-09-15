/**
 * `scripts/real-papers/*.tex` を pdflatex で組み、PDF と正解 JSON を書き出す。
 *
 *   node --experimental-strip-types scripts/build-real-papers.ts
 *
 * 出力（どちらもリポジトリに入れる）:
 *   scripts/real-papers/<name>.pdf         … 組み上がった PDF
 *   scripts/real-papers/<name>.truth.json  … .tex から取り出した正解
 *
 * PDF を commit するのは、`npm run measure` と CI に pdflatex を要求しないため。
 * TeX Live は数 GB あり、これを入れないと測れない道具は結局誰も測らなくなる。
 * .tex も一緒に置いてあるので、中身が怪しければこのスクリプトで組み直せる。
 *
 * PDF の大きさは Times（標準 14 書体）を使って抑えてある。フォントが埋め込まれないので、
 * Computer Modern のままだと 1 本 170KB のところが 90KB で済む。
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTruth } from './real-paper-truth.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const papersDir = join(here, 'real-papers');

/**
 * `real-papers/*.tex` と `real-papers/unrecoverable/*.tex` の両方を組む。
 *
 * `unrecoverable/` は「直せないと分かっている壊れ方」の標本。別の場所に置くのは、
 * 再現率 100% を求める門（measureRealPapers）と混ぜないため。
 */
const sources = [
  ...readdirSync(papersDir).filter((name) => name.endsWith('.tex')).map((name) => name),
  ...readdirSync(join(papersDir, 'unrecoverable'))
    .filter((name) => name.endsWith('.tex'))
    .map((name) => join('unrecoverable', name)),
].sort();
if (sources.length === 0) throw new Error(`${papersDir} に .tex がありません`);

const work = mkdtempSync(join(tmpdir(), 'logixiv-tex-'));
try {
  for (const source of sources) {
    const name = source.replace(/\.tex$/, '');
    mkdirSync(join(papersDir, name.includes('/') ? name.replace(/\/[^/]*$/, '') : '.'), { recursive: true });
    const tex = readFileSync(join(papersDir, source), 'utf8');

    // 正解を先に作る。ここが失敗するなら PDF を組んでも意味がない。
    const truth = extractTruth(tex);
    if (truth.expectedSentences.length === 0) {
      throw new Error(`${source}: \\s{...} が 1 つもありません（正解が空になります）`);
    }

    mkdirSync(join(work, name), { recursive: true });
    const file = `${name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name}.tex`;
    copyFileSync(join(papersDir, source), join(work, name, file));
    // 和文の原稿は `fontspec` で CJK 書体を指定するので xelatex でないと通らない。
    // 欧文はこれまでどおり pdflatex（速く、標準 14 書体なら書体を埋め込まない）。
    const engine = /\\usepackage(\[[^\]]*\])?\{fontspec\}/.test(tex) ? 'xelatex' : 'pdflatex';

    // 相互参照（ノンブル・引用番号）を確定させるため 2 回通す。
    for (let pass = 0; pass < 2; pass++) {
      try {
        execFileSync(engine, ['-interaction=nonstopmode', '-halt-on-error', file], {
          cwd: join(work, name),
          stdio: 'pipe',
        });
      } catch (error) {
        const log = readFileSync(join(work, name, file.replace(/\.tex$/, '.log')), 'utf8');
        throw new Error(`${source} の組版に失敗しました（${engine}）:\n${log.slice(-2000)}`, { cause: error });
      }
    }

    verifyInlineMath(tex, join(work, name, file.replace(/\.tex$/, '.pdf')), source);

    copyFileSync(join(work, name, file.replace(/\.tex$/, '.pdf')), join(papersDir, `${name}.pdf`));
    writeFileSync(join(papersDir, `${name}.truth.json`), `${JSON.stringify(truth, null, 2)}\n`, 'utf8');

    const bytes = readFileSync(join(papersDir, `${name}.pdf`)).byteLength;
    console.log(
      `${name}: 本文 ${truth.expectedSentences.length} 文 / 付物 ${truth.expectedNonBody.length} 件 / ` +
        `PDF ${Math.round(bytes / 1024)}KB`,
    );
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

/**
 * `\m{TeX}{PDF に出る字面}` の第 2 引数が本当かを、**この道具とは別の実装**で確かめる。
 *
 * ここが自己申告のままだと、書いた人が解析器の出力から写してしまう。そうなると
 * 「解析器のバグがそのまま正解に写る」という、この測定がいちばん避けたい状態になる。
 * poppler の pdftotext は独立した抽出器なので、審判として使える。
 * 空白の入り方は抽出器ごとに揺れるので、比較は空白を潰して行う（字面そのものを見る）。
 *
 * pdftotext が無い環境では確かめられないので、その旨を出して先へ進む
 * （組版そのものは pdflatex だけで完結するため、ここで止める理由はない）。
 */
function verifyInlineMath(tex: string, pdfPath: string, source: string): void {
  // コメント行は落とす。書き方の説明そのものに `\m{...}{...}` が出てくる。
  const body = tex
    .split('\n')
    .map((line) => line.replace(/(^|[^\\])%.*$/, '$1'))
    .join('\n');
  const expected: string[] = [];
  let at = 0;
  while (true) {
    const found = body.indexOf('\\m{', at);
    if (found === -1) break;
    const first = braced(body, found + 2);
    if (first === null) break;
    const second = braced(body, first.end);
    if (second === null) break;
    expected.push(second.body);
    at = second.end;
  }
  if (expected.length === 0) return;

  let extracted: string;
  try {
    extracted = execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' });
  } catch {
    console.log(`  ${source}: pdftotext が無いので、インライン数式の字面は確かめられませんでした`);
    return;
  }
  const squeezed = extracted.replace(/\s+/g, '');
  const missing = [...new Set(expected)].filter((text) => !squeezed.includes(text.replace(/\s+/g, '')));
  if (missing.length > 0) {
    throw new Error(
      `${source}: \\m{...}{...} の字面が PDF に見つかりません（pdftotext と食い違い）:\n` +
        missing.map((text) => `  ${JSON.stringify(text)}`).join('\n') +
        '\n  第 2 引数は「PDF に出る字面」です。解析器の出力からではなく、' +
        '組み上がった紙面から取ってください。',
    );
  }
}

/** `\m{...}{...}` を読むための括弧対応。real-paper-truth.ts のものと同じ規則。 */
function braced(source: string, open: number): { body: string; end: number } | null {
  if (source[open] !== '{') return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '\\') {
      i++;
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
