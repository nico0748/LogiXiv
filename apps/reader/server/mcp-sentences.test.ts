// 1 文ずつの対訳を扱う MCP ツールの単体テスト。
// 保存先は一時フォルダ。sentences.json は解析を通さず、@paperlens/core で手組みしたものを置く。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { STRUCTURE_VERSION, createDocument, sentenceHash, sentenceId, type DocumentStructure, type Sentence } from "@paperlens/core";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "paperlens-mcp-sentences-"));
process.env.PAPERLENS_DATA = data;
process.env.PAPERLENS_CONFIG = path.join(data, "config.json");

const { TOOLS, READ_TOOLS, WRITE_TOOLS } = await import("../mcp/tools.ts");
const { mcpInfo } = await import("./mcpinfo.ts");

after(() => fs.rmSync(data, { recursive: true, force: true }));

const PAPER = "fixture";
const TEXTS = [
  "Transformers are widely used.",
  "We propose sparse window attention.",
  "Results are shown in Table 1.",
  "[12] A. Author. Some reference. 2020.",
  "Results are shown in Table 1.",
  "Our method halves the memory.",
];
const HASH = TEXTS.map(sentenceHash);

function writePaper(id: string) {
  const dir = path.join(data, "papers", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "note.md"), `---\ntitle: "${id}"\nstatus: 未読\n---\n`);
  return dir;
}

function fixture() {
  const seen = new Map<string, number>();
  const sentences: Sentence[] = TEXTS.map((text, order) => {
    const hash = sentenceHash(text);
    const n = seen.get(hash) ?? 0;
    seen.set(hash, n + 1);
    return { id: sentenceId(hash, n), hash, order, page: 1, text, rects: [], sectionId: order < 3 ? "s1" : "s2" };
  });
  const structure: DocumentStructure = {
    version: STRUCTURE_VERSION,
    parser: "fallback",
    parserNote: "pdf.js",
    parsedAt: new Date().toISOString(),
    title: "Fixture",
    abstract: null,
    pageSizes: [{ page: 1, width: 600, height: 800 }],
    sections: [
      { id: "s1", title: "Introduction", level: 1, order: 0 },
      { id: "s2", title: "Results", level: 1, order: 1 },
    ],
    sentences,
    quality: { readingOrderRisk: "high", reason: "段の連結が見つかりました" },
  };
  const doc = createDocument({ id: PAPER, structure, sourceFileName: "fixture.pdf" });
  doc.annotations.translations[HASH[0]] = {
    sentenceHash: HASH[0],
    text: "Transformer は広く使われている。",
    revisedByHuman: true,
    source: "human",
    updatedAt: new Date().toISOString(),
  };
  doc.annotations.glossary.push({ term: "attention", translation: "注意機構", note: null });
  const dir = writePaper(PAPER);
  fs.writeFileSync(path.join(dir, "sentences.json"), JSON.stringify(doc));
}
fixture();
writePaper("unparsed");

const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const t = TOOLS.find((x) => x.name === name);
  assert.ok(t, name);
  const r = await t.handler(args);
  return JSON.parse(r.content[0].text);
};
const rejects = (name: string, args: Record<string, unknown>, pattern: RegExp) =>
  assert.rejects(TOOLS.find((x) => x.name === name)!.handler(args), pattern);

test("解析前の論文は parse_sentences を呼ぶよう案内する", async () => {
  for (const name of ["get_sentence_outline", "get_sentences", "get_translation_batch"]) {
    await rejects(name, { paper: "unparsed" }, /parse_sentences/);
  }
  await rejects("get_sentence_outline", { paper: "nope" }, /論文が見つかりません/);
});

test("概要: 進捗・但し書き・節が返る", async () => {
  const r = await tool("get_sentence_outline", { paper: PAPER });
  assert.equal(r.parser, "fallback");
  assert.match(r.caveat, /読み順が崩れている疑い/);
  assert.equal(r.uniqueSentences, 5);
  assert.equal(r.translated, 1);
  assert.equal(r.remaining, 4);
  assert.equal(r.firstUntranslatedOrder, 1);
  assert.deepEqual(r.sections.map((s: { firstOrder: number }) => s.firstOrder), [0, 3]);
});

test("翻訳の窓: 同じ本文は 1 回だけ、用語集と但し書きは最初に付く", async () => {
  const r = await tool("get_translation_batch", { paper: PAPER, from: 0, limit: 10 });
  assert.deepEqual(r.untranslated, [1, 2, 3, 5]);
  assert.deepEqual(r.duplicateOf, { 4: 2 });
  assert.equal(r.remainingUnique, 4);
  assert.equal(r.window[0][3], 1);
  assert.equal(r.glossary[0].translation, "注意機構");
  assert.ok(r.caveat);
  // 変わっていない用語集は 2 回目以降は付かない
  const again = await tool("get_translation_batch", { paper: PAPER, from: 4, limit: 2 });
  assert.equal(again.glossary, undefined);
  assert.equal(again.nextUntranslatedFrom, 1); // 末尾まで来たら先頭へ回り込む
});

