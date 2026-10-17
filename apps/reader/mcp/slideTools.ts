// 発表スライドと論文の対応を扱う MCP ツール。
// スライドの取り込み、四角で囲む（グループを作る）、囲んだ部分の文字を読む、論文の文・図・数式へリンクする、
// グループやリンクを直す・消す・戻すまで、画面の「スライド」と同じことができる。
// 画面を開いていれば、四角と線はすぐに描き直される。

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readPages, findText } from "../server/pdftext.ts";
import { dataRoot } from "../server/config.ts";
import { MAX_BODY } from "../server/fetchpdf.ts";
import { NodeVault } from "../server/nodeVault.ts";
import { requirePaper } from "../server/service.ts";
import { SlidesConvertError, converters, importSlides, markupTexts, slideCount } from "../server/slides.ts";
import { pdfPath } from "../src/lib/papers.ts";
import { newId } from "../src/lib/model.ts";
import {
  GROUP_COLORS,
  LINK_KIND_LABEL,
  type SlideDeck,
  type SlideLink,
  type SlideMarkup,
  boundsOf,
  changeMarkups,
  findMarkup,
  loadDeck,
  markupName,
  nextColor,
  nextIndex,
  normalizeRect,
  rectOf,
  slidesPdfPath,
  sortMarkups,
} from "../src/lib/slides.ts";
import type { Result, Tool } from "./tools.ts";

const json = (value: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const PAPER = z.string().describe("論文 ID（papers/ の下のフォルダ名）。list_papers が返す id を指定します");
const MARKUP = z.string().describe("グループの名前（Markup-03.02 の形。3 ページ目の 2 個目）か ID。get_slide_markups で確かめます");
const RECT = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().gt(0).max(1), h: z.number().gt(0).max(1) })
  .describe("ページに対する割合（0〜1）の x, y, w, h。左上が原点");
const GROUP_COLOR = z
  .number()
  .int()
  .min(0)
  .max(GROUP_COLORS.length - 1)
  .describe(`グループの色の番号（0〜${GROUP_COLORS.length - 1}）。${GROUP_COLORS.map((c, i) => `${i}=${c}`).join("、")}`);
const LINK_KIND = z.enum(["text", "figure", "equation"]).describe("text=文章、figure=図、equation=数式");

/** 文字を囲むとき、文字の枠に足す余白（ページに対する割合）。端の文字が四角からはみ出さないように */
const TEXT_PAD = 0.01;

async function deckOf(paper: string) {
  const v = new NodeVault(dataRoot());
  await requirePaper(v, paper);
  const deck = await loadDeck(v, paper);
  if (!deck) throw new Error("この論文にはスライドがありません。import_slides でスライド（PDF か PPTX）を取り込んでください。");
  return { v, deck };
}

function requireMarkup(deck: SlideDeck, key: string) {
  const m = findMarkup(deck, key);
  if (!m) throw new Error(`グループが見つかりません: ${key}。ある名前: ${sortMarkups(deck.markups).map(markupName).join(", ") || "（まだありません）"}`);
  return m;
}

/** スライドのページ数。PDF が読めなければ null（一覧は返す） */
async function pagesOf(v: NodeVault, paper: string) {
  try {
    return await slideCount(v, paper);
  } catch {
    return null;
  }
}

/** 書き込みのあとのグループ（名前の番号は、同時に足した別の書き手とぶつかるとずれることがある） */
const markupIn = (deck: SlideDeck, id: string) => deck.markups.find((m) => m.id === id);

const linkView = (l: SlideLink) => ({ id: l.id, kind: l.kind, page: l.page, text: l.text, rects: l.rects });

