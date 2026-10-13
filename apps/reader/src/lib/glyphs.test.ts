// マーカーの端を文字に合わせるための、グリフ位置の計算の単体テスト。
import assert from "node:assert/strict";
import { test } from "node:test";
import { attachGlyphs, charSpan, layoutGlyphs, type Ops } from "./glyphs.ts";

const OPS: Ops = {
  save: 10, restore: 11, transform: 12, beginText: 31, setCharSpacing: 33, setWordSpacing: 34, setHScale: 35,
  setLeading: 36, setFont: 37, setTextRise: 39, moveText: 40, setLeadingMoveText: 41, setTextMatrix: 42,
  nextLine: 43, showText: 44, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75,
};
// 高さ 800 のページ（PDF の y は下から上へ）
const VIEWPORT = [1, 0, 0, -1, 0, 800];
const font = { fontMatrix: [0.001, 0, 0, 0.001, 0, 0] };
const g = (unicode: string, width: number) => ({ unicode, width, isSpace: unicode === " " });

test("文字送りを canvas.js と同じ式で求める（字幅・TJ の詰め・字間・語間・水平倍率）", () => {
  const fn = [OPS.beginText, OPS.setFont, OPS.setCharSpacing, OPS.setWordSpacing, OPS.setTextMatrix, OPS.showText];
  const args = [
    [],
    ["F1", 10],
    [1],
    [3],
    [[1, 0, 0, 1, 100, 700]],
    [[g("W", 1000), -500, g("i", 250), g(" ", 300), g("j", 250)]],
  ];
  const out = layoutGlyphs(OPS, fn, args, () => font, VIEWPORT);
  assert.deepEqual(
    out.map((x) => [x.ch, +x.x0.toFixed(3), +x.x1.toFixed(3)]),
    [
      ["W", 100, 110], // 1000/1000 * 10pt
      ["i", 116, 118.5], // + 字間 1 + TJ の 500 で 5pt 空く
      [" ", 119.5, 122.5],
      ["j", 126.5, 129], // 空白の後は字間 1 + 語間 3
    ],
  );

  // 水平倍率 50% と、2 回目の showText は前の続きから
  const out2 = layoutGlyphs(
    OPS,
    [OPS.beginText, OPS.setFont, OPS.setHScale, OPS.moveText, OPS.showText, OPS.showText],
    [[], ["F1", 10], [50], [50, 600], [[g("a", 500)]], [[g("b", 500)]]],
    () => font,
    VIEWPORT,
  );
  assert.deepEqual(out2.map((x) => [x.ch, x.x0, x.x1]), [["a", 50, 52.5], ["b", 52.5, 55]]);
});

test("cm（transform）と save/restore、フォーム XObject の行列を反映する", () => {
  const out = layoutGlyphs(
    OPS,
    [OPS.save, OPS.transform, OPS.beginText, OPS.setFont, OPS.moveText, OPS.showText, OPS.restore, OPS.paintFormXObjectBegin, OPS.beginText, OPS.setFont, OPS.showText, OPS.paintFormXObjectEnd],
    [[], [2, 0, 0, 2, 10, 0], [], ["F1", 10], [5, 0], [[g("x", 500)]], [], [[1, 0, 0, 1, 300, 0], null], [], ["F1", 10], [[g("y", 500)]], []],
    () => font,
    VIEWPORT,
  );
  assert.deepEqual(out.map((x) => [x.ch, x.x0, x.x1]), [["x", 20, 30], ["y", 300, 305]]);
});

test("縦書きや回転した文字は返さない（呼び出し側は按分に戻る）", () => {
  const rotated = layoutGlyphs(OPS, [OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText], [[], ["F1", 10], [[0, 1, -1, 0, 100, 100]], [[g("a", 500)]]], () => font, VIEWPORT);
  assert.equal(rotated.length, 0);
  const vertical = layoutGlyphs(OPS, [OPS.beginText, OPS.setFont, OPS.showText], [[], ["F1", 10], [[g("あ", 1000)]]], () => ({ ...font, vertical: true }), VIEWPORT);
  assert.equal(vertical.length, 0);
});

test("テキストの項目の各文字にグリフの位置を割り当てる（合字・補った空白・余分なグリフを越えて同期する）", () => {
  const glyphs = [
    { ch: "ﬁ", x0: 0, x1: 10 }, // 合字は NFKC で fi の 2 文字に分ける
    { ch: "n", x0: 10, x1: 15 },
    { ch: "e", x0: 15, x1: 20 },
    { ch: "*", x0: 20, x1: 22 }, // テキストに無い記号
    { ch: "日", x0: 30, x1: 40 },
    { ch: "本", x0: 40, x1: 50 },
    { ch: "語", x0: 50, x1: 60 },
  ];
  const xs = attachGlyphs(["fine ", "日本語"], glyphs, 100);
  assert.ok(xs);
  const at = (i: number, c: number) => [xs[i][c * 2], xs[i][c * 2 + 1]];
  assert.deepEqual(at(0, 0), [0, 0.05]);
  assert.deepEqual(at(0, 1), [0.05, 0.1]);
  assert.deepEqual(at(0, 3), [0.15, 0.2]);
  assert.ok(Number.isNaN(xs[0][4 * 2])); // 空白は割り当てない
  assert.deepEqual(at(1, 0), [0.3, 0.4]);
  assert.deepEqual(at(1, 2), [0.5, 0.6]);
  // ほとんど対応しないページは使わない
  assert.equal(attachGlyphs(["abcdef"], [{ ch: "x", x0: 0, x1: 1 }], 100), null);
});

test("文の途中から途中までの横の範囲は、文字数ではなくグリフの位置で決まる", () => {
  const str = "WWii";
  const xs = new Float64Array([0, 0.1, 0.1, 0.2, 0.2, 0.22, 0.22, 0.24]);
  const rect = { x: 0, y: 0, w: 0.24, h: 0.01 };
  assert.deepEqual(charSpan(str, xs, rect, 2, 4), [0.2, 0.24]);
  // 文字数で按分すると 0.12〜0.24 になってしまう
  assert.deepEqual(charSpan(str, null, rect, 2, 4), [0.12, 0.24]);
  // 位置の分からない文字だけ按分で補う。空白だけなら null
  const partial = new Float64Array([0, 0.1, NaN, NaN, 0.2, 0.22, 0.22, 0.24]);
  assert.deepEqual(charSpan(str, partial, rect, 0, 2), [0, 0.12]);
  assert.equal(charSpan("a  b", null, rect, 1, 3), null);
});
