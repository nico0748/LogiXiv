import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PAPERLENS_VERSION, needsTranslation, progress, type PaperDocument, type Sentence } from '@paperlens/core';
import { PaperLensClient } from './client.ts';

/**
 * Claude から PaperLens を触るための MCP サーバー。
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

/**
 * 検索語の上限（本体の http.ts と同じ値）。
 * 手前で断るのは、往復 1 回ぶん早く、しかも**理由を確実に日本語で返せる**ため。
 */
const MAX_QUERY_CHARS = 4_000;

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
/**
 * 用語集は「変わったとき」に返す。
 *
 * 最初の 1 回だけに絞っていたので、作業中に update_glossary で足した訳語が、
 * その後の窓に一度も現れなかった。長い作業で文脈が圧縮されると、
 * 自分で決めた訳語を自分で忘れることになる。
 */
type Glossary = { term: string; translation: string; note: string | null }[];

function makeGlossaryTracker() {
  // 接続ごとに持つ。プロセスで共有すると、同じ文書を別のセッションが
  // 途中から開いたときに「もう送った」扱いになり、用語集が一度も届かない。
  const seen = new Map<string, string>();
  return (documentId: string, glossary: Glossary, force: boolean): Glossary | undefined => {
    const signature = JSON.stringify(glossary);
    const changed = seen.get(documentId) !== signature;
    // 空でも記録する。記録せずに帰ると、消して同じ内容に戻したときに
    // 「変わっていない」と見なされ、以後ずっと送られなくなる。
    seen.set(documentId, signature);
    if (glossary.length === 0) return undefined;
    return force || changed ? glossary : undefined;
  };
}

/**
 * 「同じところで足踏みしていないか」を見る。
 *
 * 末尾から先頭へ回り込むようにしたので完了の誤報は消えたが、代わりに
 * 同じ文を保留し続けると同じ窓を延々と取り直す形になった。進んでいないことは
 * 呼び出し側より server の方が確実に分かるので、こちらから伝える。
 */
function makeProgressWatcher() {
  const last = new Map<string, { from: number; remaining: number; times: number }>();
  return (documentId: string, from: number, remaining: number): boolean => {
    const previous = last.get(documentId);
    const same = previous !== undefined && previous.from === from && previous.remaining === remaining;
    last.set(documentId, { from, remaining, times: same ? previous.times + 1 : 0 });
    return same;
  };
}

/**
 * 簡易解析の文書に付ける但し書き。
 *
 * 「節が取れず」と決め打ちしていたが、簡易解析でも節はたいてい取れる
 * （8 節取れている文書に「節が取れず」と返していた）。実際に取れているものを
 * 取れないと言うと、呼び出し側は使える手掛かりを使わなくなる。
 * 読み順の崩れが検出されているときは、そちらの方が重いので先に言う。
 */
