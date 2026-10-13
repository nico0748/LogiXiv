// 1 文ずつの対訳の保存（papers/<id>/sentences.json）の単体テスト。
// GROBID は使わず、簡易解析（pdf.js）で文に分ける。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// GROBID が手元で動いていても、テストは必ず簡易解析を通す。
process.env.PAPERLENS_GROBID_URL = "http://127.0.0.1:9";

const { importPaper } = await import("../src/lib/papers.ts");
const { NodeVault } = await import("./nodeVault.ts");
const S = await import("./sentences.ts");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperlens-sentences-"));
const vault = new NodeVault(root);
const sample = fs.readFileSync(new URL("../src/demo/sample.pdf", import.meta.url));
let id = "";

before(async () => {
  id = await importPaper(vault, "sample.pdf", sample.buffer.slice(sample.byteOffset, sample.byteOffset + sample.byteLength) as ArrayBuffer, "Sample");
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

const file = () => path.join(root, "papers", id, "sentences.json");
const ready = async () => {
  const s = await S.sentencesState(vault, id);
  assert.equal(s.status, "ready");
  return (s as { document: import("@paperlens/core").PaperDocument }).document;
};

test("解析前は none、解析中は parsing、終わると ready", async () => {
  assert.deepEqual(await S.sentencesState(vault, id), { status: "none" });
  const done = S.parseSentences(vault, id, "auto");
  assert.equal((await S.sentencesState(vault, id)).status, "parsing");
  // 二重に始めても同じ解析を待つ
  assert.equal(S.parseSentences(vault, id, "auto"), done);
  const r = await done;
  assert.equal(r.status, "ready", JSON.stringify(r).slice(0, 300));
  const doc = await ready();
  assert.equal(doc.id, id);
  assert.equal(doc.structure.parser, "fallback");
  assert.ok(doc.structure.sentences.length > 5, `${doc.structure.sentences.length}`);
  assert.ok(fs.existsSync(file()));
  // GROBID が使えなかったことは warning で伝わる
  assert.match((await S.sentencesState(vault, id) as { warning?: string }).warning ?? "", /GROBID/);
});

test("訳を付ける・まとめて付ける・消す", async () => {
  const [a, b] = (await ready()).structure.sentences;
  let doc = await S.setTranslation(vault, id, a.hash, "訳A", "human");
  assert.equal(doc.annotations.translations[a.hash].text, "訳A");
  assert.equal(doc.annotations.translations[a.hash].revisedByHuman, true);
  const r = await S.setTranslations(vault, id, [{ hash: a.hash, text: "機械A" }, { hash: b.hash, text: "訳B" }, { hash: "nope", text: "x" }], "claude");
  // 人が直した訳は機械が上書きしない
  assert.equal(r.applied, 1);
  assert.deepEqual(r.unknown.sort(), [a.hash, "nope"].sort());
  assert.equal(r.document.annotations.translations[a.hash].text, "訳A");
  doc = await S.clearTranslation(vault, id, b.hash);
  assert.equal(doc.annotations.translations[b.hash], undefined);
  await assert.rejects(S.setTranslation(vault, id, "nope", "x", "human"), /該当する文がありません/);
});

test("メモ・訳さない・用語集", async () => {
  const [, , c, d] = (await ready()).structure.sentences;
  let doc = await S.addSentenceNote(vault, id, c.hash, "ここが要点");
  const note = doc.annotations.notes.find((n) => n.sentenceHash === c.hash)!;
  assert.equal(note.body, "ここが要点");
  doc = await S.removeSentenceNote(vault, id, note.id);
  assert.equal(doc.annotations.notes.length, 0);
  await assert.rejects(S.removeSentenceNote(vault, id, note.id), /メモが見つかりません/);

  doc = await S.skipSentences(vault, id, [d.hash], "数式");
  assert.equal(doc.annotations.skipped?.[d.hash]?.reason, "数式");
  doc = await S.unskipSentences(vault, id, [d.hash]);
  assert.equal(doc.annotations.skipped?.[d.hash], undefined);

  doc = await S.upsertGlossary(vault, id, { term: "attention", translation: "注意機構" });
  doc = await S.upsertGlossary(vault, id, { term: "Attention", translation: "アテンション", note: "表記を統一" });
  assert.deepEqual(doc.annotations.glossary, [{ term: "Attention", translation: "アテンション", note: "表記を統一" }]);
  doc = await S.removeGlossary(vault, id, "attention");
  assert.equal(doc.annotations.glossary.length, 0);
  await assert.rejects(S.upsertGlossary(vault, id, { term: " ", translation: "x" }), /原語が空/);
});

test("文の区切りを直して、取り消す", async () => {
  const before = (await ready()).structure.sentences;
  const [x, y] = before.slice(4, 6);
  let doc = await S.editSentenceBoundary(vault, id, { type: "merge", hashes: [x.hash, y.hash] });
  assert.equal(doc.structure.sentences.length, before.length - 1);
  const edit = doc.annotations.sentenceEdits!.at(-1)!;
  doc = await S.undoSentenceEdit(vault, id, edit.id);
  assert.equal(doc.structure.sentences.length, before.length);
  assert.deepEqual(doc.structure.sentences.map((s) => s.hash), before.map((s) => s.hash));
  await assert.rejects(S.editSentenceBoundary(vault, id, { type: "merge", hashes: ["a", "b"] }), (e: Error) => e instanceof S.SentencesError);
});

test("解析し直しても、訳と区切りの直しは残る", async () => {
  const sents = (await ready()).structure.sentences;
  const t = sents[1];
  await S.setTranslation(vault, id, t.hash, "残る訳", "human");
  const [x, y] = sents.slice(6, 8);
  await S.editSentenceBoundary(vault, id, { type: "merge", hashes: [x.hash, y.hash] });
  const count = (await ready()).structure.sentences.length;
  const r = await S.parseSentences(vault, id, "fallback");
  assert.equal(r.status, "ready");
  const doc = await ready();
  assert.equal(doc.annotations.translations[t.hash].text, "残る訳");
  assert.equal(doc.structure.sentences.length, count);
  assert.equal(doc.annotations.sentenceEdits!.filter((e) => !e.detached).length, 1);
  // 読み直しても中身が変わらない（sanitize が何も落とさない）
  const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
  assert.deepEqual(doc.structure, raw.structure);
});

test("壊れたファイルは failed で伝え、解析し直すと退避して作り直す", async () => {
  fs.writeFileSync(file(), "{ broken");
  const s = await S.sentencesState(vault, id);
  assert.equal(s.status, "failed");
  assert.equal((s as { code?: string }).code, "corrupt");
  await assert.rejects(S.setTranslation(vault, id, "x", "y", "human"), /壊れて/);
  const r = await S.parseSentences(vault, id, "fallback");
  assert.equal(r.status, "ready");
  assert.ok(fs.readdirSync(path.join(root, "papers", id)).some((n) => n.startsWith("sentences.corrupt-")));
});

test("読めない PDF は failed になり、理由の印が付く", async () => {
  const bad = await importPaper(vault, "bad.pdf", new TextEncoder().encode("%PDF-1.4\nnot really a pdf").buffer as ArrayBuffer, "Bad");
  const r = await S.parseSentences(vault, bad, "fallback");
  assert.equal(r.status, "failed");
  assert.ok((r as { code?: string }).code, JSON.stringify(r));
  const s = await S.sentencesState(vault, bad);
  assert.equal(s.status, "failed");
  // 無い論文・外を指す ID
  assert.equal((await S.parseSentences(vault, "nope")).status, "failed");
  await assert.rejects(S.sentencesState(vault, "../x"), /論文 ID が正しくありません/);
});
