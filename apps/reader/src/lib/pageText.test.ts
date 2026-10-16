// 項目の位置（行の帯・回転したページ）を求める pageText.ts の単体テスト。
import assert from "node:assert/strict";
import { test } from "node:test";
import { fromDisplay, layoutItems, mergeLineRects, segmentRects, textRotation, toDisplay } from "./pageText.ts";

const close = (a: number, b: number, what: string, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${what}: ${a} != ${b}`);

/** 幅 600・高さ 800 のページの、回転 r のビューポート（pdf.js の PageViewport.transform と同じ式） */
function viewport(r: number) {
  const W = 600;
  const H = 800;
  switch (r) {
    case 90:
      return { transform: [0, 1, 1, 0, 0, 0], width: H, height: W, scale: 1 };
    case 180:
      return { transform: [-1, 0, 0, 1, W, 0], width: W, height: H, scale: 1 };
    case 270:
      return { transform: [0, -1, -1, 0, H, W], width: H, height: W, scale: 1 };
    default:
      return { transform: [1, 0, 0, -1, 0, H], width: W, height: H, scale: 1 };
  }
}

test("項目の縦は書体の ascent / descent から決めた帯（Computer Modern は 1em に伸ばす）", () => {
  // ベースライン y=700（PDF の座標）＝上から 100、10pt の字
  const [it] = layoutItems(
    [{ str: "hello", transform: [10, 0, 0, 10, 60, 700], width: 30, fontName: "F1", hasEOL: true }],
    { F1: { ascent: 0.678, descent: -0.216 } },
    viewport(0),
  );
  close(it.rect.x * 600, 60, "左端");
  close(it.rect.w * 600, 30, "幅");
  close(it.rect.y * 800, 100 - 7.584, "上端", 1e-3);
  close((it.rect.y + it.rect.h) * 800, 100 + 2.416, "下端", 1e-3);
  assert.equal(it.hasEOL, true);
});

test("書体の値が無い項目は既定の帯（−0.8em 〜 +0.2em）", () => {
  const [it] = layoutItems([{ str: "x", transform: [10, 0, 0, 10, 0, 700], width: 5, fontName: "F9" }], { F9: { ascent: 0, descent: 0 } }, viewport(0));
  close(it.rect.y * 800, 92, "上端");
  close((it.rect.y + it.rect.h) * 800, 102, "下端");
});

test("文字が横に流れる向きを選ぶ: /Rotate だけ立てたページは 0、中身ごと回したページは表示の向き", () => {
  const upright = [{ str: "Upright text in the page", transform: [10, 0, 0, 10, 60, 700], width: 120 }];
  assert.equal(textRotation(upright, 90, viewport), 0);
  assert.equal(textRotation(upright, 0, viewport), 0);
  // 反時計回りに 90 度回して描いた字（pdflscape で中身ごと回したページ）
  const turned = [{ str: "Turned text in the page", transform: [0, 10, -10, 0, 100, 60], width: 120 }];
  assert.equal(textRotation(turned, 90, viewport), 90);
  // 文字が無ければ表示の向きのまま
  assert.equal(textRotation([], 270, viewport), 270);
});

test("フレームの矩形を表示の向きへ回し、点を戻す（90 / 180 / 270 度）", () => {
  const r = { x: 0.1, y: 0.2, w: 0.3, h: 0.05 };
  const cases: [number, { x: number; y: number; w: number; h: number }][] = [
    [0, r],
    [90, { x: 0.75, y: 0.1, w: 0.05, h: 0.3 }],
    [180, { x: 0.6, y: 0.75, w: 0.3, h: 0.05 }],
    [270, { x: 0.2, y: 0.6, w: 0.05, h: 0.3 }],
  ];
  for (const [d, want] of cases) {
    const got = toDisplay(r, d);
    for (const k of ["x", "y", "w", "h"] as const) close(got[k], want[k], `${d} 度の ${k}`);
    // 表示の向きの左上の点を戻すと、フレームの矩形の角のどれかになる
    const [fx, fy] = fromDisplay(got.x + got.w / 2, got.y + got.h / 2, d);
    close(fx, r.x + r.w / 2, `${d} 度で戻した中心の x`);
    close(fy, r.y + r.h / 2, `${d} 度で戻した中心の y`);
  }
});

test("文字範囲の矩形: 横はグリフの位置、縦は項目の帯。同じ行の項目は外接矩形にまとめる", () => {
  const xs = new Float64Array([0.1, 0.11, 0.11, 0.125, 0.125, 0.13]); // "abc" の 3 文字
  const items = [
    { str: "abc", rect: { x: 0.1, y: 0.5, w: 0.03, h: 0.012 }, hasEOL: false, xs },
    { str: "2", rect: { x: 0.13, y: 0.496, w: 0.005, h: 0.008 }, hasEOL: true }, // 上付き（グリフの位置なし）
    { str: "next", rect: { x: 0.1, y: 0.52, w: 0.04, h: 0.012 }, hasEOL: false },
  ];
  const rects = segmentRects(items, [
    { k: 0, a: 1, b: 3 },
    { k: 1, a: 0, b: 1 },
    { k: 2, a: 0, b: 2 },
  ]);
  assert.equal(rects.length, 2);
  close(rects[0].x, 0.11, "1 行目の左端（グリフ b の左端）");
  close(rects[0].x + rects[0].w, 0.135, "1 行目の右端（上付きの字まで）");
  close(rects[0].y, 0.496, "1 行目の上端（上付きの字の帯まで）");
  close(rects[1].x + rects[1].w, 0.12, "2 行目の右端（按分）");
});

test("別の段の矩形はまとめない", () => {
  const out = mergeLineRects([
    { x: 0.1, y: 0.5, w: 0.3, h: 0.012 },
    { x: 0.55, y: 0.5, w: 0.3, h: 0.012 },
  ]);
  assert.equal(out.length, 2);
});