export const SLIDE_READ_TOOLS: Tool[] = [
  {
    name: "get_slide_markups",
    config: {
      title: "スライドのグループを読む",
      description:
        "論文に付けた発表スライドで、四角で囲んだ部分（グループ）の一覧を返します。名前は Markup-ページ.番号 です。" +
        "rect はスライドのページに対する割合、color は色の番号（colorHex がその色）、slideText は四角の中にある文字（画像だけなら空。そのときは get_page_image を source=\"slides\" で呼んで見ます）、links は論文の該当箇所（文章・図・数式）です。" +
        "slidePages はスライドのページ数で、差し替えでページが減ってページの外になったグループには outOfRange: true が付きます。" +
        "リンクのないグループは、論文を find_in_paper や read_paper_text で読んで link_slide_markup でつないでください。",
      inputSchema: { paper: PAPER },
      annotations: { readOnlyHint: true },
    },
    handler: async ({ paper }) => {
      const { v, deck } = await deckOf(paper);
      const texts = new Map((await markupTexts(v, paper, deck)).map((t) => [t.name, t.text]));
      const slidePages = await pagesOf(v, paper);
      return json({
        source: deck.source,
        convertedFrom: deck.convertedFrom,
        importedAt: deck.importedAt,
        slidePages,
        markups: sortMarkups(deck.markups).map((m) => ({
          name: markupName(m),
          id: m.id,
          slidePage: m.page,
          ...(slidePages !== null && m.page > slidePages ? { outOfRange: true } : {}),
          rect: m.rect,
          color: m.color,
          colorHex: GROUP_COLORS[m.color] ?? GROUP_COLORS[0],
          memo: m.memo,
          slideText: texts.get(markupName(m)) ?? "",
          links: m.links.map(linkView),
        })),
      });
    },
  },
  {
    name: "read_slide_text",
    config: {
      title: "スライドの文字",
      description:
        "発表スライド（slides.pdf）から取り出した文字をページごとに返します。from_page と to_page で数ページずつ読めます。先頭の行が総ページ数です。" +
        "囲む場所を決めるとき（add_slide_markup の text）に使います。文字の無い、画像だけのページは get_page_image を source=\"slides\" で呼んで見てください。",
      inputSchema: {
        paper: PAPER,
        from_page: z.number().int().min(1).optional().describe("読み始めるページ（1 から）。省略すると 1"),
        to_page: z.number().int().min(1).optional().describe("読み終えるページ。省略すると最後まで"),
      },
      annotations: { readOnlyHint: true },
    },
    handler: async ({ paper, from_page, to_page }) => {
      const { v } = await deckOf(paper);
      const pages = await readPages(v.resolve(slidesPdfPath(paper)));
      const last = Math.min(to_page ?? pages.length, pages.length);
      const list = pages.slice(Math.max(0, (from_page ?? 1) - 1), last);
      const text = [
        `総ページ数: ${pages.length}`,
        ...list.map((p) => `\n--- スライド p.${p.page} ---\n${p.text.trim() || "（文字がありません。画像だけのページかもしれません）"}`),
      ].join("\n");
      return { content: [{ type: "text", text }] } satisfies Result;
    },
  },
];

