import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { LOGIXIV_VERSION, needsTranslation, progress, type PaperDocument, type Sentence } from '@logixiv/core';
import { LogiXivClient } from './client.ts';

/**
 * Claude から LogiXiv を触るための MCP サーバー。
 *
 * 設計方針は 3 つ。
 *
 * 1. 文の指定は必ず sentenceHash で行う。順番や ID ではなく本文由来の値なので、
 *    再解析をまたいでも Claude の指した文がずれない。
 *
 * 2. 文脈は「連続した平文の並び」で渡す。文ごとに前後 2 文を複製していた頃は、
 *    受信バイトの 88% が重複テキストで、原文はわずか 12% だった（264 文の論文で 210KB）。
 *    範囲 + そのうちの未訳リスト、という形なら情報量を保ったまま 1/4 以下になる。
 *
 * 3. 書き込みの結果は機械可読な JSON で返す。「人手修正済み（＝放置してよい）」と
 *    「該当する文が無い（＝hash を取り直すべき）」は必要な対応が正反対なので、
 *    人間向けの文章に混ぜない。
 */

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function errorResult(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

/** 解析方式によって取れないものがあることを、その場で伝える。 */
function fallbackCaveat(document: PaperDocument): string | undefined {
  if (document.structure.parser === 'grobid') return undefined;
  return 'この文書は簡易解析（pdf.js）で取り込まれています。節が取れず、参考文献・ページ番号・数式の断片が本文に混ざることがあります。GROBID を起動して reparse_document すると改善します。';
}

function sentenceView(document: PaperDocument, sentence: Sentence) {
  const translation = document.annotations.translations[sentence.hash];
  const notes = document.annotations.notes
    .filter((note) => note.sentenceHash === sentence.hash)
    .map((note) => note.body);
  const view: Record<string, unknown> = {
    hash: sentence.hash,
    order: sentence.order,
    page: sentence.page,
    source: sentence.text,
  };
  // 常に同じ値・常に空のフィールドは落とす。Claude が読むトークンをそのぶん節約する。
  const section = document.structure.sections.find((s) => s.id === sentence.sectionId)?.title;
  if (section) view['section'] = section;
  if (translation) {
    view['translation'] = translation.text;
    if (translation.revisedByHuman) view['revisedByHuman'] = true;
  }
  if (notes.length > 0) view['notes'] = notes;
  return view;
}

export function createMcpServer(baseUrl: string): McpServer {
  const client = new LogiXivClient(baseUrl);
  const server = new McpServer(
    { name: 'logixiv', version: LOGIXIV_VERSION },
    {
      instructions:
        'LogiXiv は論文 PDF を 1 文単位で読むためのローカルツールです。' +
        'まず list_documents で対象を選び、get_translation_batch で未訳の文を前後の文脈ごと受け取り、' +
        'set_translations でまとめて書き戻してください。' +
        '訳しにくい箇所は勝手に意訳せず add_note に判断を残すのが望ましい運用です。' +
        '人手修正済み (revisedByHuman) の訳は上書きされません。' +
        '訳す対象でない文（参考文献・ページ番号・数式の断片など）に当たったら、' +
        'skip_sentences に渡して「訳さない」と記録してください。飛ばすだけでは残り続けます。',
    },
  );

  server.registerTool(
    'list_documents',
    {
      title: '文書一覧',
      description:
        'LogiXiv に取り込まれている論文の一覧と翻訳の進捗、本体の状態（GROBID の生死を含む）を返す。' +
        'まずこれを呼んで document_id を決める。',
      inputSchema: {},
    },
    async () => {
      try {
        const [{ documents }, health] = await Promise.all([
          client.listDocuments(),
          client.health().catch(() => null),
        ]);
        if (documents.length === 0) {
          return textResult(
            '取り込み済みの論文がありません。LogiXiv の画面（既定では http://127.0.0.1:4173）を開いて PDF をドラッグしてください。' +
              (health?.grobid === 'down'
                ? '\nGROBID が未接続です。精度の高い文分割には docker compose -f docker/grobid.yml up -d を先に実行してください。'
                : ''),
          );
        }
        return jsonResult({
          documents,
          grobid: health?.grobid ?? 'unknown',
          hint: health?.grobid === 'down' ? 'GROBID 未接続。簡易解析の文書は節が取れません。' : undefined,
        });
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
        '論文のタイトル・節構成・ページ数・解析方式・用語集・翻訳の進捗を返す。全文を読み込まずに構造だけ把握したいときに使う。',
      inputSchema: { document_id: z.string().describe('list_documents が返した id') },
    },
    async ({ document_id }) => {
      try {
        const document = await client.getDocument(document_id);
        const stats = progress(document);
        const firstRemaining = document.structure.sentences.find((s) => needsTranslation(document, s));
        return jsonResult({
          id: document.id,
          title: document.title,
          parser: document.structure.parser,
          parserNote: document.structure.parserNote,
          caveat: fallbackCaveat(document),
          pages: document.structure.pageSizes.length,
          // 訳は「異なり文」単位で付く。同じ文が複数回出る文書では sentences と食い違う。
          sentences: stats.sentences,
          uniqueSentences: stats.uniqueSentences,
          translated: stats.translated,
          skipped: stats.skipped,
          remaining: stats.remaining,
          firstUntranslatedOrder: firstRemaining?.order ?? null,
          revisedByHuman: stats.revisedByHuman,
          abstract: document.structure.abstract,
          sections: document.structure.sections.map((section) => ({
            id: section.id,
            title: section.title,
            firstOrder: document.structure.sentences.find((s) => s.sectionId === section.id)?.order ?? null,
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
        '文を範囲指定で取得する。原文・既存訳・メモが揃って返るので、訳の見直しや前後関係の確認に使う。' +
        'from は**文の通し番号 (order)** で、節やページで絞っても意味は変わらない。',
      inputSchema: {
        document_id: z.string(),
        from: z.number().int().min(0).default(0).describe('開始する文の通し番号 (order)。0 始まり'),
        limit: z.number().int().min(1).max(200).default(40),
        section_id: z.string().optional().describe('指定するとその節だけに絞る'),
        page: z.number().int().min(1).optional().describe('指定するとそのページだけに絞る'),
      },
    },
    async ({ document_id, from, limit, section_id, page }) => {
      try {
        const document = await client.getDocument(document_id);
        let sentences = document.structure.sentences;
        if (section_id) {
          const known = document.structure.sections.some((s) => s.id === section_id);
          if (!known) {
            return textResult(
              `節 ${section_id} はこの文書にありません。${
                document.structure.sections.length === 0
                  ? (fallbackCaveat(document) ?? '節が 1 つも検出されていません。')
                  : `使える節: ${document.structure.sections.map((s) => s.id).join(', ')}`
              }`,
            );
          }
          sentences = sentences.filter((s) => s.sectionId === section_id);
        }
        if (page !== undefined) sentences = sentences.filter((s) => s.page === page);

        // from は order。フィルタ後の添字ではない。
        const slice = sentences.filter((s) => s.order >= from).slice(0, limit);
        const last = slice[slice.length - 1];
        return jsonResult({
          matched: sentences.length,
          returned: slice.length,
          nextFrom: last && sentences.some((s) => s.order > last.order) ? last.order + 1 : null,
          sentences: slice.map((sentence) => sentenceView(document, sentence)),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_translation_batch',
    {
      title: '翻訳する範囲を取得',
      description:
        '翻訳作業の入口。指定位置以降の連続した文を平文の配列で返し、そのうち未訳のものを別に列挙する。' +
        '文脈は配列そのもの（重複が無い）ので、前後関係を見ながら訳せる。' +
        '訳す対象でない文に当たったら、返ってきた nextFrom を from に入れて呼び直せば飛ばせる。',
      inputSchema: {
        document_id: z.string(),
        from: z.number().int().min(0).default(0).describe('開始する文の通し番号 (order)'),
        limit: z.number().int().min(1).max(120).default(40).describe('返す文の総数（未訳・既訳の両方を含む）'),
      },
    },
    async ({ document_id, from, limit }) => {
      try {
        const document = await client.getDocument(document_id);
        const all = document.structure.sentences;
        const window = all.filter((s) => s.order >= from).slice(0, limit);
        const remaining = all.filter((s) => needsTranslation(document, s));

        if (window.length === 0) {
          return textResult(
            remaining.length === 0
              ? '未訳の文はありません。翻訳は完了しています。'
              : `order ${from} 以降に文がありません（この文書の order は 0〜${all.length - 1}）。` +
                  `まだ ${remaining.length} 文残っているので、from=${remaining[0]!.order} から呼び直してください。`,
          );
        }

        const last = window[window.length - 1]!;
        // 「窓の次の位置」と「次に訳す必要がある位置」は別物。後者が終了条件。
        const nextUntranslated = remaining.find((s) => s.order > last.order);
        return jsonResult({
          // 解析方式の注意は最初の呼び出しにだけ付ける（毎回返すと受信の 6% を食う）。
          caveat: from === 0 ? fallbackCaveat(document) : undefined,
          glossary: from === 0 && document.annotations.glossary.length > 0 ? document.annotations.glossary : undefined,
          remainingUntranslated: remaining.length,
          nextFrom: all.some((s) => s.order > last.order) ? last.order + 1 : null,
          /** 次に訳す必要がある文の order。null なら翻訳は終わり。 */
          nextUntranslatedFrom: nextUntranslated?.order ?? null,
          // 連続する本文。文脈はこの並びそのもの。[order, hash, 原文, 訳?]
          window: window.map((sentence) => {
            const translation = document.annotations.translations[sentence.hash];
            return translation
              ? [sentence.order, sentence.hash, sentence.text, translation.text]
              : [sentence.order, sentence.hash, sentence.text];
          }),
          // この窓のうち、訳す必要があるものの order。hash は window から引く。
          untranslated: window.filter((s) => needsTranslation(document, s)).map((s) => s.order),
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
        '訳をまとめて書き込む。sentenceHash で文を指定する。結果は JSON で返る。' +
        'skipped の code が revised_by_human なら対応不要（人手修正済みなので上書きしない仕様）、' +
        'unknown_hash なら hash が間違っているので取り直すこと。',
      inputSchema: {
        document_id: z.string(),
        translations: z
          .array(
            z.object({
              sentenceHash: z.string().describe('get_translation_batch の untranslated が返した hash'),
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
        const unknown = result.skipped.filter((s) => s.code === 'unknown_hash');
        const hints: string[] = [];
        if (unknown.length > 0) {
          hints.push(
            `${unknown.length} 件の hash がこの文書にありません。get_translation_batch を呼び直して hash を取り直してください。`,
          );
        }
        if (result.duplicates.length > 0) {
          hints.push(`同じ hash が ${result.duplicates.length} 件重複していたので、最後の訳を採用しました。`);
        }
        if (result.sentencesAffected > result.applied) {
          hints.push(
            `同じ本文が複数回現れるため、${result.applied} 件の訳が ${result.sentencesAffected} 箇所に反映されました。`,
          );
        }
        return jsonResult({
          applied: result.applied,
          sentencesAffected: result.sentencesAffected,
          // 打ち切らない。100 件上限なので全件出しても小さい。
          skipped: result.skipped,
          hint: hints.length > 0 ? hints.join(' ') : undefined,
        });
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
        'メモは他人の書き出しを取り込んでも消えない。存在しない hash は拒否される。',
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
        if (!note.applied) {
          return errorResult(new Error(`メモを追加できませんでした: ${note.reason ?? '不明'}`));
        }
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
      description:
        '原文・訳文・メモを横断して検索する。ヒットには訳文とメモも入るので、' +
        '訳語の揺れをこのツールだけで確認できる。直したい文の hash もそのまま返る。',
      inputSchema: {
        document_id: z.string(),
        query: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(30),
        from: z.number().int().min(0).default(0).describe('ヒットの何件目から返すか'),
      },
    },
    async ({ document_id, query, limit, from }) => {
      try {
        const result = await client.search(document_id, query, limit, from);
        if (result.hits.length === 0) return textResult(`「${query}」に一致する箇所はありませんでした。`);
        return jsonResult({
          total: result.total,
          truncated: result.truncated,
          nextFrom: result.truncated ? from + result.hits.length : null,
          hits: result.hits,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'update_glossary',
    {
      title: '用語集を更新',
      description:
        '訳語の対応表を更新する。既定は追記（既存の語は消さない）。mode に replace を渡したときだけ全置換になる。' +
        '以後の翻訳ではここに載っている訳語を優先すること。既存の訳文は自動では書き換わらないので、' +
        '必要なら search_document で探して set_translations で直す。',
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
        mode: z
          .enum(['append', 'replace'])
          .default('append')
          .describe('append は追記（既定）。replace は既存の用語集を全部消して置き換える'),
      },
    },
    async ({ document_id, entries, mode }) => {
      try {
        if (mode === 'replace') {
          const result = await client.replaceGlossary(document_id, entries);
          return textResult(`用語集を ${result.total} 件で置き換えました（既存の内容は消えました）。`);
        }
        if (entries.length === 0) {
          return errorResult(new Error('entries が空です。追加する語を渡してください。'));
        }
        const result = await client.addGlossaryEntries(document_id, entries);
        return textResult(
          `用語集を更新しました（新規 ${result.added} / 訳語の変更 ${result.updated} / 合計 ${result.total} 件）。`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'skip_sentences',
    {
      title: '訳さないと記録する',
      description:
        '「この文は訳す対象ではない」と記録する。参考文献の断片・ページ番号・数式・柱など、' +
        'フォールバック解析で本文に混ざったものに使う。記録した文は未訳の集計から外れるので、' +
        'これを使わずに飛ばすだけだと翻訳がいつまでも終わらない。undo で取り消せる。',
      inputSchema: {
        document_id: z.string(),
        sentence_hashes: z.array(z.string()).min(1).max(500),
        reason: z
          .enum(['reference', 'figure', 'table', 'equation', 'header', 'footer', 'other'])
          .default('other'),
        undo: z.boolean().default(false).describe('true にすると「訳さない」を取り消す'),
      },
    },
    async ({ document_id, sentence_hashes, reason, undo }) => {
      try {
        if (undo) {
          const result = await client.unskipSentences(document_id, sentence_hashes);
          return jsonResult({ restored: result.applied, remainingUntranslated: result.remaining });
        }
        const result = await client.skipSentences(document_id, sentence_hashes, reason);
        return jsonResult({
          skipped: result.applied,
          unknownHashes: result.unknown,
          remainingUntranslated: result.remaining,
          hint:
            result.unknown.length > 0
              ? `${result.unknown.length} 件の hash がこの文書にありません。`
              : undefined,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'fix_sentence_boundary',
    {
      title: '文の区切りを直す',
      description:
        '文の切れ目がおかしいときに直す。merge は連続する 2 文以上を 1 文にまとめ、split は 1 文を文字位置で割る。' +
        '訳が「前半だけ」「2 文ぶん」になってしまう原因はほぼここなので、訳す前に直す方が手戻りが少ない。' +
        '同じ本文が複数箇所にあるときは、そのすべてに同じ区切りが適用される（訳は本文のハッシュに付くため）。' +
        '直した内容は記録され、再解析しても流し直される。undo_edit_id か undo=true で取り消せる。',
      inputSchema: {
        document_id: z.string(),
        action: z.enum(['merge', 'split', 'undo']),
        sentence_hashes: z
          .array(z.string())
          .max(64)
          .default([])
          .describe('merge では結合する文のハッシュを本文の順に 2 件以上、split では対象 1 件'),
        offsets: z
          .array(z.number().int().positive())
          .max(64)
          .default([])
          .describe('split のときの分割位置。原文テキストの先頭からの文字数で、切りたい文字の直前を指す'),
        undo_edit_id: z.string().optional().describe('undo のとき、特定の編集だけ取り消したい場合に指定'),
      },
    },
    async ({ document_id, action, sentence_hashes, offsets, undo_edit_id }) => {
      try {
        if (action === 'undo') {
          const result = await client.undoSentenceEdit(document_id, undo_edit_id);
          return result.applied
            ? textResult('区切りの変更を取り消しました。')
            : textResult(`取り消せませんでした: ${result.reason ?? '理由不明'}`);
        }
        if (action === 'merge' && sentence_hashes.length < 2) {
          return textResult('merge には本文の順に並んだ 2 件以上の sentence_hashes が要ります。');
        }
        if (action === 'split' && (sentence_hashes.length !== 1 || offsets.length === 0)) {
          return textResult('split には sentence_hashes を 1 件と、offsets を 1 件以上指定してください。');
        }

        const result = await client.editSentenceBoundary(document_id, {
          type: action,
          hashes: sentence_hashes,
          ...(action === 'split' ? { offsets } : {}),
        });
        if (!result.applied) {
          return textResult(
            `直せませんでした: ${result.reason ?? '理由不明'}\n` +
              'get_sentences で今の区切りとハッシュを取り直してからやり直してください。',
          );
        }
        // 直すと文のハッシュが変わる。古いハッシュのまま訳を書くと素通りするので必ず伝える。
        const detached = result.detached;
        const lost = detached.translations + detached.notes + detached.skipped;
        return jsonResult({
          applied: true,
          editId: result.editId,
          occurrences: result.occurrences,
          // 区切りが変わった文はハッシュも変わる。新しい文の hash を返しておけば
          // もう一度取得しに行かずに訳を書ける。
          resultHashes: result.resultHashes,
          detached,
          hint:
            '区切りを変えた文はハッシュが変わりました。resultHashes が新しい文のハッシュです。' +
            (result.occurrences > 1 ? ` 同じ本文の ${result.occurrences} か所に適用されています。` : '') +
            (lost > 0
              ? ` 元の文に付いていた訳 ${detached.translations} 件・メモ ${detached.notes} 件は、どの文にも結び付かなくなりました（消えてはおらず、action=undo で戻ります）。`
              : ''),
        });
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
        '同じ PDF を解析し直して文の区切りと座標を作り直す。訳とメモは本文のハッシュで再結合されるので基本的に消えない。' +
        'GROBID を後から立ち上げたときや、文の分割がおかしいときに使う。',
      inputSchema: {
        document_id: z.string(),
        parser: z.enum(['auto', 'grobid', 'fallback']).default('auto'),
      },
    },
    async ({ document_id, parser }) => {
      try {
        const result = await client.reparse(document_id, parser);
        const lines = [
          `再解析しました。訳の再結合 ${result.rebound} 件、対応が見つからなかった注釈 ${result.orphaned} 件。`,
        ];
        if (result.editsReapplied > 0 || result.editsDropped > 0) {
          lines.push(
            `文の区切りの直しは ${result.editsReapplied} 件を再適用しました` +
              (result.editsDropped > 0
                ? `（${result.editsDropped} 件は本文が変わって当てられなくなったため解除しました）。`
                : '。'),
          );
        }
        if (result.warning) lines.push(result.warning);
        if (result.orphaned > 0) {
          lines.push(
            '対応が見つからなかった注釈も削除はされていません。文の区切りが変わった可能性があるので、' +
              'get_document_outline で文数を確認してください。',
          );
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
              '1. get_document_outline で節構成・解析方式・用語集を確認する。firstUntranslatedOrder が再開位置。',
              '2. get_translation_batch を from=firstUntranslatedOrder（無ければ 0）で呼ぶ。',
              '   window は [order, hash, 原文, 訳?] の並び。untranslated がそのうち訳すべき order。',
              '3. 訳を set_translations でまとめて書き戻す（hash は window から引く）。',
              '4. 返ってきた nextUntranslatedFrom を from に入れて 2 に戻る。null になったら終わり。',
              '   nextFrom ではなく nextUntranslatedFrom を見ること。前者は「窓の次」なので、',
              '   訳し終わった後も最後まで空振りし続ける。',
              '5. 訳す対象でないと判断した文は skip_sentences に渡してから進む。',
              '   飛ばすだけでは未訳として残り続け、手順が終わらない。',
              '6. 1 文が途中で切れている・2 文が 1 枚に入っている、と気づいたら',
              '   fix_sentence_boundary で直してから訳す。直すとハッシュが変わるので、',
              '   その窓は取り直すこと。',
              '',
              '訳し方の方針:',
              '- 1 文は 1 文として訳す。読みやすさのために 2 文に割ったり、隣の文と混ぜたりしない（画面上で原文と 1 対 1 に並ぶため）。',
              '- 原文の側が間違って切れているときは、訳で辻褄を合わせずに fix_sentence_boundary で区切りを直す。',
              '  「前半だけの訳」「2 文ぶんの訳」は、後から見て原因が分からなくなる。',
              '- 専門用語は用語集に従う。用語集に無い重要語を決めたら update_glossary に足してから続ける（既定は追記なので既存の判断は消えない）。',
              '- 数式・記号・変数名・引用番号は原文のまま残す。',
              '- 原文が曖昧で複数に読める箇所は、片方を選んで訳し切ったうえで add_note に「なぜそちらを選んだか」を書く。',
              '- 訳が確定できない箇所を、それらしい日本語で埋めない。分からないことは add_note に書く。',
              '- 参考文献の断片・ページ番号・数式だけの行など、訳す対象でないものは skip_sentences に渡す。',
              '  簡易解析の文書ではこれらが本文に混ざる。無理に日本語を当てない。',
              '- 同じ本文が複数回現れる文書では、訳は 1 つの hash に付いて全出現に反映される。',
              '  set_translations の sentencesAffected がその件数。',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  return server;
}

/** e2e が実際のツール数と突き合わせるための定数。ここを増やしたらツールも増やすこと。 */
export const TOOL_NAMES = [
  'list_documents',
  'get_document_outline',
  'get_sentences',
  'get_translation_batch',
  'set_translations',
  'add_note',
  'search_document',
  'update_glossary',
  'skip_sentences',
  'fix_sentence_boundary',
  'reparse_document',
] as const;
