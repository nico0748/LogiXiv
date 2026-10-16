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
 *
 * 続けて「全行・4 辺」の検査をする（こちらは基準を満たさなければ終了コード 1）:
 *   - 対象: 文の枠（解析 → グリフに合わせた後。アプリと同じ）と、AI エージェントのマーカー
 *     （MCP の add_highlight と同じ findText。画面で選んだマーカーも同じ関数で矩形を作る）。
 *   - すべての行の矩形について、左右の端が字を 0.5pt より多く割らない（中の字を欠かない・外の字にかからない）、
 *     上下の端が字の帯（MuPDF の字の箱の中央値）から ±0.05em 以内。
 *   - 回転したページ（/Rotate 90）と切り抜いたページ（CropBox）も、実物の 2 段組から作って測る。
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Rect, Sentence } from '../packages/core/src/index.ts';
import { parseWithPdfJs } from '../packages/server/src/fallback.ts';
import { makePaperPdf, type PaperSpec } from './make-paper-pdf.ts';
import { degrees, PDFDocument } from 'pdf-lib';
import { findText, readPages } from '../apps/reader/server/pdftext.ts';
import { glyphPagesFromText, refineStructureRects } from '../apps/reader/server/refineRects.ts';
import { fromDisplay } from '../apps/reader/src/lib/pageText.ts';

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

/** ページごとの /Rotate（glyph-truth.py の座標は回転前の向き）。glyphs() が埋める。 */
const truthRotation = new Map<string, Map<number, number>>();

