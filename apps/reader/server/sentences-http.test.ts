// 対訳の HTTP API と、変更の通知（SSE の kind "sentences"）のテスト。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "paperlens-sentences-http-"));
process.env.PAPERLENS_DATA = data;
process.env.PAPERLENS_CONFIG = path.join(data, "config.json");
process.env.PAPERLENS_GROBID_URL = "http://127.0.0.1:9";

const { startServer } = await import("./app.ts");
const sample = fs.readFileSync(new URL("../src/demo/sample.pdf", import.meta.url));

let s: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  s = await startServer({ port: 0 });
});
after(async () => {
  await s.close();
  fs.rmSync(data, { recursive: true, force: true });
});

const api = async (p: string, method = "GET", body?: unknown) => {
  const res = await fetch(`${s.url}${p}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "x-paperlens-client": "test-client" } });
  return { status: res.status, body: await res.json() };
};

test("取り込むと自動で文に分かれ、通知が届き、API で注釈を書ける", async () => {
  // 通知を聞く
  const ctrl = new AbortController();
  const events: { kind: string; paper?: string }[] = [];
  const res = await fetch(`${s.url}/api/events`, { signal: ctrl.signal });
  void (async () => {
    const dec = new TextDecoder();
    try {
      const reader = res.body!.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const m of dec.decode(value).matchAll(/^data: (.+)$/gm)) events.push(JSON.parse(m[1]));
      }
    } catch {
      // 止めたとき
    }
  })();

  const imp = await fetch(`${s.url}/api/papers?name=sample.pdf`, { method: "POST", body: sample });
  const { id } = (await imp.json()) as { id: string };
  let st = (await api(`/api/papers/${id}/sentences`)).body;
  for (let i = 0; i < 100 && st.status === "parsing"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    st = (await api(`/api/papers/${id}/sentences`)).body;
  }
  assert.equal(st.status, "ready", JSON.stringify(st).slice(0, 300));
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(events.some((e) => e.kind === "sentences" && e.paper === id), JSON.stringify(events));
  ctrl.abort();

  const [a, b] = st.document.structure.sentences;
  let r = await api(`/api/papers/${id}/sentences/translations/${a.hash}`, "PUT", { text: "訳" });
  assert.equal(r.status, 200);
  assert.equal(r.body.document.annotations.translations[a.hash].source, "human");
  r = await api(`/api/papers/${id}/sentences/notes`, "POST", { hash: a.hash, body: "メモ" });
  const noteId = r.body.document.annotations.notes[0].id;
  r = await api(`/api/papers/${id}/sentences/notes/${noteId}`, "DELETE");
  assert.equal(r.body.document.annotations.notes.length, 0);
  r = await api(`/api/papers/${id}/sentences/skip`, "POST", { hashes: [b.hash], reason: "柱" });
  assert.equal(r.body.document.annotations.skipped[b.hash].reason, "柱");
  r = await api(`/api/papers/${id}/sentences/skip`, "DELETE", { hashes: [b.hash] });
  assert.equal(r.body.document.annotations.skipped[b.hash], undefined);
  r = await api(`/api/papers/${id}/sentences/glossary`, "PUT", { term: "A/B", translation: "エービー" });
  assert.equal(r.body.document.annotations.glossary[0].term, "A/B");
  r = await api(`/api/papers/${id}/sentences/glossary/${encodeURIComponent("A/B")}`, "DELETE");
  assert.equal(r.body.document.annotations.glossary.length, 0);
  r = await api(`/api/papers/${id}/sentences/edits`, "POST", { type: "merge", hashes: [a.hash, b.hash] });
  assert.equal(r.status, 200);
  const editId = r.body.document.annotations.sentenceEdits[0].id;
  r = await api(`/api/papers/${id}/sentences/edits/${editId}`, "DELETE");
  assert.equal(r.body.document.annotations.sentenceEdits.length, 0);
  r = await api(`/api/papers/${id}/sentences/translations/${a.hash}`, "DELETE");
  assert.equal(r.body.document.annotations.translations[a.hash], undefined);

  // 誤った入力・無い論文
  assert.equal((await api(`/api/papers/${id}/sentences/edits`, "POST", { type: "x", hashes: [a.hash] })).status, 400);
  assert.equal((await api(`/api/papers/${id}/sentences/translations/nope`, "PUT", { text: "x" })).status, 400);
  assert.equal((await api(`/api/papers/nope/sentences`)).status, 404);

  // 解析し直し: すぐ parsing が返り、終わると ready
  r = await api(`/api/papers/${id}/sentences/parse`, "POST", { parser: "fallback" });
  assert.equal(r.body.status, "parsing");
  for (let i = 0; i < 100 && r.body.status === "parsing"; i++) {
    await new Promise((res) => setTimeout(res, 100));
    r = await api(`/api/papers/${id}/sentences`);
  }
  assert.equal(r.body.status, "ready");
});
