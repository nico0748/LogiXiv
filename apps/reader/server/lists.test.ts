// 単語帳・数式帳の集計。保存先は一時フォルダを使う。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { collectLists } from "./lists.ts";
import { NodeVault } from "./nodeVault.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperlens-lists-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const put = (rel: string, text: string) => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
};
const note = (title: string) => `---\ntitle: "${title}"\nstatus: 未読\n---\n本文\n`;

test("すべての論文から用語・用語集・数式を集める", async () => {
  put("papers/p1/note.md", note("論文A"));
  put(
    "papers/p1/paperlens.json",
    JSON.stringify({
      version: 1,
      highlights: [],
      terms: [{ id: "t1", term: "埋め込み", reading: "うめこみ", short: "ベクトル表現", detail: "詳しく", inPaper: "入力に使う", related: [], page: 2, createdAt: "2026-01-01" }],
      equations: [{ id: "e1", label: "式1", tex: "a=b", explanation: "等しい", page: 3, source: "", createdAt: "" }],
    }),
  );
  put("papers/p1/sentences.json", JSON.stringify({ structure: {}, annotations: { glossary: [{ term: "attention", translation: "注意", note: null }, { bad: 1 }] } }));
  // sentences.json が壊れている論文
  put("papers/p2/note.md", note("論文B"));
  put("papers/p2/paperlens.json", JSON.stringify({ version: 1, highlights: [], terms: [], equations: [] }));
  put("papers/p2/sentences.json", "{ 壊れた");
  // paperlens.json も無い論文
  put("papers/p3/note.md", note("論文C"));
  put("papers/p3/sentences.json", JSON.stringify({ annotations: { glossary: [{ term: "loss", translation: "損失", note: "最小化する量" }] } }));
  // note.md が無いフォルダは論文ではない
  put("papers/junk/paperlens.json", "{}");

  const r = await collectLists(new NodeVault(root));
  assert.deepEqual(
    r.vocab.map((v) => [v.paperTitle, v.source, v.term, v.meaning]),
    [
      ["論文C", "glossary", "loss", "損失"],
      ["論文A", "term", "埋め込み", "ベクトル表現"],
      ["論文A", "glossary", "attention", "注意"],
    ],
  );
  const t = r.vocab.find((v) => v.term === "埋め込み")!;
  assert.equal(t.reading, "うめこみ");
  assert.equal(t.page, 2);
  assert.match(t.detail!, /詳しく[\s\S]*この論文での使われ方: 入力に使う/);
  assert.equal(r.vocab.find((v) => v.term === "loss")!.detail, "最小化する量");
  assert.equal(r.vocab.find((v) => v.term === "attention")!.detail, undefined);
  assert.equal(new Set(r.vocab.map((v) => v.key)).size, r.vocab.length);

  assert.deepEqual(r.formulas, [
    { key: "p1:eq:e1", paperId: "p1", paperTitle: "論文A", id: "e1", label: "式1", tex: "a=b", explanation: "等しい", page: 3, createdAt: undefined },
  ]);
});

test("論文が無い保管庫では空", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "paperlens-lists-empty-"));
  try {
    assert.deepEqual(await collectLists(new NodeVault(empty)), { vocab: [], formulas: [] });
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
