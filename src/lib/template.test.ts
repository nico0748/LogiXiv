import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATE } from "./defaultTemplate";
import { renderHighlights } from "./model";
import { importPaper, loadNote, saveAnnotations, writeField, writeStatus } from "./papers";
import {
  fillPlaceholders,
  getFrontmatter,
  parseFields,
  setField,
  setFrontmatter,
  setList,
} from "./template";
import { MemoryVault } from "./vault";

const note = fillPlaceholders(DEFAULT_TEMPLATE, {
  title: "Attention Is All You Need",
  date: "2026-10-12",
  pdf: "paper.pdf",
});

describe("テンプレート", () => {
  it("差し込み項目を置き換える", () => {
    expect(note).toContain("title: Attention Is All You Need");
    expect(note).toContain("![[paper.pdf]]");
    expect(note).not.toMatch(/\{\{/);
  });

  it("入力欄を見出しごとに取り出す", () => {
    const f = parseFields(note);
    expect(f.map((x) => x.id)).toEqual([
      "summary", "problem", "purpose", "method", "results",
      "strengths", "limitations", "relevance", "next",
    ]);
    expect(f[0]).toMatchObject({ label: "一言でいうと", section: "1. 概要をつかむ", value: "" });
    expect(f[0].hint).toContain("1〜2文");
    expect(f[3].section).toBe("2. 精読する");
  });

  it("入力欄だけを書き換え、他は変えない", () => {
    const edited = note.replace("## 2. 精読する", "## 2. 精読する\n\n自分で書いた段落");
    const out = setField(edited, "summary", "自己注意だけで翻訳モデルを作った。");
    expect(parseFields(out).find((x) => x.id === "summary")!.value).toBe(
      "自己注意だけで翻訳モデルを作った。",
    );
    expect(out).toContain("自分で書いた段落");
    // 同じ値で書き直しても本文は変わらない
    expect(setField(out, "summary", "自己注意だけで翻訳モデルを作った。")).toBe(out);
    // 空に戻すと元のテンプレートと一致する
    expect(setField(out, "summary", "")).toBe(edited);
  });

  it("$ を含む値も壊さない", () => {
    const out = setField(note, "method", "損失は $L = -\\log p$ で $& と $1 を含む");
    expect(parseFields(out).find((x) => x.id === "method")!.value).toBe(
      "損失は $L = -\\log p$ で $& と $1 を含む",
    );
  });

  it("frontmatter を書き換える", () => {
    const out = setFrontmatter(note, "status", "精読");
    expect(getFrontmatter(out).status).toBe("精読");
    expect(getFrontmatter(setFrontmatter(out, "doi", "10.1/abc:d")).doi).toBe("10.1/abc:d");
  });

  it("一覧の範囲が無いノートには節を足す", () => {
    const out = setList("# メモ\n", "terms", "### [[自己注意]]", "用語");
    expect(out).toContain("## 用語\n\n<!-- list: terms -->\n### [[自己注意]]\n<!-- /list -->");
    expect(setList(out, "terms", "### [[多頭注意]]", "用語")).not.toContain("自己注意");
  });
});

describe("保管庫", () => {
  it("取り込み → 記録 → ノート反映", async () => {
    const v = new MemoryVault();
    const id = await importPaper(v, "attention.pdf", new ArrayBuffer(8), "Attention");
    await writeField(v, id, "summary", "一言");
    await writeStatus(v, id, "概要把握");
    // 外部アプリでの追記
    await v.writeText(`papers/${id}/note.md`, (await loadNote(v, id)) + "\n外部で追記\n");
    const md = await saveAnnotations(v, id, {
      version: 1,
      highlights: [{
        id: "h-1", page: 2, rects: [{ x: 0, y: 0.1, w: 1, h: 0.02 }],
        text: "We propose the Transformer.", color: "yellow",
        translation: "Transformer を提案する。", memo: "", createdAt: "",
      }],
      terms: [],
      equations: [{ id: "e-1", label: "式(1)", tex: "\\mathrm{softmax}(QK^T)", explanation: "", page: 4, source: "", createdAt: "" }],
    });
    expect(md).toContain("一言");
    expect(md).toContain("status: 概要把握");
    expect(md).toContain("外部で追記");
    expect(md).toContain("> 訳: Transformer を提案する。");
    expect(md).toContain("$$\n\\mathrm{softmax}(QK^T)\n$$");
  });

  it("マーカーをページ順に並べる", () => {
    const base = { rects: [{ x: 0, y: 0.5, w: 1, h: 0.1 }], color: "cyan" as const, translation: "", memo: "", createdAt: "" };
    const out = renderHighlights([
      { ...base, id: "b", page: 3, text: "B" },
      { ...base, id: "a", page: 1, text: "A" },
    ]);
    expect(out.indexOf("> A")).toBeLessThan(out.indexOf("> B"));
  });
});