test("訳の書き込み: 人手修正済みと未知の hash は機械可読に断る", async () => {
  const r = await tool("set_translations", {
    paper: PAPER,
    translations: [
      { sentenceHash: HASH[1], text: "疎な窓注意機構を提案する。" },
      { sentenceHash: HASH[2], text: "結果を表 1 に示す。" },
      { sentenceHash: HASH[0], text: "上書きしようとする訳" },
      { sentenceHash: "0000000000000000", text: "どこにも無い" },
    ],
  });
  assert.equal(r.applied, 2);
  assert.equal(r.sentencesAffected, 3); // 表 1 の文は 2 か所に出る
  assert.deepEqual(r.skipped.map((s: { code: string }) => s.code).sort(), ["revised_by_human", "unknown_hash"]);
  assert.equal(r.remainingUnique, 2);
  const file = JSON.parse(fs.readFileSync(path.join(data, "papers", PAPER, "sentences.json"), "utf8"));
  assert.equal(file.annotations.translations[HASH[0]].text, "Transformer は広く使われている。");
  assert.equal(file.annotations.translations[HASH[1]].source, "claude");
});

test("訳さない記録: 残件から外れ、訳のある文は対象外にしない", async () => {
  const r = await tool("skip_sentences", { paper: PAPER, sentence_hashes: [HASH[3], HASH[1], "ffff"], reason: "reference" });
  assert.equal(r.skipped, 1);
  assert.deepEqual(r.alreadyTranslated, [HASH[1]]);
  assert.deepEqual(r.unknownHashes, ["ffff"]);
  assert.equal(r.remainingUnique, 1);
  const undo = await tool("skip_sentences", { paper: PAPER, sentence_hashes: [HASH[3]], undo: true });
  assert.equal(undo.restored, 1);
  assert.equal(undo.remainingUnique, 2);
  await tool("skip_sentences", { paper: PAPER, sentence_hashes: [HASH[3]], reason: "reference" });
});

test("最後の 1 文を訳すと完了と分かる", async () => {
  const r = await tool("set_translations", { paper: PAPER, translations: [{ sentenceHash: HASH[5], text: "提案法はメモリを半分にする。" }] });
  assert.equal(r.remainingUnique, 0);
  assert.equal(r.nextUntranslatedFrom, null);
  const batch = await tool("get_translation_batch", { paper: PAPER, from: 0 });
  assert.deepEqual(batch.untranslated, []);
});

test("文のメモ・取得・検索", async () => {
  const n = await tool("add_sentence_note", { paper: PAPER, sentence_hash: HASH[1], body: "window は「窓」と訳した" });
  assert.ok(n.noteId);
  await rejects("add_sentence_note", { paper: PAPER, sentence_hash: "abcd", body: "x" }, /hash を取り直して/);
  const g = await tool("get_sentences", { paper: PAPER, section_id: "s1" });
  assert.equal(g.matched, 3);
  assert.deepEqual(g.sentences[1].notes, ["window は「窓」と訳した"]);
  assert.equal(g.sentences[0].revisedByHuman, true);
  const s = await tool("search_sentences", { paper: PAPER, query: "表 1" });
  assert.equal(s.total, 2);
  assert.deepEqual(s.hits[0].where, ["translation"]);
  const none = await tool("get_sentences", { paper: PAPER, section_id: "zz" });
  assert.match(none.hint, /節 zz はこの論文にありません/);
});

test("用語集: 既定は追記、replace で置き換え", async () => {
  const a = await tool("update_glossary", { paper: PAPER, entries: [{ term: "window", translation: "窓" }, { term: "Attention", translation: "アテンション" }] });
  assert.deepEqual([a.added, a.updated, a.total], [1, 1, 2]);
  const r = await tool("update_glossary", { paper: PAPER, entries: [{ term: "memory", translation: "メモリ" }], mode: "replace" });
  assert.equal(r.total, 1);
  const o = await tool("get_sentence_outline", { paper: PAPER });
  assert.deepEqual(o.glossary.map((g: { term: string }) => g.term), ["memory"]);
});

test("区切りの直し: merge で新しい hash を返し、undo で戻す", async () => {
  const m = await tool("fix_sentence_boundary", { paper: PAPER, action: "merge", sentence_hashes: [HASH[0], HASH[1]] });
  assert.equal(m.applied, true);
  assert.equal(m.resultHashes.length, 1);
  assert.equal(m.detached.translations, 2);
  assert.ok(m.editId);
  const bad = await tool("fix_sentence_boundary", { paper: PAPER, action: "merge", sentence_hashes: [HASH[2]] });
  assert.equal(bad.applied, false);
  const u = await tool("fix_sentence_boundary", { paper: PAPER, action: "undo" });
  assert.equal(u.applied, true);
  const o = await tool("get_sentence_outline", { paper: PAPER });
  assert.equal(o.sentences, 6);
  const none = await tool("fix_sentence_boundary", { paper: PAPER, action: "undo" });
  assert.equal(none.applied, false);
});

