import assert from "node:assert/strict";
import { test } from "node:test";
import { expandTerm, matchesQuery, normalizeQuery, queryTerms } from "./searchText.ts";

test("正規化: 全角・大文字・空白（全角の空白を含む）の違いを無くす", () => {
  assert.equal(normalizeQuery(" ＡＰＩ　キー "), "apiキー");
  assert.equal(normalizeQuery("Dark Mode"), "darkmode");
});

test("空白の有無と全角半角を問わない", () => {
  assert.ok(matchesQuery("Claude の API キーを入力します", "APIキー"));
  assert.ok(matchesQuery("Claude の APIキー", "api キー"));
  assert.ok(matchesQuery("BibTeX を書き出す", "ｂｉｂｔｅｘ"));
});

test("言い換え: 初めて使う人の言い方で当たる", () => {
  assert.ok(matchesQuery("選んだ文を日本語に訳します", "翻訳"));
  assert.ok(matchesQuery("選んだ文を日本語に訳します", "訳せない"));
  assert.ok(matchesQuery("保存先フォルダの papers/", "保存場所"));
  assert.ok(matchesQuery("明るい表示と暗い表示を切り替え", "ダークモード"));
  assert.ok(matchesQuery("キーボード操作の一覧", "ショートカット"));
  assert.ok(matchesQuery("設定を書き出して読み込む", "バックアップ"));
  assert.ok(matchesQuery("Anthropic が課金します", "料金"));
});

test("表の語と残りの文字の両方が要る。助詞は無視する", () => {
  assert.deepEqual(expandTerm("PDFが")[0], ["pdf"]);
  assert.equal(queryTerms("PDFが表示されない").length, 2);
  assert.ok(matchesQuery("PDF のページが見えないとき", "PDFが表示されない"));
  assert.ok(!matchesQuery("スライドが見えないとき", "PDFが表示されない"));
  assert.ok(!matchesQuery("テーマを変える", "PDFが表示されない"));
});

test("語はすべて当たる必要がある。追加の語でも当たる。空の検索語はすべてに当たる", () => {
  assert.ok(!matchesQuery("スライドを囲む", "スライド 料金"));
  assert.ok(matchesQuery("お金はかかりますか", "費用"));
  assert.ok(matchesQuery("表示", "バックアップ", ["書き出し"]));
  assert.ok(matchesQuery("なんでも", "  "));
});
