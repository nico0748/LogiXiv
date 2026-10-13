// MCP の add_highlight が引くマーカーの位置（findText）の単体テスト。
// 期待値は実際の PDF（scripts/real-papers）のグリフの位置を PyMuPDF で測ったもの（ページ幅に対する割合）。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { findText, mergeLines, readPages } from "./pdftext.ts";

const paper = (name: string) => fileURLToPath(new URL(`../../../scripts/real-papers/${name}.pdf`, import.meta.url));
// 0.003 ≒ 1.8pt。文字数で按分していたときは 3〜44pt ずれていた
const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 0.003, `${what}: ${actual.toFixed(4)} != ${expected.toFixed(4)}`);

const edges = async (name: string, sentence: string) => {
  const m = findText(await readPages(paper(name), { glyphs: true }), sentence);
  assert.ok(m, `見つからない: ${sentence}`);
  const last = m.rects[m.rects.length - 1];
  return { m, start: m.rects[0].x, end: last.x + last.w };
};

test("和欧混在で両端揃えの行でも、文頭・文末がグリフに合う", async () => {
  const { start, end, m } = await edges("japanese-onecolumn", "たとえば attention や transformer といった語は、訳さずにそのまま使われる。");
  near(start, 0.7024, "文頭"); // 文字数で按分すると 0.6286（44pt 手前）から塗っていた
  near(end, 0.5931, "文末");
  assert.equal(m.rects.length, 2);
});

test("プロポーショナルフォントの行の途中から始まり途中で終わる文", async () => {
  for (const [s, a, b] of [
    ["Small blocks approximate dense attention closely but make the selection matrix large.", 0.8429, 0.7074],
    ["Large blocks make the selection cheap and force the kernel to read positions it does not need.", 0.7164, 0.6443],
    ["We measured both effects on a single node with eight accelerators.", 0.6542, 0.373],
  ] as const) {
    const { start, end } = await edges("onecolumn", s);
    near(start, a, `文頭 ${s}`);
    near(end, b, `文末 ${s}`);
  }
});

test("行末のハイフンで語が割れている文も見つけ、行ごとに塗る", async () => {
  const s = "Retrieval augmented systems concatenate dozens of documents into a single prompt, and agentic systems accumulate context over many turns.";
  const { m, start, end } = await edges("twocolumn", s);
  assert.equal(m.rects.length, 3);
  near(start, 0.0952, "文頭");
  near(end, 0.2916, "文末");
});

test("描画命令を読まないときは、従来どおり文字数で按分する", async () => {
  const m = findText(await readPages(paper("onecolumn")), "These notes collect the design decisions behind the block selection rule.");
  assert.ok(m);
  near(m.rects[0].x, 0.1852, "文頭");
});

test("同じ行の矩形だけをまとめ、別の段の矩形はまとめない", () => {
  const h = 0.015;
  assert.deepEqual(
    mergeLines([
      { x: 0.1, y: 0.5, w: 0.1, h },
      { x: 0.205, y: 0.5, w: 0.1, h },
      { x: 0.55, y: 0.5, w: 0.1, h }, // 右の段
      { x: 0.1, y: 0.52, w: 0.2, h }, // 次の行
    ]).map((r) => [r.x, +(r.x + r.w).toFixed(3), r.y]),
    [
      [0.1, 0.305, 0.5],
      [0.55, 0.65, 0.5],
      [0.1, 0.3, 0.52],
    ],
  );
});
