// 読解ノートまわりの MCP ツール（ページの画像・リスト・項目の直し・保存先）の単体テスト。保存先は一時フォルダ。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "paperlens-mcp-core-"));
process.env.PAPERLENS_DATA = data;
process.env.PAPERLENS_CONFIG = path.join(data, "config.json");

const { TOOLS } = await import("../mcp/tools.ts");
const { importBytes } = await import("./service.ts");
const { NodeVault } = await import("./nodeVault.ts");
const { ensureLayout } = await import("../src/lib/papers.ts");
const sample = fs.readFileSync(new URL("../src/demo/sample.pdf", import.meta.url));

let id = "";
before(async () => {
  const v = new NodeVault(data);
  await ensureLayout(v);
  id = await importBytes(v, "sample.pdf", sample.buffer.slice(sample.byteOffset, sample.byteOffset + sample.byteLength) as ArrayBuffer);
});
after(() => fs.rmSync(data, { recursive: true, force: true }));

const call = (name: string, args: Record<string, unknown> = {}) => {
  const t = TOOLS.find((x) => x.name === name);
  assert.ok(t, name);
  return t.handler(args);
};
const tool = async (name: string, args: Record<string, unknown> = {}) => JSON.parse((await call(name, args)).content[0].text);

/** PNG の幅と高さ（IHDR） */
const pngSize = (b: Buffer) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });

test("get_settings はスライドと対訳のファイルの場所も返す", async () => {
  const s = await tool("get_settings");
  assert.equal(s.layout.sentences, "papers/<論文ID>/sentences.json");
  assert.equal(s.layout.slides, "papers/<論文ID>/slides.pdf");
  assert.equal(s.layout.slidesSource, "papers/<論文ID>/slides.pptx");
  assert.equal(s.layout.slideMarkups, "papers/<論文ID>/slides.json");
});

test("get_page_image: ページ全体と切り出しを PNG で返し、大きさを抑える", async () => {
  const r = await call("get_page_image", { paper: id, page: 1 });
  const info = JSON.parse(r.content[0].text);
  const img = r.content[1];
  assert.equal(img.type, "image");
  assert.ok(img.type === "image" && img.mimeType === "image/png");
  const png = Buffer.from(img.type === "image" ? img.data : "", "base64");
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.deepEqual(pngSize(png), { w: info.width, h: info.height });
  assert.ok(Math.max(info.width, info.height) <= 1600, JSON.stringify(info));
  // 大きな拡大率を頼んでも、長い辺は 1600px まで
  const big = JSON.parse((await call("get_page_image", { paper: id, page: 1, scale: 6 })).content[0].text);
  assert.ok(Math.max(big.width, big.height) <= 1600, JSON.stringify(big));
  // 一部だけを切り出す
  const crop = await call("get_page_image", { paper: id, page: 1, rect: { x: 0.1, y: 0.6, w: 0.8, h: 0.1 }, scale: 2 });
  const c = JSON.parse(crop.content[0].text);
  assert.ok(c.width > c.height * 5, JSON.stringify(c));
  assert.ok(c.width < info.width * 2);
  await assert.rejects(call("get_page_image", { paper: id, page: 99 }), /この PDF は \d+ ページです/);
  await assert.rejects(call("get_page_image", { paper: id, page: 1, source: "slides" }), /スライドがありません/);
  await assert.rejects(call("get_page_image", { paper: "nope", page: 1 }), /論文が見つかりません/);
});

test("get_lists: 用語と数式を論文をまたいで集め、語句で絞る", async () => {
  const t = await tool("add_term", { paper: id, term: "自己注意（self-attention）", short: "系列の各位置どうしの重み付け" });
  const e = await tool("add_equation", { paper: id, tex: "a_{ij} = \\exp(q_i k_j)", label: "式(2)" });
  const all = await tool("get_lists");
  assert.equal(all.vocab.length, 1);
  assert.equal(all.formulas.length, 1);
  const q = await tool("get_lists", { query: "SELF-ATTENTION" });
  assert.deepEqual(q.vocab.map((v: { term: string }) => v.term), ["自己注意（self-attention）"]);
  assert.equal(q.formulas.length, 0);
  assert.equal((await tool("get_lists", { query: "exp" })).formulas[0].id, e.id);
  assert.equal((await tool("get_lists", { paper: "other" })).vocab.length, 0);

  // 用語と数式のページ・元の文字列も直せる
  assert.equal((await tool("update_term", { paper: id, id: t.id, page: 2 })).page, 2);
  const ue = await tool("update_equation", { paper: id, id: e.id, page: 1, source: "a_ij = exp(q_i . k_j / sqrt(d_k))" });
  assert.equal(ue.page, 1);
  assert.equal(ue.source, "a_ij = exp(q_i . k_j / sqrt(d_k))");
  assert.equal(ue.label, "式(2)");
});

test("update_highlight: text か page を渡すと、引く場所を探し直す", async () => {
  const h = await tool("add_highlight", { paper: id, text: "We propose sparse window attention", translation: "疎な窓注意を提案する" });
  assert.equal(h.located, true);
  const file = () => JSON.parse(fs.readFileSync(path.join(data, "papers", id, "paperlens.json"), "utf8")).highlights[0];
  const before = file().rects;
  const u = await tool("update_highlight", { paper: id, id: h.highlight.id, text: "Transformer models struggle to read long scientific documents" });
  assert.equal(u.located, true);
  assert.equal(u.text, "Transformer models struggle to read long scientific documents");
  assert.equal(u.translation, "疎な窓注意を提案する"); // 指定しなかった項目は変えない
  assert.notDeepEqual(file().rects, before);
  // 見つからなければ何も変えない
  await assert.rejects(tool("update_highlight", { paper: id, id: h.highlight.id, text: "not in the paper at all" }), /見つかりませんでした/);
  assert.equal(file().text, "Transformer models struggle to read long scientific documents");
  await assert.rejects(tool("update_highlight", { paper: id, id: h.highlight.id, page: 99 }), /ページです/);
  await assert.rejects(tool("update_highlight", { paper: id, id: "h-none", text: "x" }), /マーカーが見つかりません/);
  // 訳だけなら、場所は変えない
  const only = await tool("update_highlight", { paper: id, id: h.highlight.id, memo: "冒頭の主張" });
  assert.equal(only.memo, "冒頭の主張");
  assert.equal(only.located, undefined);
});

test("set_data_root: 絶対パスだけを受け付け、PAPERLENS_DATA があれば断る。変えたらフォルダを整える", async () => {
  await assert.rejects(tool("set_data_root", { path: "relative/dir" }), /絶対パスで指定/);
  await assert.rejects(tool("set_data_root", { path: path.join(data, "other") }), /PAPERLENS_DATA/);
  const next = path.join(data, "other");
  delete process.env.PAPERLENS_DATA;
  try {
    const r = await tool("set_data_root", { path: next });
    assert.equal(r.dataRoot, next);
    assert.equal(r.dataRootSource, "config");
    assert.ok(fs.existsSync(path.join(next, "_templates")), "テンプレートを置く");
  } finally {
    process.env.PAPERLENS_DATA = data;
  }
});