function glyphs(pdfPath: string): Map<number, Glyph[]> | null {
  const run = spawnSync('python3', [join(here, 'glyph-truth.py'), pdfPath], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (run.status !== 0) return null;
  const pages = JSON.parse(run.stdout) as { page: number; rotation?: number; chars: [string, number, number, number, number][] }[];
  truthRotation.set(pdfPath, new Map(pages.map((p) => [p.page, p.rotation ?? 0])));
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

async function run(label: string, pdf: Uint8Array, queriesFrom?: Sentence[], noY = false): Promise<Row | null> {
  const dir = mkdtempSync(join(tmpdir(), 'paperlens-edges-'));
  const path = join(dir, 'paper.pdf');
  writeFileSync(path, pdf);
  const truth = glyphs(path);
  if (!truth) return null;
  const structure = await parseWithPdfJs(pdf);
  await fourEdges(label, path, structure, truth, queriesFrom, noY);
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

// --- 全行・4 辺 --------------------------------------------------------------------

/** 左右の端の許容（pt）と、上下の端の許容（em）。 */
const X_TOL = 0.5;
const Y_TOL_EM = 0.05;

interface FourEdge {
  label: string;
  kind: '文の枠' | 'MCP';
  rects: number;
  /** 左右の端が字を 0.5pt より多く割った矩形 */
  xBad: number;
  /** 上下の端が帯から 0.05em より外れた矩形 */
  yBad: number;
  /** 測れなかった（行に字が無い）矩形 */
  skipped: number;
  /** 上下を測らない（正解の字の箱が書体の実際の帯と違う。下の synthetic を参照） */
  noY?: boolean;
  worstX: number;
  worstYEm: number;
}
const fourEdgeRows: FourEdge[] = [];
const fourEdgeExamples: string[] = [];

function checkRect(r: { x: number; y: number; w: number; h: number }, list: readonly Glyph[], row: FourEdge, what: () => string): void {
  const line = list.filter((g) => {
    const overlap = Math.min(r.y + r.h, g.y1) - Math.max(r.y, g.y0);
    return overlap > 0.5 * Math.min(r.h, g.y1 - g.y0);
  });
  const inside = line.filter((g) => (g.x0 + g.x1) / 2 >= r.x && (g.x0 + g.x1) / 2 <= r.x + r.w);
  if (inside.length === 0) {
    row.skipped++;
    return;
  }
  row.rects++;
  // 左右: 中の字を欠く量・外の字にかかる量
  let dx = 0;
  for (const g of inside) dx = Math.max(dx, r.x - g.x0, g.x1 - (r.x + r.w));
  const overlap = (a: Glyph, x0: number, x1: number) => Math.max(0, Math.min(a.x1, x1) - Math.max(a.x0, x0));
  for (const g of line) {
    if (inside.includes(g)) continue;
    // 和文の約物の詰め（「。」の箱に次の字の箱が重なる）のように、字の箱どうしが元から重なっている分は数えない
    const inherent = Math.max(0, ...inside.map((h) => overlap(g, h.x0, h.x1)));
    dx = Math.max(dx, overlap(g, r.x, r.x + r.w) - inherent);
  }
  // 上下: 文の枠は字の箱の中央値（上付き・下付きに引っ張られない帯）、
  // マーカーは中の字の箱の外接（行の項目をまとめるとき外接矩形にするので、添字の字まで覆う）
  const mid = (vs: number[]) => [...vs].sort((a, b) => a - b)[vs.length >> 1]!;
  const union = row.kind === 'MCP';
  const y0 = union ? Math.min(...inside.map((g) => g.y0)) : mid(inside.map((g) => g.y0));
  const y1 = union ? Math.max(...inside.map((g) => g.y1)) : mid(inside.map((g) => g.y1));
  const em = mid(inside.map((g) => g.y1 - g.y0));
  let dyEm = Math.max(Math.abs(r.y - y0), Math.abs(r.y + r.h - y1)) / em;
  if (row.noY) dyEm = 0;
  row.worstX = Math.max(row.worstX, dx);
  row.worstYEm = Math.max(row.worstYEm, dyEm);
  if (dx > X_TOL) row.xBad++;
  if (dyEm > Y_TOL_EM) row.yBad++;
  if ((dx > X_TOL || dyEm > Y_TOL_EM) && fourEdgeExamples.length < 60) {
    fourEdgeExamples.push(`  [${row.label} / ${row.kind}] 左右 ${dx.toFixed(2)}pt 上下 ${dyEm.toFixed(3)}em: ${what()}`);
  }
}

/**
 * 文の枠（グリフに合わせた後）と MCP のマーカーを、全行・4 辺で測る。
 * queriesFrom を渡すと、MCP の検索語はその文（回転・切り抜き前の PDF の解析結果）から取る。
 */
async function fourEdges(
  label: string,
  path: string,
  structure: Awaited<ReturnType<typeof parseWithPdfJs>>,
  truth: Map<number, Glyph[]>,
  queriesFrom?: Sentence[],
  noY = false,
): Promise<void> {
  const pages = await readPages(path, { glyphs: true });
  const rotation = truthRotation.get(path) ?? new Map<number, number>();
  const empty = (kind: FourEdge['kind']): FourEdge => ({ label, kind, rects: 0, xBad: 0, yBad: 0, skipped: 0, worstX: 0, worstYEm: 0, noY });

  // 文の枠: アプリのサーバーと同じく、解析のあとグリフに合わせる。回転したページは対象外（枠を描く座標系が違う）
  const box = empty('文の枠');
  const refined = refineStructureRects(structure, glyphPagesFromText(pages, structure.pageSizes)).structure;
  for (const s of refined.sentences) {
    for (const r of s.rects) {
      if ((rotation.get(r.page) ?? 0) !== 0) continue;
      checkRect(r, truth.get(r.page) ?? [], box, () => s.text.slice(0, 60));
    }
  }
  if (box.rects + box.skipped > 0) fourEdgeRows.push(box);

  // MCP: 文ごとに findText。矩形は表示の向きのページに対する割合なので、回転前の pt に戻して比べる
  const mcp = empty('MCP');
  for (const s of queriesFrom ?? structure.sentences) {
    const m = findText(pages, s.text, s.page);
    if (!m) continue;
    const p = pages[m.page - 1]!;
    const rot = rotation.get(m.page) ?? 0;
    // glyph-truth.py の座標は /Rotate を掛ける前。pdftext.ts の rotation（フレームから表示）が同じ角度のときだけ測れる
    if ((p.rotation ?? 0) !== rot) continue;
    const turned = rot % 180 !== 0;
    const fw = turned ? p.height : p.width;
    const fh = turned ? p.width : p.height;
    for (const r of m.rects) {
      const [ax, ay] = fromDisplay(r.x, r.y, rot);
      const [bx, by] = fromDisplay(r.x + r.w, r.y + r.h, rot);
      const fr = { x: Math.min(ax, bx) * fw, y: Math.min(ay, by) * fh, w: Math.abs(bx - ax) * fw, h: Math.abs(by - ay) * fh };
      checkRect(fr, truth.get(m.page) ?? [], mcp, () => s.text.slice(0, 60));
    }
  }
  fourEdgeRows.push(mcp);
}

function printFourEdges(): boolean {
  console.log(`\n全行・4 辺（左右: 字を ${X_TOL}pt より多く割らない、上下: 字の帯から ±${Y_TOL_EM}em 以内）`);
  console.log('対象                          種類     矩形   左右NG   上下NG  測れず  左右最大pt  上下最大em');
  let ok = true;
  for (const r of fourEdgeRows) {
    // 基準: 左右・上下とも、外れる矩形が 1% 以下
    const bad = r.xBad / Math.max(1, r.rects) > 0.01 || r.yBad / Math.max(1, r.rects) > 0.01;
    if (bad) ok = false;
    console.log(
      `${r.label.padEnd(28)} ${r.kind.padEnd(6)} ${String(r.rects).padStart(6)} ${pct(r.xBad, r.rects)} ${pct(r.yBad, r.rects)} ${String(r.skipped).padStart(6)}` +
        `  ${r.worstX.toFixed(2).padStart(9)}  ${r.noY ? '        -' : r.worstYEm.toFixed(3).padStart(9)}${bad ? '  ← 基準外' : ''}`,
    );
  }
  if (verbose || !ok) console.log(fourEdgeExamples.join('\n'));
  return ok;
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
  // 合成 PDF は埋め込まない標準書体（Times / Helvetica）で組む。MuPDF はその字の箱を代わりの書体の
  // ascender（約 1.05em）で作るので、描いた字の帯（−0.76〜+0.24em）と比べられない。上下は測らない
  const row = await run(label, makePaperPdf(spec).pdf, undefined, true);
  if (row) rows.push(row);
}
const realDir = join(here, 'real-papers');
for (const name of readdirSync(realDir).filter((n) => n.endsWith('.pdf')).sort()) {
  const row = await run(`実物 / ${name.replace(/\.pdf$/, '')}`, new Uint8Array(readFileSync(join(realDir, name))));
  if (row) rows.push(row);
}

// 回転・切り抜きしたページ: 実物の 2 段組から作る（検索語は元の PDF の文）
{
  const source = readFileSync(join(realDir, 'twocolumn.pdf'));
  const queries = (await parseWithPdfJs(new Uint8Array(source))).sentences;
  const variant = async (edit: (page: ReturnType<PDFDocument['getPage']>) => void) => {
    const doc = await PDFDocument.load(source);
    for (const page of doc.getPages()) edit(page);
    return doc.save();
  };
  for (const [label, edit] of [
    ['実物 / twocolumn /Rotate 90', (p) => p.setRotation(degrees(90))],
    ['実物 / twocolumn /Rotate 270', (p) => p.setRotation(degrees(270))],
    // 左 40pt・上 60pt を切り落とす（PDF の座標は下から）
    ['実物 / twocolumn CropBox', (p) => p.setCropBox(40, 30, p.getWidth() - 60, p.getHeight() - 90)],
  ] as [string, (page: ReturnType<PDFDocument['getPage']>) => void][]) {
    await run(label, await variant(edit), queries);
  }
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
const fourEdgesOk = printFourEdges();
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
if (!fourEdgesOk) {
  console.log('\n全行・4 辺の基準を満たしていません。');
  process.exit(1);
}
