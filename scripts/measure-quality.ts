/**
 * フォールバック解析（GROBID 無し）の品質を数値で出す。
 *
 * 単体テストは「この入力でこう壊れないこと」を固定するが、
 * 「実際の論文でどれくらい正しく読めているか」は測れない。
 * こちらは正解が分かっている PDF を突き合わせる。入力は 2 系統ある:
 *
 *   - 合成 PDF（make-paper-pdf.ts）… 回帰の網。壊れ方を狙って作れる。
 *   - 実物の論文（scripts/real-papers/）… pdflatex / xelatex で組んだ本物。PDF と正解を
 *     リポジトリに入れてあるので、pdflatex が無い環境でも測れる。
 *     組み直しは `node --experimental-strip-types scripts/build-real-papers.ts`。
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
 * 7. **合成 PDF だけで満足しない。** 合成は自分で座標を置くので、自分が想定した
 *    壊れ方しか再現できない。実際に報告された崩れ（1 ページ目で左右の段が語単位に
 *    混ざる、付録が丸ごと参考文献になる、擬似コードの途中の行が題名になる）は、
 *    合成 14 シナリオが全部 100% のまま素通りしていた。実物を入れて初めて落ちた。
 *    実物の正解は .tex の `\s{...}` から機械的に作る（scripts/real-paper-truth.ts）。
 *    **PDF から取り出した結果を正解にしてはいけない** — それでは何も測れない。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSentence } from '../packages/core/src/index.ts';
import { parseWithPdfJs } from '../packages/server/src/fallback.ts';
import { makePaperPdf, type PaperSpec } from './make-paper-pdf.ts';
import type { PaperTruth } from './real-paper-truth.ts';

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
  /** core が自己申告した読み順の危うさ。high なら「怪しい」と自分で言えている。 */
  readingOrderRisk: 'low' | 'high';
  /**
   * 行になった文字のうち、行き先の説明が付いた割合（core の自己申告）。
   *
   * 読み順の申告は**生き残った本文行**しか見ないので、落とされた行は検出器の
   * 入力に一度も入らない。消去は原理的に検出できない。だから別の列で持つ。
   */
  coverage: number;
  coverageRisk: 'low' | 'high';
  /**
   * 「本文として採らなかった行と重なる位置で組み立てた」印が付いた文の数。
   *
   * 文書単位の申告（読順・採録）では足りない。正しく取れた文と、原文と内容が違う文が
   * 同じ顔で並ぶので、読む側は**どの文か**を知れない。
   */
  seams: number;
  /**
   * そのうち、**正解の本文そのもの**に付いてしまった数（＝誤爆）。
   * 1 件でも出れば印は信用されなくなるので、ここは 0 でなければならない。
   */
  seamFalseAlarms: number;
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

