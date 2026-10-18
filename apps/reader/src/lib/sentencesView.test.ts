import assert from "node:assert/strict";
import { test } from "node:test";
import type { NonBodySentence, PaperDocument, Sentence } from "@paperlens/core";
import type { Equation } from "./model.ts";
import {
  buildRows,
  equationNumber,
  matchEquation,
  filterNonBody,
  filterSentences,
  formatElapsed,
  hitTest,
  marksByPage,
  moveTarget,
  qualityCaveats,
  sentenceAnchor,
  sentenceProgress,
  successorSentence,
  toPageFraction,
  wordBoundaries,
} from "./sentencesView.ts";

const s = (order: number, text: string, extra: Partial<Sentence> = {}): Sentence => ({
  id: `s${order}`,
  hash: `h-${text}`,
  order,
  page: 1,
  text,
  rects: [{ page: 1, x: 100, y: 200 + order * 20, w: 300, h: 10 }],
  sectionId: "sec1",
  ...extra,
});

function doc(sentences: Sentence[], extra: Partial<PaperDocument["structure"]> = {}): PaperDocument {
  return {
    id: "p",
    title: "t",
    sourceFileName: "p.pdf",
    createdAt: "",
    updatedAt: "",
    structure: {
      version: 1,
      parser: "grobid",
      parserNote: "",
      parsedAt: "",
      title: null,
      abstract: null,
      pageSizes: [{ page: 1, width: 600, height: 800 }],
      sections: [{ id: "sec1", title: "Introduction", level: 1, order: 0 }, { id: "sec2", title: "Method", level: 1, order: 1 }],
      sentences,
      ...extra,
    },
    annotations: { translations: {}, notes: [], glossary: [], skipped: {}, sentenceEdits: [] },
  };
}

test("PDF 座標をページの割合に直す", () => {
  const f = toPageFraction({ page: 1, x: 60, y: 80, w: 120, h: 40 }, [{ page: 1, width: 600, height: 800 }]);
  assert.deepEqual(f, { page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.05 });
  assert.equal(toPageFraction({ page: 2, x: 0, y: 0, w: 1, h: 1 }, [{ page: 1, width: 600, height: 800 }]), null);
});

test("ページからはみ出す矩形は切り詰める", () => {
  const f = toPageFraction({ page: 1, x: 500, y: -10, w: 200, h: 20 }, [{ page: 1, width: 600, height: 800 }])!;
  assert.equal(f.x + f.w, 1);
  assert.equal(f.y, 0);
});

test("マーカーをページごとにまとめ、点に重なる文を引く", () => {
  const d = doc([s(0, "A b."), s(1, "C d.")]);
  d.annotations.translations["h-A b."] = { sentenceHash: "h-A b.", text: "訳", revisedByHuman: false, source: "claude", updatedAt: "" };
  const marks = marksByPage(d).get(1)!;
  assert.equal(marks.length, 2);
  assert.equal(marks[0]!.translated, true);
  assert.equal(hitTest(marks, 0.3, (200 + 20 + 5) / 800)?.id, "s1");
  assert.equal(hitTest(marks, 0.9, 0.9), null);
});

test("文の位置（スクロール先）", () => {
  const d = doc([s(0, "A."), s(1, "B.", { rects: [], page: 3 })]);
  assert.deepEqual(sentenceAnchor(d, "s0"), { page: 1, y: 200 / 800 });
  assert.deepEqual(sentenceAnchor(d, "s1"), { page: 3, y: 0 });
  assert.equal(sentenceAnchor(d, "nope"), null);
});

