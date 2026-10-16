// PaperLens の MCP ツール定義。
// 画面でできる操作を、そのまま AI エージェント向けのツールとして公開する。
// 実体は server/ と src/lib/ の処理を直接呼ぶため、アプリを起動していなくても使える。
// アプリを開いている場合は、ここでの変更が画面にすぐ反映される（サーバーがフォルダを見張っている）。

import { z } from "zod";
import { DEFAULT_TEMPLATE, STATUSES } from "../src/lib/defaultTemplate.ts";
import { type ListName, MARKER_LABEL } from "../src/lib/model.ts";
import {
  PAPERS_DIR,
  TEMPLATE_PATH,
  collectGraph,
  ensureLayout,
  listPapers,
  loadNote,
  notePath,
  paperDetail,
  readTemplate,
  searchNotes,
  updateNote,
  writeMeta,
  writeTemplate,
} from "../src/lib/papers.ts";
import { toBibtex } from "../src/lib/bibtex.ts";
import { parseFields, setField } from "../src/lib/template.ts";
import { dataRoot, readConfig, writeConfig } from "../server/config.ts";
import { NodeVault } from "../server/nodeVault.ts";
import {
  addEquation,
  addHighlight,
  addTerm,
  findInPaper,
  importFrom,
  paperText,
  removeItem,
  requirePaper,
  updateItem,
} from "../server/service.ts";
import { parseSentences } from "../server/sentences.ts";
import { SENTENCE_READ_TOOLS, SENTENCE_WRITE_TOOLS, sentenceProgress } from "./sentenceTools.ts";
import { SLIDE_READ_TOOLS, SLIDE_WRITE_TOOLS } from "./slideTools.ts";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
// 引数の型は inputSchema（zod）で検査済み
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;

export interface Tool {
  name: string;
  config: {
    title: string;
    description: string;
    inputSchema: z.ZodRawShape;
    annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  };
  handler: (args: Args) => Promise<Result>;
}