async function score(label: string, pdf: Uint8Array, paper: PaperTruth): Promise<Result> {
  const started = Date.now();
  const structure = await parseWithPdfJs(pdf);
  const ms = Date.now() - started;

  const got = structure.sentences.map((s) => normalizeSentence(s.text));
  const expected = paper.expectedSentences.map(normalizeSentence);
  const found = multisetOverlap(expected, got);

  const nonBody = paper.expectedNonBody.map(normalizeSentence).filter((text) => text.length >= 3);
  /**
   * 混入は「本文でないものが本文の文に混ざったか」。
   *
   * **正解の本文そのものは、何を含んでいても混入ではない。** 照合は
   * 「付物の先頭 20 文字を含むか」という緩い当たり方をするので、和文のように
   * 1 文字あたりの情報量が多い書記系では、付物の文字列そのものが本文に出てくる
   * （実測: 柱の `情報処理学会論文誌` が、本文の `三つのコーパスは情報処理学会論文誌、
   * 人工知能学会誌、…` に含まれて混入 1 件と数えられていた）。
   * この除外を入れないと、偽の混入が本物の混入 1 件ぶんの枠を食い潰す。
   */
  const wanted = new Set(expected);
  const leaks = got.filter((g) => !wanted.has(g) && nonBody.some((n) => g.includes(n.slice(0, 20)))).length;

  // 画面に出る文字列の検査。行末ハイフンが残っていると "Sma- ller" のまま表示される。
  const hyphenated = structure.sentences.filter((s) => /\p{L}-\s+\p{L}/u.test(s.text)).length;

  // 字面そのものの照合。空白の詰め方だけ揃えて、ハイフンには触れずに比べる。
  // 正規化して一致した数との差が、「正規化すれば同じだが画面に出る字は違う」文の数。
  const marked = structure.sentences.filter((sentence) => sentence.seam !== undefined).map((sentence) => normalizeSentence(sentence.text));

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
    readingOrderRisk: structure.quality?.readingOrderRisk ?? 'low',
    coverage: structure.quality?.coverage ?? 1,
    coverageRisk: structure.quality?.coverageRisk ?? 'low',
    seams: marked.length,
    seamFalseAlarms: marked.filter((text) => wanted.has(text)).length,
  };
}

async function measure(label: string, spec: PaperSpec): Promise<Result> {
  const paper = makePaperPdf(spec);
  return score(label, paper.pdf, paper);
}

/**
 * pdflatex で組んだ実物の論文を測る。
 *
 * 合成 PDF（makePaperPdf）は自分で座標を置くので、**自分が想定した壊れ方しか再現できない**。
 * 実際に報告された崩れ（1 ページ目で左右の段が語単位に混ざる、付録が丸ごと参考文献になる）は、
 * 合成 14 シナリオが全部 100% のまま素通りしていた。だからここは実物を入れる。
 *
 * PDF と正解はリポジトリに入れてある（scripts/real-papers/）。正解は .tex の `\s{...}` から
 * 機械的に作ったもので、PDF から取り出した結果ではない。組み直しは
 * `node --experimental-strip-types scripts/build-real-papers.ts`
 * （欧文は pdflatex、和文は xelatex。どちらを使うかは .tex の fontspec の有無で決まる）。
 */
async function measureRealPapers(): Promise<Result[]> {
  const dir = join(fileURLToPath(new URL('.', import.meta.url)), 'real-papers');
  const names = readdirSync(dir).filter((name) => name.endsWith('.pdf')).sort();
  const out: Result[] = [];
  for (const name of names) {
    const base = name.replace(/\.pdf$/, '');
    const truth = JSON.parse(readFileSync(join(dir, `${base}.truth.json`), 'utf8')) as PaperTruth;
    out.push(await score(`実物 / ${base}`, new Uint8Array(readFileSync(join(dir, name))), truth));
  }
  return out;
}

/**
 * 直せないと分かっている壊れ方の標本（scripts/real-papers/unrecoverable/）。
 *
 * ML・統計・最適化の論文では、仮定・補題・定理の主張そのものが別行立ての数式で
 * 書かれる。pdf.js は分数の分子と分母、総和の上下の添字を別々の行として返すので、
 * それらは版面の規則で「数式」として落ちる。落ちた断片をまたいで前後が繋がると、
 * 出来上がるのは**文法の通る英文**で、数学だけが間違っている。
 * この経路は版面の情報だけでは直せない（消えた記号はどこにも残っていない）。
 *
 * だからここで測るのは「直ったか」ではなく「**印を付けられたか**」:
 *   - 継ぎ目の印が付いているか（MIN_SEAMS 以上）
 *   - 正しく取れている文に 1 件も付いていないか（誤爆 0）
 *   - 全部が崩れてはいないか（再現率の下限）
 */
const MIN_SEAMS = 2;
const MIN_UNRECOVERABLE_RECALL = 0.6;

