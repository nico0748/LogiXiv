import assert from "node:assert/strict";
import { test } from "node:test";
import { FrontmatterError, readFrontmatter, setFrontmatterValue } from "./frontmatter.ts";

// frontmatter の外（閉じの --- の後ろ）。すべての書き換えで、ここが変わらないことを確かめる（18）
const BODY = "\n\n# 題名\n\n本文 key: value\n- 箇条書き\n---\n";
const fm = (inner: string) => `---\n${inner}\n---${BODY}`;
const inner = (md: string) => md.slice(4, md.lastIndexOf(`\n---${BODY}`));
const set = (md: string, key: string, v: string | string[]) => {
  const out = setFrontmatterValue(md, key, v);
  assert.ok(out.endsWith(`---${BODY}`) || !md.startsWith("---"), "frontmatter の外が変わった");
  return out;
};

const OBSIDIAN = fm("authors:\n  - Alice Example\n  - Bob Sample\nyear: 2024");

test("1. ブロック形式の一覧を配列で読む", () => {
  assert.deepEqual(readFrontmatter(OBSIDIAN), { authors: ["Alice Example", "Bob Sample"], year: "2024" });
});

test("2. 配列を書くと、ブロック形式のまま置き換え、ほかの行は残る", () => {
  assert.equal(inner(set(OBSIDIAN, "authors", ["C"])), "authors:\n  - C\nyear: 2024");
});

test("3. 一覧の項目に文字列を書くと、分けてブロック形式で書く", () => {
  assert.equal(inner(set(OBSIDIAN, "authors", "C; D")), "authors:\n  - C\n  - D\nyear: 2024");
});

test("4. 字下げの無いブロック形式を保つ", () => {
  assert.equal(inner(set(fm("authors:\n- A\n- B"), "authors", ["X"])), "authors:\n- X");
});

test("5. フロー形式の一覧を読む", () => {
  assert.deepEqual(readFrontmatter(fm("tags: [paper, ml]")).tags, ["paper", "ml"]);
});

test("6. フロー形式の一覧は、フロー形式で書き戻す", () => {
  assert.equal(inner(set(fm("tags: [paper, ml]"), "tags", ["paper", "nlp"])), "tags: [paper, nlp]");
});

test("7. フロー形式の要素の中の , は引用符の中だけ許す", () => {
  assert.deepEqual(readFrontmatter(fm('tags: ["a, b", c]')).tags, ["a, b", "c"]);
});

const MULTI = fm("abstract: |\n  line1\n  line2\nyear: 2024");

test("8. 複数行の値は書き換えずにエラーにする", () => {
  assert.throws(() => setFrontmatterValue(MULTI, "abstract", "x"), (e) => e instanceof FrontmatterError && /複数行の値/.test(e.message));
});

test("9. 複数行の値の項目は残し、ほかの項目を書き換える", () => {
  assert.equal(inner(set(MULTI, "year", "2025")), "abstract: |\n  line1\n  line2\nyear: 2025");
});

test("10. 入れ子の対応表は書き換えない", () => {
  assert.throws(() => setFrontmatterValue(fm("meta:\n  a: 1\n  b: 2"), "meta", "x"), FrontmatterError);
});

test("11. 空の文字列の項目に配列を書くと、ブロック形式になる", () => {
  assert.equal(inner(set(fm('authors: ""'), "authors", ["A", "B"])), "authors:\n  - A\n  - B");
});

test("12. コメントと空行を残す", () => {
  assert.equal(inner(set(fm("# コメント\ntitle: X\n\nstatus: 未読"), "status", "精読")), "# コメント\ntitle: X\n\nstatus: 精読");
});

test("13. frontmatter が無いノートには、先頭に足す", () => {
  const md = "# 題名\n\n本文\n";
  const out = setFrontmatterValue(md, "year", "2024");
  assert.equal(out, `---\nyear: 2024\n---\n\n${md}`);
});

test("14. \\r\\n の改行を保つ", () => {
  const md = "---\r\ntitle: X\r\nstatus: 未読\r\n---\r\n\r\n本文\r\n";
  assert.equal(setFrontmatterValue(md, "status", "精読"), "---\r\ntitle: X\r\nstatus: 精読\r\n---\r\n\r\n本文\r\n");
});

test("15. YAML の予約語は引用符で囲む", () => {
  assert.equal(inner(set(fm("title: X"), "title", "null")), 'title: "null"');
  assert.equal(inner(set(fm("title: X"), "title", "Yes")), 'title: "Yes"');
});

test("16. 記号で始まる値は引用符で囲む", () => {
  assert.equal(inner(set(fm("title: X"), "title", "- dash")), 'title: "- dash"');
  assert.equal(inner(set(fm("title: X"), "title", "#1")), 'title: "#1"');
});

test("17. 一覧の後ろの空行を残す", () => {
  assert.equal(inner(set(fm("authors:\n  - A\n\nyear: 2024"), "authors", ["B"])), "authors:\n  - B\n\nyear: 2024");
});

test("18. 数字だけの値は引用符を付けない。項目が無ければ末尾に足す", () => {
  assert.equal(inner(set(fm("title: X"), "year", "2024")), "title: X\nyear: 2024");
  assert.equal(inner(set(fm("title: X"), "authors", ["A"])), "title: X\nauthors:\n  - A");
});

// C2 N-1: 日本語・スペース・引用符を含む項目名
test("N-1. 日本語の項目名の行は、前の一覧に吸い込まれない", () => {
  const md = fm("authors:\n  - A\n読了日: 2026-10-01");
  assert.equal(inner(set(md, "authors", ["B", "C"])), "authors:\n  - B\n  - C\n読了日: 2026-10-01");
  assert.equal(readFrontmatter(md)["読了日"], "2026-10-01");
});

test("N-1. スペースを含む項目名の後ろの項目を書き換えても、その行は残る", () => {
  const md = fm("my rating: 4\nstatus: 未読");
  assert.equal(inner(set(md, "status", "精読")), "my rating: 4\nstatus: 精読");
  assert.equal(readFrontmatter(md)["my rating"], "4");
});

test("N-1. 引用符付きの項目名", () => {
  const md = fm('"a:b": 1\ntags:\n  - x');
  assert.deepEqual(readFrontmatter(md), { "a:b": "1", tags: ["x"] });
  assert.equal(inner(set(md, "a:b", "2")), '"a:b": 2\ntags:\n  - x');
});

test("空の配列は key: [] で書く", () => {
  assert.equal(inner(set(OBSIDIAN, "authors", [])), "authors: []\nyear: 2024");
  assert.deepEqual(readFrontmatter(fm("authors: []")).authors, []);
});

test("空のフロー形式の一覧（テンプレートの authors: []）に書くと、ブロック形式になる", () => {
  assert.equal(inner(set(fm("authors: []\nyear: 2024"), "authors", ["A", "B"])), "authors:\n  - A\n  - B\nyear: 2024");
});

test("0 で始まる数字は引用符で囲み、読み直すと同じ文字列になる", () => {
  const out = set(fm("title: x\nyear: 2024"), "year", "007");
  assert.match(inner(out), /^year: "007"$/m);
  assert.equal(readFrontmatter(out).year, "007");
  assert.match(inner(set(fm("year: 1"), "year", "2017")), /^year: 2017$/m);
});