const json = (value: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const text = (value: string): Result => ({ content: [{ type: "text", text: value }] });

async function vault() {
  const v = new NodeVault(dataRoot());
  await ensureLayout(v);
  return v;
}

const PAPER = z.string().describe("論文 ID（papers/ の下のフォルダ名）。list_papers が返す id を指定します");
const COLOR = z.enum(["yellow", "cyan", "magenta", "green"]).describe(
  `マーカーの色。${Object.entries(MARKER_LABEL).map(([k, v]) => `${k}=${v}`).join("、")}。使い分けは利用者に合わせます`,
);
const ITEM = z.string().describe("項目の ID。get_paper の annotations に含まれる id を指定します");

/** 記録欄（field）を探し、無ければ候補を添えて止める。 */
function requireField(md: string, field: string) {
  const fields = parseFields(md);
  if (!fields.some((f) => f.id === field)) {
    throw new Error(`記録欄が見つかりません: ${field}。使える ID: ${fields.map((f) => f.id).join(", ")}`);
  }
}

const READ: Tool[] = [
  {
    name: "get_settings",
    config: {
      title: "保存先と記録の形式",
      description:
        "保存先フォルダ、フォルダ構成、読解の段階（status に使える値）、テンプレートの記録欄を返します。最初に一度呼ぶと、ほかのツールの使い方が分かります。",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handler: async () => {
      const v = await vault();
      const c = readConfig();
      const tpl = await readTemplate(v);
      return json({
        dataRoot: c.dataRoot,
        dataRootSource: c.dataRootSource,
        layout: {
          template: TEMPLATE_PATH,
          paper: `${PAPERS_DIR}/<論文ID>/paper.pdf`,
          note: `${PAPERS_DIR}/<論文ID>/note.md`,
          annotations: `${PAPERS_DIR}/<論文ID>/paperlens.json`,
        },
        statuses: STATUSES,
        fields: parseFields(tpl).map(({ id, label, hint, section }) => ({ id, label, hint, phase: section })),
        markerColors: MARKER_LABEL,
      });
    },
  },
  {
    name: "list_papers",
    config: {
      title: "論文の一覧",
      description:
        "保存先にある論文の ID・題名・読解の段階・年と、1 文ずつの対訳の進み具合（sentences: 解析の状態・未訳の文の数）を返します。ほかのツールに渡す論文 ID はここで調べます。",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handler: async () => {
      const v = await vault();
      const papers = await listPapers(v);
      return json(await Promise.all(papers.map(async (p) => ({ ...p, sentences: await sentenceProgress(v, p.id) }))));
    },
  },
  {
    name: "get_paper",
    config: {
      title: "論文の記録",
      description:
        "論文1本の記録をまとめて返します。frontmatter（題名・著者・status など）、記録欄（段階ごとの見出し・ヒント・現在の値）、マーカーと訳・用語・数式の一覧を含みます。",
      inputSchema: { paper: PAPER },
      annotations: { readOnlyHint: true },
    },
    handler: async ({ paper }) => {
      const v = await vault();
      await requirePaper(v, paper);
      return json(await paperDetail(v, paper));
    },
  },
  {
    name: "get_bibtex",
    config: {
      title: "BibTeX",
      description:
        "論文の frontmatter（題名・著者・年・掲載先・DOI・arXiv）から BibTeX を作って返します。画面の「BibTeX をコピー」と同じ内容です。",
      inputSchema: { paper: PAPER },
      annotations: { readOnlyHint: true },
    },
    handler: async ({ paper }) => {
      const v = await vault();
      await requirePaper(v, paper);
      return text(toBibtex((await paperDetail(v, paper)).frontmatter, paper));
    },
  },
  {
    name: "get_note",
    config: {
      title: "読解ノートの本文",
      description: "読解ノート（note.md）の Markdown をそのまま返します。Obsidian で開いたときと同じ内容です。",
      inputSchema: { paper: PAPER },
      annotations: { readOnlyHint: true },
    },
    handler: async ({ paper }) => {
      const v = await vault();
      await requirePaper(v, paper);
      return text(await loadNote(v, paper));
    },
  },
  {
    name: "read_paper_text",
    config: {
      title: "論文の本文",
      description:
        "PDF から取り出した本文をページごとに返します。長い論文は from_page と to_page で数ページずつ読んでください。戻り値の pages は総ページ数です。",
      inputSchema: {
        paper: PAPER,
        from_page: z.number().int().min(1).optional().describe("読み始めるページ（1 から）。省略すると 1"),
        to_page: z.number().int().min(1).optional().describe("読み終えるページ。省略すると最後まで"),
      },
      annotations: { readOnlyHint: true },
    },
    handler: async ({ paper, from_page, to_page }) => {
      const v = await vault();
      await requirePaper(v, paper);
      const r = await paperText(v, paper, from_page ?? 1, to_page);
      return text(
        [`総ページ数: ${r.pages}`, ...r.text.map((p) => `\n--- p.${p.page} ---\n${p.text}`)].join("\n"),
      );
    },
  },
  {
    name: "find_in_paper",
    config: {
      title: "論文の中を探す",
      description: "論文の本文から語句を探し、ページと前後の文を返します。大文字と小文字、空白の違いは区別しません。",
      inputSchema: { paper: PAPER, query: z.string().min(1).describe("探す語句") },
      annotations: { readOnlyHint: true },
    },
    handler: async ({ paper, query }) => {
      const v = await vault();
      await requirePaper(v, paper);
      return json(await findInPaper(v, paper, query));
    },
  },
  {
    name: "search_notes",
    config: {
      title: "ノートを横断検索",
      description:
        "すべての読解ノートから語句を含む行を探します。過去に読んだ論文の記録を参照するときに使います。region は当たった場所です（frontmatter=書誌情報、field=記録欄（field に欄の ID）、list:highlights=マーカーと訳、list:terms=用語、list:equations=数式、body=それ以外の本文）。",
      inputSchema: { query: z.string().min(1).describe("探す語句") },
      annotations: { readOnlyHint: true },
    },
    handler: async ({ query }) => json(await searchNotes(await vault(), query)),
  },
  {
    name: "get_graph",
    config: {
      title: "論文と用語のつながり",
      description: "論文ごとに登録した用語と関連語の組を返します。画面の「グラフ」と同じデータです。",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handler: async () => {
      const v = await vault();
      return json(await collectGraph(v, await listPapers(v)));
    },
  },
  {
    name: "get_template",
    config: {
      title: "テンプレート",
      description: `読解ノートのテンプレート（${TEMPLATE_PATH}）を返します。新しく取り込む論文のノートはここから作ります。`,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handler: async () => text(await readTemplate(await vault())),
  },
];

const WRITE: Tool[] = [
  {
    name: "import_paper",
    config: {
      title: "論文を取り込む",
      description:
        "PDF を取り込み、テンプレートから読解ノートを作ります。source には、次のどれかを指定します。\n- 端末上の PDF の絶対パス\n- PDF の URL\n- arXiv の abs／pdf の URL、または番号（例 2410.12345）\n\narXiv の論文は、題名・著者・年・DOI を frontmatter に入れます。同じ arXiv の論文が既にあれば取り込まず、existing: true とその論文の ID を返します。DOI のリンクは使えません。端末内やローカルネットワークの URL は使えません。取り込むと 1 文ずつの対訳の解析が裏で始まります（終わったかは get_sentence_outline で確かめます）。",
      inputSchema: {
        source: z.string().min(1).describe("PDF の絶対パス、PDF の URL、arXiv の URL か番号"),
        title: z.string().optional().describe("題名。省略すると PDF の文書情報かファイル名を使います"),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    handler: async ({ source, title }) => {
      const v = await vault();
      const r = await importFrom(v, source, title);
      // 対訳の土台（sentences.json）は裏で作る。待つと GROBID の解析で呼び出しが時間切れになる
      if (!r.existing) void parseSentences(v, r.id, "auto").catch(() => undefined);
      return json({ id: r.id, note: notePath(r.id), existing: r.existing, meta: r.meta, sentences: r.existing ? undefined : "parsing" });
    },
  },
  {
    name: "set_fields",
    config: {
      title: "記録欄に書く",
      description:
        "読解ノートの記録欄を書き換えます。values は { 記録欄の ID: 内容 } の形です（例: { \"summary\": \"…\" }）。記録欄の ID は get_paper の fields で確かめます。内容は Markdown で書けます。空文字を渡すと欄を空にします。ノートの記録欄の外側は変更しません。",
      inputSchema: {
        paper: PAPER,
        values: z.record(z.string(), z.string()).describe("{ 記録欄の ID: 内容 }"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    handler: async ({ paper, values }) => {
      const v = await vault();
      await requirePaper(v, paper);
      const md = await loadNote(v, paper);
      for (const f of Object.keys(values)) requireField(md, f);
      await updateNote(v, paper, (cur) => Object.entries(values as Record<string, string>).reduce((acc, [f, val]) => setField(acc, f, val), cur));
      return json({ updated: Object.keys(values), note: notePath(paper) });
    },
  },
  {
    name: "set_status",
    config: {
      title: "読解の段階を変える",
      description: `読解ノートの status を変えます。使える値: ${STATUSES.join(" → ")}。`,
      inputSchema: { paper: PAPER, status: z.enum(STATUSES) },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    handler: async ({ paper, status }) => {
      const v = await vault();
      await requirePaper(v, paper);
      await writeMeta(v, paper, "status", status);
      return json({ status });
    },
  },
  {
    name: "set_meta",
    config: {
      title: "書誌情報を変える",
      description:
        "読解ノートの frontmatter の1項目を書き換えます。title・authors・year・venue・doi などに使います。項目が無ければ追加します。著者など一覧の項目は配列で渡します（例: [\"A. Example\", \"B. Sample\"]）。一覧の書き方（ブロック形式・フロー形式）は元の形を保ちます。複数行の値の項目は書き換えられません。",
      inputSchema: {
        paper: PAPER,
        key: z.string().regex(/^[\w-]+$/).describe("項目名（英数字・ハイフン・下線）"),
        value: z.union([z.string(), z.array(z.string())]).describe("値。一覧の項目は文字列の配列"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    handler: async ({ paper, key, value }) => {
      const v = await vault();
      await requirePaper(v, paper);
      await writeMeta(v, paper, key, value);
      return json({ [key]: value });
    },
  },
  {
    name: "add_highlight",
    config: {
      title: "マーカーを引く",
      description:
        "本文の文にマーカーを引き、訳とメモを付けます。text は PDF の文字どおりに指定してください（空白や改行の違いは無視します）。見つかった場合は PDF の該当位置に色が付き、ノートの「マーカーと訳」に引用として残ります。訳は自然な日本語で、専門用語は初出で原語を括弧書きにします。",
      inputSchema: {
        paper: PAPER,
        text: z.string().min(1).describe("マーカーを引く原文"),
        page: z.number().int().min(1).optional().describe("探すページ。省略すると全ページから探します"),
        color: COLOR.optional(),
        translation: z.string().optional().describe("日本語訳"),
        memo: z.string().optional().describe("自分用のメモ"),
      },
      annotations: { readOnlyHint: false },
    },
    handler: async ({ paper, ...input }) => {
      const r = await addHighlight(await vault(), paper, input as Parameters<typeof addHighlight>[2]);
      return json({ highlight: { ...r.highlight, rects: undefined }, located: r.located, around: r.around });
    },
  },
  {
    name: "update_highlight",
    config: {
      title: "マーカーを直す",
      description: "マーカーの訳・メモ・色を書き換えます。指定した項目だけを変えます。",
      inputSchema: {
        paper: PAPER,
        id: ITEM,
        translation: z.string().optional(),
        memo: z.string().optional(),
        color: COLOR.optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    handler: async ({ paper, id, ...patch }) => json(await updateItem(await vault(), paper, "highlights", id, clean(patch))),
  },
  {
    name: "add_term",
    config: {
      title: "用語を登録する",
      description:
        "用語と説明を登録します。ノートの「用語」に [[用語]] の見出しで残るため、Obsidian では論文をまたいでリンクされます。related に関連語を入れると、グラフでつながります。",
      inputSchema: {
        paper: PAPER,
        term: z.string().min(1).describe("用語。原語の場合は日本語訳を括弧で添えます（例: 自己注意（self-attention））"),
        reading: z.string().optional().describe("読み方（日本語の用語の場合）"),
        short: z.string().optional().describe("1文の説明"),
        detail: z.string().optional().describe("詳しい説明"),
        inPaper: z.string().optional().describe("この論文での使われ方"),
        related: z.array(z.string()).optional().describe("関連する用語"),
        page: z.number().int().min(1).optional().describe("出てきたページ"),
      },
      annotations: { readOnlyHint: false },
    },
    handler: async ({ paper, ...input }) => json(await addTerm(await vault(), paper, input as Parameters<typeof addTerm>[2])),
  },
  {
    name: "update_term",
    config: {
      title: "用語を直す",
      description: "登録した用語の説明を書き換えます。指定した項目だけを変えます。",
      inputSchema: {
        paper: PAPER,
        id: ITEM,
        term: z.string().optional(),
        reading: z.string().optional(),
        short: z.string().optional(),
        detail: z.string().optional(),
        inPaper: z.string().optional(),
        related: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    handler: async ({ paper, id, ...patch }) => json(await updateItem(await vault(), paper, "terms", id, clean(patch))),
  },
  {
    name: "add_equation",
    config: {
      title: "数式を登録する",
      description: "数式を TeX で登録します。ノートの「数式」に $$ … $$ で残り、Obsidian でも数式として表示されます。",
      inputSchema: {
        paper: PAPER,
        tex: z.string().min(1).describe("TeX（$ や $$ は付けない）"),
        label: z.string().optional().describe("見出し（例: 式(3)）。省略すると「式n」"),
        explanation: z.string().optional().describe("記号の意味と式の読み方"),
        page: z.number().int().min(1).optional(),
        source: z.string().optional().describe("PDF 上の元の文字列"),
      },
      annotations: { readOnlyHint: false },
    },
    handler: async ({ paper, ...input }) => json(await addEquation(await vault(), paper, input as Parameters<typeof addEquation>[2])),
  },
  {
    name: "update_equation",
    config: {
      title: "数式を直す",
      description: "登録した数式を書き換えます。指定した項目だけを変えます。",
      inputSchema: {
        paper: PAPER,
        id: ITEM,
        tex: z.string().optional(),
        label: z.string().optional(),
        explanation: z.string().optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    handler: async ({ paper, id, ...patch }) => json(await updateItem(await vault(), paper, "equations", id, clean(patch))),
  },
  {
    name: "remove_annotation",
    config: {
      title: "マーカー・用語・数式を消す",
      description: "マーカー・用語・数式のいずれかを1件消します。ノートの一覧からも消えます。",
      inputSchema: {
        paper: PAPER,
        kind: z.enum(["highlights", "terms", "equations"]).describe("highlights=マーカー、terms=用語、equations=数式"),
        id: ITEM,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    handler: async ({ paper, kind, id }) => json(await removeItem(await vault(), paper, kind as ListName, id)),
  },
  {
    name: "set_template",
    config: {
      title: "テンプレートを書き換える",
      description:
        "読解ノートのテンプレートを書き換えます。これから取り込む論文に使われ、取り込み済みのノートは変わりません。記録欄は <!-- field: ID | 見出し | ヒント --> と <!-- /field --> で囲み、直前の ## 見出しが段階のまとまりになります。{{title}} {{date}} {{pdf}} {{id}} が差し込めます。",
      inputSchema: { text: z.string().min(1).describe("テンプレートの Markdown 全体") },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    handler: async ({ text: tpl }) => {
      await writeTemplate(await vault(), tpl);
      return json({ file: TEMPLATE_PATH, fields: parseFields(tpl).map((f) => f.id) });
    },
  },
  {
    name: "reset_template",
    config: {
      title: "テンプレートを初期状態に戻す",
      description: "読解ノートのテンプレートを、アプリの初期のものに戻します。",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    handler: async () => {
      await writeTemplate(await vault(), DEFAULT_TEMPLATE);
      return json({ file: TEMPLATE_PATH });
    },
  },
  {
    name: "set_data_root",
    config: {
      title: "保存先を変える",
      description:
        "保存先フォルダを変えます。設定ファイルに書くため、アプリの画面も同じフォルダに切り替わります。環境変数 PAPERLENS_DATA で起動している場合は、その指定が優先されます。",
      inputSchema: { path: z.string().min(1).describe("保存先フォルダの絶対パス") },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    handler: async ({ path }) => {
      writeConfig({ dataRoot: path });
      const c = readConfig();
      return json({ dataRoot: c.dataRoot, dataRootSource: c.dataRootSource, note: c.dataRootSource === "env" ? "PAPERLENS_DATA が優先されています" : undefined });
    },
  },
];

/** 省略された項目（undefined）を取り除き、指定された項目だけで書き換える。 */
function clean(o: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

export const READ_TOOLS = [...READ, ...SENTENCE_READ_TOOLS, ...SLIDE_READ_TOOLS];
export const WRITE_TOOLS = [...WRITE, ...SENTENCE_WRITE_TOOLS, ...SLIDE_WRITE_TOOLS];
/** 対訳（sentences.json）を扱うツールの名前。設定画面で分けて見せる。 */
export const SENTENCE_TOOL_NAMES = new Set([...SENTENCE_READ_TOOLS, ...SENTENCE_WRITE_TOOLS].map((t) => t.name));
export const TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];