function fallbackCaveat(document: PaperDocument): string | undefined {
  if (document.structure.parser === 'grobid') return undefined;
  const parts: string[] = [];
  const quality = document.structure.quality;
  if (quality?.coverageRisk === 'high') {
    // 消えた本文は読み順の検査に映らない（生き残った行しか見ないため）ので別建て。
    // 残骸が文法の通る英文に癒着すると、訳す側にも「そう書いてある」としか見えない。
    parts.push(
      `本文の一部が取り出せていない疑いがあります（${quality.coverageReason ?? ''}）。` +
        '欠けた文はそもそもこの一覧に出てこないので、訳す前に PDF と突き合わせてください。',
    );
  }
  if (quality?.readingOrderRisk === 'high') {
    parts.push(
      `読み順が崩れている疑いがあります（${quality.reason}）。` +
        '原文そのものが壊れている可能性があるので、訳す前に原文を確かめてください。',
    );
  }
  parts.push('この文書は簡易解析（pdf.js）で取り込まれています。');
  if (document.structure.sections.length === 0) parts.push('節は取れていません。');
  parts.push(
    '参考文献・ページ番号・数式の断片が本文に混ざることがあります。' +
      'GROBID を起動して reparse_document すると改善します。',
  );
  return parts.join('');
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
    // 原文そのものが壊れているおそれのある文。落とした行がこの文の中に重なっていた。
    // 記号が落ちて**文法の通る英文**になることがあるので、訳す側からは見分けが付かない。
    // 付いていない文は「検出できなかった」であって無傷の保証ではない。
    ...(sentence.seam
      ? {
          seam: {
            kinds: sentence.seam.kinds,
            // 抜けた中身そのもの。補題の本体が落ちていることがあり、
            // これがあれば「飛ばす」以外の手（補って訳す）が取れる。
            // 継ぎ直せるときだけ中身が入る（1〜2 文字の断片は渡さない。
            // 「抜けたのはここ: 4」は読む側に何も与えないため）。
            missing: sentence.seam.texts ?? [],
            warning:
              (sentence.seam.texts && sentence.seam.texts.length > 0
                ? 'missing に抜けた中身が入っています。それを補って訳してよい（数式・記号は原文のまま残す）。'
                : '抜けたのは記号の断片なので中身は渡せません。この文は原文が壊れていると考えてください。') +
              '補えないときは add_note で「原文が壊れている可能性」を残すか、skip_sentences に reason="unreadable" で回してください。',
          },
        }
      : {}),
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
  const client = new PaperLensClient(baseUrl);
  const glossaryIfChanged = makeGlossaryTracker();
  const noteProgress = makeProgressWatcher();
  const server = new McpServer(
    { name: 'paperlens-server', version: PAPERLENS_VERSION },
    {
      instructions:
        'PaperLens は論文 PDF を 1 文単位で読むためのローカルツールです。' +
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
        'PaperLens に取り込まれている論文の一覧と翻訳の進捗、本体の状態（GROBID の生死を含む）を返す。' +
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
          // 返りの形は常に JSON。1 か所でも平文を混ぜると、素直に JSON.parse する
          // 呼び出し側がその 1 か所で落ちる。
          return jsonResult({
            documents: [],
            hint:
              '取り込み済みの論文がありません。PaperLens の画面（既定では http://127.0.0.1:4173）を開いて PDF をドラッグしてください。' +
              (health?.grobid === 'down'
                ? ' GROBID が未接続です。精度の高い文分割には docker compose -f docker/grobid.yml up -d を先に実行してください。'
                : ''),
          });
        }
        return jsonResult({
          documents,
          grobid: health?.grobid ?? 'unknown',
          // 「節が取れません」と決め打ちしていたが、簡易解析でも節はたいてい取れる
          // （15 節取れている文書に「取れません」と返していた）。同じ文書の
          // get_document_outline が正反対のことを言うので、呼び出し側が
          // 使える手掛かりを使わなくなる。
          hint:
            health?.grobid === 'down'
              ? 'GROBID 未接続。簡易解析で取り込んだ文書は、節・図表・数式の切り分けが崩れることがあります。' +
                '文書ごとの詳しい但し書きは get_document_outline の caveat に入ります。'
              : undefined,
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
            return jsonResult({
              matched: 0,
              returned: 0,
              nextFrom: null,
              sentences: [],
              sections: document.structure.sections.map((s) => s.id),
              hint:
                `節 ${section_id} はこの文書にありません。` +
                (document.structure.sections.length === 0
                  ? (fallbackCaveat(document) ?? '節が 1 つも検出されていません。')
                  : `使える節は sections にあります。`),
            });
          }
          sentences = sentences.filter((s) => s.sectionId === section_id);
        }
        if (page !== undefined) sentences = sentences.filter((s) => s.page === page);

        // from は order。フィルタ後の添字ではない。
        const slice = sentences.filter((s) => s.order >= from).slice(0, limit);
        const last = slice[slice.length - 1];
        const orders = sentences.map((s) => s.order);
        return jsonResult({
          matched: sentences.length,
          returned: slice.length,
          nextFrom: last && sentences.some((s) => s.order > last.order) ? last.order + 1 : null,
          sentences: slice.map((sentence) => sentenceView(document, sentence)),
          // 0 件には「該当が無い」と「from が範囲の外」の 2 通りがある。
          // 区別できないと、呼び出し側は前者だと思って諦める。
          hint:
            slice.length > 0
              ? undefined
              : sentences.length === 0
                ? '条件に合う文がありません。'
                : `from=${from} は範囲の外です（order は ${Math.min(...orders)}〜${Math.max(...orders)}）。`,
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
        '**終了条件は remainingUnique が 0 になること。** nextUntranslatedFrom は次に見るべき位置の案内で、' +
        '末尾まで行くと先頭へ回り込む。訳す対象でない文は skip_sentences に渡すこと' +
        '（from を進めて飛ばすだけでは、いつまでも残り続ける）。',
      inputSchema: {
        document_id: z.string(),
        from: z.number().int().min(0).default(0).describe('開始する文の通し番号 (order)'),
        limit: z.number().int().min(1).max(120).default(40).describe('返す文の総数（未訳・既訳の両方を含む）'),
        include_translations: z
          .boolean()
          .default(false)
          .describe('既訳の訳文も返す。既定は false（自分が書いた訳文を読み返す必要は普通ない）'),
      },
    },
    async ({ document_id, from, limit, include_translations }) => {
      try {
        const document = await client.getDocument(document_id);
        const all = document.structure.sentences;
        const window = all.filter((s) => s.order >= from).slice(0, limit);
        const remaining = all.filter((s) => needsTranslation(document, s));
        // 訳は hash に付くので、残件は「異なり文」で数える。延べ数で数えると、
        // 1 つの hash を訳しただけで残りが 15 減り、進捗が説明できなくなる。
        const remainingUnique = new Set(remaining.map((s) => s.hash)).size;
        const stalled = noteProgress(document_id, from, remainingUnique);

        if (window.length === 0) {
          // 返り値の形は必ず JSON にする。ここだけ平文を返すと、
          // 素直に JSON.parse する呼び出し側が末端で必ず落ちる。
          return jsonResult({
            remainingUntranslated: remaining.length,
            remainingUnique,
            nextFrom: null,
            nextUntranslatedFrom: remaining[0]?.order ?? null,
            window: [],
            untranslated: [],
            hint:
              remaining.length === 0
                ? '未訳の文はありません。翻訳は完了しています。'
                : `order ${from} 以降に文がありません（この文書の order は 0〜${all.length - 1}）。` +
                  `まだ ${remainingUnique} 文（延べ ${remaining.length}）残っているので、` +
                  `nextUntranslatedFrom から呼び直してください。`,
          });
        }

        const last = window[window.length - 1]!;
        /**
         * 次に見る位置。**末尾まで来たら先頭へ回り込む。**
         *
         * 前へ進むだけにしていたので、途中で保留した文があると
         * 「まだ残っているのに null（＝完了）」を返していた。指示どおりに
         * 動く呼び出し側ほど、穴の空いた論文を「訳し終えた」と信じて終わる。
         */
        const nextUntranslated = remaining.find((s) => s.order > last.order) ?? remaining[0];

        // 同じ本文は 1 回訳せば全出現に反映される。窓の中の重複を先に畳んでおかないと、
        // 同じ文の訳を 2 回生成して、書き込み時に「重複でした」と後から言われる。
        const byOrder = new Map(all.map((sentence) => [sentence.order, sentence]));
        const seen = new Set<string>();
        const untranslated: number[] = [];
        const duplicateOf = new Map<number, number>();
        for (const sentence of window) {
          if (!needsTranslation(document, sentence)) continue;
          if (seen.has(sentence.hash)) {
            const head = untranslated.find((order) => byOrder.get(order)?.hash === sentence.hash);
            if (head !== undefined) duplicateOf.set(sentence.order, head);
            continue;
          }
          seen.add(sentence.hash);
          untranslated.push(sentence.order);
        }

        const withNotes = window
          .filter((s) => document.annotations.notes.some((note) => note.sentenceHash === s.hash))
          .map((s) => s.order);

        return jsonResult({
          // 解析方式の注意は最初の呼び出しにだけ付ける（毎回返すと受信の 6% を食う）。
          caveat: from === 0 ? fallbackCaveat(document) : undefined,
          // 用語集は「変わったとき」に返す。最初の 1 回だけだと、途中で足した訳語が
          // 長い作業の間に一度も戻ってこない。
          glossary: glossaryIfChanged(document_id, document.annotations.glossary, from === 0),
          /**
           * 前回と同じ窓を、残件も変わらないまま取り直している。
           * 保留を続けても先へは進まないので、訳すか skip_sentences に渡すこと。
           */
          noProgress: stalled || undefined,
          /** 未訳の延べ数（同じ本文が複数回出ればその数だけ数える）。 */
          remainingUntranslated: remaining.length,
          /** 未訳の異なり文の数。訳はこの単位で付くので、作業量はこちら。 */
          remainingUnique,
          nextFrom: all.some((s) => s.order > last.order) ? last.order + 1 : null,
          /** 次に見るべき位置。末尾まで来たら先頭へ回り込む。null は「未訳ゼロ」。 */
          nextUntranslatedFrom: nextUntranslated?.order ?? null,
          /**
           * 連続する本文。文脈はこの並びそのもの。`[order, hash, 原文]`、
           * 既に訳のある文は `[order, hash, 原文, 1]`（訳文そのものは返さない）。
           *
           * 既訳の訳文を毎回返していた頃は、受信の 4 割強が「自分が書いた日本語の
           * 読み返し」だった。文脈に要るのは原文で、訳語の統一は用語集が担う。
           * どうしても要るときだけ include_translations で取る。
           */
          window: window.map((sentence) => {
            const translation = document.annotations.translations[sentence.hash];
            if (!translation) return [sentence.order, sentence.hash, sentence.text];
            return include_translations
              ? [sentence.order, sentence.hash, sentence.text, translation.text]
              : [sentence.order, sentence.hash, sentence.text, 1];
          }),
          // この窓のうち訳す必要があるものの order。同じ本文は最初の 1 つだけ。
          untranslated,
          // 本文が同じなので訳さなくてよい order → 代表の order。
          duplicateOf: duplicateOf.size > 0 ? Object.fromEntries(duplicateOf) : undefined,
          // メモが付いている文（保留の理由などを書いた場所）。
          withNotes: withNotes.length > 0 ? withNotes : undefined,
          // 原文が壊れているおそれのある文の order。
          // 記号が落ちて文法の通る英文になることがあるので、読んだだけでは見分けが付かない。
          // 「分からないところをそれらしい日本語で埋めるな」という手順が効くのは、
          // 壊れていることが分かっている場合だけなので、必ず名指しで渡す。
          damaged: (() => {
            const orders = window.filter((sentence) => sentence.seam).map((sentence) => sentence.order);
            return orders.length > 0
              ? {
                  orders,
                  warning:
                    'これらの文は、本文として取り出せなかった行を挟んで組み立てられています。' +
                    '記号や語が抜けているおそれがあるので、訳す前に get_sentences で seam を確かめ、' +
                    '自信が持てなければ add_note に理由を残すか skip_sentences に reason="unreadable" で回してください。',
                }
              : undefined;
          })(),
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
        '訳をまとめて書き込む。1 件は {"sentenceHash": "…", "text": "日本語訳"}。' +
        // 項目名を description にも書く。用語集は term/translation、メモは
        // sentence_hash/body と流儀が違うので、手順だけ読んで translation と
        // 書いてしまう呼び出しが実際に出た（1 往復まるごと無駄になる）。
        '**訳の項目名は text。`translation` ではない**（`translation` は update_glossary の方）。' +
        '1 回に渡せるのは 120 件まで（get_translation_batch の limit と同じ）。結果は JSON で返る。' +
        'skipped の code が revised_by_human なら対応不要（人手修正済みなので上書きしない仕様）、' +
        'unknown_hash なら hash が間違っているので取り直すこと。',
      inputSchema: {
        document_id: z.string(),
        translations: z
          .array(
            z.object({
              sentenceHash: z
                .string({
                  required_error:
                    '文の指定は sentenceHash という項目名で送ってください（get_translation_batch の window/untranslated が返した hash）。',
                })
                .describe('get_translation_batch の untranslated が返した hash'),
              // 空の訳を通すと、その文は「訳し終わった」ことになって二度と出てこない。
              // 生成が途中で切れたときに静かに欠落するので、ここで断る。
              //
              // required_error に直し方を書いておく。zod の既定は "Required" だけなので、
              // `translation` と書いた呼び出し側には「何が足りないか」しか伝わらず、
              // 正しい項目名（このツール固有の text）はどこにも出てこなかった。
              text: z
                .string({
                  required_error:
                    '訳の項目名は text です（translation ではありません）。' +
                    '例: {"sentenceHash": "…", "text": "日本語訳"}。' +
                    'term/translation は update_glossary、sentence_hash/body は add_note の項目名です。',
                  invalid_type_error: 'text は文字列で渡してください。',
                })
                .trim()
                .min(1, '訳が空です。訳せない文は skip_sentences に渡してください。')
                .describe('日本語訳（項目名は text。空にはできない）'),
            }),
          )
          .min(1)
          // get_translation_batch の limit と揃える。窓いっぱい訳したのに
          // 書き戻せない、という噛み合わせの悪さを作らない。
          .max(120),
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
        if (result.overwritten > 0) {
          // 上書きは黙って起きてはいけない。別の窓と重なって呼んだときや、
          // 別のセッションが先に訳を入れていたときに、何が置き換わったか分からなくなる。
          hints.push(`${result.overwritten} 件は既にあった訳を置き換えました。`);
        }
        // 残りを一緒に返す。これが無いと、最後の 1 文を書いた後に「本当に終わったか」
        // を確かめるためだけの往復が毎回 1 回増える（しかも窓が丸ごと返ってくる）。
        const after = await client.getDocument(document_id);
        const left = after.structure.sentences.filter((s) => needsTranslation(after, s));
        return jsonResult({
          applied: result.applied,
          created: result.created,
          overwritten: result.overwritten,
          sentencesAffected: result.sentencesAffected,
          /** 未訳の異なり文の数。0 になったら翻訳は終わり。 */
          remainingUnique: new Set(left.map((s) => s.hash)).size,
          nextUntranslatedFrom: left[0]?.order ?? null,
          // 打ち切らない。120 件上限なので全件出しても小さい。
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
        return jsonResult({ applied: true, noteId: note.id });
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
        '訳語の揺れをこのツールだけで確認できる。直したい文の hash もそのまま返る。' +
        '参考文献・図表キャプション・脚注など「本文として扱わなかった行」も探す（画面にも出ている）。' +
        'それらは isBody:false・nonBodyKind 付きで返る。訳の対象ではないので set_translations に渡さないこと。',
      inputSchema: {
        document_id: z.string(),
        query: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(30),
        from: z.number().int().min(0).default(0).describe('ヒットの何件目から返すか'),
      },
    },
    async ({ document_id, query, limit, from }) => {
      try {
        // 長すぎる検索語はここで断る。本体まで運ぶと、経路によっては
        // 理由の書かれていない失敗（本文なしの 431）になって戻ってくる。
        // 断るときは「何文字だったか」まで言う。言わないと切り詰め方が決まらない。
        if (query.length > MAX_QUERY_CHARS) {
          return errorResult(
            new Error(
              `検索語が長すぎます（${query.length} 文字 / 上限 ${MAX_QUERY_CHARS} 文字）。` +
                'この検索は「文書の中から語や 1 文を探す」ためのものなので、' +
                '段落まるごとではなく、探したい語・固有名詞・1 文だけを渡してください。' +
                '原文全体を見たいときは get_document を使ってください。',
            ),
          );
        }
        const result = await client.search(document_id, query, limit, from);
        // 本文でないヒット（参考文献・キャプションなど）は訳せない。件数を添えておかないと、
        // 一致したのだからと set_translations に渡され、「該当する文がありません」で弾かれる。
        const nonBody = result.hits.filter((hit) => hit.isBody === false).length;
        // 返りは常に JSON。「1 件も無い」と「from が末尾を越えた」は別の話なので、
        // 0 件のときも total を返して区別できるようにする。
        return jsonResult({
          total: result.total,
          truncated: result.truncated,
          nextFrom: result.truncated ? from + result.hits.length : null,
          hits: result.hits,
          hint:
            result.total === 0
              ? `「${query}」に一致する箇所はありませんでした。`
              : result.hits.length === 0
                ? `from=${from} は末尾を越えています（全 ${result.total} 件）。`
                : nonBody > 0
                  ? `このうち ${nonBody} 件は本文として扱わなかった行（isBody:false）です。訳の対象ではありません。`
                  : undefined,
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
        if (entries.length === 0) {
          // replace で空配列を通すと、確認も無く用語集が消える。
          // append では断っているのに replace では通る、という非対称は事故のもと。
          return errorResult(
            new Error('entries が空です。用語集を空にしたい場合も、意図が読めないので受け付けません。'),
          );
        }
        if (mode === 'replace') {
          const result = await client.replaceGlossary(document_id, entries);
          return jsonResult({
            total: result.total,
            hint: `用語集を ${result.total} 件で置き換えました（既存の内容は消えました）。`,
          });
        }
        const result = await client.addGlossaryEntries(document_id, entries);
        return jsonResult({
          added: result.added,
          updated: result.updated,
          total: result.total,
          hint: `用語集を更新しました（新規 ${result.added} / 訳語の変更 ${result.updated} / 合計 ${result.total} 件）。`,
        });
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
          // `unreadable` は「解析が失敗していて、そもそも文として読めない」。
          // 簡易解析でいちばん多い理由なのに値が無く、other に押し込むしかなかった。
          // 後から「解析を直せば訳せる文」だけを拾い直せるように、独立させる。
          .enum(['reference', 'figure', 'table', 'equation', 'header', 'footer', 'unreadable', 'other'])
          .default('other')
          .describe(
            '訳さない理由。unreadable は「解析が崩れていて文として読めない」。' +
              '再解析で直ったときに拾い直せるよう、他と分けてある。',
          ),
        undo: z.boolean().default(false).describe('true にすると「訳さない」を取り消す'),
      },
    },
    async ({ document_id, sentence_hashes, reason, undo }) => {
      try {
        if (undo) {
          const result = await client.unskipSentences(document_id, sentence_hashes);
          // 片方の分岐だけ形が違うと、片方を覚えた呼び出し側がもう片方で落ちる。
          return jsonResult({
            skipped: 0,
            restored: result.applied,
            unknownHashes: [],
            alreadyTranslated: [],
            remainingUnique: result.remaining,
          });
        }
        const result = await client.skipSentences(document_id, sentence_hashes, reason);
        const hints: string[] = [];
        if (result.unknown.length > 0) {
          hints.push(`${result.unknown.length} 件の hash がこの文書にありません。`);
        }
        if (result.alreadyTranslated?.length > 0) {
          hints.push(
            `${result.alreadyTranslated.length} 件は既に訳が付いているので対象外にしませんでした` +
              '（外したいなら、画面のその文で「訳を消して外す」を押してください）。',
          );
        }
        return jsonResult({
          skipped: result.applied,
          restored: 0,
          unknownHashes: result.unknown,
          alreadyTranslated: result.alreadyTranslated ?? [],
          /** 未訳の異なり文の数。get_translation_batch の remainingUnique と同じ数え方。 */
          remainingUnique: result.remaining,
          hint: hints.length > 0 ? hints.join(' ') : undefined,
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
        'drop は 1 文を本文から取り除いて「訳さないもの」へ移す（消さずに残るので、画面には理由つきで並ぶ）。' +
        '本文 1 文の**真ん中**に図の枠内文字や表の行が割り込んでいるときは、' +
        'split で 3 つに割り、割り込みを drop し、残った前後を merge すると 1 文に戻せる。' +
        '訳が「前半だけ」「2 文ぶん」になってしまう原因はほぼここなので、訳す前に直す方が手戻りが少ない。' +
        '同じ本文が複数箇所にあるときは、そのすべてに同じ区切りが適用される（訳は本文のハッシュに付くため）。' +
        '直した内容は記録され、再解析しても流し直される。action=\'undo\' で取り消せる（特定の編集だけなら undo_edit_id も指定する）。',
      inputSchema: {
        document_id: z.string(),
        action: z.enum(['merge', 'split', 'drop', 'undo']),
        sentence_hashes: z
          .array(z.string())
          .max(64)
          .default([])
          .describe('merge では結合する文のハッシュを本文の順に 2 件以上、split と drop では対象 1 件'),
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
          return jsonResult({
            applied: result.applied,
            hint: result.applied ? '区切りの変更を取り消しました。' : `取り消せませんでした: ${result.reason ?? '理由不明'}`,
          });
        }
        if (action === 'merge' && sentence_hashes.length < 2) {
          return jsonResult({ applied: false, hint: 'merge には本文の順に並んだ 2 件以上の sentence_hashes が要ります。' });
        }
        if (action === 'split' && (sentence_hashes.length !== 1 || offsets.length === 0)) {
          return jsonResult({
            applied: false,
            hint: 'split には sentence_hashes を 1 件と、offsets を 1 件以上指定してください。',
          });
        }
        if (action === 'drop' && sentence_hashes.length !== 1) {
          return jsonResult({ applied: false, hint: 'drop には取り除く文の sentence_hashes を 1 件だけ指定してください。' });
        }

        const result = await client.editSentenceBoundary(document_id, {
          type: action,
          hashes: sentence_hashes,
          ...(action === 'split' ? { offsets } : {}),
        });
        if (!result.applied) {
          return jsonResult({
            applied: false,
            reason: result.reason,
            hint: 'get_sentences で今の区切りとハッシュを取り直してからやり直してください。',
          });
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
            (action === 'drop'
              ? '本文から取り除いて「訳さないもの」へ移しました（消えてはいません）。' +
                '取り除いた前後の文が隣り合ったので、1 文に戻すならこのまま merge できます。'
              : '区切りを変えた文はハッシュが変わりました。resultHashes が新しい文のハッシュです。') +
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
          lines.push('対応が見つからなかった注釈も削除はされていません。');
        }
        // 再解析で文の区切りが変わると order も hash も動く。作業中の位置を
        // 平文で「気をつけて」と書いても伝わらないので、再開位置を数で返す。
        // 再解析の応答に文書そのものが入っている。取り直すと転送が二重になるうえ、
        // 2 回の読みの間に別の書き込みが挟まる隙間ができる。
        const outline = result.document;
        const remaining = outline.structure.sentences.filter((s) => needsTranslation(outline, s));
        lines.push('以前の order と hash は無効です。下の firstUntranslatedOrder から取り直してください。');
        return jsonResult({
          rebound: result.rebound,
          orphaned: result.orphaned,
          editsReapplied: result.editsReapplied,
          editsDropped: result.editsDropped,
          sentences: outline.structure.sentences.length,
          remainingUnique: new Set(remaining.map((s) => s.hash)).size,
          firstUntranslatedOrder: remaining[0]?.order ?? null,
          warning: result.warning ?? undefined,
          hint: lines.join(' '),
        });
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
              `PaperLens の文書 ${document_id} を翻訳してください。${field ? `分野は「${field}」です。` : ''}`,
              '',
              '手順:',
              '1. get_document_outline で節構成・解析方式・用語集を確認する。firstUntranslatedOrder が再開位置。',
              '2. get_translation_batch を from=firstUntranslatedOrder（無ければ 0）で呼ぶ。',
              '   window は [order, hash, 原文, 訳?] の並び。untranslated がそのうち訳すべき order',
              '   （同じ本文は最初の 1 つだけ。残りは duplicateOf に出る）。',
              '3. 訳を set_translations でまとめて書き戻す（hash は window から引く）。',
              '   1 件の形は {"sentenceHash": "…", "text": "日本語訳"}。**訳の項目名は text**',
              '   （translation ではない。用語集だけが term/translation、メモは sentence_hash/body）。',
              '   1 回に渡せるのは 120 件まで。',
              '4. 返ってきた nextUntranslatedFrom を from に入れて 2 に戻る。',
              '   **終わりの判定は remainingUnique が 0 になったとき。** nextUntranslatedFrom は',
              '   末尾まで行くと先頭へ回り込むので、保留した文があれば必ずもう一度回ってくる。',
              '5. 訳す対象でないと判断した文は skip_sentences に渡してから進む。',
              '   飛ばすだけでは未訳として残り続け、手順が終わらない。',
              '6. 1 文が途中で切れている・2 文が 1 枚に入っている、と気づいたら',
              '   fix_sentence_boundary で直してから訳す。直すとハッシュが変わるので、',
              '   resultHashes を使うか、その窓を取り直すこと。',
              '7. reparse_document を途中で使ったら、order も hash も変わる。',
              '   返ってきた firstUntranslatedOrder から取り直すこと。',
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
