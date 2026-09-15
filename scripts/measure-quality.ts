/**
 * フォールバック解析（GROBID 無し）の品質を数値で出す。
 *
 * 単体テストは「この入力でこう壊れないこと」を固定するが、
 * 「実際の論文でどれくらい正しく読めているか」は測れない。
 * こちらは正解が分かっている論文風 PDF を作って、再現率と混入率を出す。
 *
 *   npm run measure
 *
 * 閾値を下回ったら終了コード 1 を返すので、CI の門番にも使える。
 */

import { normalizeSentence, splitIntoSentences } from '../packages/core/src/index.ts';
import { parseWithPdfJs } from '../packages/server/src/fallback.ts';
import { makePaperPdf } from './make-paper-pdf.ts';

/** これを下回ったら失敗にする。段組を見ない実装では 2 段組が 30% まで落ちていた。 */
const MIN_RECALL = 0.9;
/** 本文でないもの（柱・ノンブル・図表キャプション・数式・参考文献）の混入の上限。 */
const MAX_LEAKS = 1;

interface Result {
  label: string;
  recall: number;
  found: number;
  expected: number;
  leaks: number;
  sentences: number;
  sections: number;
  ms: number;
}

async function measure(label: string, twoColumn: boolean, pages: number): Promise<Result> {
  const paper = makePaperPdf({ pages, twoColumn });
  const started = Date.now();
  const structure = await parseWithPdfJs(paper.pdf);
  const ms = Date.now() - started;

  const got = structure.sentences.map((s) => normalizeSentence(s.text));
  // 正解も同じ分割器に通す（"A. B." は 2 文になるのが正しい）。
  const expected = [...new Set(paper.expectedSentences.flatMap(splitIntoSentences).map(normalizeSentence))];
  const found = expected.filter((e) => got.includes(e)).length;

  const nonBody = paper.expectedNonBody.map(normalizeSentence);
  const leaks = got.filter((g) => nonBody.some((n) => g.includes(n.slice(0, 20)))).length;

  return {
    label,
    recall: expected.length === 0 ? 1 : found / expected.length,
    found,
    expected: expected.length,
    leaks,
    sentences: structure.sentences.length,
    sections: structure.sections.length,
    ms,
  };
}

const results = [
  await measure('1 段組 / 6 ページ', false, 6),
  await measure('2 段組 / 6 ページ', true, 6),
  await measure('2 段組 / 12 ページ', true, 12),
];

console.log('レイアウト             再現率   本文文数  節  混入  解析');
console.log('------------------------------------------------------------');
for (const r of results) {
  const recall = `${Math.round(r.recall * 100)}%`.padStart(5);
  console.log(
    `${r.label.padEnd(20)} ${recall} (${r.found}/${r.expected})  ` +
      `${String(r.sentences).padStart(4)}  ${String(r.sections).padStart(2)}  ` +
      `${String(r.leaks).padStart(3)}  ${String(r.ms).padStart(5)}ms`,
  );
}

const failures = results.filter((r) => r.recall < MIN_RECALL || r.leaks > MAX_LEAKS);
if (failures.length > 0) {
  console.error(
    `\n品質が基準を下回りました（再現率 >= ${MIN_RECALL * 100}%、混入 <= ${MAX_LEAKS}）:\n` +
      failures.map((f) => `  ${f.label}: 再現率 ${Math.round(f.recall * 100)}% / 混入 ${f.leaks}`).join('\n'),
  );
  process.exit(1);
}
console.log('\n基準を満たしています。');
