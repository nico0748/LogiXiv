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

// --- MCP で囲む・直す・消す・取り込む --------------------------------------------

const slidesFile = path.join(data, "talk-slides.pdf");

test("MCP: スライドの取り込みは絶対パスの PDF だけを受け付け、差し替えてもグループを残す", async () => {
  fs.writeFileSync(slidesFile, slides);
  await assert.rejects(tool("import_slides", { paper: id, source: "talk.pdf" }), /絶対パスで指定/);
  await assert.rejects(tool("import_slides", { paper: id, source: "https://example.com/talk.pdf" }), /URL からは取り込めません/);
  await assert.rejects(tool("import_slides", { paper: id, source: path.join(data, "none.pdf") }), /ファイルが見つかりません/);
  const key = path.join(data, "talk.key");
  fs.writeFileSync(key, "x");
  await assert.rejects(tool("import_slides", { paper: id, source: key }), /PPTX か PDF に書き出して/);
  await assert.rejects(tool("import_slides", { paper: "nope", source: slidesFile }), /論文が見つかりません/);
  const r = await tool("import_slides", { paper: id, source: slidesFile });
  assert.equal(r.source, "talk-slides.pdf");
  assert.equal(r.slidePages, 2);
  assert.equal(r.replaced, true);
  assert.equal(r.keptMarkups, 1);
  assert.deepEqual(r.outOfRange, []);
});

test("MCP: スライドの文字をページごとに読む", async () => {
  const t = TOOLS.find((x) => x.name === "read_slide_text")!;
  const all = (await t.handler({ paper: id })).content[0].text;
  assert.match(all, /^総ページ数: 2/);
  assert.match(all, /--- スライド p\.1 ---\nTitle slide/);
  assert.match(all, /Proposed method/);
  const two = (await t.handler({ paper: id, from_page: 2 })).content[0].text;
  assert.doesNotMatch(two, /Title slide/);
});

test("MCP: get_slide_markups は範囲・色・リンクの位置・スライドの情報も返す", async () => {
  const g = await tool("get_slide_markups", { paper: id });
  assert.equal(g.source, "talk-slides.pdf");
  assert.equal(g.slidePages, 2);
  assert.ok(g.importedAt);
  const m = g.markups[0];
  assert.deepEqual(m.rect, { x: 0.05, y: 0.1, w: 0.4, h: 0.12 });
  assert.equal(m.color, 0);
  assert.equal(m.colorHex, "#2a78d6");
  assert.equal(m.outOfRange, undefined);
  assert.ok(m.links.length > 0);
  assert.ok(m.links.every((l: { rects: unknown[] }) => l.rects.length > 0));
});

test("MCP: 文字か範囲でスライドを囲み、名前と色が自動で決まる", async () => {
  const a = await tool("add_slide_markup", { paper: id, slide_page: 1, text: "Title  slide" });
  assert.equal(a.markup, "Markup-01.01");
  assert.equal(a.color, 1); // 0 番は Markup-02.01 が使っている
  // 文字を囲む四角なので、文字はその中に入る
  const g = await tool("get_slide_markups", { paper: id });
  assert.equal(g.markups.find((m: { name: string }) => m.name === "Markup-01.01").slideText, "Title slide");
  const b = await tool("add_slide_markup", { paper: id, slide_page: 2, rect: { x: 0.5, y: 0.5, w: 0.3, h: 0.3 }, memo: "図の説明" });
  assert.equal(b.markup, "Markup-02.02");
  const deck = JSON.parse(fs.readFileSync(path.join(data, "papers", id, "slides.json"), "utf8"));
  assert.equal(deck.used, undefined);
  assert.equal(deck.markups.find((m: { id: string }) => m.id === b.id).memo, "図の説明");
  await assert.rejects(tool("add_slide_markup", { paper: id, slide_page: 3, rect: { x: 0, y: 0, w: 0.1, h: 0.1 } }), /スライドは 2 ページです/);
  await assert.rejects(tool("add_slide_markup", { paper: id, slide_page: 1 }), /どちらか一方/);
  await assert.rejects(tool("add_slide_markup", { paper: id, slide_page: 1, text: "x", rect: { x: 0, y: 0, w: 0.1, h: 0.1 } }), /どちらか一方/);
  await assert.rejects(tool("add_slide_markup", { paper: id, slide_page: 1, text: "Proposed method" }), /p\.1 にその文字列が見つかりませんでした/);
});

