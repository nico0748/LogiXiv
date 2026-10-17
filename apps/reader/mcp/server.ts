// PaperLens の MCP サーバー本体。stdio で動かす入口は mcp/main.ts。

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { STATUSES } from "../src/lib/defaultTemplate.ts";
import { listPapers, loadNote, notePath } from "../src/lib/papers.ts";
import { dataRoot } from "../server/config.ts";
import { NodeVault } from "../server/nodeVault.ts";
import { VERSION } from "../server/version.ts";
import { TRANSLATION_STYLE, TRANSLATION_WORKFLOW } from "./sentenceTools.ts";
import { READ_TOOLS, WRITE_TOOLS, type Tool } from "./tools.ts";

const INSTRUCTIONS = `PaperLens は、論文を読みながら訳・用語・数式・読解メモを Markdown のノートに残すアプリです。
データは保存先フォルダの普通のファイルで、Obsidian の保管庫としても開けます。

- 論文1本 = papers/<論文ID>/ のフォルダ。paper.pdf（原文）、note.md（読解ノート）、paperlens.json（マーカーの位置など）、sentences.json（1 文ずつの対訳）が入っています。発表スライドがあれば slides.pdf（表示に使う PDF）、slides.pptx（PPTX から取り込んだときの元のファイル）、slides.json（囲んだグループと論文へのリンク）も入ります。
- ファイルを直接書き換えず、必ずツールで変更してください（画面と同時に書いても消し合わないよう、ツールは変更を 1 件ずつ当てます）。
- 読解ノートはテンプレートから作られ、段階（## 見出し）ごとに記録欄があります。記録欄は set_fields で書きます。記録欄の外側は利用者が自由に書く場所なので、変更しないでください。
- 読解の段階は status で表します: ${STATUSES.join(" → ")}。
- まず get_settings と list_papers を呼び、論文 ID と記録欄の ID を確かめてください。本文は read_paper_text で数ページずつ読みます。
- マーカー（add_highlight）は PDF の文字どおりに指定すると、画面の PDF 上にも色が付きます。引く場所を直すときは update_highlight に text か page を渡します。
- 数式・図・表など文字で読めないところは get_page_image でページの画像を見ます（rect で一部だけを切り出せます）。
- 全論文の用語と数式を横断して見るときは get_lists（画面の「リスト」と同じ単語帳・数式帳）を使います。
- 書く日本語は、です・ます調ではなく、ノートらしい簡潔な常体（〜である、〜する）にそろえます。専門用語は初出で原語を括弧書きにします。
- 全文を 1 文ずつ訳すときは get_sentence_outline → get_translation_batch → set_translations を、remainingUnique が 0 になるまで繰り返します（プロンプト translate_paper に手順があります）。文の指定は hash で行います。訳す対象でない文は skip_sentences、区切りの誤りは fix_sentence_boundary（取り消しは get_sentence_outline の boundaryEdits の id で）、訳語の統一は update_glossary（1 語だけ消すなら remove_glossary_terms）を使います。訳を消すのは clear_translations、文のメモを消すのは remove_sentence_note です。人が直した訳は、利用者に確かめずに消さないでください。sentences.json がまだ無い論文では parse_sentences を呼びます。
- 発表スライドは import_slides（PDF か PPTX の絶対パス）で論文に取り込みます。スライドを四角で囲んだ部分をグループと呼び、名前は Markup-03.02（3 ページ目の 2 個目）です。get_slide_markups で一覧と四角の中の文字を、read_slide_text でスライドの文字を読めます。囲むのは add_slide_markup（rect か、スライドの文字列 text で）で、各グループが論文のどの文章・図・数式に当たるかを link_slide_markup でつなぐと、画面ではスライドと論文が線で結ばれます。直すのは update_slide_markup・update_slide_link・unlink_slide_markup、消すのは delete_slide_markup（戻り値の removed を restore_slide_markup に渡すと戻せます）です。
- アプリを開いている場合、ここでの変更は画面にすぐ反映されます。`;

