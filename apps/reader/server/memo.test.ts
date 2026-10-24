// 保管庫の memo（ファイルから作った値の使い回し）。ファイルが変われば作り直すことを確かめる。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { listPapers, searchNotes } from "../src/lib/papers.ts";
import { collectLists } from "./lists.ts";
import { NodeVault } from "./nodeVault.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperlens-memo-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const put = (rel: string, text: string) => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
};

test("中身が変わるまで作り直さず、変わったら作り直す", async () => {
  const v = new NodeVault(root);
  put("a.txt", "abc");
  let calls = 0;
  const derive = (t: string) => {
    calls++;
    return t.toUpperCase();
  };
  assert.equal(await v.memo("a.txt", "up", derive), "ABC");
  assert.equal(await v.memo("a.txt", "up", derive), "ABC");
  assert.equal(calls, 1);
  // 同じ大きさのまま、その場で書き換える（rename しない外部の編集）
  put("a.txt", "xyz");
  assert.equal(await v.memo("a.txt", "up", derive), "XYZ");
  assert.equal(calls, 2);
  // 保管庫の書き込み（一時ファイルから置き換え）
  await v.writeText("a.txt", "xyz");
  assert.equal(await v.memo("a.txt", "up", derive), "XYZ");
  assert.equal(calls, 3);
  // tag が違えば別の値
  assert.equal(await v.memo("a.txt", "len", (t) => t.length), 3);
});

test("無いファイルは readText と同じく失敗し、作った値の失敗は覚えない", async () => {
  const v = new NodeVault(root);
  await assert.rejects(v.memo("none.txt", "x", (t) => t), { code: "ENOENT" });
  put("bad.json", "{");
  await assert.rejects(v.memo("bad.json", "json", (t) => JSON.parse(t)));
  put("bad.json", "{}");
  assert.deepEqual(await v.memo("bad.json", "json", (t) => JSON.parse(t)), {});
});

test("一覧・検索・単語帳は、外で書き換えたノートと対訳をすぐに映す", async () => {
  const v = new NodeVault(root);
  put("papers/p1/note.md", `---\ntitle: "古い題名"\nstatus: 未読\n---\nattention の話\n`);
  put("papers/p1/sentences.json", JSON.stringify({ annotations: { glossary: [{ term: "loss", translation: "損失" }] } }));
  assert.equal((await listPapers(v))[0].title, "古い題名");
  assert.equal((await searchNotes(v, "attention")).length, 1);
  assert.deepEqual((await collectLists(v)).vocab.map((x) => x.term), ["loss"]);

  // 呼び出し側が一覧の値を書き換えても、次の一覧には響かない
  (await listPapers(v))[0].authors.push("書き換え");
  assert.deepEqual((await listPapers(v))[0].authors, []);

  put("papers/p1/note.md", `---\ntitle: "新しい題名"\nstatus: 精読\n---\ntransformer の話\n`);
  put("papers/p1/sentences.json", JSON.stringify({ annotations: { glossary: [{ term: "gain", translation: "利得" }] } }));
  const [p] = await listPapers(v);
  assert.equal(p.title, "新しい題名");
  assert.equal(p.status, "精読");
  assert.equal((await searchNotes(v, "attention")).length, 0);
  assert.equal((await searchNotes(v, "TRANSFORMER")).length, 1);
  assert.deepEqual((await collectLists(v)).vocab.map((x) => x.term), ["gain"]);
});
