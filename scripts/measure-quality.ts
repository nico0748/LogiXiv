/**
 * フォールバック解析（GROBID 無し）の品質を数値で出す。
 *
 * 単体テストは「この入力でこう壊れないこと」を固定するが、
 * 「実際の論文でどれくらい正しく読めているか」は測れない。
 * こちらは正解が分かっている論文風 PDF を作って突き合わせる。
 *
 *   npm run measure
 *
 * 閾値を下回ったら終了コード 1 を返すので、CI の門番にも使える。
 *
 * **測り方の約束**（以前ここを間違えて、何を壊しても 100% が出ていた）:
 *
 * 1. 正解は生成器が文単位で持つ。測定側で分割器に通し直さない。
 *    通し直すと分割器のバグがそのまま正解に写り、この指標では二度と検出できない。
 * 2. 重複を潰さない。同じ本文が 35 回出る論文で 34 回落としても、
 *    集合で数えると 100% に見える。
 * 3. 見えている文字列（sentence.text）も見る。正規化ハッシュだけで比べると、
 *    画面に "Sma- ller ones" と出ていても一致扱いになる。
 * 4. 取りこぼしだけでなく、余計に作った文も数える。
 * 5. 読み順も見る。段の左右が入れ替わっても、集合としては全部見つかる。
 * 6. 正規化ハッシュが一致しても**字面**が違えば別に数える。normalizeSentence は
 *    語中のハイフンを畳むので（`long-range` も `longrange` も同じハッシュになる）、
 *    再現率だけ見ていると「本来のハイフンを黙って消した」壊れ方が 100% のまま通る。
 */

import { normalizeSentence } from '../packages/core/src/index.ts';
import { parseWithPdfJs } from '../packages/server/src/fallback.ts';
import { makePaperPdf, type PaperSpec } from './make-paper-pdf.ts';

/** これを下回ったら失敗にする。段組を見ない実装では 2 段組が 30% まで落ちていた。 */
const MIN_RECALL = 0.9;
/** 読み順（正解の並びが解析結果の中でどれだけ順序を保っているか）。 */
const MIN_ORDER = 0.9;
/** 本文でないもの（柱・ノンブル・図表キャプション・数式・参考文献）の混入の上限。 */
const MAX_LEAKS = 1;
/** 正解に無い文を作りすぎていないか。取りこぼしと同じだけ害がある。 */
const MAX_SPURIOUS_RATIO = 0.05;
/** 画面に出る文字列にハイフネーションの残骸が混ざっている数の上限。 */
const MAX_HYPHEN_ARTEFACTS = 0;
/** 正規化すると一致するのに字面が違う文（＝原文を黙って書き換えた文）の上限。 */
const MAX_REWRITTEN = 0;

interface Result {
  label: string;
  recall: number;
  found: number;
  expected: number;
  /** 正解に無い文の数。 */
  spurious: number;
  order: number;
  leaks: number;
  hyphenated: number;
  /** 正規化すれば一致するのに、画面に出る字面が正解と違う文の数。 */
  rewritten: number;
  sentences: number;
  sections: number;
  ms: number;
}

/** 多重集合の一致数。同じ文が n 回出るなら n 回数える。 */
function multisetOverlap(expected: readonly string[], got: readonly string[]): number {
  const pool = new Map<string, number>();
  for (const item of got) pool.set(item, (pool.get(item) ?? 0) + 1);
  let found = 0;
  for (const item of expected) {
    const left = pool.get(item) ?? 0;
    if (left > 0) {
      pool.set(item, left - 1);
      found++;
    }
  }
  return found;
}

/**
 * 読み順の score。正解の並びのうち、解析結果の中でも同じ前後関係を保っている割合。
 * 最長増加部分列の長さ / 一致した文の数。
 */
function orderScore(expected: readonly string[], got: readonly string[]): number {
  const positions = new Map<string, number[]>();
  got.forEach((item, index) => {
    const list = positions.get(item);
    if (list) list.push(index);
    else positions.set(item, [index]);
  });

  const sequence: number[] = [];
  for (const item of expected) {
    const list = positions.get(item);
    if (list && list.length > 0) sequence.push(list.shift()!);
  }
  if (sequence.length === 0) return 1;

  // 最長増加部分列（同値は許さない＝厳密に増加）。
  const tails: number[] = [];
  for (const value of sequence) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (tails[mid]! < value) low = mid + 1;
      else high = mid;
    }
    tails[low] = value;
  }
  return tails.length / sequence.length;
}