export const SLIDE_WRITE_TOOLS: Tool[] = [
  {
    name: "import_slides",
    config: {
      title: "スライドを取り込む",
      description:
        "論文に発表スライドを取り込みます。source は端末上の PDF か PPTX の絶対パスです（URL は使えません）。PPTX は LibreOffice か Keynote で PDF に変換して取り込みます。" +
        "既にスライドがあれば差し替えます。そのときも、囲んだグループと論文へのリンクは残します（ページが減ったときは戻り値の outOfRange と get_slide_markups で確かめてください）。" +
        "取り込んだら read_slide_text で中身を読み、add_slide_markup で囲んでください。",
      inputSchema: {
        paper: PAPER,
        source: z.string().min(1).describe("スライドの PDF か PPTX の絶対パス"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    handler: async ({ paper, source }) => {
      const v = new NodeVault(dataRoot());
      await requirePaper(v, paper);
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) throw new Error("URL からは取り込めません。端末上の PDF か PPTX の絶対パスを指定してください。");
      if (!path.isAbsolute(source)) throw new Error(`絶対パスで指定してください: ${source}`);
      let size: number;
      try {
        size = (await fs.stat(source)).size;
      } catch {
        throw new Error(`ファイルが見つかりません: ${source}。パスを確かめてください。`);
      }
      if (size > MAX_BODY) throw new Error(`スライドが ${MAX_BODY / 1024 / 1024}MB を超えているため取り込めません。`);
      const b = await fs.readFile(source);
      const had = await loadDeck(v, paper);
      let deck: SlideDeck;
      try {
        deck = await importSlides(v, paper, path.basename(source), b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      } catch (e) {
        if (e instanceof SlidesConvertError) {
          const list = await converters();
          throw new Error(`${e.message}（この端末で使える変換方法: ${list.length ? list.join("、") : "ありません"}）`);
        }
        throw e;
      }
      const slidePages = await pagesOf(v, paper);
      return json({
        source: deck.source,
        convertedFrom: deck.convertedFrom,
        slidePages,
        replaced: !!had,
        keptMarkups: deck.markups.length,
        outOfRange: slidePages === null ? [] : sortMarkups(deck.markups).filter((m) => m.page > slidePages).map(markupName),
      });
    },
  },
  {
    name: "add_slide_markup",
    config: {
      title: "スライドを囲む",
      description:
        "スライドの一部を四角で囲み、グループを作ります（画面の「囲む」と同じ）。囲む範囲は rect（ページに対する割合 0〜1）で指定するか、text にスライドの文字どおりの文字列を指定します（その文字を囲む四角を作ります）。" +
        "名前（Markup-03.02）は自動で決まり、色も使っている数の少ない色が選ばれます。作ったら link_slide_markup で論文の該当箇所につないでください。",
      inputSchema: {
        paper: PAPER,
        slide_page: z.number().int().min(1).describe("スライドのページ（1 から）"),
        rect: RECT.optional().describe("囲む範囲（ページに対する割合 0〜1）。text と、どちらか一方を指定します"),
        text: z.string().optional().describe("囲むスライドの文字列（read_slide_text の文字どおり。空白や改行の違いは無視します）"),
        memo: z.string().optional().describe("グループのメモ（そのスライドで言うこと）"),
      },
      annotations: { readOnlyHint: false },
    },
    handler: async ({ paper, slide_page, rect, text, memo }) => {
      const { v, deck } = await deckOf(paper);
      const total = await slideCount(v, paper);
      if (slide_page > total) throw new Error(`スライドは ${total} ページです。slide_page を 1〜${total} で指定してください。`);
      if (!!rect === !!text?.trim()) throw new Error("rect と text のどちらか一方を指定してください。");
      let box;
      if (rect) box = rectOf(rect);
      else {
        const pages = await readPages(v.resolve(slidesPdfPath(paper)), { glyphs: true });
        const found = findText(pages, text!, slide_page);
        if (!found) {
          throw new Error(`スライド p.${slide_page} にその文字列が見つかりませんでした。read_slide_text で文字どおりに確かめるか、rect で範囲を指定してください。`);
        }
        const b = boundsOf(found.rects)!;
        box = normalizeRect({ x: b.x - TEXT_PAD, y: b.y - TEXT_PAD, w: b.w + TEXT_PAD * 2, h: b.h + TEXT_PAD * 2 });
      }
      const item: SlideMarkup = {
        id: newId("m"),
        page: slide_page,
        index: nextIndex(deck.markups, slide_page, deck.used),
        rect: box,
        color: nextColor(deck.markups),
        memo: memo?.trim() ?? "",
        links: [],
        createdAt: new Date().toISOString(),
      };
      // 使った番号（used）は add の操作が上げる。別の書き手と番号がぶつかったときは次の番号にずれる
      const r = await changeMarkups(v, paper, [{ op: "add", item }]);
      const made = markupIn(r.deck, item.id) ?? item;
      return json({ markup: markupName(made), id: made.id, slidePage: made.page, rect: made.rect, color: made.color, colorHex: GROUP_COLORS[made.color] });
    },
  },
  {
    name: "link_slide_markup",
    config: {
      title: "グループを論文につなぐ",
      description:
        "スライドのグループを、論文の該当箇所につなぎます。文章は text に PDF の文字どおりの文を指定します（空白や改行の違いは無視します）。図・数式は page と rect（ページに対する割合 0〜1 の x, y, w, h）で範囲を指定するか、図の見出しなど範囲内の文字を text に指定します。画面では、グループの色の線で結ばれます。" +
        "範囲を決めるために図や数式を見たいときは get_page_image を使います。",
      inputSchema: {
        paper: PAPER,
        markup: MARKUP,
        kind: LINK_KIND,
        text: z.string().optional().describe("論文の文字列。文章のときは必須"),
        page: z.number().int().min(1).optional().describe("論文のページ。text を探すページを絞るときと、rect を使うときに指定します"),
        rect: RECT.optional().describe("図・数式の範囲（ページに対する割合 0〜1）"),
      },
      annotations: { readOnlyHint: false },
    },
    handler: async ({ paper, markup, kind, text, page, rect }) => {
      const { v, deck } = await deckOf(paper);
      const m = requireMarkup(deck, markup);
      let link: SlideLink;
      const base = { id: newId("l"), kind, createdAt: new Date().toISOString() };
      // 枠の端を文字にぴったり合わせるため、マーカー（add_highlight）と同じく各文字の実際の位置も読む
      const pages = await readPages(v.resolve(pdfPath(paper)), { glyphs: true });
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
    name: "update_slide_link",
    config: {
      title: "リンクの種類を直す",
      description:
        "グループから論文へのリンク 1 本の種類（文章・図・数式）を変えます。link は get_slide_markups の links の id です。" +
        "論文の場所を変えたいときは、unlink_slide_markup で外してから link_slide_markup でつなぎ直します。",
      inputSchema: { paper: PAPER, markup: MARKUP, link: z.string().describe("リンクの ID"), kind: LINK_KIND },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    handler: async ({ paper, markup, link, kind }) => {
      const { v, deck } = await deckOf(paper);
      const m = requireMarkup(deck, markup);
      if (!m.links.some((l) => l.id === link)) throw new Error(`${markupName(m)} にそのリンクはありません: ${link}。get_slide_markups で links の id を確かめてください。`);
      await changeMarkups(v, paper, [{ op: "updateLink", id: m.id, link, patch: { kind } }]);
      return json({ markup: markupName(m), link, kind: LINK_KIND_LABEL[kind as SlideLink["kind"]] });
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
    name: "update_slide_markup",
    config: {
      title: "グループを直す",
      description:
        "グループのメモ・色・囲む範囲を書き換えます。指定した項目だけを変えます。memo はノートの「発表スライドとの対応」にも出ます。" +
        "名前（ページと番号）は変わりません。別のページを囲み直すときは、delete_slide_markup で消してから add_slide_markup で作ります。",
      inputSchema: {
        paper: PAPER,
        markup: MARKUP,
        memo: z.string().optional().describe("グループのメモ（そのスライドで言うこと、論文との対応の要点）"),
        color: GROUP_COLOR.optional(),
        rect: RECT.optional().describe("囲む範囲（スライドのページに対する割合 0〜1）"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    handler: async ({ paper, markup, memo, color, rect }) => updateMarkup(paper, markup, { memo, color, rect }),
  },
  {
    name: "set_slide_markup_memo",
    config: {
      title: "グループにメモを書く",
      description: "グループのメモを書き換えます（update_slide_markup の memo と同じ。前からの呼び方として残しています）。色や範囲も直すなら update_slide_markup を使います。",
      inputSchema: { paper: PAPER, markup: MARKUP, memo: z.string() },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    handler: async ({ paper, markup, memo }) => updateMarkup(paper, markup, { memo }),
  },
  {
    name: "delete_slide_markup",
    config: {
      title: "グループを消す",
      description:
        "グループを 1 つ消します。論文へのリンクもすべて一緒に消えます。名前の番号は使い直しません（ほかのグループの名前もずれません）。" +
        "戻り値の removed は消したグループそのものです。取り消すときは、それを restore_slide_markup の item に渡します。",
      inputSchema: { paper: PAPER, markup: MARKUP },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    handler: async ({ paper, markup }) => {
      const { v, deck } = await deckOf(paper);
      const m = requireMarkup(deck, markup);
      await changeMarkups(v, paper, [{ op: "remove", id: m.id }]);
      return json({ markup: markupName(m), links: m.links.length, removed: m });
    },
  },
  {
    name: "restore_slide_markup",
    config: {
      title: "消したグループを戻す",
      description:
        "delete_slide_markup で消したグループを、同じ名前・色・範囲・メモ・リンクのまま戻します。item には delete_slide_markup が返した removed をそのまま渡します。" +
        "同じ ID のグループが既にあれば、何もしません。",
      inputSchema: {
        paper: PAPER,
        item: z
          .object({
            id: z.string(),
            page: z.number().int().min(1),
            index: z.number().int().min(1),
            rect: RECT,
            color: z.number().int().min(0).optional(),
            memo: z.string().optional(),
            links: z.array(z.record(z.string(), z.unknown())).optional(),
            createdAt: z.string().optional(),
          })
          .passthrough()
          .describe("delete_slide_markup が返した removed"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    handler: async ({ paper, item }) => {
      const { v } = await deckOf(paper);
      // restore は、消したグループを元の名前のまま戻す操作。形の検査（parseMarkupOps）は changeMarkups が行う
      const r = await changeMarkups(v, paper, [{ op: "restore", item }]);
      const back = markupIn(r.deck, String(item.id));
      if (!back) throw new Error("グループを戻せませんでした。get_slide_markups で今の状態を確かめてください。");
      return json({ markup: markupName(back), id: back.id, links: back.links.length });
    },
  },
];

/** グループのメモ・色・範囲を書き換える（update_slide_markup と set_slide_markup_memo で共通） */
async function updateMarkup(paper: string, markup: string, input: { memo?: string; color?: number; rect?: unknown }) {
  const { v, deck } = await deckOf(paper);
  const m = requireMarkup(deck, markup);
  const patch: Record<string, unknown> = {};
  if (input.memo !== undefined) patch.memo = input.memo;
  if (input.color !== undefined) patch.color = input.color;
  if (input.rect !== undefined) patch.rect = rectOf(input.rect);
  if (!Object.keys(patch).length) throw new Error("memo・color・rect のどれかを指定してください。");
  const r = await changeMarkups(v, paper, [{ op: "update", id: m.id, patch }]);
  const now = markupIn(r.deck, m.id) ?? m;
  return json({ markup: markupName(now), memo: now.memo, color: now.color, colorHex: GROUP_COLORS[now.color], rect: now.rect });
}
