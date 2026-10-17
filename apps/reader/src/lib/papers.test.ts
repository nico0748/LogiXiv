import assert from "node:assert/strict";
import { before, test } from "node:test";
import { emptyAnnotations } from "./model.ts";
import { importPaper, listPapers, loadNote, saveAnnotations, searchNotes, writeField } from "./papers.ts";
import { MemoryVault } from "./vault.ts";

const v = new MemoryVault();
let id = "";

before(async () => {
  id = await importPaper(v, "window.pdf", new ArrayBuffer(8), "Sparse Window Attention");
  await writeField(v, id, "summary", "窓付きの疎な注意で、長い論文を読めるようにした。");
  await saveAnnotations(v, id, {
    ...emptyAnnotations(),
    highlights: [{
      id: "h-1", page: 1, rects: [], text: "We propose sparse window attention.", color: "yellow",
      translation: "疎な窓付き注意を提案する。", memo: "", createdAt: "",
    }],
  });
  await v.writeText(`papers/${id}/note.md`, `${await loadNote(v, id)}\n自由に書いたメモ: 窓の幅が気になる。\n`);
});

test("1. 記録欄の中の語は field と欄の ID", async () => {
  const hits = await searchNotes(v, "窓付きの疎な");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].region, "field");
  assert.equal(hits[0].field, "summary");
});

test("2. マーカーの訳の中の語は list:highlights", async () => {
  const hits = await searchNotes(v, "疎な窓付き注意を提案");
  assert.deepEqual(hits.map((h) => h.region), ["list:highlights"]);
  assert.equal(hits[0].field, undefined);
});

test("3. コメントの行には当たらない", async () => {
  assert.deepEqual(await searchNotes(v, "summary"), []);
  assert.deepEqual(await searchNotes(v, "/field"), []);
});

test("4. frontmatter の題名は frontmatter", async () => {
  const hits = await searchNotes(v, "sparse window attention");
  assert.equal(hits[0].region, "frontmatter");
  assert.ok(hits.some((h) => h.region === "list:highlights"));
});

test("5. 記録欄の外の自由記述は body。空白だけの語は空の配列", async () => {
  const hits = await searchNotes(v, "窓の幅");
  assert.deepEqual(hits.map((h) => h.region), ["body"]);
  assert.deepEqual(await searchNotes(v, "   "), []);
});

test("一覧の tags は配列にそろえ、空の項目は除く", async () => {
  const v = new MemoryVault();
  await v.writeText("papers/a/note.md", "---\ntitle: A\ntags: [ml, '', nlp]\n---\n");
  await v.writeText("papers/b/note.md", "---\ntitle: B\ntags: single\n---\n");
  await v.writeText("papers/c/note.md", "---\ntitle: C\n---\n");
  const list = await listPapers(v);
  assert.deepEqual(Object.fromEntries(list.map((p) => [p.id, p.tags])), { a: ["ml", "nlp"], b: ["single"], c: [] });
});
