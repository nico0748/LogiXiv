// 文の枠の端をグリフに合わせる処理（refineRects.ts）の単体テスト。グリフは合成する。
import assert from "node:assert/strict";
import { test } from "node:test";
import { type DocumentStructure, RECT_BAND_VERSION, type Rect, type Sentence } from "@paperlens/core";
import { type GlyphBox, type GlyphPage, glyphPagesFromText, refineSentenceRects, refineStructureRects } from "./refineRects.ts";

/** 1 行を左から並べる。width(ch) で字幅、空白は space の幅（両端揃えなら広い）。 */
function layLine(text: string, x: number, y: number, width: (ch: string) => number, space: number): GlyphBox[] {
  const out: GlyphBox[] = [];
  for (const ch of text) {
    if (ch === " ") {
      x += space;
      continue;
    }
    const w = width(ch);
    out.push({ ch, x0: x, x1: x + w, y0: y, y1: y + 10 });
    x += w;
  }
  return out;
}
const latin = (ch: string) => (/[il.,]/.test(ch) ? 2.5 : /[mwMW]/.test(ch) ? 8 : 5);
const wide = (ch: string) => (/[　-鿿]/.test(ch) ? 10 : latin(ch));

const sentence = (text: string, rects: Omit<Rect, "page">[], page = 1): Sentence => ({
  id: "s", hash: "h", order: 0, page, text, sectionId: null, rects: rects.map((r) => ({ page, ...r })),
});
const pages = (glyphs: GlyphBox[]): Map<number, GlyphPage> => new Map([[1, { page: 1, glyphs }]]);
const at = (glyphs: GlyphBox[], text: string, ch: string, nth = 0) => glyphs.filter((g) => g.ch === ch)[nth];
const close = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} != ${b}`);

test("両端揃えの行の途中から始まる文の文頭を、見積もりが手前でも奥でも文頭のグリフに合わせる", () => {
  const line = "the previous claim holds.   Next we measure the latency of every kernel";
  const glyphs = layLine(line, 72, 100, latin, 9); // 語間が広い
  const n = at(glyphs, line, "N");
  const lastGlyph = glyphs[glyphs.length - 1];
  const text = "Next we measure the latency of every kernel on a single node.";
  for (const est of [n.x0 - 7, n.x0 + 6]) {
    const s = sentence(text, [
      { x: est, y: 100, w: lastGlyph.x1 - est, h: 10 },
      { x: 72, y: 112, w: 100, h: 10 },
    ]);
    const out = refineSentenceRects(s, pages(glyphs));
    close(out.rects[0].x, n.x0, `見積もり ${est}`);
    close(out.rects[0].x + out.rects[0].w, lastGlyph.x1, "右端は動かさない");
    assert.deepEqual(out.rects[1], s.rects[1], "途中の行はそのまま");
  }
});

test("前の文の文末が同じ語でも、隣の文のグリフはつかまない", () => {
  // 前の文の末尾 "it." と、この文の先頭 "It" が並ぶ。いちばん近い端に寄せると "it" をつかむ
  const line = "and we keep it. It works because the cache stays warm";
  const glyphs = layLine(line, 72, 100, latin, 3);
  const prevI = at(glyphs, line, "i", 0 + line.slice(0, line.indexOf("it.")).split("").filter((c) => c === "i").length);
  const bigI = at(glyphs, line, "I");
  const s = sentence("It works because the cache stays warm.", [{ x: prevI.x0 + 0.5, y: 100, w: glyphs[glyphs.length - 1].x1 - prevI.x0, h: 10 }]);
  const out = refineSentenceRects(s, pages(glyphs));
  close(out.rects[0].x, bigI.x0, "文頭");

  // 文末側: 見積もりが次の文の頭まではみ出していても、この文の "." で止める
  const line2 = "We cache it. It helps a lot";
  const g2 = layLine(line2, 72, 100, latin, 3);
  const dot = at(g2, line2, ".");
  const s2 = sentence("We cache it.", [{ x: 72, y: 100, w: at(g2, line2, "I").x1 + 1 - 72, h: 10 }]);
  const out2 = refineSentenceRects(s2, pages(g2));
  close(out2.rects[0].x + out2.rects[0].w, dot.x1, "文末は句点の右端");
});

test("和文に欧文が混ざる行でも、文頭・文末（句点を含む）がグリフに合う", () => {
  const line = "これは attention の例です。次の文は transformer を使う。";
  const glyphs = layLine(line, 72, 200, wide, 2.5);
  const first = at(glyphs, line, "次");
  const end1 = at(glyphs, line, "。", 0);
  const end2 = at(glyphs, line, "。", 1);
  const s1 = sentence("これは attention の例です。", [{ x: 72, y: 200, w: end1.x1 + 12 - 72, h: 10 }]);
  const s2 = sentence("次の文は transformer を使う。", [{ x: first.x0 - 15, y: 200, w: end2.x1 - first.x0 + 15 - 4, h: 10 }]);
  const o1 = refineSentenceRects(s1, pages(glyphs));
  const o2 = refineSentenceRects(s2, pages(glyphs));
  close(o1.rects[0].x, 72, "1 文目の文頭");
  close(o1.rects[0].x + o1.rects[0].w, end1.x1, "1 文目の文末");
  close(o2.rects[0].x, first.x0, "2 文目の文頭");
  close(o2.rects[0].x + o2.rects[0].w, end2.x1, "2 文目の文末");
});

test("照合できないときは枠を動かさない（本文が紙面と違う・別の行）", () => {
  const glyphs = layLine("something entirely different here", 72, 100, latin, 3);
  const s = sentence("Next we measure the latency.", [{ x: 80, y: 100, w: 90, h: 10 }]);
  assert.equal(refineSentenceRects(s, pages(glyphs)), s);
  const other = sentence("something entirely different here.", [{ x: 72, y: 300, w: 120, h: 10 }]);
  assert.equal(refineSentenceRects(other, pages(glyphs)), other);
});

const structureOf = (sentences: Sentence[]): DocumentStructure => ({
  version: 2, parser: "fallback", parserNote: "", parsedAt: "", title: null, abstract: null,
  pageSizes: [{ page: 1, width: 600, height: 800 }], sections: [], sentences,
});

test("グリフの対応が取れないページ（xs が無い・8 割未満・大きさが違う）は使わず、枠はそのまま", () => {
  const item = (str: string, xs?: Float64Array) => ({ str, rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.02 }, xs });
  const nan = (n: number) => new Float64Array(n * 2).fill(NaN);
  assert.equal(glyphPagesFromText([{ page: 1, width: 600, height: 800, items: [item("Hello world")] }], structureOf([]).pageSizes).length, 0);
  assert.equal(glyphPagesFromText([{ page: 1, width: 600, height: 800, items: [item("Hello", nan(5))] }], structureOf([]).pageSizes).length, 0);
  const good = new Float64Array([0.1, 0.11, 0.11, 0.12, 0.12, 0.13, 0.13, 0.14, 0.14, 0.15]);
  assert.equal(glyphPagesFromText([{ page: 1, width: 600, height: 800, items: [item("Hello", good)] }], structureOf([]).pageSizes).length, 1);
  assert.equal(glyphPagesFromText([{ page: 1, width: 800, height: 600, items: [item("Hello", good)] }], structureOf([]).pageSizes).length, 0);

  const s = sentence("Hello there.", [{ x: 61, y: 80, w: 30, h: 10 }]);
  const { structure } = refineStructureRects(structureOf([s]), []);
  assert.equal(structure.rectEdges, "estimate");
  assert.deepEqual(structure.sentences[0].rects, s.rects);
});

test("構造全体: 本文と nonBody の端を合わせ、rectEdges を glyph にする", () => {
  const line = "Intro text ends.   Figure 1: The pipeline.";
  const glyphs = layLine(line, 72, 100, latin, 6);
  const f = at(glyphs, line, "F");
  const s = sentence("Intro text ends.", [{ x: 72, y: 100, w: f.x0 - 72, h: 10 }]);
  const nb = { ...sentence("Figure 1: The pipeline.", [{ x: f.x0 - 8, y: 100, w: glyphs[glyphs.length - 1].x1 - f.x0 + 8, h: 10 }]), kind: "caption" as const, afterOrder: 0, afterHash: "h" };
  const { structure, stats } = refineStructureRects({ ...structureOf([s]), nonBody: [nb] }, [{ page: 1, glyphs }]);
  assert.equal(structure.rectEdges, "glyph");
  close(structure.sentences[0].rects[0].x + structure.sentences[0].rects[0].w, at(glyphs, line, ".", 0).x1, "本文の文末");
  close(structure.nonBody![0].rects[0].x, f.x0, "nonBody の文頭");
  assert.equal(stats.startSnapped + stats.endSnapped, 2);
});

test("枠の縦を、その行のグリフの帯に合わせる（古い式の 0.25em 上ずれを直す）。何行にもまたがる枠は潰さない", () => {
  const line = "Every block keeps its top scoring keys.";
  // グリフの帯は y=100〜110。古い解析の枠は 2.4pt 上にずれている
  const glyphs = layLine(line, 72, 100, latin, 3);
  const last = glyphs[glyphs.length - 1];
  const s = sentence(line, [{ x: 72, y: 97.6, w: last.x1 - 72, h: 10 }]);
  const { structure, stats } = refineStructureRects(structureOf([s]), [{ page: 1, glyphs }]);
  const r = structure.sentences[0].rects[0];
  close(r.y, 100, "上端");
  close(r.h, 10, "高さ");
  assert.equal(stats.bandSnapped, 1);
  assert.equal(structure.rectBand, RECT_BAND_VERSION);

  // 図の中の文字をまとめた背の高い枠（付物）は、1 行の帯にしない
  const tall = sentence(line, [{ x: 72, y: 90, w: last.x1 - 72, h: 40 }]);
  assert.equal(refineSentenceRects(tall, pages(glyphs)).rects[0].h, 40);
});

test("行の途中の端（文頭・文末ではない行末）が字を割っていたら、その字の端へ寄せる", () => {
  const l1 = layLine("The first line of a long sentence", 72, 100, latin, 3);
  const l2 = layLine("ends on the second line.", 72, 112, latin, 3);
  const end1 = l1[l1.length - 1];
  const s = sentence("The first line of a long sentence ends on the second line.", [
    // 1 行目の右端が最後の字の 8 割のところで止まっている（両端揃えの行末の見積もり）
    { x: 72, y: 100, w: end1.x0 + (end1.x1 - end1.x0) * 0.8 - 72, h: 10 },
    { x: 72, y: 112, w: l2[l2.length - 1].x1 - 72, h: 10 },
  ]);
  const out = refineSentenceRects(s, pages([...l1, ...l2]));
  close(out.rects[0].x + out.rects[0].w, end1.x1, "1 行目の右端");
});