test("検索は原文・訳文・メモを見る。未訳だけは訳さない文も外す", () => {
  const d = doc([s(0, "Alpha."), s(1, "Beta."), s(2, "Gamma.")]);
  d.annotations.translations["h-Alpha."] = { sentenceHash: "h-Alpha.", text: "アルファ", revisedByHuman: true, source: "human", updatedAt: "" };
  d.annotations.skipped = { "h-Gamma.": { sentenceHash: "h-Gamma.", reason: "", at: "" } };
  d.annotations.notes.push({ id: "n1", sentenceHash: "h-Beta.", body: "要確認", author: null, createdAt: "", updatedAt: "" });
  assert.deepEqual(filterSentences(d, { query: "アルファ", onlyUntranslated: false }).map((x) => x.id), ["s0"]);
  assert.deepEqual(filterSentences(d, { query: "要確認", onlyUntranslated: false }).map((x) => x.id), ["s1"]);
  assert.deepEqual(filterSentences(d, { query: "", onlyUntranslated: true }).map((x) => x.id), ["s1"]);
  assert.deepEqual(sentenceProgress(d), { total: 3, translated: 1, skipped: 1, remaining: 1, occurrences: 3 });
});

test("並びに節の見出しと訳さない行が差し込まれる", () => {
  const nb: NonBodySentence = { ...s(9, "[1] Ref."), id: "nb1", kind: "reference", afterOrder: 2, afterHash: "h-C." };
  const d = doc([s(0, "A."), s(1, "B.", { sectionId: "sec2" }), s(2, "C.", { sectionId: "sec2" })], { nonBody: [nb] });
  const all = filterSentences(d, { query: "", onlyUntranslated: false });
  const rows = buildRows(d, all, filterNonBody(d.structure, { query: "", onlyUntranslated: false }));
  assert.deepEqual(rows.map((r) => r.kind), ["heading", "sentence", "heading", "sentence", "sentence", "nonbody"]);
  const first = rows[1]!;
  assert.ok(first.kind === "sentence" && first.next?.id === "s1" && first.mergeCount === 1);
  // 未訳だけのときは訳さない行を出さない
  assert.equal(filterNonBody(d.structure, { query: "", onlyUntranslated: true }).length, 0);
  // 絞り込みで隠れた文の見出しは出さない
  const only = buildRows(d, [d.structure.sentences[2]!], []);
  assert.deepEqual(only.map((r) => r.kind), ["heading", "sentence"]);
});

test("同じ本文のくり返しに印が付く", () => {
  const d = doc([s(0, "Same."), { ...s(1, "Same."), id: "s1b" }]);
  const rows = buildRows(d, d.structure.sentences, []).filter((r) => r.kind === "sentence");
  assert.deepEqual(rows.map((r) => r.kind === "sentence" && r.repeat), [false, true]);
  assert.ok(rows[0]!.kind === "sentence" && rows[0]!.splitCount === 2);
});

test("j/k と次の未訳", () => {
  const d = doc([s(0, "A."), s(1, "B."), s(2, "C.")]);
  d.annotations.translations["h-B."] = { sentenceHash: "h-B.", text: "B", revisedByHuman: false, source: "claude", updatedAt: "" };
  const list = d.structure.sentences;
  assert.equal(moveTarget(d, list, null, 1)?.id, "s0");
  assert.equal(moveTarget(d, list, "s0", 1)?.id, "s1");
  assert.equal(moveTarget(d, list, "s2", 1)?.id, "s2");
  assert.equal(moveTarget(d, list, "s0", -1)?.id, "s0");
  assert.equal(moveTarget(d, list, "s0", "next-untranslated")?.id, "s2");
  assert.equal(moveTarget(d, list, "s2", "next-untranslated")?.id, "s0");
});

test("語の切れ目と経過時間", () => {
  assert.deepEqual(wordBoundaries("We  propose it."), [4, 12]);
  assert.deepEqual(wordBoundaries("Word"), []);
  assert.equal(formatElapsed(5400), "5 秒");
  assert.equal(formatElapsed(125000), "2 分 5 秒");
});

test("注意書きは痕跡があるときだけ強く出す", () => {
  assert.deepEqual(qualityCaveats(doc([s(0, "A.")]).structure), []);
  const d = doc([s(0, "A.", { seam: { kinds: ["formula"], rects: [] } })], {
    parser: "fallback",
    parserNote: "簡易解析です",
    quality: { readingOrderRisk: "high", reason: "段が混ざっています", coverageRisk: "high", coverageReason: "欠落" },
  });
  assert.deepEqual(qualityCaveats(d.structure).map((c) => c.label), ["簡易解析", "読み順に崩れの疑い", "本文の欠落の疑い", "抜けのある文 1"]);
});

