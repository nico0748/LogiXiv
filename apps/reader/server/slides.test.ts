// 発表スライドの API と MCP ツール。保存先は一時フォルダを使う。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "paperlens-slides-"));
process.env.PAPERLENS_DATA = data;
process.env.PAPERLENS_CONFIG = path.join(data, "config.json");

const { startServer } = await import("./app.ts");
const { TOOLS } = await import("../mcp/tools.ts");
const { importSlides } = await import("./slides.ts");
const { NodeVault } = await import("./nodeVault.ts");
const sample = fs.readFileSync(new URL("../src/demo/sample.pdf", import.meta.url));

/** 2 ページのスライド。2 ページ目の左上に「Proposed method」と書く */
async function makeSlides() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([960, 540]).drawText("Title slide", { x: 80, y: 400, size: 40, font });
  doc.addPage([960, 540]).drawText("Proposed method", { x: 96, y: 432, size: 32, font });
  return Buffer.from(await doc.save());
}

let s: Awaited<ReturnType<typeof startServer>>;
let id = "";
let slides: Buffer;
before(async () => {
  s = await startServer({ port: 0 });
  slides = await makeSlides();
  const res = await fetch(`${s.url}/api/papers?name=sample.pdf`, { method: "POST", body: sample, headers: { "content-type": "application/pdf" } });
  id = ((await res.json()) as { id: string }).id;
});
after(async () => {
  await s.close();
  fs.rmSync(data, { recursive: true, force: true });
});

const api = async (p: string, init: RequestInit = {}) => {
  const res = await fetch(`${s.url}${p}`, init);
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.arrayBuffer();
  return { status: res.status, body };
};
const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const t = TOOLS.find((x) => x.name === name);
  assert.ok(t, name);
  const r = await t.handler(args);
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
};

test("スライドの無い論文は deck: null。MCP はわかる言葉で断る", async () => {
  assert.deepEqual((await api(`/api/papers/${id}/slides`)).body, { deck: null });
  await assert.rejects(tool("get_slide_markups", { paper: id }), /スライドがありません/);
});

test("PDF のスライドを取り込み、PDF を返す", async () => {
  const r = await api(`/api/papers/${id}/slides?name=talk.pdf`, { method: "POST", body: new Uint8Array(slides) });
  assert.equal(r.status, 200);
  assert.equal(r.body.deck.source, "talk.pdf");
  assert.deepEqual(r.body.deck.markups, []);
  const pdf = await api(`/api/papers/${id}/slides/pdf`);
  assert.equal(Buffer.from(pdf.body as ArrayBuffer).subarray(0, 5).toString(), "%PDF-");
});

