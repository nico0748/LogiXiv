import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { progress, type PaperDocument, type Sentence } from '@logixiv/core';
import { LogiXivClient } from './client.ts';

/**
 * Claude から LogiXiv を触るための MCP サーバー。
 *
 * 設計方針は 2 つ。
 * 1. 文の指定は必ず sentenceHash で行う。順番や ID ではなく本文由来の値なので、
 *    再解析をまたいでも Claude の指した文がずれない。
 * 2. 文脈をまとめて渡し、訳もまとめて受け取る。1 文ずつ往復すると
 *    前後関係を見ずに訳すことになり、代名詞と時制がすぐ壊れる。
 */

const TOOL_COUNT = 9;

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

function sentenceView(document: PaperDocument, sentence: Sentence) {
  const translation = document.annotations.translations[sentence.hash];
  const notes = document.annotations.notes
    .filter((note) => note.sentenceHash === sentence.hash)
    .map((note) => note.body);
  return {
    sentenceHash: sentence.hash,
    order: sentence.order,
    page: sentence.page,
    section: document.structure.sections.find((s) => s.id === sentence.sectionId)?.title ?? null,
    source: sentence.text,
    translation: translation?.text ?? null,
    revisedByHuman: translation?.revisedByHuman ?? false,
    notes,
  };
}