test("結合・分割で消えた文の後継: 結合した文、分割した先頭の断片を選ぶ", () => {
  const a = s(1, "Alpha is first.");
  const b = s(2, "Beta follows.");
  const merged = { ...s(1, "Alpha is first. Beta follows."), id: "m" };
  assert.equal(successorSentence(a, [merged, s(3, "Gamma.")])?.id, "m");
  const head = { ...s(1, "Alpha is"), id: "p1" };
  const rest = { ...s(2, "first."), id: "p2" };
  assert.equal(successorSentence(a, [head, rest, b])?.id, "p1");
  // 同じ書き出しが2か所にあれば、元の位置に近い方
  const far = { ...s(9, "Alpha is first."), id: "far" };
  const near = { ...s(1, "Alpha is first. Beta follows."), id: "near" };
  assert.equal(successorSentence(a, [far, near])?.id, "near");
  assert.equal(successorSentence(a, [s(3, "Gamma.")]), null);
});

test("数式の行は、数式タブの式と対応が付けば式として差し込み、付かなければ載せない。表・柱も載せない", () => {
  const nb = (id: string, kind: NonBodySentence["kind"], text: string, afterHash: string, y = 300): NonBodySentence => ({
    ...s(9, text, { rects: [{ page: 1, x: 100, y, w: 300, h: 20 }] }), id, kind, afterOrder: 0, afterHash,
  });
  const eq = (id: string, extra: Partial<Equation>): Equation => ({ id, label: "", tex: "x", explanation: "", source: "", createdAt: "", ...extra });
  const d = doc([s(0, "A."), s(1, "B.")], {
    nonBody: [
      nb("f1", "formula", "Attention(Q, K,V ) = softmax √ V, (1)", "h-A.", 300),
      nb("f2", "formula", "si j = √i , (2)", "h-A.", 500),
      nb("f3", "formula", "garbled (3)", "h-B.", 600),
      nb("t1", "table", "a a", "h-B."),
      nb("r1", "runningHead", "Journal 2024", "h-B."),
      nb("c1", "caption", "Figure 1. A cat.", "h-B."),
    ],
  });
  const equations = [
    // 位置が重なる（f1 の y=300/800=0.375 付近）
    eq("e-place", { page: 1, rects: [{ x: 0.2, y: 0.37, w: 0.5, h: 0.03 }] }),
    // 見出しの番号で対応
    eq("e-num", { page: 1, label: "式(2)" }),
    // 既定の見出し「式3」は登録順の番号なので対応させない
    eq("e-auto", { page: 1, label: "式3" }),
  ];
  const rows = buildRows(d, d.structure.sentences, filterNonBody(d.structure, { query: "", onlyUntranslated: false }), equations);
  assert.deepEqual(
    rows.filter((r) => r.kind !== "heading").map((r) => (r.kind === "formula" ? `F:${r.equation.id}` : r.kind === "nonbody" ? `N:${r.item.id}` : r.kind === "sentence" ? r.sentence.id : "")),
    ["s0", "F:e-place", "F:e-num", "s1", "N:c1"],
  );
});

test("式番号は行の中で最後の (n)", () => {
  assert.equal(equationNumber("E f(x) = 1. (1) M"), "1");
  assert.equal(equationNumber("a (see (2)) = b (3a)"), "3a");
  assert.equal(equationNumber("no number"), null);
  const item: NonBodySentence = { ...s(9, "y = x (4)"), id: "f", kind: "formula", afterOrder: 0, afterHash: null, page: 2 };
  const eq = (id: string, extra: Partial<Equation>): Equation => ({ id, label: "", tex: "", explanation: "", source: "", createdAt: "", ...extra });
  // 元の文字列の番号でも対応する。ページが違えば対応しない
  assert.equal(matchEquation(item, [eq("a", { page: 2, source: "y=x (4)" })], [])?.id, "a");
  assert.equal(matchEquation(item, [eq("b", { page: 3, label: "(4)" })], []), null);
  assert.equal(matchEquation(item, [eq("c", { label: "(4)" })], [])?.id, "c");
});
