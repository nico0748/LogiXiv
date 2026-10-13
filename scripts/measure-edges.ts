/**
 * 文の枠（sentence.rects）の**端**がどれくらい正確かを測る。
 *
 *   node --experimental-strip-types scripts/measure-edges.ts [--verbose] [--refine]
 *
 * --refine を付けると、PaperLens アプリのサーバーが解析後に掛ける「枠の端をグリフに合わせる」
 * 処理（apps/reader/server/refineRects.ts）を通した枠も測り、見積もりだけの表と並べて出す。
 *
 * measure-quality.ts は「どの文が取れたか」しか見ない。こちらは「その文の枠が紙面の
 * どこから始まってどこで終わるか」を見る。文が行の途中で始まる・終わるとき、
 * 枠が文頭を覆わない（足りない）／隣の文まで覆う（はみ出す）という崩れを数える。
 *
 * **正解は pdf.js ではなく MuPDF（PyMuPDF）から取る**（scripts/glyph-truth.py）。
 * 解析器と同じ pdf.js の文字片を正解にすると、測りたい誤差（文字片の粒度）がそのまま
 * 正解に写る。PyMuPDF が無い環境では何もせずに終わる（門ではない）。
 *
 * 測り方:
 *   1. 文の先頭（末尾）の英数字・かな漢字を最大 24 文字（見つからなければ 12、6 文字）、紙面の文字列の中から探す。
 *      複数見つかったら、その文の枠にいちばん近いものを採る。前後の約物（`(` `.` `。` `」`）は
 *      紙面の並びが一致する限り含める。
 *   2. その文字の行（縦に重なる枠）を探し、枠の左端（右端）と文字の左端（右端）の差を取る。
 *   3. 差がその行の文字幅の中央値（≒1 文字）を超えたら、足りない／はみ出すに数える。
 *      行に枠が 1 つも無ければ「行ごと欠落」。
 * 文頭が行の途中にある文（＝同じ行に前の文が居る）だけを抜き出した数も出す。
 * 崩れが起きるのはほぼそこなので、全体の割合だけだと薄まって見えない。
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Rect, Sentence } from '../packages/core/src/index.ts';
import { parseWithPdfJs } from '../packages/server/src/fallback.ts';
import { makePaperPdf, type PaperSpec } from './make-paper-pdf.ts';
import { readPages } from '../apps/reader/server/pdftext.ts';
import { glyphPagesFromText, refineStructureRects } from '../apps/reader/server/refineRects.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const verbose = process.argv.includes('--verbose');
const refine = process.argv.includes('--refine');

interface Glyph {
  c: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function glyphs(pdfPath: string): Map<number, Glyph[]> | null {
  const run = spawnSync('python3', [join(here, 'glyph-truth.py'), pdfPath], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (run.status !== 0) return null;
  const pages = JSON.parse(run.stdout) as { page: number; chars: [string, number, number, number, number][] }[];
  return new Map(pages.map((p) => [p.page, p.chars.map(([c, x0, y0, x1, y1]) => ({ c, x0, y0, x1, y1 }))]));
}

/** 照合に使う文字（英数字・かな漢字）。約物とハイフンは紙面と字面で揃わないので鍵にしない。 */
const KEY = /[\p{L}\p{N}]/u;
const key = (c: string): string => c.normalize('NFKC').toLowerCase();

interface PageIndex {
  glyphs: Glyph[];
  /** 鍵になる文字だけを並べた文字列と、その 1 文字ずつの glyphs 上の位置。 */
  keys: string;
  at: number[];
}

function indexPage(list: Glyph[]): PageIndex {
  let keys = '';
  const at: number[] = [];
  list.forEach((g, i) => {
    for (const ch of key(g.c)) {
      if (!KEY.test(ch)) continue;
      keys += ch;
      at.push(i);
    }
  });
  return { glyphs: list, keys, at };
}

function distance(g: Glyph, rects: readonly Rect[]): number {
  let best = Infinity;
  for (const r of rects) {
    const dx = Math.max(r.x - g.x1, 0, g.x0 - (r.x + r.w));
    // 縦は文字の中心で見る。文字の箱は隣の行の枠と上下で少し重なるので、箱どうしで
    // 比べると隣の行の同じ語に吸い寄せられる。
    const cy = (g.y0 + g.y1) / 2;
    const dy = Math.max(r.y - cy, 0, cy - (r.y + r.h));
    best = Math.min(best, Math.hypot(dx, dy));
  }
  return best;
}

