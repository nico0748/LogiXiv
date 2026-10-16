// MCP の add_highlight が引くマーカーの位置（findText）の単体テスト。
// 期待値は実際の PDF（scripts/real-papers）のグリフの位置を PyMuPDF で測ったもの（ページ幅に対する割合）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { degrees, PDFDocument } from "pdf-lib";
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

test("同じ行の矩形をまとめるときは、縦も外接矩形にする（上付きの小さな字の項目で上端が欠けない）", () => {
  const out = mergeLines([
    { x: 0.1, y: 0.5, w: 0.1, h: 0.012 },
    { x: 0.2, y: 0.497, w: 0.01, h: 0.008 }, // 上付きの字（上にはみ出す）
    { x: 0.21, y: 0.5, w: 0.1, h: 0.013 }, // 下に少し深い
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].y, 0.497);
  assert.ok(Math.abs(out[0].y + out[0].h - 0.513) < 1e-9);
  assert.ok(Math.abs(out[0].x + out[0].w - 0.31) < 1e-9);
});

// 縦の帯: MuPDF の字の箱（scripts/glyph-truth.py と同じ取り方）に 0.05em（≒0.5pt）以内で合う
const RETRIEVAL =
  "Retrieval augmented systems concatenate dozens of documents into a single prompt, and agentic systems accumulate context over many turns.";
/** twocolumn.pdf の 1 ページ目で、この文の 1 行目と 3 行目の字の箱（pt、MuPDF の line bbox） */
const LINE1 = { y0: 454.83, y1: 464.79 };
const LINE3 = { y0: 478.74, y1: 488.7 };
const nearPt = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 0.5, `${what}: ${actual.toFixed(2)}pt != ${expected.toFixed(2)}pt`);

test("マーカーの上端・下端は、字の帯（ベースライン − ascent 〜 + descent）に合う", async () => {
  const pages = await readPages(paper("twocolumn"), { glyphs: true });
  const m = findText(pages, RETRIEVAL);
  assert.ok(m);
  const H = pages[0].height;
  nearPt(m.rects[0].y * H, LINE1.y0, "1 行目の上端"); // 以前は 2.4pt 上（ベースライン − 1em）
  nearPt((m.rects[0].y + m.rects[0].h) * H, LINE1.y1, "1 行目の下端");
  nearPt(m.rects[2].y * H, LINE3.y0, "3 行目の上端");
  nearPt((m.rects[2].y + m.rects[2].h) * H, LINE3.y1, "3 行目の下端");
});

/** twocolumn.pdf を /Rotate や CropBox を変えて書き出す（回転・切り抜きしたページの試験用） */
async function variant(name: string, edit: (page: ReturnType<PDFDocument["getPage"]>) => void) {
  const doc = await PDFDocument.load(await fs.readFile(paper("twocolumn")));
  for (const page of doc.getPages()) edit(page);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperlens-pdftext-"));
  const file = path.join(dir, `${name}.pdf`);
  await fs.writeFile(file, await doc.save());
  return file;
}

test("/Rotate 90 のページでも、表示の向きで字に合う矩形を返す", async () => {
  const upright = findText(await readPages(paper("twocolumn"), { glyphs: true }), RETRIEVAL);
  const pages = await readPages(await variant("rot90", (p) => p.setRotation(degrees(90))), { glyphs: true });
  assert.equal(pages[0].rotation, 90, "文字は回転前の向きで横に流れる");
  assert.ok(Math.abs(pages[0].width - 841.89) < 0.01, "表示の向きの幅");
  const m = findText(pages, RETRIEVAL);
  assert.ok(m && upright);
  assert.equal(m.rects.length, upright.rects.length);
  // 時計回りに 90 度: 表示の (x, y) = (1 − 元の y, 元の x)
  m.rects.forEach((r, i) => {
    const u = upright.rects[i];
    nearPt(r.x * 841.89, (1 - u.y - u.h) * 841.89, `${i} 行目の左端`);
    nearPt((r.x + r.w) * 841.89, (1 - u.y) * 841.89, `${i} 行目の右端`);
    nearPt(r.y * 595.28, u.x * 595.28, `${i} 行目の上端`);
    nearPt((r.y + r.h) * 595.28, (u.x + u.w) * 595.28, `${i} 行目の下端`);
  });
});

test("CropBox で切り抜いたページでも、切り抜いた紙面に対する位置を返す", async () => {
  const upright = findText(await readPages(paper("twocolumn"), { glyphs: true }), RETRIEVAL);
  // 左 40pt・上 60pt を切り落とす（PDF の座標は下から: y = 30〜781.89）
  const pages = await readPages(await variant("cropped", (p) => p.setCropBox(40, 30, 535.28, 751.89)), { glyphs: true });
  const m = findText(pages, RETRIEVAL);
  assert.ok(m && upright);
  m.rects.forEach((r, i) => {
    const u = upright.rects[i];
    nearPt(r.x * 535.28, u.x * 595.28 - 40, `${i} 行目の左端`);
    nearPt((r.x + r.w) * 535.28, (u.x + u.w) * 595.28 - 40, `${i} 行目の右端`);
    nearPt(r.y * 751.89, u.y * 841.89 - 60, `${i} 行目の上端`);
  });
});
