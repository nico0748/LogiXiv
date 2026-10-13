import assert from "node:assert/strict";
import { test } from "node:test";
import { bibKey, escapeTex, toBibtex } from "./bibtex.ts";

const base = { title: "Attention Is All You Need", authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"], year: "2017" };

test("1. arXiv だけの論文は @misc と eprint", () => {
  const b = toBibtex({ ...base, venue: "arXiv", arxiv: "1706.03762" }, "x");
  assert.match(b, /^@misc\{vaswani2017attention,\n/);
  assert.match(b, /eprint = \{1706\.03762\}/);
  assert.match(b, /archivePrefix = \{arXiv\}/);
  assert.match(b, /url = \{https:\/\/arxiv\.org\/abs\/1706\.03762\}/);
});

test("2. 会議の論文は @inproceedings", () => {
  const b = toBibtex({ ...base, venue: "Proceedings of ACL 2024" }, "x");
  assert.match(b, /^@inproceedings\{/);
  assert.match(b, /booktitle = \{Proceedings of ACL 2024\}/);
});

test("3. 論文誌は @article", () => {
  const b = toBibtex({ ...base, venue: "Nature", doi: "https://doi.org/10.1038/x" }, "x");
  assert.match(b, /^@article\{/);
  assert.match(b, /journal = \{Nature\}/);
  assert.match(b, /doi = \{10\.1038\/x\}/);
});

test("4. 著者の配列は and でつなぐ", () => {
  const b = toBibtex(base, "x");
  assert.equal(b.match(/ and /g)?.length, 2);
});

test("5. 文字列の著者はそのまま書く", () => {
  const b = toBibtex({ ...base, authors: "Vaswani, A., Shazeer, N." }, "x");
  assert.match(b, /author = \{Vaswani, A\., Shazeer, N\.\}/);
  assert.equal(bibKey({ ...base, authors: "Vaswani, A., Shazeer, N." }, "x"), "vaswani2017attention");
});

test("6. 特殊文字をエスケープし、題名は二重の括弧で囲む", () => {
  assert.equal(escapeTex("50% & $x_1$"), "50\\% \\& \\$x\\_1\\$");
  assert.equal(escapeTex("a\\b~c^d{e}#"), "a\\textbackslash{}b\\textasciitilde{}c\\textasciicircum{}d\\{e\\}\\#");
  assert.match(toBibtex({ ...base, title: "50% & $x_1$" }, "x"), /title = \{\{50\\% \\& \\\$x\\_1\\\$\}\}/);
});

test("7. 著者が無ければ、キーは論文 ID の英数字", () => {
  assert.equal(bibKey({ title: "X", authors: [] }, "20261013-Sparse-Window"), "20261013SparseWindow");
  assert.match(toBibtex({ title: "X" }, "20261013-Sparse-Window"), /^@misc\{20261013SparseWindow,/);
});

test("8. 日本語の題名でも、キーに日本語が入らない", () => {
  const k = bibKey({ title: "長い論文を読むための疎な注意", authors: ["Taro Yamada"], year: "2024" }, "x");
  assert.equal(k, "yamada2024");
  assert.equal(bibKey({ title: "注意", authors: ["山田 太郎"], year: "2024" }, "p-1"), "p1");
});