/** 文の端の文字（紙面上）。見つからなければ null。 */
function locate(
  sentence: Sentence,
  pages: Map<number, PageIndex>,
  side: 'start' | 'end',
): { page: number; glyphIndex: number; index: PageIndex; widths: number[] } | null {
  const chars = [...sentence.text.normalize('NFKC').toLowerCase()].filter((c) => KEY.test(c));
  if (chars.length === 0) return null;
  // 長い鍵から試す（同じ語句が近くに 2 度出ると短い鍵では取り違える）。行番号や
  // 脚注記号が間に挟まって長い鍵が見つからないときだけ短くする。
  for (const n of [24, 12, 6]) {
    const found = locateWith(sentence, pages, side, chars, Math.min(n, chars.length));
    if (found) return found;
  }
  return null;
}

function locateWith(
  sentence: Sentence,
  pages: Map<number, PageIndex>,
  side: 'start' | 'end',
  chars: string[],
  n: number,
): { page: number; glyphIndex: number; index: PageIndex; widths: number[] } | null {
  const needle = (side === 'start' ? chars.slice(0, n) : chars.slice(chars.length - n)).join('');
  let best: { page: number; glyphIndex: number; index: PageIndex; widths: number[]; d: number } | null = null;
  // 文頭は最初のページ、文末は最後のページにしか無い（ページを跨ぐ文で、もう片方の
  // ページの似た文に吸い寄せられないように）。
  const rectPages = sentence.rects.map((r) => r.page);
  const sentencePages = [side === 'start' ? Math.min(...rectPages) : Math.max(...rectPages)];
  for (const page of sentencePages) {
    const index = pages.get(page);
    if (!index) continue;
    const onPage = sentence.rects.filter((r) => r.page === page);
    for (let from = index.keys.indexOf(needle); from !== -1; from = index.keys.indexOf(needle, from + 1)) {
      const gi = side === 'start' ? index.at[from]! : index.at[from + needle.length - 1]!;
      const d = distance(index.glyphs[gi]!, onPage);
      if (!best || d < best.d) {
        const widths = index.at.slice(from, from + needle.length).map((i) => index.glyphs[i]!.x1 - index.glyphs[i]!.x0);
        best = { page, glyphIndex: gi, index, widths, d };
      }
    }
  }
  // 枠から遠すぎる一致は取り違え（行番号が挟まって本物が見つからず、別の場所の
  // 似た語句に当たった）。測れなかったことにする。本物の欠落なら隣の行（十数 pt）に居る。
  if (!best || best.d > 30) return null;
  // 前後の約物を、紙面の並びが字面と一致する限り含める（文頭の `(`、文末の `.` `。` `」`）。
  const text = sentence.text.replace(/\s+/g, '');
  const edge = side === 'start' ? [...text.slice(0, text.search(KEY))] : [...text.slice(lastKey(text) + 1)];
  let gi = best.glyphIndex;
  if (side === 'start') {
    for (let k = edge.length - 1; k >= 0; k--) {
      const prev = best.index.glyphs[gi - 1];
      if (prev && key(prev.c) === key(edge[k]!) && sameLine(prev, best.index.glyphs[gi]!)) gi--;
      else break;
    }
  } else {
    for (const ch of edge) {
      const next = best.index.glyphs[gi + 1];
      if (next && key(next.c) === key(ch) && sameLine(next, best.index.glyphs[gi]!)) gi++;
      else break;
    }
  }
  return { page: best.page, glyphIndex: gi, index: best.index, widths: best.widths };
}

function lastKey(text: string): number {
  const chars = [...text];
  let offset = text.length;
  for (let i = chars.length - 1; i >= 0; i--) {
    offset -= chars[i]!.length;
    if (KEY.test(chars[i]!)) return offset + chars[i]!.length - 1;
  }
  return -1;
}

function sameLine(a: Glyph, b: Glyph): boolean {
  const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return overlap > 0.4 * Math.min(a.y1 - a.y0, b.y1 - b.y0);
}

function median(values: number[]): number {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  return sorted.length === 0 ? 4 : sorted[Math.floor(sorted.length / 2)]!;
}

