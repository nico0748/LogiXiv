import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type FormulaItem,
  type VocabItem,
  countByPaper,
  filterFormulas,
  filterVocab,
  mergeVocab,
  sectionsByPaper,
  sortFormulas,
  sortVocabRows,
} from "./lists.ts";

const v = (term: string, extra: Partial<VocabItem> = {}): VocabItem => ({
  key: `${extra.paperId ?? "p1"}:${term}`, paperId: "p1", paperTitle: "論文A", source: "term", term, meaning: "", ...extra,
});
const f = (label: string, extra: Partial<FormulaItem> = {}): FormulaItem => ({
  key: `${extra.paperId ?? "p1"}:${label}`, paperId: "p1", paperTitle: "論文A", id: label, label, tex: "x", explanation: "", ...extra,
});

test("用語は語・読み・意味・詳細・論文名のどれでも見つかる（全角半角・大小は無視）", () => {
  const items = [
    v("Attention", { meaning: "注意機構" }),
    v("埋め込み", { reading: "うめこみ", detail: "ベクトルにする" }),
    v("損失", { paperId: "p2", paperTitle: "Sparse Window" }),
  ];
  assert.deepEqual(filterVocab(items, "ＡＴＴＥＮＴＩＯＮ").map((x) => x.term), ["Attention"]);
  assert.deepEqual(filterVocab(items, "うめ").map((x) => x.term), ["埋め込み"]);
  assert.deepEqual(filterVocab(items, "ベクトル").map((x) => x.term), ["埋め込み"]);
  assert.deepEqual(filterVocab(items, "sparse").map((x) => x.term), ["損失"]);
  assert.deepEqual(filterVocab(items, "注意 attention").map((x) => x.term), ["Attention"]);
  assert.equal(filterVocab(items, "  ").length, 3);
  assert.deepEqual(filterVocab(items, "", "p2").map((x) => x.term), ["損失"]);
});

test("数式はラベル・TeX・説明で見つかる", () => {
  const items = [f("式1", { tex: "\\softmax(QK^T)" }), f("式2", { explanation: "正規化" })];
  assert.deepEqual(filterFormulas(items, "softmax").map((x) => x.label), ["式1"]);
  assert.deepEqual(filterFormulas(items, "正規").map((x) => x.label), ["式2"]);
});

test("同じ用語は論文をまたいで1行にまとめ、読みを補う", () => {
  const rows = mergeVocab([
    v("Transformer", { paperId: "p2", paperTitle: "論文B", meaning: "B での意味" }),
    v("transformer ", { paperId: "p1", reading: "トランスフォーマー", meaning: "A での意味" }),
    v("RNN"),
  ]);
  assert.equal(rows.length, 2);
  const t = rows.find((r) => r.term === "Transformer")!;
  assert.equal(t.reading, "トランスフォーマー");
  assert.deepEqual(t.entries.map((e) => e.paperTitle), ["論文A", "論文B"]);
});

test("五十音順は読みを使い、かなと英字を混ぜても並ぶ", () => {
  const rows = sortVocabRows(mergeVocab([v("埋め込み", { reading: "うめこみ" }), v("アテンション"), v("勾配", { reading: "こうばい" })]));
  assert.deepEqual(rows.map((r) => r.term), ["アテンション", "埋め込み", "勾配"]);
  assert.deepEqual(sortFormulas([f("式10"), f("式2"), f("式1")]).map((x) => x.label), ["式1", "式2", "式10"]);
});

test("論文ごとに分け、中はページ順", () => {
  const s = sectionsByPaper(
    [v("b", { page: 3 }), v("a"), v("c", { page: 1 }), v("z", { paperId: "p0", paperTitle: "あ論文" })],
    (x) => x.term,
  );
  assert.deepEqual(s.map((x) => x.title), ["あ論文", "論文A"]);
  assert.deepEqual(s[1].items.map((x) => x.term), ["c", "b", "a"]);
  assert.deepEqual(countByPaper([v("a"), v("b"), v("c", { paperId: "p0", paperTitle: "あ論文" })]), [
    { paperId: "p0", title: "あ論文", count: 1 },
    { paperId: "p1", title: "論文A", count: 2 },
  ]);
});
