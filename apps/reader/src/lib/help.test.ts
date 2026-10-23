import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANGELOG, HELP_CHAPTERS, HELP_FAQ, hasUnreadChanges, isHelpPage, parseInline, plainText, searchHelp } from "./help.ts";

test("文の中の `code`・{{キー}}・[[章|文字]] を読み分ける", () => {
  assert.deepEqual(parseInline("保存先の `note.md` を {{⌘/Ctrl + \\}} で [[read|読む]] へ"), [
    { t: "text", v: "保存先の " },
    { t: "code", v: "note.md" },
    { t: "text", v: " を " },
    { t: "kbd", v: "⌘/Ctrl + \\" },
    { t: "text", v: " で " },
    { t: "link", to: "read", v: "読む" },
    { t: "text", v: " へ" },
  ]);
  // 閉じていない記号はそのまま
  assert.deepEqual(parseInline("[スライド | 論文] と `x"), [{ t: "text", v: "[スライド | 論文] と `x" }]);
  assert.equal(plainText("{{j}} / {{k}} で移動"), "j / k で移動");
});

test("章の id は重ならず、よくある質問の章は実在する。リンク先もすべて実在する", () => {
  const ids = HELP_CHAPTERS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const f of HELP_FAQ) if (f.chapter) assert.ok(isHelpPage(f.chapter), f.chapter);
  const texts = [...HELP_CHAPTERS.flatMap((c) => c.blocks.flatMap((b) => ("items" in b ? b.items : "text" in b ? [b.text] : []))), ...HELP_FAQ.flatMap((f) => f.a)];
  for (const t of texts) for (const x of parseInline(t)) if (x.t === "link") assert.ok(isHelpPage(x.to), x.to);
});

test("仕様の章立てがそろっている", () => {
  assert.deepEqual(
    HELP_CHAPTERS.map((c) => c.title.replace(/（.*$/, "")),
    ["はじめに", "論文を取り込む", "読む", "記録する", "対訳で読む", "用語集とグラフ", "スライドと論文を対応させる", "書き出す", "AI エージェントから使う", "設定"],
  );
});

test("検索: 題名に当たった章を先に出し、全角・大文字を区別しない", () => {
  const hits = searchHelp("ｂｉｂｔｅｘ");
  assert.equal(hits[0].page, "export");
  assert.ok(hits[0].snippet.toLowerCase().includes("bibtex"));
  assert.equal(searchHelp("スライド")[0].page, "slides");
});

test("検索: 空白で区切った語はすべて含むものだけ。よくある質問も当たる", () => {
  const hits = searchHelp("API キー");
  assert.ok(hits.some((h) => h.page === "faq" && h.anchor === "faq-ai"));
  assert.ok(hits.every((h) => h.snippet.length > 0));
  assert.deepEqual(searchHelp("スライド 存在しない語"), []);
  assert.deepEqual(searchHelp("   "), []);
});

test("検索: 抜粋は書き方の記号を外し、長いときは … で切る", () => {
  const [hit] = searchHelp("gitignore");
  assert.equal(hit.page, "export");
  assert.ok(!hit.snippet.includes("`"));
  assert.ok(hit.snippet.startsWith("…"));
});

test("検索: 初めて使う人の言い方でも当たる", () => {
  const first = (q: string) => searchHelp(q)[0];
  assert.ok(searchHelp("訳せない").some((h) => h.anchor === "faq-ai"));
  assert.ok(searchHelp("翻訳").some((h) => h.page === "record"));
  assert.ok(searchHelp("保存場所").some((h) => h.anchor === "faq-note"));
  assert.equal(first("ダークモード").page, "settings");
  assert.ok(searchHelp("バックアップ").some((h) => h.anchor === "faq-move"));
  assert.equal(first("料金").anchor, "faq-cost");
  assert.equal(first("PDFが表示されない").anchor, "faq-pdf-blank");
  assert.ok(searchHelp("APIキー").some((h) => h.anchor === "faq-ai"));
  assert.equal(first("ショートカット").page, "keys");
});

test("更新情報の未読: 最新の id を読んでいなければ未読", () => {
  assert.equal(hasUnreadChanges(null), true);
  assert.equal(hasUnreadChanges("old"), true);
  assert.equal(hasUnreadChanges(CHANGELOG[0].id), false);
  assert.equal(hasUnreadChanges(null, []), false);
});