interface EdgeStats {
  edges: number;
  unmatched: number;
  missing: number;
  under: number;
  over: number;
  /** 行の途中にある端だけ。 */
  mid: number;
  midMissing: number;
  midUnder: number;
  midOver: number;
  /** 端の誤差の絶対値（pt）。 */
  errors: number[];
}

const emptyStats = (): EdgeStats => ({
  edges: 0, unmatched: 0, missing: 0, under: 0, over: 0, mid: 0, midMissing: 0, midUnder: 0, midOver: 0, errors: [],
});

function measureEdges(sentences: readonly Sentence[], truth: Map<number, Glyph[]>, label: string): { start: EdgeStats; end: EdgeStats } {
  const pages = new Map([...truth].map(([page, list]) => [page, indexPage(list)]));
  const start = emptyStats();
  const end = emptyStats();
  for (const sentence of sentences) {
    if (sentence.rects.length === 0) continue;
    for (const side of ['start', 'end'] as const) {
      const stats = side === 'start' ? start : end;
      stats.edges++;
      const found = locate(sentence, pages, side);
      if (!found) {
        stats.unmatched++;
        continue;
      }
      const g = found.index.glyphs[found.glyphIndex]!;
      const tol = median(found.widths);
      // 同じ行で、この文字のすぐ隣（3 文字幅以内）に別の文字があるか＝行の途中の端か。
      const neighbours = found.index.glyphs.filter((o, i) => i !== found.glyphIndex && sameLine(o, g));
      const mid =
        side === 'start'
          ? neighbours.some((o) => o.x1 <= g.x0 + 0.5 && o.x1 > g.x0 - tol * 3)
          : neighbours.some((o) => o.x0 >= g.x1 - 0.5 && o.x0 < g.x1 + tol * 3);
      if (mid) stats.mid++;
      const lineRects = sentence.rects.filter((r) => {
        if (r.page !== found.page) return false;
        const overlap = Math.min(r.y + r.h, g.y1) - Math.max(r.y, g.y0);
        return overlap > 0.5 * Math.min(r.h, g.y1 - g.y0);
      });
      if (lineRects.length === 0) {
        stats.missing++;
        if (mid) stats.midMissing++;
        if (verbose) console.log(`  [${label}] ${side} 行ごと欠落 g=${g.c}@${g.x0},${g.y0} p${found.page} rects=${JSON.stringify(sentence.rects)}: ${sentence.text.slice(0, 60)}`);
        continue;
      }
      // その行で文字にいちばん近い枠。
      const rect = lineRects.reduce((a, b) => (distance(g, [a]) <= distance(g, [b]) ? a : b));
      // 正: 足りない（枠が文字の内側で止まっている）／負: はみ出している。
      const error = side === 'start' ? rect.x - g.x0 : g.x1 - (rect.x + rect.w);
      stats.errors.push(Math.abs(error));
      if (error > tol) {
        stats.under++;
        if (mid) stats.midUnder++;
      } else if (error < -tol) {
        stats.over++;
        if (mid) stats.midOver++;
      }
      if (verbose && Math.abs(error) > tol) {
        const snippet = side === 'start' ? sentence.text.slice(0, 50) : sentence.text.slice(-50);
        console.log(`  [${label}] ${side} ${error > 0 ? "足りない" : "はみ出す"} ${error.toFixed(1)}pt (1字≈${tol.toFixed(1)}) g=${g.c}@${g.x0.toFixed(1)},${g.y0.toFixed(1)} rect=${rect.x},${rect.y},${rect.w}: ${snippet}`);
      }
    }
  }
  return { start, end };
}

interface Row {
  label: string;
  start: EdgeStats;
  end: EdgeStats;
}

const refinedRows: Row[] = [];
const timings: { label: string; glyphMs: number; refineMs: number; pages: number; sentences: number; snapped: number; kept: number }[] = [];

async function run(label: string, pdf: Uint8Array): Promise<Row | null> {
  const dir = mkdtempSync(join(tmpdir(), 'paperlens-edges-'));
  const path = join(dir, 'paper.pdf');
  writeFileSync(path, pdf);
  const truth = glyphs(path);
  if (!truth) return null;
  const structure = await parseWithPdfJs(pdf);
  if (refine) {
    const t0 = performance.now();
    const pages = glyphPagesFromText(await readPages(path, { glyphs: true }), structure.pageSizes);
    const t1 = performance.now();
    const { structure: refined, stats } = refineStructureRects(structure, pages);
    const t2 = performance.now();
    timings.push({
      label, glyphMs: t1 - t0, refineMs: t2 - t1, pages: pages.length, sentences: structure.sentences.length,
      snapped: stats.startSnapped + stats.endSnapped, kept: stats.startKept + stats.endKept,
    });
    refinedRows.push({ label, ...measureEdges(refined.sentences, truth, `${label} / glyph`) });
  }
  return { label, ...measureEdges(structure.sentences, truth, label) };
}

