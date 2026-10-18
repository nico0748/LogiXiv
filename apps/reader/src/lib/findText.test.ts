import assert from "node:assert/strict";
import { test } from "node:test";
import { findText, type PageText, termNeedles } from "./findText.ts";

test("用語の見出しから探す語: そのまま、括弧の中の原語、括弧の前", () => {
  assert.deepEqual(termNeedles("自己注意（self-attention）"), ["自己注意（self-attention）", "self-attention", "自己注意"]);
  assert.deepEqual(termNeedles("Transformer"), ["Transformer"]);
  assert.deepEqual(termNeedles("reservoir (RC)"), ["reservoir (RC)", "RC", "reservoir"]);
});

test("語の位置を大文字小文字・空白の違いを無視して探す", () => {
  const item = (str: string, x: number, y: number) => ({ str, rect: { x, y, w: str.length * 0.01, h: 0.02 }, hasEOL: false });
  const pages: PageText[] = [
    { page: 1, width: 600, height: 800, rotation: 0, text: "Intro", items: [item("Intro", 0.1, 0.1)] },
    { page: 2, width: 600, height: 800, rotation: 0, text: "uses Self Attention here", items: [item("uses Self Attention here", 0.1, 0.5)] },
  ];
  const m = findText(pages, "self-attention".replace("-", " "));
  assert.equal(m?.page, 2);
  assert.ok(m && m.rects.length === 1 && Math.abs(m.rects[0].x - 0.15) < 1e-9 && m.rects[0].y === 0.5);
  assert.equal(findText(pages, "self attention", 1), null);
});
