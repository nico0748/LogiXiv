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

const sources = readdirSync(papersDir).filter((name) => name.endsWith('.tex')).sort();
if (sources.length === 0) throw new Error(`${papersDir} に .tex がありません`);

const work = mkdtempSync(join(tmpdir(), 'logixiv-tex-'));
try {
  for (const source of sources) {
    const name = source.replace(/\.tex$/, '');
    const tex = readFileSync(join(papersDir, source), 'utf8');

    // 正解を先に作る。ここが失敗するなら PDF を組んでも意味がない。
    const truth = extractTruth(tex);
    if (truth.expectedSentences.length === 0) {
      throw new Error(`${source}: \\s{...} が 1 つもありません（正解が空になります）`);
    }

    mkdirSync(join(work, name), { recursive: true });
    copyFileSync(join(papersDir, source), join(work, name, source));
    // 相互参照（ノンブル・引用番号）を確定させるため 2 回通す。
    for (let pass = 0; pass < 2; pass++) {
      try {
        execFileSync('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', source], {
          cwd: join(work, name),
          stdio: 'pipe',
        });
      } catch (error) {
        const log = readFileSync(join(work, name, `${name}.log`), 'utf8');
        throw new Error(`${source} の組版に失敗しました:\n${log.slice(-2000)}`, { cause: error });
      }
    }

    copyFileSync(join(work, name, `${name}.pdf`), join(papersDir, `${name}.pdf`));
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
