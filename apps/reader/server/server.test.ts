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

test("MCP: set_meta に配列を渡すと、ブロック形式の一覧になる", async () => {
  await tool("set_meta", { paper: id, key: "authors", value: ["A. Example", "B. Sample"] });
  const note = fs.readFileSync(path.join(data, "papers", id, "note.md"), "utf8");
  assert.match(note, /\nauthors:\n {2}- "A\. Example"\n {2}- "B\. Sample"\n/);
  const p = await tool("get_paper", { paper: id });
  assert.deepEqual(p.frontmatter.authors, ["A. Example", "B. Sample"]);
});

test("MCP: Obsidian 形式の一覧と日本語の項目名があっても、set_meta(year) はほかの行を変えない", async () => {
  const file = path.join(data, "papers", id, "note.md");
  const before = fs.readFileSync(file, "utf8");
  const fmEnd = before.indexOf("\n---", 4);
  const edited = `${before.slice(0, fmEnd)}\ntags:\n- paper\n- ml\n読了日: 2026-10-01\nmy rating: 4${before.slice(fmEnd)}`;
  fs.writeFileSync(file, edited);
  await tool("set_meta", { paper: id, key: "year", value: "2025" });
  const after = fs.readFileSync(file, "utf8");
  const lines = (s: string) => s.split("\n").filter((l) => !l.startsWith("year:"));
  assert.deepEqual(lines(after), lines(edited));
  assert.match(after, /\nyear: 2025\n/);
});

test("複数行の値の項目を画面から書き換えると 409 で断る", async () => {
  const file = path.join(data, "papers", id, "note.md");
  const md = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, md.replace(/\nvenue: [^\n]*\n/, "\nvenue: |\n  line1\n  line2\n"));
  const r = await api(`/api/papers/${id}/meta`, { method: "PUT", body: JSON.stringify({ key: "venue", value: "x" }) });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /複数行の値/);
  const ok = await api(`/api/papers/${id}/meta`, { method: "PUT", body: JSON.stringify({ key: "year", value: ["x"] }) });
  assert.equal(ok.status, 200);
  await api(`/api/papers/${id}/meta`, { method: "PUT", body: JSON.stringify({ key: "year", value: "2025" }) });
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("venue: |\n  line1\n  line2\n", 'venue: ""\n'));
});

test("MCP: get_bibtex は frontmatter から BibTeX を作る", async () => {
  const t = TOOLS.find((x) => x.name === "get_bibtex")!;
  const r = await t.handler({ paper: id });
  assert.match(r.content[0].text, /^@misc\{example2025sparse,\n {2}title = \{\{Sparse Window Attention/);
  assert.match(r.content[0].text, /author = \{A\. Example and B\. Sample\}/);
});

// --- URL・arXiv からの取り込み（外へは通信しない。取得の処理を差し替える） ---------------

test("from-url: 端末のパスは 400", async () => {
  const r = await api("/api/papers/from-url", { method: "POST", body: JSON.stringify({ url: "/etc/passwd" }) });
  assert.equal(r.status, 400);
  const f = await api("/api/papers/from-url", { method: "POST", body: JSON.stringify({ url: "file:///etc/passwd" }) });
  assert.equal(f.status, 400);
});

test("from-url: DOI のリンクは専用の文言で 400", async () => {
  const r = await api("/api/papers/from-url", { method: "POST", body: JSON.stringify({ url: "https://doi.org/10.1145/3292500.3330701" }) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /DOI のリンクは論文のページを指すため取り込めません。PDF の URL を指定してください。/);
});

test("from-url: arXiv の番号で取り込むと、題名がフォルダ名と見出しになり、書誌情報が入る。2 回目は existing", async () => {
  const { setFetchers } = await import("./service.ts");
  let pdfCalls = 0;
  setFetchers({
    arxiv: async () => ({ title: "Attention Is All You Need", authors: ["Ashish Vaswani", "Noam Shazeer"], year: "2017", doi: "", venue: "arXiv" }),
    pdf: async (url: string) => {
      pdfCalls++;
      return { data: sample.buffer.slice(sample.byteOffset, sample.byteOffset + sample.byteLength) as ArrayBuffer, finalUrl: url };
    },
  });
  try {
    const before = fs.readdirSync(path.join(data, "papers")).length;
    const r = await api("/api/papers/from-url", { method: "POST", body: JSON.stringify({ url: "https://arxiv.org/abs/1706.03762v7" }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.existing, false);
    assert.match(r.body.id, /^\d{8}-Attention-Is-All-You-Need$/);
    const note = fs.readFileSync(path.join(data, "papers", r.body.id, "note.md"), "utf8");
    assert.match(note, /\n# Attention Is All You Need\n/);
    assert.match(note, /\nauthors:\n {2}- Ashish Vaswani\n|\nauthors:\n {2}- "Ashish Vaswani"\n/);
    assert.match(note, /\narxiv: 1706\.03762\n|\narxiv: "1706\.03762"\n/);
    assert.match(note, /\nurl: "https:\/\/arxiv\.org\/abs\/1706\.03762v7"\n/);
    assert.match(note, /\nyear: 2017\n/);

    const again = await tool("import_paper", { source: "1706.03762" });
    assert.equal(again.existing, true);
    assert.equal(again.id, r.body.id);
    assert.equal(pdfCalls, 1);
    assert.equal(fs.readdirSync(path.join(data, "papers")).length, before + 1);
  } finally {
    setFetchers();
  }
});
