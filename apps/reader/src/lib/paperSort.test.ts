import assert from "node:assert/strict";
import { test } from "node:test";
import { sortPapers } from "./paperSort.ts";
import type { PaperSummary } from "./papers.ts";

const p = (id: string, o: Partial<PaperSummary> = {}): PaperSummary => ({
  id, title: id, status: "未読", year: "", authors: [], arxiv: "", created: "", ...o,
});

const ids = (list: PaperSummary[]) => list.map((x) => x.id);

test("追加日は新しい順。日付が無いものは後ろで、ID の逆順", () => {
  const list = [p("a"), p("b", { created: "2026-10-01" }), p("c", { created: "2026-10-15" }), p("d")];
  assert.deepEqual(ids(sortPapers(list, "created")), ["c", "b", "d", "a"]);
});

test("題名は大文字と小文字、全角と半角を区別しない", () => {
  const list = [p("1", { title: "bert" }), p("2", { title: "Ａｔｔｅｎｔｉｏｎ" }), p("3", { title: "Codex" })];
  assert.deepEqual(ids(sortPapers(list, "title")), ["2", "1", "3"]);
});

test("発行年は新しい順で、年の無い論文は最後", () => {
  const list = [p("a"), p("b", { year: "2017" }), p("c", { year: "2024" })];
  assert.deepEqual(ids(sortPapers(list, "year")), ["c", "b", "a"]);
});

test("段階は未読から順に並べ、知らない段階は最後", () => {
  const list = [p("a", { status: "まとめ済み" }), p("b", { status: "独自" }), p("c", { status: "未読" }), p("d", { status: "精読" })];
  assert.deepEqual(ids(sortPapers(list, "status")), ["c", "d", "a", "b"]);
});

test("元の配列は並べ替えない", () => {
  const list = [p("a", { year: "2000" }), p("b", { year: "2020" })];
  sortPapers(list, "year");
  assert.deepEqual(ids(list), ["a", "b"]);
});