async function measure(label: string, spec: PaperSpec): Promise<Result> {
  const paper = makePaperPdf(spec);
  const started = Date.now();
  const structure = await parseWithPdfJs(paper.pdf);
  const ms = Date.now() - started;

  const got = structure.sentences.map((s) => normalizeSentence(s.text));
  const expected = paper.expectedSentences.map(normalizeSentence);
  const found = multisetOverlap(expected, got);

  const nonBody = paper.expectedNonBody.map(normalizeSentence).filter((text) => text.length >= 3);
  const leaks = got.filter((g) => nonBody.some((n) => g.includes(n.slice(0, 20)))).length;

  // 画面に出る文字列の検査。行末ハイフンが残っていると "Sma- ller" のまま表示される。
  const hyphenated = structure.sentences.filter((s) => /\p{L}-\s+\p{L}/u.test(s.text)).length;

  // 字面そのものの照合。空白の詰め方だけ揃えて、ハイフンには触れずに比べる。
  // 正規化して一致した数との差が、「正規化すれば同じだが画面に出る字は違う」文の数。
  const flatten = (text: string): string => text.replace(/\s+/g, ' ').trim();
  const exact = multisetOverlap(paper.expectedSentences.map(flatten), structure.sentences.map((s) => flatten(s.text)));

  return {
    label,
    recall: expected.length === 0 ? 1 : found / expected.length,
    found,
    expected: expected.length,
    spurious: Math.max(0, got.length - found - leaks),
    order: orderScore(expected, got),
    leaks,
    hyphenated,
    rewritten: Math.max(0, found - exact),
    sentences: structure.sentences.length,
    sections: structure.sections.length,
    ms,
  };
}

const results = [
  await measure('1 段組 / 6 ページ', { pages: 6, columns: 1 }),
  await measure('2 段組 / 6 ページ', { pages: 6, columns: 2 }),
  await measure('2 段組 / 12 ページ', { pages: 12, columns: 2 }),
  await measure('3 段組 / 6 ページ', { pages: 6, columns: 3 }),
  await measure('2 段組 / 狭い柱間', { pages: 6, columns: 2, columnGap: 14 }),
  // `\documentclass[twocolumn]{article}` の既定（\columnsep = 10pt）。arXiv の
  // プレプリントは既定値のまま出すことが多いので、ここが落ちると実害が最も大きい。
  await measure('2 段組 / 既定の柱間 10pt', { pages: 6, columns: 2, columnGap: 10, justified: true }),
  // 表のセルと別行立て数式が本文の文の**途中**に挟まる形。
  await measure('本文中の表と数式', { pages: 6, columns: 2, inlineDisplay: true, justified: true }),
  // 本文が "… report every number in Table 3." と図表を参照し、折り返しで
  // `Table 3.` が行頭に来る形。論文では普通の書き方なので当たりやすい。
  await measure('本文が表を参照', { pages: 6, columns: 2, captionReference: true, justified: true }),
  await measure('2 段組 / 表題あり', { pages: 6, columns: 2, banner: true }),
  await measure('1 ページのみ', { pages: 1, columns: 2 }),
  await measure('紛らわしい言い回し', { pages: 6, columns: 2, pathological: true }),
  await measure('段抜きの図キャプション', { pages: 6, columns: 2, spanFigure: true }),
  // 文書内に 1 回しか出ない複合語が行末で割れる形。用例に頼った判定だとハイフンが落ちる。
  await measure('行末の複合語', { pages: 6, columns: 2, hyphenTraps: true }),
  // 1 行目が文末で終わるキャプション。終端記号だけで閉じると 2 文目が本文に混ざる。
  await measure('文末で折り返すキャプション', { pages: 6, columns: 2, splitCaption: true }),
];

console.log('レイアウト             再現率   読順  余分  混入  ハイフン  書換  文数  節  解析');
console.log('---------------------------------------------------------------------------------');
for (const r of results) {
  console.log(
    `${r.label.padEnd(20)} ${`${Math.round(r.recall * 100)}%`.padStart(5)} (${r.found}/${r.expected})  ` +
      `${`${Math.round(r.order * 100)}%`.padStart(4)} ` +
      `${String(r.spurious).padStart(4)} ${String(r.leaks).padStart(5)} ` +
      `${String(r.hyphenated).padStart(7)} ${String(r.rewritten).padStart(5)} ` +
      `${String(r.sentences).padStart(5)} ` +
      `${String(r.sections).padStart(3)} ${String(r.ms).padStart(6)}ms`,
  );
}

const failures = results.filter(
  (r) =>
    r.recall < MIN_RECALL ||
    r.order < MIN_ORDER ||
    r.leaks > MAX_LEAKS ||
    r.hyphenated > MAX_HYPHEN_ARTEFACTS ||
    r.rewritten > MAX_REWRITTEN ||
    r.spurious > Math.ceil(r.expected * MAX_SPURIOUS_RATIO),
);
if (failures.length > 0) {
  console.error(
    `\n品質が基準を下回りました（再現率 >= ${MIN_RECALL * 100}% / 読順 >= ${MIN_ORDER * 100}% / ` +
      `混入 <= ${MAX_LEAKS} / ハイフン残り <= ${MAX_HYPHEN_ARTEFACTS} / 書換 <= ${MAX_REWRITTEN} / ` +
      `余分 <= ${MAX_SPURIOUS_RATIO * 100}%）:\n` +
      failures
        .map(
          (f) =>
            `  ${f.label}: 再現率 ${Math.round(f.recall * 100)}% / 読順 ${Math.round(f.order * 100)}% / ` +
            `余分 ${f.spurious} / 混入 ${f.leaks} / ハイフン ${f.hyphenated} / 書換 ${f.rewritten}`,
        )
        .join('\n'),
  );
  process.exit(1);
}
console.log('\n基準を満たしています。');