async function measureUnrecoverable(): Promise<Result[]> {
  const dir = join(fileURLToPath(new URL('.', import.meta.url)), 'real-papers', 'unrecoverable');
  const names = readdirSync(dir).filter((name) => name.endsWith('.pdf')).sort();
  const out: Result[] = [];
  for (const name of names) {
    const base = name.replace(/\.pdf$/, '');
    const truth = JSON.parse(readFileSync(join(dir, `${base}.truth.json`), 'utf8')) as PaperTruth;
    out.push(await score(`直せない / ${base}`, new Uint8Array(readFileSync(join(dir, name))), truth));
  }
  return out;
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
  // 段に収まる幅の中央寄せ表題。幅だけを見ると段抜きだと分からず、本文の途中に刺さる。
  await measure('3 段組 / 段に収まる表題', { pages: 6, columns: 3, narrowBanner: true }),
  await measure('1 ページのみ', { pages: 1, columns: 2 }),
  await measure('紛らわしい言い回し', { pages: 6, columns: 2, pathological: true }),
  await measure('段抜きの図キャプション', { pages: 6, columns: 2, spanFigure: true }),
  // 文書内に 1 回しか出ない複合語が行末で割れる形。用例に頼った判定だとハイフンが落ちる。
  await measure('行末の複合語', { pages: 6, columns: 2, hyphenTraps: true }),
  // 1 行目が文末で終わるキャプション。終端記号だけで閉じると 2 文目が本文に混ざる。
  await measure('文末で折り返すキャプション', { pages: 6, columns: 2, splitCaption: true }),
];

const realResults = await measureRealPapers();
const unrecoverableResults = await measureUnrecoverable();

