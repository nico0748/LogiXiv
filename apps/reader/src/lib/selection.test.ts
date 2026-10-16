// マウスで選んだ範囲の端を、押した・離した位置とグリフの位置から決め直す selection.ts の単体テスト。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LaidItem } from "./pageText.ts";
import { segmentText, snapSegments } from "./selection.ts";

/** 1 行を 1 項目にする。字幅は 0.01、空白は 0.005（ページ幅に対する割合）。 */
function line(str: string, x: number, y: number, hasEOL = true): LaidItem {
  const xs = new Float64Array(str.length * 2);
  let cx = x;
  for (let c = 0; c < str.length; c++) {
    const w = str[c] === " " ? 0.005 : 0.01;
    xs[c * 2] = cx;
    xs[c * 2 + 1] = cx + w;
    cx += w;
  }
  return { str, rect: { x, y, w: cx - x, h: 0.012 }, hasEOL, xs };
}
/** 項目 it の c 文字目のグリフの、左端から frac の位置 */
const at = (it: LaidItem, c: number, frac: number) => ({ x: it.xs![c * 2] + (it.xs![c * 2 + 1] - it.xs![c * 2]) * frac, y: it.rect.y + 0.006 });

const items = [line("Alpha beta gamma.", 0.1, 0.5), line("Delta epsilon zeta.", 0.1, 0.515)];

test("テキスト層のずれで 1 文字先から始まった選択を、押したグリフから始め直す", () => {
  // "beta" の b（6 文字目）の左寄りを押したが、ブラウザは e から選んだ
  const native = [{ k: 0, a: 7, b: 10 }];
  const out = snapSegments(items, native, at(items[0], 6, 0.3), at(items[0], 9, 0.7));
  assert.deepEqual(out, [{ k: 0, a: 6, b: 10 }]);
  assert.equal(segmentText(items, out), "beta");
});

test("最後の 1 文字が落ちた選択を、離したグリフまで伸ばす", () => {
  const native = [{ k: 0, a: 6, b: 9 }]; // "bet"
  const out = snapSegments(items, native, at(items[0], 6, 0.3), at(items[0], 9, 0.7));
  assert.deepEqual(out, [{ k: 0, a: 6, b: 10 }]);
});

test("グリフの右半分で押したら次の字から、左半分で離したら前の字まで（ブラウザと同じ規則）", () => {
  const native = [{ k: 0, a: 6, b: 10 }];
  const out = snapSegments(items, native, at(items[0], 6, 0.7), at(items[0], 9, 0.3));
  assert.deepEqual(out, [{ k: 0, a: 7, b: 9 }]);
});

test("後ろから前へのドラッグ（呼び出し側が文書の順の前の端・後ろの端に直して渡す）でも同じ", () => {
  // 離した位置（前の端）が start、押した位置（後ろの端）が end
  const native = [{ k: 0, a: 7, b: 9 }];
  const out = snapSegments(items, native, at(items[0], 6, 0.2), at(items[0], 9, 0.8));
  assert.deepEqual(out, [{ k: 0, a: 6, b: 10 }]);
});

test("複数行: 最初の行と最後の行の端だけを直し、間はそのまま", () => {
  const native = [
    { k: 0, a: 12, b: 17 }, // "amma."（g が落ちた）
    { k: 1, a: 0, b: 12 }, // "Delta epsilo"（n が落ちた）
  ];
  const out = snapSegments(items, native, at(items[0], 11, 0.4), at(items[1], 12, 0.6));
  assert.deepEqual(out, [
    { k: 0, a: 11, b: 17 },
    { k: 1, a: 0, b: 13 },
  ]);
  assert.equal(segmentText(items, out), "gamma.\nDelta epsilon");
});

test("押した位置が行から外れている・遠すぎるときは、ブラウザの選択のまま", () => {
  const native = [{ k: 0, a: 6, b: 10 }];
  // 行の下の余白で押した
  assert.deepEqual(snapSegments(items, native, { x: at(items[0], 2, 0.5).x, y: 0.6 }, null), native);
  // 4 文字以上離れた位置（別の操作の位置が残っていたなど）
  assert.deepEqual(snapSegments(items, native, at(items[0], 0, 0.3), null), native);
  // 位置が無い（キーボードで選んだ）
  assert.deepEqual(snapSegments(items, native, null, null), native);
});

test("決め直すと範囲が裏返るときは、ブラウザの選択のまま", () => {
  const native = [{ k: 0, a: 6, b: 7 }];
  const out = snapSegments(items, native, at(items[0], 7, 0.8), at(items[0], 6, 0.2));
  assert.deepEqual(out, native);
});

test("同じ行の別の項目（式の 1 文字など）へも端を移せる", () => {
  const its = [line("query block", 0.1, 0.5, false), { ...line(" ", 0.205, 0.5, false), xs: undefined }, line("i", 0.21, 0.5)];
  // ブラウザは "block" で止まったが、離したのは i の右寄り
  const out = snapSegments(its, [{ k: 0, a: 0, b: 11 }], at(its[0], 0, 0.2), at(its[2], 0, 0.7));
  assert.deepEqual(out, [
    { k: 0, a: 0, b: 11 },
    { k: 2, a: 0, b: 1 },
  ]);
  assert.equal(segmentText(its, out), "query block i");
});
