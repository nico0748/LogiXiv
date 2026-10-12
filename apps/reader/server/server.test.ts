// ローカルサーバーと MCP ツールの単体テスト。保存先は一時フォルダを使う。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "paperlens-test-"));
process.env.PAPERLENS_DATA = data;
process.env.PAPERLENS_CONFIG = path.join(data, "config.json");

const { startServer } = await import("./app.ts");
const { TOOLS } = await import("../mcp/tools.ts");
const sample = fs.readFileSync(new URL("../src/demo/sample.pdf", import.meta.url));

let s: Awaited<ReturnType<typeof startServer>>;
let id = "";
before(async () => {
  s = await startServer({ port: 0 });
});
after(async () => {
  await s.close();
  fs.rmSync(data, { recursive: true, force: true });
});

const api = async (p: string, init: RequestInit = {}) => {
  const res = await fetch(`${s.url}${p}`, init);
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  return { status: res.status, body };
};
const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const t = TOOLS.find((x) => x.name === name);
  assert.ok(t, name);
  const r = await t.handler(args);
  return JSON.parse(r.content[0].text);
};

test("PDF を取り込むと、テンプレートからノートができる", async () => {
  const r = await api("/api/papers?name=sample.pdf", { method: "POST", body: sample, headers: { "content-type": "application/pdf" } });
  assert.equal(r.status, 200);
  id = r.body.id;
  assert.ok(fs.existsSync(path.join(data, "_templates/reading-note.md")));
  const note = fs.readFileSync(path.join(data, "papers", id, "note.md"), "utf8");
  assert.match(note, /title: "Sparse Window Attention/);
});

test("PDF でないファイルは取り込まない", async () => {
  const r = await api("/api/papers?name=x.pdf", { method: "POST", body: "hello" });
  assert.equal(r.status, 400);
});

test("記録欄と status を書き換える", async () => {
  const r = await api(`/api/papers/${id}/fields/summary`, { method: "PUT", body: JSON.stringify({ value: "要約 $1 $&" }) });
  assert.match(r.body.note, /要約 \$1 \$&/);
  await api(`/api/papers/${id}/meta`, { method: "PUT", body: JSON.stringify({ key: "status", value: "精読" }) });
  const list = (await api("/api/papers")).body;
  assert.equal(list[0].status, "精読");
});

test("注釈の操作は、別の書き手の変更を残す", async () => {
  await tool("add_term", { paper: id, term: "エージェントの用語" });
  const r = await api(`/api/papers/${id}/annotations`, {
    method: "PATCH",
    body: JSON.stringify({ ops: [{ op: "add", list: "terms", item: { id: "t-ui", term: "画面の用語", reading: "", short: "", detail: "", inPaper: "", related: [], createdAt: "" } }] }),
  });
  assert.deepEqual(r.body.annotations.terms.map((t: { term: string }) => t.term).sort(), ["エージェントの用語", "画面の用語"]);
  assert.match(r.body.note, /### \[\[画面の用語\]\]/);
});

test("MCP: 本文の文を探してマーカーを引く", async () => {
  const r = await tool("add_highlight", { paper: id, text: "Transformer  models struggle\nto read", translation: "訳" });
  assert.equal(r.located, true);
  assert.equal(r.highlight.page, 1);
  const a = JSON.parse(fs.readFileSync(path.join(data, "papers", id, "paperlens.json"), "utf8"));
  const rect = a.highlights[0].rects[0];
  assert.ok(rect.x > 0 && rect.x < 1 && rect.y > 0 && rect.y < 0.5 && rect.w > 0.1, JSON.stringify(rect));
});

test("MCP: 無い記録欄・無い論文はわかる言葉で断る", async () => {
  const t = TOOLS.find((x) => x.name === "set_fields")!;
  await assert.rejects(t.handler({ paper: id, values: { nope: "x" } }), /記録欄が見つかりません: nope/);
  await assert.rejects(t.handler({ paper: "nope", values: {} }), /論文が見つかりません/);
  await assert.rejects(t.handler({ paper: "../x", values: {} }), /論文 ID が正しくありません/);
});

test("ほかのサイトからの操作と、保存先の外は受け付けない", async () => {
  const r = await api("/api/template", { method: "PUT", body: JSON.stringify({ text: "x" }), headers: { origin: "https://example.com" } });
  assert.equal(r.status, 403);
  const t = await api(`/api/papers/${encodeURIComponent("../../etc")}/note`);
  assert.equal(t.status, 400);
});

test("MCP の登録方法に、この端末のパスが入る", async () => {
  const r = await api("/api/mcp");
  assert.match(r.body.claudeCode, /^claude mcp add paperlens /);
  assert.match(r.body.claudeCodeReadOnly, /PAPERLENS_MCP_READONLY=1/);
  assert.ok(JSON.parse(r.body.desktopConfig).mcpServers.paperlens.env.PAPERLENS_CONFIG);
});
