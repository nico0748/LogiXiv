import assert from "node:assert/strict";
import { test } from "node:test";
import { type Annotations, type Highlight, type Term, applyOps, diffAnnotations, emptyAnnotations } from "./model.ts";

const h = (id: string, extra: Partial<Highlight> = {}): Highlight => ({
  id, page: 1, rects: [{ x: 0, y: 0, w: 1, h: 1 }], text: id, color: "yellow", translation: "", memo: "", createdAt: "", ...extra,
});
const t = (id: string): Term => ({ id, term: id, reading: "", short: "", detail: "", inPaper: "", related: [], createdAt: "" });

test("差分を当てると同じ内容になる", () => {
  const base: Annotations = { ...emptyAnnotations(), highlights: [h("a"), h("b")], terms: [t("x")] };
  const next: Annotations = { ...emptyAnnotations(), highlights: [h("a", { translation: "訳" }), h("c")], terms: [t("y"), t("z"), t("x")] };
  assert.deepEqual(applyOps(base, diffAnnotations(base, next)), next);
});

test("別の書き手の追加を消さない", () => {
  const base: Annotations = { ...emptyAnnotations(), highlights: [h("a")] };
  const mine: Annotations = { ...base, highlights: [h("a", { memo: "画面のメモ" })] };
  const theirs: Annotations = { ...base, highlights: [h("a"), h("agent", { translation: "エージェントの訳" })], terms: [t("agent-term")] };
  const merged = applyOps(theirs, diffAnnotations(base, mine));
  assert.equal(merged.highlights.length, 2);
  assert.equal(merged.highlights[0].memo, "画面のメモ");
  assert.equal(merged.highlights[1].translation, "エージェントの訳");
  assert.equal(merged.terms.length, 1);
});

test("更新は変わった項目だけを送る", () => {
  const base: Annotations = { ...emptyAnnotations(), highlights: [h("a")] };
  const next: Annotations = { ...base, highlights: [h("a", { translation: "訳" })] };
  assert.deepEqual(diffAnnotations(base, next), [{ op: "update", list: "highlights", id: "a", patch: { translation: "訳" } }]);
});

test("消えた項目は削除し、無い項目への更新は無視する", () => {
  const base: Annotations = { ...emptyAnnotations(), terms: [t("x"), t("y")] };
  const out = applyOps(base, [{ op: "remove", list: "terms", id: "x" }, { op: "update", list: "terms", id: "nope", patch: { short: "?" } }]);
  assert.deepEqual(out.terms.map((x) => x.id), ["y"]);
});

test("数式はページ順、同じページは見出しの番号順、ページの無いものは先頭", async () => {
  const { sortEquationsByPage, renderEquations } = await import("./model.ts");
  const e = (id: string, label: string, page?: number) => ({ id, label, tex: id, explanation: "", source: "", page, createdAt: "" });
  const list = [e("c", "式(10)", 5), e("a", "式(2)", 2), e("hand", "式31"), e("b", "式(9)", 5), e("z", "式(1)", 2)];
  assert.deepEqual(sortEquationsByPage(list).map((x) => x.id), ["hand", "z", "a", "b", "c"]);
  assert.deepEqual(list.map((x) => x.id), ["c", "a", "hand", "b", "z"], "元の配列は並べ替えない");
  const md = renderEquations(list);
  assert.ok(md.indexOf("式(9)") < md.indexOf("式(10)"));
});
