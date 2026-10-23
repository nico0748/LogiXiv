import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_STYLE, glossaryFor, glossaryItemToPair, glossaryRule, mergeGlossary, styleOf, termToPair, trimAround } from "./aiPrompt.ts";

test("文体は言語ごと。空なら初期値", () => {
  assert.equal(styleOf({ apiKey: "", model: "" }), DEFAULT_STYLE.ja);
  assert.equal(styleOf({ apiKey: "", model: "", lang: "en" }), DEFAULT_STYLE.en);
  assert.equal(styleOf({ apiKey: "", model: "", style: { ja: "  " } }), DEFAULT_STYLE.ja);
  assert.equal(styleOf({ apiKey: "", model: "", style: { ja: "短く書く" } }), "短く書く");
});

test("前後の本文を選んだ文の前後に切り詰める", () => {
  const around = `${"a".repeat(1000)}TARGET${"b".repeat(1000)}`;
  const r = trimAround(around, "TARGET", 100);
  assert.equal(r, `${"a".repeat(100)}TARGET${"b".repeat(100)}`);
  // 短ければそのまま
  assert.equal(trimAround("xx TARGET yy", "TARGET", 100), "xx TARGET yy");
  // 見つからなければ先頭から
  assert.equal(trimAround("c".repeat(500), "zzz", 50).length, 100);
});

test("訳語の固定は送る文に出てくる語だけ", () => {
  const pairs = [{ en: "Self-Attention", ja: "自己注意" }, { en: "token", ja: "トークン" }];
  assert.deepEqual(glossaryFor(pairs, "We use self-attention here."), [pairs[0]]);
  assert.deepEqual(glossaryFor(undefined, "x"), []);
  assert.equal(glossaryRule([]), "");
  assert.match(glossaryRule([pairs[0]]), /Self-Attention → 自己注意/);
});

test("用語の見出しから訳語の対を取り出す", () => {
  assert.deepEqual(termToPair("自己注意（self-attention）"), { en: "self-attention", ja: "自己注意" });
  assert.deepEqual(termToPair("Transformer (変換器)"), { en: "Transformer", ja: "変換器" });
  assert.equal(termToPair("Transformer"), null);
  assert.equal(termToPair("BERT（RoBERTa）"), null);
  assert.deepEqual(glossaryItemToPair("tokenizer", "トークナイザ"), { en: "tokenizer", ja: "トークナイザ" });
  assert.equal(glossaryItemToPair("tokenizer", "文を細かく分ける仕組みである。"), null);
});

test("既にある語は足さない（大文字と小文字は区別しない）", () => {
  const r = mergeGlossary([{ en: "Token", ja: "トークン" }], [{ en: "token", ja: "字句" }, { en: "head", ja: "ヘッド" }]);
  assert.equal(r.added, 1);
  assert.deepEqual(r.list.map((p) => p.en), ["Token", "head"]);
});

test("訳語の固定は語の切れ目で当てる。入力途中の空白や空の訳語は使わない", () => {
  const pairs = [{ en: "head", ja: "ヘッド" }, { en: "C++", ja: "シープラスプラス" }, { en: "token ", ja: " トークン " }, { en: "layer", ja: "" }];
  assert.deepEqual(glossaryFor(pairs, "Go ahead."), []);
  assert.deepEqual(glossaryFor(pairs, "Each head attends."), [{ en: "head", ja: "ヘッド" }]);
  assert.deepEqual(glossaryFor(pairs, "written in C++ code"), [{ en: "C++", ja: "シープラスプラス" }]);
  assert.deepEqual(glossaryFor(pairs, "one token per layer"), [{ en: "token", ja: "トークン" }]);
});