export function createServer(opts: { readOnly?: boolean } = {}) {
  const server = new McpServer({ name: "paperlens", version: VERSION }, { instructions: INSTRUCTIONS });

  const register = (t: Tool) =>
    server.registerTool(t.name, t.config, async (args: Record<string, unknown>) => {
      try {
        return await t.handler(args);
      } catch (e) {
        return { content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    });
  for (const t of READ_TOOLS) register(t);
  if (!opts.readOnly) for (const t of WRITE_TOOLS) register(t);

  // 読解ノートを資料として読めるようにする
  server.registerResource(
    "note",
    new ResourceTemplate("paperlens://papers/{paper}/note.md", {
      list: async () => {
        const papers = await listPapers(new NodeVault(dataRoot()));
        return {
          resources: papers.map((p) => ({
            uri: `paperlens://papers/${encodeURIComponent(p.id)}/note.md`,
            name: p.title,
            description: `読解ノート（${p.status}）`,
            mimeType: "text/markdown",
          })),
        };
      },
    }),
    { title: "読解ノート", description: "論文ごとの読解ノート（note.md）", mimeType: "text/markdown" },
    async (uri, { paper }) => {
      const id = decodeURIComponent(String(paper));
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: await loadNote(new NodeVault(dataRoot()), id) }] };
    },
  );

  server.registerPrompt(
    "read_paper",
    {
      title: "論文を段階を追って読む",
      description: "テンプレートの段階に沿って論文を読み、記録欄・マーカー・用語・数式を埋めます。",
      argsSchema: {
        paper: z.string().describe("論文 ID"),
        focus: z.string().optional().describe("読む目的や、特に知りたいこと"),
      },
    },
    ({ paper, focus }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `PaperLens の論文「${paper}」を読み、読解ノート（${notePath(paper)}）を埋めてください。`,
              focus ? `読む目的: ${focus}` : "",
              "",
              "1. get_paper で記録欄と現在の記録を確かめる。すでに書かれている欄は、利用者の記録として尊重し、書き換えずに足りない点だけ補う。",
              "2. read_paper_text で、アブストラクト・図・結論を先に読み、「1. 概要をつかむ」の欄を set_fields で書く。終えたら set_status で「概要把握」にする。",
              "3. 本文を数ページずつ読み、要となる文に add_highlight でマーカーと訳を付ける（1ページに1〜3か所まで）。初めて出た専門用語は add_term、主要な数式は add_equation で登録する。",
              "4. 「2. 精読する」「3. 検討する」の欄を書き、段階ごとに status を進める。",
              "   全文の対訳が要るときは、translate_paper の手順（get_sentence_outline → get_translation_batch → set_translations を remainingUnique が 0 になるまで）で 1 文ずつ訳す。読解ノートの記録欄には要点だけを書く。",
              "5. 最後に「4. まとめる」を書き、status を「まとめ済み」にする。",
              "",
              "書く日本語は簡潔な常体にそろえ、推測は推測と分かるように書いてください。",
            ]
              .filter((l, i, a) => l || a[i - 1])
              .join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "translate_paper",
    {
      title: "論文を 1 文ずつ全文訳す",
      description: "対訳（sentences.json）の未訳の文を文脈ごと受け取り、用語集に従って訳し、まとめて書き戻すのを最後まで繰り返します。",
      argsSchema: {
        paper: z.string().describe("論文 ID"),
        field: z.string().optional().describe("分野（例: 機械学習）。訳語の選び方に影響します"),
      },
    },
    ({ paper, field }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `PaperLens の論文「${paper}」を 1 文ずつ全文訳してください。${field ? `分野は「${field}」です。` : ""}`,
              "",
              "手順:",
              ...TRANSLATION_WORKFLOW.map((l, i) => `${i + 1}. ${l}`),
              "",
              "訳し方の方針:",
              ...TRANSLATION_STYLE.map((l) => `- ${l}`),
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "review_notes",
    {
      title: "読んだ論文をふり返る",
      description: "保存先の読解ノートを横断して、テーマごとの要点と次に読む論文を整理します。",
      argsSchema: { topic: z.string().optional().describe("ふり返るテーマ") },
    },
    ({ topic }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `PaperLens の読解ノートをふり返ってください。${topic ? `テーマ: ${topic}。` : ""}list_papers と get_paper で各論文の記録を読み、search_notes と get_graph で共通する用語やつながりを調べ、論文どうしの関係・未解決の疑問・次に読む論文を日本語でまとめてください。ノートは書き換えないでください。`,
          },
        },
      ],
    }),
  );

  return server;
}