test("PDF でも PPTX でもないものは断る", async () => {
  const r = await api(`/api/papers/${id}/slides?name=x.pdf`, { method: "POST", body: "hello" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /PDF か PPTX/);
  const k = await api(`/api/papers/${id}/slides?name=talk.key`, { method: "POST", body: "hello" });
  assert.match(k.body.error, /PPTX か PDF に書き出して/);
});

test("四角を足すと、ノートに「発表スライドとの対応」が出る", async () => {
  const item = { id: "m-ui", page: 2, index: 1, rect: { x: 0.05, y: 0.1, w: 0.4, h: 0.12 }, color: 0, memo: "", links: [], createdAt: "" };
  const r = await api(`/api/papers/${id}/slides/markups`, { method: "PATCH", body: JSON.stringify({ ops: [{ op: "add", item }] }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.deck.markups.length, 1);
  assert.match(r.body.note, /### Markup-02\.01（スライド p\.2）/);
});

test("MCP: 四角の中の文字を読み、論文の文につなぐ", async () => {
  const g = await tool("get_slide_markups", { paper: id });
  assert.equal(g.markups[0].name, "Markup-02.01");
  assert.equal(g.markups[0].slideText, "Proposed method");
  const r = await tool("link_slide_markup", { paper: id, markup: "Markup-02.01", kind: "text", text: "Transformer  models struggle\nto read" });
  assert.equal(r.link.page, 1);
  const deck = JSON.parse(fs.readFileSync(path.join(data, "papers", id, "slides.json"), "utf8"));
  const link = deck.markups[0].links[0];
  assert.equal(link.kind, "text");
  assert.ok(link.rects[0].w > 0.1, JSON.stringify(link.rects));
  // 図は範囲で指定する
  await tool("link_slide_markup", { paper: id, markup: "02.01", kind: "figure", page: 1, rect: { x: 0.1, y: 0.5, w: 0.3, h: 0.2 } });
  await tool("set_slide_markup_memo", { paper: id, markup: "m-ui", memo: "ここで手法を説明する" });
  const note = fs.readFileSync(path.join(data, "papers", id, "note.md"), "utf8");
  assert.match(note, /ここで手法を説明する\n\n- 文章: p\.1「Transformer models struggle to read/);
  assert.match(note, /- 図: p\.1\n/);
  const un = await tool("unlink_slide_markup", { paper: id, markup: "Markup-02.01", link: link.id });
  assert.equal(un.removed, link.id);
  await assert.rejects(tool("link_slide_markup", { paper: id, markup: "Markup-09.01", kind: "text", text: "x" }), /ある名前: Markup-02\.01/);
  await assert.rejects(tool("link_slide_markup", { paper: id, markup: "Markup-02.01", kind: "text", text: "not in the paper at all" }), /見つかりませんでした/);
  await assert.rejects(tool("link_slide_markup", { paper: id, markup: "Markup-02.01", kind: "figure", page: 999, rect: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } }), /ページです/);
});

test("MCP: 同じグループに並べてつないでも、リンクは全部残る", async () => {
  const before = (await tool("get_slide_markups", { paper: id })).markups[0].links.length;
  await Promise.all(
    [0.1, 0.3, 0.5, 0.7].map((y) => tool("link_slide_markup", { paper: id, markup: "Markup-02.01", kind: "figure", page: 1, rect: { x: 0.1, y, w: 0.2, h: 0.1 } })),
  );
  assert.equal((await tool("get_slide_markups", { paper: id })).markups[0].links.length, before + 4);
});

test("正しくない操作は 400 で断り、保存先を変えない", async () => {
  const r = await api(`/api/papers/${id}/slides/markups`, { method: "PATCH", body: JSON.stringify({ ops: [{ op: "add", item: { id: "m2", page: 1, index: 1 } }] }) });
  assert.equal(r.status, 400);
  const u = await api(`/api/papers/${id}/slides/markups`, { method: "PATCH", body: JSON.stringify({ ops: [{ op: "frobnicate", id: "m-ui" }] }) });
  assert.equal(u.status, 400);
  assert.deepEqual((await api(`/api/papers/${id}/slides`)).body.deck.markups.map((m: { id: string }) => m.id), ["m-ui"]);
});

test("スライドを差し替えても四角は残る。PPTX は変換して、元のファイルも置く", async () => {
  const v = new NodeVault(data);
  const pptx = Buffer.from("PK\u0003\u0004 fake pptx");
  let got = 0;
  const deck = await importSlides(v, id, "talk.pptx", pptx.buffer.slice(pptx.byteOffset, pptx.byteOffset + pptx.byteLength) as ArrayBuffer, async (b) => {
    got = b.byteLength;
    return slides.buffer.slice(slides.byteOffset, slides.byteOffset + slides.byteLength) as ArrayBuffer;
  });
  assert.equal(got, pptx.byteLength);
  assert.equal(deck.convertedFrom, "pptx");
  assert.equal(deck.markups.length, 1);
  assert.ok(fs.existsSync(path.join(data, "papers", id, "slides.pptx")));
});

test("ほかのプロセス（MCP）の書き込みは、画面へ slides として知らせる", async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${s.url}/api/events`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  await reader.read(); // : connected
  await tool("set_slide_markup_memo", { paper: id, markup: "Markup-02.01", memo: "書き換え" });
  let text = "";
  const deadline = Date.now() + 3000;
  while (!text.includes('"kind":"slides"') && Date.now() < deadline) {
    const { value } = await reader.read();
    text += new TextDecoder().decode(value);
  }
  ctrl.abort();
  assert.match(text, new RegExp(`"kind":"slides","paper":"${id}"`));
});

test("PPTX の見分け: 拡張子で決め、無いときだけ中身を見る", async () => {
  const { isPptx } = await import("./slides.ts");
  const zip = (body: string) => new TextEncoder().encode(`PK\u0003\u0004${body}`).buffer as ArrayBuffer;
  assert.equal(isPptx("talk.PPTX", zip("")), true);
  assert.equal(isPptx("talk.docx", zip("word/document.xml")), false);
  assert.equal(isPptx("talk.pdf", zip("ppt/presentation.xml")), false);
  assert.equal(isPptx("talk", zip("[Content_Types].xml ppt/presentation.xml")), true);
  assert.equal(isPptx("talk", zip("word/document.xml")), false);
  const k = await api(`/api/papers/${id}/slides?name=talk.key`, { method: "POST", body: new Uint8Array(zip("Index/")) });
  assert.equal(k.status, 400);
});