function table(title: string, rows: Result[]): void {
  console.log(`\n${title}`);
  console.log('レイアウト             再現率   読順  余分  混入  ハイフン  書換  文数  節  申告  採録   印  解析');
  console.log('-------------------------------------------------------------------------------------------------------');
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(20)} ${`${Math.round(r.recall * 100)}%`.padStart(5)} (${r.found}/${r.expected})  ` +
        `${`${Math.round(r.order * 100)}%`.padStart(4)} ` +
        `${String(r.spurious).padStart(4)} ${String(r.leaks).padStart(5)} ` +
        `${String(r.hyphenated).padStart(7)} ${String(r.rewritten).padStart(5)} ` +
        `${String(r.sentences).padStart(5)} ` +
        `${String(r.sections).padStart(3)} ${r.readingOrderRisk.padStart(5)} ` +
        `${`${(r.coverage * 100).toFixed(1)}%${r.coverageRisk === 'high' ? '!' : ' '}`.padStart(7)} ` +
        `${`${r.seams}${r.seamFalseAlarms > 0 ? `(誤${r.seamFalseAlarms})` : ''}`.padStart(4)} ` +
        `${String(r.ms).padStart(6)}ms`,
    );
  }
}

table('合成 PDF（回帰の網）', results);
table('実物の論文（pdflatex / xelatex で組んだもの）', realResults);
table('直せない壊れ方（印が付くかだけを見る）', unrecoverableResults);

const all = [...results, ...realResults];

const failures = all.filter(
  (r) =>
    r.recall < MIN_RECALL ||
    r.order < MIN_ORDER ||
    r.leaks > MAX_LEAKS ||
    r.hyphenated > MAX_HYPHEN_ARTEFACTS ||
    r.rewritten > MAX_REWRITTEN ||
    r.spurious > Math.ceil(r.expected * MAX_SPURIOUS_RATIO),
);

/**
 * 「崩れていない文書に高リスクの申告を出していないか」も門にする。
 *
 * 自己申告は、当たらないより**誤って鳴る方**が害が大きい。全部に警告を出す実装は
 * 「簡易解析」バッジ 1 種類だったときと同じで、見分けが付かないという問題を戻すだけ。
 * 再現率が十分高い（＝実際には崩れていない）文書で high が出たら、それは誤検出。
 */
const falseAlarms = all.filter((r) => r.readingOrderRisk === 'high' && r.recall >= MIN_RECALL);

/**
 * 欠落の自己申告（採録率）の門。
 *
 * 1. 取れているのに high が出たら誤検出。読み順の申告と同じ理由で、誤って鳴る方が害が大きい。
 * 2. 採録率そのものにも下限を置く。ここが落ちているということは、本文として読める行を
 *    数式や表として落としているということで、**再現率が 100% でも**起きうる
 *    （正解に無い形で消えるのではなく、正解の文が丸ごと消えるため再現率にも出るが、
 *    片方だけ見ていると「消えた理由」が分からない）。
 */
const MIN_MEASURED_COVERAGE = 0.98;
const coverageAlarms = all.filter((r) => r.coverageRisk === 'high' && r.recall >= MIN_RECALL);
const coverageFailures = all.filter((r) => r.coverage < MIN_MEASURED_COVERAGE);

/**
 * 継ぎ目の印の誤爆の門。
 *
 * 印は「この文だけは原文と食い違っているおそれがある」という強い主張なので、
 * 正しく取れている文に 1 件でも付いたら、以後まとめて無視されるようになる。
 * 正解の本文そのものに印が付いていたら落とす。
 */
const seamFalseAlarms = [...all, ...unrecoverableResults].filter((r) => r.seamFalseAlarms > 0);

/** 直せない標本で、印がちゃんと付いているか。付かなければ黙って壊れたままになる。 */
const seamMisses = unrecoverableResults.filter(
  (r) => r.seams < MIN_SEAMS || r.recall < MIN_UNRECOVERABLE_RECALL,
);

if (
  failures.length > 0 ||
  falseAlarms.length > 0 ||
  coverageAlarms.length > 0 ||
  coverageFailures.length > 0 ||
  seamFalseAlarms.length > 0 ||
  seamMisses.length > 0
) {
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
  }
  if (falseAlarms.length > 0) {
    console.error(
      '\n読み順の自己申告が誤って鳴っています（十分に取れている文書に high）:\n' +
        falseAlarms.map((f) => `  ${f.label}: 再現率 ${Math.round(f.recall * 100)}%`).join('\n'),
    );
  }
  if (coverageAlarms.length > 0) {
    console.error(
      '\n欠落の自己申告が誤って鳴っています（十分に取れている文書に high）:\n' +
        coverageAlarms
          .map((f) => `  ${f.label}: 再現率 ${Math.round(f.recall * 100)}% / 採録率 ${(f.coverage * 100).toFixed(1)}%`)
          .join('\n'),
    );
  }
  if (seamFalseAlarms.length > 0) {
    console.error(
      '\n継ぎ目の印が、正解の本文そのものに付いています（誤爆）:\n' +
        seamFalseAlarms.map((f) => `  ${f.label}: 印 ${f.seams} 件 / うち誤爆 ${f.seamFalseAlarms} 件`).join('\n'),
    );
  }
  if (seamMisses.length > 0) {
    console.error(
      `\n直せない壊れ方に印が付いていません（印 >= ${MIN_SEAMS} / 再現率 >= ${MIN_UNRECOVERABLE_RECALL * 100}%）:\n` +
        seamMisses
          .map((f) => `  ${f.label}: 印 ${f.seams} 件 / 再現率 ${Math.round(f.recall * 100)}%`)
          .join('\n'),
    );
  }
  if (coverageFailures.length > 0) {
    console.error(
      `\n採録率が基準（${MIN_MEASURED_COVERAGE * 100}%）を下回りました` +
        '（本文として読める行を数式や表として落としています）:\n' +
        coverageFailures.map((f) => `  ${f.label}: 採録率 ${(f.coverage * 100).toFixed(1)}%`).join('\n'),
    );
  }
  process.exit(1);
}
console.log('\n基準を満たしています。');
