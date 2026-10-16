// 発表スライドと論文の対応を扱う MCP ツール。
// スライドを四角で囲むのは画面で行う（どこを囲むかは発表者が決める）。エージェントは、囲んだ部分の文字を読み、
// 論文のどの文・図・数式に当たるかをリンクする。画面を開いていれば、線がすぐに描き直される。

import { z } from "zod";
import { readPages, findText } from "../server/pdftext.ts";
import { dataRoot } from "../server/config.ts";
import { NodeVault } from "../server/nodeVault.ts";
import { requirePaper } from "../server/service.ts";
import { markupTexts } from "../server/slides.ts";
import { pdfPath } from "../src/lib/papers.ts";
import { newId } from "../src/lib/model.ts";
import { LINK_KIND_LABEL, type SlideLink, changeMarkups, findMarkup, loadDeck, markupName, rectOf, sortMarkups } from "../src/lib/slides.ts";
import type { Tool } from "./tools.ts";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const PAPER = z.string().describe("論文 ID（papers/ の下のフォルダ名）。list_papers が返す id を指定します");
const MARKUP = z.string().describe("グループの名前（Markup-03.02 の形。3 ページ目の 2 個目）か ID。get_slide_markups で確かめます");

async function deckOf(paper: string) {
  const v = new NodeVault(dataRoot());
  await requirePaper(v, paper);
  const deck = await loadDeck(v, paper);
  if (!deck) throw new Error("この論文にはスライドがありません。利用者に、画面の「スライド」からスライドを追加してもらってください。");
  return { v, deck };
}

function requireMarkup(deck: Awaited<ReturnType<typeof deckOf>>["deck"], key: string) {
  const m = findMarkup(deck, key);
  if (!m) throw new Error(`グループが見つかりません: ${key}。ある名前: ${sortMarkups(deck.markups).map(markupName).join(", ") || "（まだありません）"}`);
  return m;
}

export const SLIDE_READ_TOOLS: Tool[] = [
  {
    name: "get_slide_markups",
    config: {
      title: "スライドのグループを読む",
      description:
        "論文に付けた発表スライドで、四角で囲んだ部分（グループ）の一覧を返します。名前は Markup-ページ.番号 です。slideText は四角の中にある文字（画像だけなら空）、links は論文の該当箇所（文章・図・数式）です。リンクのないグループは、論文を find_in_paper や read_paper_text で読んで link_slide_markup でつないでください。",
      inputSchema: { paper: PAPER },
      annotations: { readOnlyHint: true },
    },
    handler: async ({ paper }) => {
      const { v, deck } = await deckOf(paper);
      const texts = new Map((await markupTexts(v, paper, deck)).map((t) => [t.name, t.text]));
      return json({
        source: deck.source,
        markups: sortMarkups(deck.markups).map((m) => ({
          name: markupName(m),
          id: m.id,
          slidePage: m.page,
          memo: m.memo,
          slideText: texts.get(markupName(m)) ?? "",
          links: m.links.map((l) => ({ id: l.id, kind: l.kind, page: l.page, text: l.text })),
        })),
      });
    },
  },
];

export const SLIDE_WRITE_TOOLS: Tool[] = [
  {
    name: "link_slide_markup",
    config: {
      title: "グループを論文につなぐ",
      description:
        "スライドのグループを、論文の該当箇所につなぎます。文章は text に PDF の文字どおりの文を指定します（空白や改行の違いは無視します）。図・数式は page と rect（ページに対する割合 0〜1 の x, y, w, h）で範囲を指定するか、図の見出しなど範囲内の文字を text に指定します。画面では、グループの色の線で結ばれます。",
      inputSchema: {
        paper: PAPER,
        markup: MARKUP,
        kind: z.enum(["text", "figure", "equation"]).describe("text=文章、figure=図、equation=数式"),
        text: z.string().optional().describe("論文の文字列。文章のときは必須"),
        page: z.number().int().min(1).optional().describe("論文のページ。text を探すページを絞るときと、rect を使うときに指定します"),
        rect: z
          .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().gt(0).max(1), h: z.number().gt(0).max(1) })
          .optional()
          .describe("図・数式の範囲（ページに対する割合 0〜1）"),
      },
      annotations: { readOnlyHint: false },
    },
    handler: async ({ paper, markup, kind, text, page, rect }) => {
      const { v, deck } = await deckOf(paper);
      const m = requireMarkup(deck, markup);
      let link: SlideLink;
      const base = { id: newId("l"), kind, createdAt: new Date().toISOString() };
      const pages = await readPages(v.resolve(pdfPath(paper)));
      if (page && page > pages.length) throw new Error(`論文は ${pages.length} ページです。page を 1〜${pages.length} で指定してください。`);
      if (rect) {
        if (!page) throw new Error("rect を使うときは page も指定してください。");
        link = { ...base, page, rects: [rectOf(rect)], text: text?.trim() ?? "" };
      } else {
        if (!text?.trim()) throw new Error("text か、page と rect のどちらかを指定してください。");
        const found = findText(pages, text, page);
        if (!found) throw new Error("論文の中にその文字列が見つかりませんでした。PDF の文字どおりに指定するか、page を指定してください。");
        link = { ...base, page: found.page, rects: found.rects, text: found.text };
      }
      await changeMarkups(v, paper, [{ op: "addLink", id: m.id, link }]);
      return json({ markup: markupName(m), link: { id: link.id, kind: LINK_KIND_LABEL[kind as SlideLink["kind"]], page: link.page, text: link.text } });
    },
  },
  {
    name: "unlink_slide_markup",
    config: {
      title: "グループのリンクを外す",
      description: "グループから、論文の該当箇所へのリンクを 1 本外します。link は get_slide_markups の links の id です。",
      inputSchema: { paper: PAPER, markup: MARKUP, link: z.string().describe("リンクの ID") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    handler: async ({ paper, markup, link }) => {
      const { v, deck } = await deckOf(paper);
      const m = requireMarkup(deck, markup);
      if (!m.links.some((l) => l.id === link)) throw new Error(`${markupName(m)} にそのリンクはありません: ${link}`);
      await changeMarkups(v, paper, [{ op: "removeLink", id: m.id, link }]);
      return json({ markup: markupName(m), removed: link });
    },
  },
  {
    name: "set_slide_markup_memo",
    config: {
      title: "グループにメモを書く",
      description: "グループのメモ（そのスライドで言うこと、論文との対応の要点）を書き換えます。ノートの「発表スライドとの対応」にも出ます。",
      inputSchema: { paper: PAPER, markup: MARKUP, memo: z.string() },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    handler: async ({ paper, markup, memo }) => {
      const { v, deck } = await deckOf(paper);
      const m = requireMarkup(deck, markup);
      await changeMarkups(v, paper, [{ op: "update", id: m.id, patch: { memo } }]);
      return json({ markup: markupName(m), memo });
    },
  },
];