export function createMcpServer(baseUrl: string): McpServer {
  const client = new LogiXivClient(baseUrl);
  const server = new McpServer(
    { name: 'logixiv', version: '0.1.0' },
    {
      instructions:
        'LogiXiv は論文 PDF を 1 文単位で読むためのローカルツールです。' +
        'まず list_documents で対象を選び、get_untranslated_sentences で未訳の文を前後の文脈込みで受け取り、' +
        'set_translations でまとめて書き戻してください。' +
        '訳しにくい箇所は勝手に意訳せず add_note に判断を残すのが望ましい運用です。' +
        '人手修正済み (revisedByHuman) の訳は上書きされません。',
    },
  );

  server.registerTool(
    'list_documents',
    {
      title: '文書一覧',
      description: 'LogiXiv に取り込まれている論文の一覧と翻訳の進捗を返す。まずこれを呼んで document_id を決める。',
      inputSchema: {},
    },
    async () => {
      try {
        const { documents } = await client.listDocuments();
        if (documents.length === 0) {
          return textResult('取り込み済みの論文がありません。LogiXiv の画面から PDF を追加してください。');
        }
        return jsonResult(documents);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_document_outline',
    {
      title: '文書の概要',
      description:
        '論文のタイトル・節構成・ページ数・解析方式・翻訳の進捗を返す。全文を読み込まずに構造だけ把握したいときに使う。',
      inputSchema: { document_id: z.string().describe('list_documents が返した id') },
    },
    async ({ document_id }) => {
      try {
        const document = await client.getDocument(document_id);
        const stats = progress(document);
        return jsonResult({
          id: document.id,
          title: document.title,
          parser: document.structure.parser,
          parserNote: document.structure.parserNote,
          pages: document.structure.pageSizes.length,
          sentences: document.structure.sentences.length,
          translated: stats.translated,
          revisedByHuman: stats.revisedByHuman,
          abstract: document.structure.abstract,
          sections: document.structure.sections.map((section) => ({
            id: section.id,
            title: section.title,
            sentences: document.structure.sentences.filter((s) => s.sectionId === section.id).length,
          })),
          glossary: document.annotations.glossary,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_sentences',
    {
      title: '文を取得',
      description:
        '文を範囲指定で取得する。原文・既存訳・メモが 1 件ずつ揃って返るので、訳の見直しや前後関係の確認に使う。',
      inputSchema: {
        document_id: z.string(),
        from: z.number().int().min(0).default(0).describe('開始位置（文の通し番号、0 始まり）'),
        limit: z.number().int().min(1).max(200).default(40),
        section_id: z.string().optional().describe('指定するとその節だけに絞る'),
        page: z.number().int().min(1).optional().describe('指定するとそのページだけに絞る'),
      },
    },
    async ({ document_id, from, limit, section_id, page }) => {
      try {
        const document = await client.getDocument(document_id);
        let sentences = document.structure.sentences;
        if (section_id) sentences = sentences.filter((s) => s.sectionId === section_id);
        if (page !== undefined) sentences = sentences.filter((s) => s.page === page);
        const slice = sentences.slice(from, from + limit);
        return jsonResult({
          total: sentences.length,
          returned: slice.length,
          sentences: slice.map((sentence) => sentenceView(document, sentence)),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_untranslated_sentences',
    {
      title: '未訳の文を取得',
      description:
        'まだ訳が付いていない文を原文の順に返す。context_before / context_after で前後の文も付くので、' +
        '代名詞や時制を前の文に合わせて訳せる。翻訳作業はこのツールから始めるのが基本。',
      inputSchema: {
        document_id: z.string(),
        limit: z.number().int().min(1).max(60).default(20),
        context: z.number().int().min(0).max(5).default(2).describe('前後に付ける文脈の文数'),
      },
    },
    async ({ document_id, limit, context }) => {
      try {
        const document = await client.getDocument(document_id);
        const all = document.structure.sentences;
        const targets = all.filter((s) => !document.annotations.translations[s.hash]).slice(0, limit);
        if (targets.length === 0) {
          return textResult('未訳の文はありません。');
        }
        return jsonResult({
          glossary: document.annotations.glossary,
          remaining: all.filter((s) => !document.annotations.translations[s.hash]).length,
          sentences: targets.map((sentence) => ({
            ...sentenceView(document, sentence),
            context_before: all.slice(Math.max(0, sentence.order - context), sentence.order).map((s) => s.text),
            context_after: all.slice(sentence.order + 1, sentence.order + 1 + context).map((s) => s.text),
          })),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'set_translations',
    {
      title: '訳を書き込む',
      description:
        '訳をまとめて書き込む。sentenceHash で文を指定する。' +
        '人手修正済みの訳は上書きされず、その旨が skipped に返る（これは失敗ではない）。',
      inputSchema: {
        document_id: z.string(),
        translations: z
          .array(
            z.object({
              sentenceHash: z.string().describe('get_untranslated_sentences などが返した値をそのまま使う'),
              text: z.string().describe('日本語訳'),
            }),
          )
          .min(1)
          .max(100),
      },
    },
    async ({ document_id, translations }) => {
      try {
        const result = await client.setTranslations(document_id, translations);
        const lines = [`${result.applied} 件の訳を書き込みました。`];
        if (result.skipped.length > 0) {
          lines.push(`${result.skipped.length} 件は書き込みませんでした:`);
          for (const skipped of result.skipped.slice(0, 10)) {
            lines.push(`  ${skipped.sentenceHash}: ${skipped.reason}`);
          }
        }
        return textResult(lines.join('\n'));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'add_note',
    {
      title: 'メモを残す',
      description:
        '文にメモを付ける。訳語の選択理由、原文の曖昧さ、他の論文との関係など、訳文に押し込めない判断を残す場所。' +
        'メモは他人の書き出しを取り込んでも消えない。',
      inputSchema: {
        document_id: z.string(),
        sentence_hash: z.string(),
        body: z.string().min(1),
        author: z.string().optional().describe('省略時は claude'),
      },
    },
    async ({ document_id, sentence_hash, body, author }) => {
      try {
        const note = await client.addNote(document_id, sentence_hash, body, author ?? 'claude');
        return textResult(`メモを追加しました (${note.id})`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'search_document',
    {
      title: '文書内検索',
      description: '原文・訳文・メモを横断して検索する。訳語の揺れを探すときに使う。',
      inputSchema: { document_id: z.string(), query: z.string().min(1) },
    },
    async ({ document_id, query }) => {
      try {
        const { hits } = await client.search(document_id, query);
        if (hits.length === 0) return textResult(`「${query}」に一致する箇所はありませんでした。`);
        return jsonResult(hits);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'set_glossary',
    {
      title: '用語集を更新',
      description:
        '訳語の対応表を置き換える。以後の翻訳ではここに載っている訳語を優先すること。' +
        '既存の訳文は自動では書き換わらないので、必要なら search_document で探して set_translations で直す。',
      inputSchema: {
        document_id: z.string(),
        entries: z
          .array(
            z.object({
              term: z.string().describe('原語'),
              translation: z.string().describe('採用する訳語'),
              note: z.string().optional().describe('なぜその訳にしたか'),
            }),
          )
          .max(500),
      },
    },
    async ({ document_id, entries }) => {
      try {
        await client.setGlossary(document_id, entries);
        return textResult(`用語集を ${entries.length} 件で更新しました。`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'reparse_document',
    {
      title: '再解析',
      description:
        '同じ PDF を解析し直して文の区切りと座標を作り直す。訳とメモは本文のハッシュで再結合されるので消えない。' +
        'GROBID を後から立ち上げたときや、文の分割がおかしいときに使う。',
      inputSchema: {
        document_id: z.string(),
        parser: z.enum(['auto', 'grobid', 'fallback']).default('auto'),
      },
    },
    async ({ document_id, parser }) => {
      try {
        const result = await client.reparse(document_id, parser);
        const lines = [`再解析しました。訳の再結合 ${result.rebound} 件、対応が見つからなかった注釈 ${result.orphaned} 件。`];
        if (result.warning) lines.push(result.warning);
        if (result.orphaned > 0) {
          lines.push('対応が見つからなかった注釈も削除はされていません。文の区切りが変わった可能性があります。');
        }
        return textResult(lines.join('\n'));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerPrompt(
    'translate_paper',
    {
      title: '論文を1文ずつ訳す',
      description: '未訳の文を文脈込みで取得し、用語集に従って訳し、まとめて書き戻すまでの手順。',
      argsSchema: {
        document_id: z.string().describe('list_documents が返した id'),
        field: z.string().optional().describe('分野（例: 機械学習、計算論的神経科学）。訳語の選択に影響する'),
      },
    },
    ({ document_id, field }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `LogiXiv の文書 ${document_id} を翻訳してください。${field ? `分野は「${field}」です。` : ''}`,
              '',
              '手順:',
              '1. get_document_outline で節構成と用語集を確認する。',
              '2. get_untranslated_sentences を context=2 で呼び、前後の文を見ながら訳す。',
              '3. set_translations でまとめて書き戻す。2 と 3 を未訳が無くなるまで繰り返す。',
              '',
              '訳し方の方針:',
              '- 1 文は 1 文として訳す。読みやすさのために 2 文に割ったり、隣の文と混ぜたりしない（画面上で原文と 1 対 1 に並ぶため）。',
              '- 専門用語は用語集に従う。用語集に無い重要語を決めたら set_glossary に足してから続ける。',
              '- 数式・記号・変数名・引用番号は原文のまま残す。',
              '- 原文が曖昧で複数に読める箇所は、片方を選んで訳し切ったうえで add_note に「なぜそちらを選んだか」を書く。',
              '- 訳が確定できない箇所を、それらしい日本語で埋めない。分からないことは add_note に書く。',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  return server;
}

export { TOOL_COUNT };