test("区切りの直しの記録を概要に出し、ID を指して取り消せる", async () => {
  const m = await tool("fix_sentence_boundary", { paper: PAPER, action: "merge", sentence_hashes: [HASH[1], HASH[2]] });
  const o = await tool("get_sentence_outline", { paper: PAPER });
  assert.equal(o.boundaryEdits.length, 1);
  assert.equal(o.boundaryEdits[0].id, m.editId);
  assert.equal(o.boundaryEdits[0].type, "merge");
  assert.equal(o.boundaryEdits[0].detached, undefined);
  assert.match(o.boundaryEdits[0].source, /We propose sparse window attention/);
  const u = await tool("fix_sentence_boundary", { paper: PAPER, action: "undo", undo_edit_id: o.boundaryEdits[0].id });
  assert.equal(u.undoneEditId, m.editId);
  assert.deepEqual((await tool("get_sentence_outline", { paper: PAPER })).boundaryEdits, []);
});

test("文のメモは ID 付きで返り、remove_sentence_note で消せる", async () => {
  const g = await tool("get_sentences", { paper: PAPER, section_id: "s1" });
  const item = g.sentences[1].noteItems[0];
  assert.equal(item.body, "window は「窓」と訳した");
  assert.deepEqual(g.sentences[1].notes, ["window は「窓」と訳した"]); // 前からの形も残す
  const s = await tool("search_sentences", { paper: PAPER, query: "窓" });
  assert.equal(s.hits.find((h: { hash: string }) => h.hash === HASH[1]).noteItems[0].id, item.id);
  const b = await tool("get_translation_batch", { paper: PAPER, from: 0, limit: 6 });
  assert.equal(b.notes[1][0].id, item.id);
  const r = await tool("remove_sentence_note", { paper: PAPER, note_id: item.id });
  assert.equal(r.removed, item.id);
  assert.equal(r.sentenceHash, HASH[1]);
  assert.equal((await tool("get_sentences", { paper: PAPER, section_id: "s1" })).sentences[1].noteItems, undefined);
  await rejects("remove_sentence_note", { paper: PAPER, note_id: item.id }, /メモが見つかりません/);
});

test("用語集から 1 語だけ消す", async () => {
  await tool("update_glossary", { paper: PAPER, entries: [{ term: "window", translation: "窓" }] });
  const r = await tool("remove_glossary_terms", { paper: PAPER, terms: ["MEMORY", "nope"] });
  assert.deepEqual(r.removed, ["MEMORY"]);
  assert.deepEqual(r.unknownTerms, ["nope"]);
  assert.equal(r.total, 1);
  assert.deepEqual((await tool("get_sentence_outline", { paper: PAPER })).glossary.map((g: { term: string }) => g.term), ["window"]);
});

test("訳を消す: 人が直した訳は、include_human を付けない限り残す", async () => {
  const r = await tool("clear_translations", { paper: PAPER, sentence_hashes: [HASH[0], HASH[1], HASH[3], "zzzz"] });
  assert.equal(r.cleared, 1);
  assert.deepEqual(r.keptHuman, [HASH[0]]);
  assert.deepEqual(r.unknownHashes, ["zzzz"]);
  assert.deepEqual(r.untranslated, [HASH[3]]);
  assert.match(r.hint, /人が直した訳/);
  assert.equal(r.remainingUnique, 1);
  const file = () => JSON.parse(fs.readFileSync(path.join(data, "papers", PAPER, "sentences.json"), "utf8")).annotations.translations;
  assert.equal(file()[HASH[1]], undefined);
  assert.ok(file()[HASH[0]]);
  // 訳を消した文は「訳さない」にできる
  const sk = await tool("skip_sentences", { paper: PAPER, sentence_hashes: [HASH[1]], reason: "other" });
  assert.equal(sk.skipped, 1);
  await tool("skip_sentences", { paper: PAPER, sentence_hashes: [HASH[1]], undo: true });
  const all = await tool("clear_translations", { paper: PAPER, sentence_hashes: [HASH[0]], include_human: true });
  assert.equal(all.cleared, 1);
  assert.deepEqual(all.keptHuman, []);
  assert.equal(file()[HASH[0]], undefined);
});

test("読み取りのみでは対訳の書き込みツールを出さない。設定画面に手順が載る", () => {
  const read = READ_TOOLS.map((t) => t.name);
  const write = WRITE_TOOLS.map((t) => t.name);
  for (const n of ["get_sentence_outline", "get_sentences", "get_translation_batch", "search_sentences"]) assert.ok(read.includes(n), n);
  for (const n of [
    "set_translations",
    "add_sentence_note",
    "remove_sentence_note",
    "update_glossary",
    "remove_glossary_terms",
    "clear_translations",
    "skip_sentences",
    "fix_sentence_boundary",
    "parse_sentences",
  ]) {
    assert.ok(write.includes(n), n);
    assert.ok(!read.includes(n), n);
  }
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, TOOLS.length);
  const info = mcpInfo();
  assert.equal(info.tools.find((t) => t.name === "set_translations")?.group, "sentences");
  assert.equal(info.tools.find((t) => t.name === "add_term")?.group, "notes");
  assert.ok(info.translationWorkflow.some((l) => l.includes("remainingUnique")));
});