const pct = (n: number, d: number): string => (d === 0 ? '   -' : `${((n / d) * 100).toFixed(1)}%`.padStart(6));
const p90 = (values: number[]): string => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? '-' : sorted[Math.floor(sorted.length * 0.9)]!.toFixed(2);
};

function print(rows: Row[]): void {
  console.log('\n文の枠の端（不足 = 文頭／文末を覆っていない、超過 = 隣の文まで覆っている。1 文字幅を超えたもの）');
  console.log('                              ---- 文頭 ----------------------------   ---- 文末 ----------------------------');
  console.log('対象                    文数   不足   超過  欠落 | 行中 不足   超過   p90pt   不足   超過  欠落 | 行中 不足   超過   p90pt  照合不可');
  for (const r of rows) {
    const s = r.start;
    const e = r.end;
    console.log(
      `${r.label.padEnd(22)} ${String(s.edges).padStart(5)} ${pct(s.under, s.edges - s.unmatched)} ${pct(s.over, s.edges - s.unmatched)} ${String(s.missing).padStart(4)} |` +
        ` ${String(s.mid).padStart(4)} ${pct(s.midUnder, s.mid)} ${pct(s.midOver, s.mid)} ${p90(s.errors).padStart(6)}  ` +
        `${pct(e.under, e.edges - e.unmatched)} ${pct(e.over, e.edges - e.unmatched)} ${String(e.missing).padStart(4)} |` +
        ` ${String(e.mid).padStart(4)} ${pct(e.midUnder, e.mid)} ${pct(e.midOver, e.mid)} ${p90(e.errors).padStart(6)}  ` +
        `${s.unmatched + e.unmatched}`,
    );
  }
}

const probe = spawnSync('python3', ['-c', 'import fitz'], { encoding: 'utf8' });
if (probe.status !== 0) {
  console.log('PyMuPDF（python3 -m pip install pymupdf）が無いので、文の枠の端は測りません。');
  process.exit(0);
}

const rows: Row[] = [];
const synthetic: [string, PaperSpec][] = [
  ['合成 / 1 段組', { pages: 4, columns: 1 }],
  ['合成 / 2 段組 両端揃え', { pages: 4, columns: 2, justified: true }],
];
for (const [label, spec] of synthetic) {
  const row = await run(label, makePaperPdf(spec).pdf);
  if (row) rows.push(row);
}
const realDir = join(here, 'real-papers');
for (const name of readdirSync(realDir).filter((n) => n.endsWith('.pdf')).sort()) {
  const row = await run(`実物 / ${name.replace(/\.pdf$/, '')}`, new Uint8Array(readFileSync(join(realDir, name))));
  if (row) rows.push(row);
}

function withTotal(list: Row[]): Row[] {
  const total: Row = { label: '合計', start: emptyStats(), end: emptyStats() };
  for (const r of list) {
    for (const side of ['start', 'end'] as const) {
      const t = total[side];
      const s = r[side];
      for (const k of ['edges', 'unmatched', 'missing', 'under', 'over', 'mid', 'midMissing', 'midUnder', 'midOver'] as const) t[k] += s[k];
      t.errors.push(...s.errors);
    }
  }
  return [...list, total];
}
if (refine) console.log('\n== 見積もりのみ（packages/core） ==');
print(withTotal(rows));
if (refine) {
  console.log('\n== グリフに合わせたあと（apps/reader/server/refineRects.ts） ==');
  print(withTotal(refinedRows));
  console.log('\nグリフの読み取り（readPages glyphs）と端の合わせ込みにかかった時間');
  for (const t of timings) {
    console.log(`${t.label.padEnd(30)} ${String(t.sentences).padStart(4)} 文  グリフ可 ${t.pages} ページ  読み取り ${t.glyphMs.toFixed(0).padStart(5)}ms  合わせ込み ${t.refineMs.toFixed(1).padStart(6)}ms  端 ${t.snapped} 合わせた / ${t.kept} そのまま`);
  }
}