test("MCP: グループのメモ・色・範囲と、リンクの種類を直す", async () => {
  const u = await tool("update_slide_markup", { paper: id, markup: "Markup-02.02", color: 5, rect: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } });
  assert.equal(u.color, 5);
  assert.equal(u.colorHex, "#008300");
  for (const k of ["x", "y", "w", "h"] as const) assert.ok(Math.abs(u.rect[k] - { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }[k]) < 1e-9, JSON.stringify(u.rect));
  assert.equal(u.memo, "図の説明"); // 指定しなかった項目は変えない
  await assert.rejects(tool("update_slide_markup", { paper: id, markup: "Markup-02.02" }), /どれかを指定/);
  await assert.rejects(tool("update_slide_markup", { paper: id, markup: "Markup-02.02", color: 99 }), /color は 0〜7/);
  await assert.rejects(tool("update_slide_markup", { paper: id, markup: "Markup-07.01", memo: "x" }), /グループが見つかりません/);
  // 前からの呼び方も使える
  assert.equal((await tool("set_slide_markup_memo", { paper: id, markup: "02.02", memo: "別のメモ" })).memo, "別のメモ");

  const byName = async (n: string) => (await tool("get_slide_markups", { paper: id })).markups.find((m: { name: string }) => m.name === n);
  const l = (await byName("Markup-02.01")).links[0];
  const kind = l.kind === "equation" ? "figure" : "equation";
  const r = await tool("update_slide_link", { paper: id, markup: "Markup-02.01", link: l.id, kind });
  assert.equal(r.kind, kind === "equation" ? "数式" : "図");
  assert.equal((await byName("Markup-02.01")).links[0].kind, kind);
  await assert.rejects(tool("update_slide_link", { paper: id, markup: "Markup-02.01", link: "l-none", kind: "text" }), /そのリンクはありません/);
});

test("MCP: グループを消すとリンクも消え、消したものを丸ごと返す", async () => {
  await tool("link_slide_markup", { paper: id, markup: "Markup-02.02", kind: "figure", page: 1, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } });
  const d = await tool("delete_slide_markup", { paper: id, markup: "Markup-02.02" });
  assert.equal(d.markup, "Markup-02.02");
  assert.equal(d.links, 1);
  assert.equal(d.removed.memo, "別のメモ");
  assert.equal(d.removed.links.length, 1);
  const g = await tool("get_slide_markups", { paper: id });
  assert.ok(!g.markups.some((m: { name: string }) => m.name === "Markup-02.02"));
  const note = fs.readFileSync(path.join(data, "papers", id, "note.md"), "utf8");
  assert.doesNotMatch(note, /Markup-02\.02/);
  await assert.rejects(tool("delete_slide_markup", { paper: id, markup: "Markup-02.02" }), /グループが見つかりません/);
  // 空いた番号は、次に作るグループが使う
  const again = await tool("add_slide_markup", { paper: id, slide_page: 2, rect: { x: 0.1, y: 0.6, w: 0.2, h: 0.2 } });
  assert.equal(again.markup, "Markup-02.02");
});

test("MCP: 消したグループを restore_slide_markup で同じ名前のまま戻す", async () => {
  const d = await tool("delete_slide_markup", { paper: id, markup: "Markup-01.01" });
  const r = await tool("restore_slide_markup", { paper: id, item: d.removed });
  assert.equal(r.markup, "Markup-01.01");
  assert.equal(r.id, d.removed.id);
  const g = await tool("get_slide_markups", { paper: id });
  assert.deepEqual(g.markups.find((m: { name: string }) => m.name === "Markup-01.01").rect, d.removed.rect);
});

test("MCP: ページが減ったスライドに差し替えると、ページの外のグループに印が付く", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([960, 540]);
  const one = path.join(data, "one-page.pdf");
  fs.writeFileSync(one, await doc.save());
  const r = await tool("import_slides", { paper: id, source: one });
  assert.equal(r.slidePages, 1);
  assert.ok(r.outOfRange.includes("Markup-02.01"), JSON.stringify(r.outOfRange));
  const g = await tool("get_slide_markups", { paper: id });
  assert.equal(g.slidePages, 1);
  assert.equal(g.markups.find((m: { name: string }) => m.name === "Markup-02.01").outOfRange, true);
  assert.equal(g.markups.find((m: { name: string }) => m.name === "Markup-01.01").outOfRange, undefined);
  await assert.rejects(tool("add_slide_markup", { paper: id, slide_page: 2, rect: { x: 0, y: 0, w: 0.1, h: 0.1 } }), /スライドは 1 ページです/);
  await tool("import_slides", { paper: id, source: slidesFile });
});

test("MCP: スライドの道具は読み取りと書き込みに分かれている", async () => {
  const { READ_TOOLS, WRITE_TOOLS } = await import("../mcp/tools.ts");
  const read = READ_TOOLS.map((t) => t.name);
  const write = WRITE_TOOLS.map((t) => t.name);
  for (const n of ["get_slide_markups", "read_slide_text"]) assert.ok(read.includes(n) && !write.includes(n), n);
  for (const n of ["import_slides", "add_slide_markup", "link_slide_markup", "update_slide_link", "unlink_slide_markup", "update_slide_markup", "set_slide_markup_memo", "delete_slide_markup", "restore_slide_markup"]) {
    assert.ok(write.includes(n) && !read.includes(n), n);
  }
  assert.equal(TOOLS.find((t) => t.name === "delete_slide_markup")!.config.annotations.destructiveHint, true);
});
