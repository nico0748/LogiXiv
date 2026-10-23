import assert from "node:assert/strict";
import { test } from "node:test";
import { TOUR_CLOSED, TOUR_STEPS, isTourDisabled, placePopover, readRecord, shouldAutoStart, tourReducer } from "./tour.ts";

test("手順は 5〜8 個で、id は重ならない", () => {
  assert.ok(TOUR_STEPS.length >= 5 && TOUR_STEPS.length <= 8);
  assert.equal(new Set(TOUR_STEPS.map((s) => s.id)).size, TOUR_STEPS.length);
  for (const s of TOUR_STEPS) assert.ok(s.targets.length > 0 && s.body.length > 0, s.id);
});

test("自動で始めるのは、記録が無く、あとでを押しておらず、無効の指定も無いときだけ", () => {
  assert.equal(shouldAutoStart({ record: null, later: false, disabled: false }), true);
  assert.equal(shouldAutoStart({ record: "done", later: false, disabled: false }), false);
  assert.equal(shouldAutoStart({ record: "off", later: false, disabled: false }), false);
  assert.equal(shouldAutoStart({ record: null, later: true, disabled: false }), false);
  assert.equal(shouldAutoStart({ record: null, later: false, disabled: true }), false);
});

test("無効の指定: ?notour か、全体の印が true", () => {
  assert.equal(isTourDisabled("?notour", undefined), true);
  assert.equal(isTourDisabled("?a=1&notour=1", undefined), true);
  assert.equal(isTourDisabled("", true), true);
  assert.equal(isTourDisabled("", "yes"), false);
  assert.equal(isTourDisabled("?tour", undefined), false);
  assert.equal(readRecord("done"), "done");
  assert.equal(readRecord("whatever"), null);
});

test("進め方: 前後に動き、端では止まり、最後の次で閉じる", () => {
  let s = tourReducer(TOUR_CLOSED, { type: "start" }, 3);
  assert.deepEqual(s, { open: true, index: 0 });
  s = tourReducer(s, { type: "prev" }, 3);
  assert.equal(s.index, 0);
  s = tourReducer(tourReducer(s, { type: "next" }, 3), { type: "next" }, 3);
  assert.deepEqual(s, { open: true, index: 2 });
  assert.deepEqual(tourReducer(s, { type: "next" }, 3), TOUR_CLOSED);
  assert.deepEqual(tourReducer(s, { type: "go", index: 9 }, 3), { open: true, index: 2 });
  assert.deepEqual(tourReducer(s, { type: "later" }, 3), TOUR_CLOSED);
  // 閉じているときは動かない
  assert.deepEqual(tourReducer(TOUR_CLOSED, { type: "next" }, 3), TOUR_CLOSED);
});

test("吹き出しの位置: 右に入れば右、入らなければ左・下、狭い窓では下の帯", () => {
  const view = { width: 1200, height: 800 };
  const pop = { width: 320, height: 200 };
  assert.equal(placePopover({ left: 0, top: 100, width: 44, height: 600 }, pop, view).placement, "right");
  assert.equal(placePopover({ left: 1100, top: 100, width: 100, height: 100 }, pop, view).placement, "left");
  assert.equal(placePopover({ left: 0, top: 0, width: 1200, height: 300 }, pop, view).placement, "bottom");
  const big = placePopover({ left: 0, top: 0, width: 1200, height: 800 }, pop, view);
  assert.equal(big.placement, "center");
  assert.ok(big.top >= 16 && big.top + pop.height <= view.height);
  const narrow = placePopover({ left: 0, top: 0, width: 44, height: 600 }, pop, { width: 400, height: 800 });
  assert.equal(narrow.placement, "sheet");
  assert.equal(placePopover(null, pop, view).placement, "center");
  // 縦は窓に収める
  const low = placePopover({ left: 0, top: 760, width: 44, height: 40 }, pop, view);
  assert.ok(low.top + pop.height <= view.height - 16);
});
