import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  DEFAULT_MODEL,
  clearStoredPositions,
  exportPrefs,
  getPref,
  importPrefs,
  patchPref,
  resetPref,
  setPref,
  setPrefsStorage,
  subscribePrefs,
} from "./prefs.ts";

/** localStorage の代わり */
function memory(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}

let s = memory();
beforeEach(() => {
  s = memory();
  setPrefsStorage(s);
});

test("保存が無ければ初期値", () => {
  assert.equal(getPref("theme"), "system");
  assert.equal(getPref("pdfZoom"), 1);
  assert.equal(getPref("sentenceMarks"), true);
  assert.equal(getPref("paperSort"), "created");
  assert.deepEqual(getPref("ai"), { apiKey: "", model: DEFAULT_MODEL });
});

test("以前のキーと値をそのまま読む", () => {
  setPrefsStorage(memory({
    "paperlens.theme": "light",
    "paperlens.sentenceMarks": "off",
    "paperlens.ui.paperSort": "year",
    "paperlens.ai": JSON.stringify({ apiKey: "sk-ant-x", model: "claude-sonnet-5-5" }),
  }));
  assert.equal(getPref("theme"), "light");
  assert.equal(getPref("sentenceMarks"), false);
  assert.equal(getPref("paperSort"), "year");
  assert.deepEqual(getPref("ai"), { apiKey: "sk-ant-x", model: "claude-sonnet-5-5" });
});

test("壊れた値は初期値に戻す", () => {
  setPrefsStorage(memory({ "paperlens.theme": "purple", "paperlens.ai": "{oops", "paperlens.pdfZoom": "7", "paperlens.display": JSON.stringify({ fontBody: 99, leading: "x" }) }));
  assert.equal(getPref("theme"), "system");
  assert.equal(getPref("ai").model, DEFAULT_MODEL);
  assert.equal(getPref("pdfZoom"), 1);
  assert.equal(getPref("display").fontBody, 20);
  assert.equal(getPref("display").leading, "normal");
});

test("書き込むと保存し、購読している側に知らせる。初期値はキーを消して表す", () => {
  const seen: string[] = [];
  const off = subscribePrefs((n) => seen.push(n));
  setPref("theme", "dark");
  assert.equal(s.m.get("paperlens.theme"), "dark");
  setPref("theme", "system");
  assert.equal(s.m.has("paperlens.theme"), false);
  setPref("sentenceMarks", false);
  assert.equal(s.m.get("paperlens.sentenceMarks"), "off");
  off();
  setPref("accent", "green");
  assert.deepEqual(seen, ["theme", "theme", "sentenceMarks"]);
});

test("patchPref は一部だけ書き換える", () => {
  patchPref("display", { fontNote: 16 });
  assert.deepEqual(getPref("display"), { fontBody: 13, fontNote: 16, fontSidebar: 13, leading: "normal" });
  patchPref("ai", { apiKey: "k", glossary: [{ en: "attention", ja: "注意" }, { en: "", ja: "空" }] });
  assert.deepEqual(getPref("ai"), { apiKey: "k", model: DEFAULT_MODEL, glossary: [{ en: "attention", ja: "注意" }] });
  resetPref("display");
  assert.equal(getPref("display").fontNote, 13);
});

test("書き出しに API キーを含めない。読み込んでも今のキーは残す", () => {
  patchPref("ai", { apiKey: "sk-ant-secret", lang: "en" });
  setPref("theme", "dark");
  const file = exportPrefs(new Date("2026-10-23T00:00:00Z"));
  const text = JSON.stringify(file);
  assert.ok(!text.includes("sk-ant-secret"));
  assert.equal(file.exportedAt, "2026-10-23T00:00:00.000Z");

  setPrefsStorage(memory({ "paperlens.ai": JSON.stringify({ apiKey: "sk-ant-other", model: "m" }) }));
  const names = importPrefs(text);
  assert.ok(names.includes("theme") && names.includes("ai"));
  assert.equal(getPref("theme"), "dark");
  assert.equal(getPref("ai").apiKey, "sk-ant-other");
  assert.equal(getPref("ai").lang, "en");
});

test("PaperLens の設定でないファイルは読み込まない", () => {
  assert.throws(() => importPrefs("not json"), /JSON/);
  assert.throws(() => importPrefs(JSON.stringify({ app: "Other" })), /PaperLens/);
});

test("前回の位置だけを消す", () => {
  setPrefsStorage(memory({ "paperlens.pos.a/1": "{}", "paperlens.pos.b/2": "{}", "paperlens.theme": "dark" }));
  assert.equal(clearStoredPositions(), 2);
  assert.equal(getPref("theme"), "dark");
});

test("訳語の行は訳語が空でも、入力途中の空白があっても残す", () => {
  patchPref("ai", { glossary: [{ en: "layer", ja: "" }, { en: "token", ja: "トー " }, { en: "  ", ja: "空" }] });
  assert.deepEqual(getPref("ai").glossary, [{ en: "layer", ja: "" }, { en: "token", ja: "トー " }]);
});

test("取り込み時の段階は決まった段階だけ。未読は空で表す", () => {
  setPref("importStatus", "精読");
  assert.equal(getPref("importStatus"), "精読");
  setPref("importStatus", "未読");
  assert.equal(getPref("importStatus"), "");
  const file = JSON.stringify({ app: "PaperLens", kind: "settings", version: 1, prefs: { importStatus: "<script>" } });
  importPrefs(file);
  assert.equal(getPref("importStatus"), "");
});
