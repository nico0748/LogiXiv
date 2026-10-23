import assert from "node:assert/strict";
import { test } from "node:test";
import { appMode, buildReport } from "./appInfo.ts";
import { SETTINGS_PAGES, SETTING_ITEMS, isSettingsPage, searchSettings } from "./settingsIndex.ts";
import { SHORTCUTS, filterShortcuts } from "./shortcuts.ts";

test("項目はどれも、あるページに属し、id が重ならない", () => {
  const ids = SETTING_ITEMS.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const i of SETTING_ITEMS) assert.ok(isSettingsPage(i.page), i.id);
  assert.equal(isSettingsPage("nope"), false);
  assert.ok(SETTINGS_PAGES.every((p) => SETTING_ITEMS.some((i) => i.page === p.id)));
});

test("設定内の検索は項目名と説明と検索用の語で絞り、項目名の当たりを先にする", () => {
  assert.deepEqual(searchSettings(""), []);
  assert.equal(searchSettings("API キー")[0].id, "api-key");
  assert.equal(searchSettings("ダーク")[0].id, "theme");
  // 全角・半角の違いは無視する
  assert.equal(searchSettings("ＰＤＦ")[0].id, "pdf-zoom");
  // 語はすべて含むものだけ
  assert.deepEqual(searchSettings("文字 ノート").map((i) => i.id), ["font-note"]);
  assert.deepEqual(searchSettings("存在しない語"), []);
});

test("ショートカットの検索", () => {
  assert.ok(SHORTCUTS.every((s) => s.keys && s.action && s.scope));
  assert.equal(filterShortcuts(SHORTCUTS, "").length, SHORTCUTS.length);
  assert.ok(filterShortcuts(SHORTCUTS, "全画面").every((s) => s.action.includes("全画面")));
  assert.ok(filterShortcuts(SHORTCUTS, "グラフ").length >= 2);
});

test("動作モードと不具合報告の文面", () => {
  assert.equal(appMode("browser", true), "browser");
  assert.equal(appMode("server", false), "server");
  assert.equal(appMode("server", true), "desktop");
  const r = buildReport({ version: "0.1.0", mode: "server", where: "/data", userAgent: "UA", language: "ja", screen: "1×1" });
  assert.match(r, /^PaperLens 0\.1\.0\n動作モード: ローカルサーバー/);
});
