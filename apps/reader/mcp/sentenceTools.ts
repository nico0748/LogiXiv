// 1 文ずつの対訳（papers/<id>/sentences.json）を扱う MCP ツール。
// packages/mcp（src/server.ts）の 11 ツールを、このアプリの論文 ID で使えるように移したもの。
//
// 方針は packages/mcp と同じ。
// - 文の指定は必ず hash で行う。本文由来の値なので、再解析をまたいでも指した文がずれない。
// - 文脈は「連続した原文の並び」で渡す。文ごとに前後を複製すると受信の大半が重複になる。
// - 書き込みの結果は機械可読な JSON で返す。「人手修正済み（放置してよい）」と
//   「該当する文が無い（hash を取り直す）」は対応が正反対なので、文章に混ぜない。
//
// 読み書きの実体は server/sentences.ts（ファイルへの保存・論文ごとの直列化・再解析）を呼ぶ。

import { z } from "zod";
import { needsTranslation, progress, searchDocument, type PaperDocument, type Sentence } from "@paperlens/core";
import { dataRoot } from "../server/config.ts";
import { NodeVault } from "../server/nodeVault.ts";
import { requirePaper } from "../server/service.ts";
import {
  addSentenceNote,
  clearTranslations,
  editSentenceBoundary,
  parseSentences,
  removeGlossary,
  removeSentenceNote,
  sentencesState,
  setTranslations,
  skipSentences,
  undoSentenceEdit,
  unskipSentences,
  upsertGlossary,
  type SentencesState,
} from "../server/sentences.ts";
import type { Tool } from "./tools.ts";

type Result = Awaited<ReturnType<Tool["handler"]>>;

// 対訳のツールは返りが大きいので、整形せずに返す（受信のトークンを節約する）
const compact = (value: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

/** 検索語の上限。段落まるごと渡されたときに、理由を日本語で返して手前で断る。 */
const MAX_QUERY_CHARS = 4_000;
/** parse_sentences が解析の終わりを待つ上限。MCP の呼び出しが時間切れになる前に返す。 */
const PARSE_WAIT_MS = 50_000;
/** set_translations に一度に渡せる件数（get_translation_batch の limit と揃える）。 */
const MAX_BATCH = 120;

const PAPER = z.string().describe("論文 ID（papers/ の下のフォルダ名）。list_papers が返す id を指定します");

const vault = () => new NodeVault(dataRoot());

/** 解析の状態を、Claude が次に何をすればよいか分かる文に直す。 */
export function stateMessage(paper: string, s: SentencesState): string {
  if (s.status === "none") {
    return (
      `論文「${paper}」はまだ 1 文ずつに分けられていません（papers/${paper}/sentences.json がありません）。` +
      "parse_sentences を呼んで解析してから、もう一度呼んでください。"
    );
  }
  if (s.status === "parsing") {
    return `論文「${paper}」は解析中です（${s.startedAt} 開始）。少し待ってから get_sentence_outline を呼び直してください。`;
  }
  if (s.status === "failed") {
    return (
      `論文「${paper}」の前回の解析は失敗しました: ${s.error}。` +
      'parse_sentences を parser="fallback" で呼び直してください（GROBID が無くても動きます）。'
    );
  }
  return "";
}

/** 解析済みの文書を返す。まだなら、次にすべきことを添えて止める。 */
async function readyDocument(v: NodeVault, paper: string): Promise<PaperDocument> {
  await requirePaper(v, paper);
  const s = await sentencesState(v, paper);
  if (s.status !== "ready") throw new Error(stateMessage(paper, s));
  return s.document;
}

/** 未訳の異なり文の数と、最初の未訳の位置。 */
function remainingOf(document: PaperDocument) {
  const left = document.structure.sentences.filter((s) => needsTranslation(document, s));
  return { remainingUnique: new Set(left.map((s) => s.hash)).size, left };
}

/**
 * 簡易解析・崩れの疑いがある文書に付ける但し書き（structure.quality から作る）。
 * 実際に取れているものを「取れない」と言うと、呼び出し側は使える手掛かりを使わなくなるので、
 * 測れた痕跡があるときだけ言う。
 */
export function parseCaveat(document: PaperDocument): string | undefined {
  if (document.structure.parser === "grobid") return undefined;
  const parts: string[] = [];
  const quality = document.structure.quality;
  if (quality?.coverageRisk === "high") {
    parts.push(
      `本文の一部が取り出せていない疑いがあります（${quality.coverageReason ?? ""}）。` +
        "欠けた文はそもそも一覧に出てこないので、訳す前に PDF（read_paper_text）と突き合わせてください。",
    );
  }
  if (quality?.readingOrderRisk === "high") {
    parts.push(
      `読み順が崩れている疑いがあります（${quality.reason}）。` +
        "原文そのものが壊れている可能性があるので、訳す前に原文を確かめてください。",
    );
  }
  parts.push("この論文は簡易解析（pdf.js）で文に分けています。");
  if (document.structure.sections.length === 0) parts.push("節は取れていません。");
  parts.push(
    "参考文献・ページ番号・数式の断片が本文に混ざることがあります。" +
      'GROBID を起動して parse_sentences（parser="grobid"）を呼ぶと改善します。',
  );
  return parts.join("");
}

function sentenceView(document: PaperDocument, sentence: Sentence) {
  const translation = document.annotations.translations[sentence.hash];
  const notes = notesOf(document, sentence.hash);
  const view: Record<string, unknown> = { hash: sentence.hash, order: sentence.order, page: sentence.page, source: sentence.text };
  // 原文が壊れているおそれのある文。記号が落ちて文法の通る英文になることがあるので、名指しで渡す
  if (sentence.seam) {
    view.seam = {
      kinds: sentence.seam.kinds,
      missing: sentence.seam.texts ?? [],
      warning:
        (sentence.seam.texts && sentence.seam.texts.length > 0
          ? "missing に抜けた中身が入っています。それを補って訳してよい（数式・記号は原文のまま残す）。"
          : "抜けたのは記号の断片なので中身は渡せません。この文は原文が壊れていると考えてください。") +
        '補えないときは add_sentence_note で「原文が壊れている可能性」を残すか、skip_sentences に reason="unreadable" で回してください。',
    };
  }
  // 常に空のフィールドは落とす
  const section = document.structure.sections.find((s) => s.id === sentence.sectionId)?.title;
  if (section) view.section = section;
  if (translation) {
    view.translation = translation.text;
    if (translation.revisedByHuman) view.revisedByHuman = true;
  }
  const skipped = document.annotations.skipped?.[sentence.hash];
  if (skipped) view.skipped = skipped.reason;
  if (notes.length > 0) {
    view.notes = notes.map((n) => n.body);
    // 消すとき（remove_sentence_note）に使う ID。notes は前からの形（本文だけ）のまま残す
    view.noteItems = notes;
  }
  return view;
}

/** 文に付いたメモ（ID と本文）。 */
function notesOf(document: PaperDocument, hash: string) {
  return document.annotations.notes.filter((n) => n.sentenceHash === hash).map((n) => ({ id: n.id, body: n.body }));
}

type Glossary = PaperDocument["annotations"]["glossary"];

/**
 * 用語集は「変わったとき」に返す。最初の 1 回だけだと、作業中に足した訳語が
 * 長い作業の間に一度も戻ってこない（文脈が圧縮されると自分で決めた訳語を忘れる）。
 * stdio の MCP は接続ごとにプロセスが分かれるので、プロセス内で持てば接続ごとになる。
 */
const glossarySeen = new Map<string, string>();
function glossaryIfChanged(paper: string, glossary: Glossary, force: boolean): Glossary | undefined {
  const signature = JSON.stringify(glossary);
  const changed = glossarySeen.get(paper) !== signature;
  glossarySeen.set(paper, signature);
  if (glossary.length === 0) return undefined;
  return force || changed ? glossary : undefined;
}

/** 同じ窓を、残件も変わらないまま取り直していないか（保留を続けても先へは進まない）。 */
const lastWindow = new Map<string, { from: number; remaining: number }>();
function stalled(paper: string, from: number, remaining: number) {
  const prev = lastWindow.get(paper);
  lastWindow.set(paper, { from, remaining });
  return prev !== undefined && prev.from === from && prev.remaining === remaining;
}

/** 区切りを変えたことで、どの文にも結び付かなくなった注釈を数える。 */
function detachedBetween(before: PaperDocument, after: PaperDocument) {
  const survivors = new Set(after.structure.sentences.map((s) => s.hash));
  const lost = new Set(before.structure.sentences.map((s) => s.hash).filter((h) => !survivors.has(h)));
  const skipped = before.annotations.skipped ?? {};
  let translations = 0;
  let skippedCount = 0;
  for (const h of lost) {
    if (before.annotations.translations[h]) translations++;
    if (skipped[h]) skippedCount++;
  }
  const notes = before.annotations.notes.filter((n) => lost.has(n.sentenceHash)).length;
  return { translations, notes, skipped: skippedCount };
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

const READ: Tool[] = [
  {
    name: "get_sentence_outline",
    config: {
      title: "対訳の概要",
      description:
        "1 文ずつの対訳（sentences.json）の概要を返します。解析方式・但し書き（caveat）・節構成・ページ数・用語集・翻訳の進捗が分かります。" +
        "全文を訳す作業はここから始めます。firstUntranslatedOrder が再開位置です。まだ解析していない論文では parse_sentences を呼ぶよう案内します。" +
          "boundaryEdits は区切りの直しの記録で、id を fix_sentence_boundary の undo_edit_id に渡すとその編集だけを取り消せます（detached は今の区切りに当たっていない記録）。",
      inputSchema: { paper: PAPER },
      annotations: { readOnlyHint: true },
    },
    handler: async ({ paper }) => {
      const document = await readyDocument(vault(), paper);
      const stats = progress(document);
      const first = document.structure.sentences.find((s) => needsTranslation(document, s));
      return compact({
        paper,
        title: document.title,
        parser: document.structure.parser,
        parserNote: document.structure.parserNote,
        caveat: parseCaveat(document),
        quality: document.structure.quality,
        pages: document.structure.pageSizes.length,
        // 訳は「異なり文」単位で付く。同じ文が複数回出る論文では sentences と食い違う
        sentences: stats.sentences,
        uniqueSentences: stats.uniqueSentences,
        translated: stats.translated,
        skipped: stats.skipped,
        remaining: stats.remaining,
        revisedByHuman: stats.revisedByHuman,
        firstUntranslatedOrder: first?.order ?? null,
        abstract: document.structure.abstract,
        sections: document.structure.sections.map((section) => {
          const inSection = document.structure.sentences.filter((s) => s.sectionId === section.id);
          return { id: section.id, title: section.title, firstOrder: inSection[0]?.order ?? null, sentences: inSection.length };
        }),
        glossary: document.annotations.glossary,
        // 区切りの直しの記録。fix_sentence_boundary の undo_edit_id に id を渡すと、その編集だけを取り消せる
        boundaryEdits: (document.annotations.sentenceEdits ?? []).map((e) => {
          const text = (e.sourceTexts ?? []).join(" / ").replace(/\s+/g, " ").trim();
          return {
            id: e.id,
            type: e.type,
            ...(e.detached ? { detached: true } : {}),
            createdAt: e.createdAt,
            ...(text ? { source: text.length > 80 ? `${text.slice(0, 80)}…` : text } : {}),
          };
        }),
      });
    },
  },
  {
    name: "get_sentences",
    config: {
      title: "文を取得",
      description:
        "1 文ずつの対訳を範囲指定で取得します。原文・既存の訳・メモ・訳さない理由が揃って返るので、訳の見直しや前後関係の確認に使います。" +
        "from は文の通し番号（order）で、節やページで絞っても意味は変わりません。メモは noteItems に ID 付きで入ります（remove_sentence_note に渡します）。",
      inputSchema: {
        paper: PAPER,
        from: z.number().int().min(0).default(0).describe("開始する文の通し番号（order）。0 始まり"),
        limit: z.number().int().min(1).max(200).default(40),
        section_id: z.string().optional().describe("指定するとその節だけに絞る（get_sentence_outline の sections の id）"),
        page: z.number().int().min(1).optional().describe("指定するとそのページだけに絞る"),
      },
      annotations: { readOnlyHint: true },
    },
    handler: async ({ paper, from = 0, limit = 40, section_id, page }) => {
      const document = await readyDocument(vault(), paper);
      let sentences = document.structure.sentences;
      if (section_id) {
        if (!document.structure.sections.some((s) => s.id === section_id)) {
          return compact({
            matched: 0,
            returned: 0,
            nextFrom: null,
            sentences: [],
            sections: document.structure.sections.map((s) => s.id),
            hint:
              `節 ${section_id} はこの論文にありません。` +
              (document.structure.sections.length === 0
                ? (parseCaveat(document) ?? "節が 1 つも検出されていません。")
                : "使える節は sections にあります。"),
          });
        }
        sentences = sentences.filter((s) => s.sectionId === section_id);
      }
      if (page !== undefined) sentences = sentences.filter((s) => s.page === page);
      // from は order。絞り込み後の添字ではない
      const slice = sentences.filter((s) => s.order >= from).slice(0, limit);
      const last = slice[slice.length - 1];
      const orders = sentences.map((s) => s.order);
      return compact({
        matched: sentences.length,
        returned: slice.length,
        nextFrom: last && sentences.some((s) => s.order > last.order) ? last.order + 1 : null,
        sentences: slice.map((s) => sentenceView(document, s)),
        // 0 件は「該当が無い」と「from が範囲の外」の 2 通りある
        hint:
          slice.length > 0
            ? undefined
            : sentences.length === 0
              ? "条件に合う文がありません。"
              : `from=${from} は範囲の外です（order は ${Math.min(...orders)}〜${Math.max(...orders)}）。`,
      });
    },
  },
  {
    name: "get_translation_batch",
    config: {
      title: "翻訳する範囲を取得",
      description:
        "全文翻訳の入口。指定位置以降の連続した文を [order, hash, 原文] の配列（window）で返し、そのうち訳すべきものの order を untranslated に列挙します。" +
        "文脈は window そのもの（重複が無い）なので、前後関係を見ながら訳せます。" +
        "終了条件は remainingUnique が 0 になること。nextUntranslatedFrom は次に見るべき位置で、末尾まで行くと先頭へ回り込みます。" +
        "訳す対象でない文は skip_sentences に渡してください（from を進めて飛ばすだけでは残り続けます）。",
      inputSchema: {
        paper: PAPER,
        from: z.number().int().min(0).default(0).describe("開始する文の通し番号（order）"),
        limit: z.number().int().min(1).max(MAX_BATCH).default(40).describe("返す文の総数（未訳・既訳の両方を含む）"),
        include_translations: z.boolean().default(false).describe("既訳の訳文も返す。既定は false（自分が書いた訳を読み返す必要は普通ない）"),
      },
      annotations: { readOnlyHint: true },
    },
    handler: async ({ paper, from = 0, limit = 40, include_translations = false }) => {
      const document = await readyDocument(vault(), paper);
      const all = document.structure.sentences;
      const window = all.filter((s) => s.order >= from).slice(0, limit);
      const { remainingUnique, left: remaining } = remainingOf(document);
      const noProgress = stalled(paper, from, remainingUnique);

      if (window.length === 0) {
        return compact({
          remainingUntranslated: remaining.length,
          remainingUnique,
          nextFrom: null,
          nextUntranslatedFrom: remaining[0]?.order ?? null,
          window: [],
          untranslated: [],
          hint:
            remaining.length === 0
              ? "未訳の文はありません。翻訳は完了しています。"
              : `order ${from} 以降に文がありません（この論文の order は 0〜${all.length - 1}）。` +
                `まだ ${remainingUnique} 文残っているので、nextUntranslatedFrom から呼び直してください。`,
        });
      }

      const last = window[window.length - 1]!;
      // 末尾まで来たら先頭へ回り込む。前へ進むだけだと、保留した文があるのに「完了」に見える
      const nextUntranslated = remaining.find((s) => s.order > last.order) ?? remaining[0];

      // 同じ本文は 1 回訳せば全出現に反映される。窓の中の重複は先に畳む
      const seen = new Map<string, number>();
      const untranslated: number[] = [];
      const duplicateOf: Record<number, number> = {};
      for (const s of window) {
        if (!needsTranslation(document, s)) continue;
        const head = seen.get(s.hash);
        if (head !== undefined) {
          duplicateOf[s.order] = head;
          continue;
        }
        seen.set(s.hash, s.order);
        untranslated.push(s.order);
      }
      const withNotes = window.filter((s) => document.annotations.notes.some((n) => n.sentenceHash === s.hash)).map((s) => s.order);
      const damaged = window.filter((s) => s.seam).map((s) => s.order);

      return compact({
        // 解析方式の注意は最初の呼び出しにだけ付ける
        caveat: from === 0 ? parseCaveat(document) : undefined,
        glossary: glossaryIfChanged(paper, document.annotations.glossary, from === 0),
        noProgress: noProgress ? "前回と同じ窓を、残件も変わらないまま取り直しています。訳すか skip_sentences に渡してください。" : undefined,
        remainingUntranslated: remaining.length,
        remainingUnique,
        nextFrom: all.some((s) => s.order > last.order) ? last.order + 1 : null,
        nextUntranslatedFrom: nextUntranslated?.order ?? null,
        // 既訳は [order, hash, 原文, 1]（訳文そのものは返さない）。訳語の統一は用語集が担う
        window: window.map((s) => {
          const t = document.annotations.translations[s.hash];
          if (!t) return [s.order, s.hash, s.text];
          return [s.order, s.hash, s.text, include_translations ? t.text : 1];
        }),
        untranslated,
        duplicateOf: Object.keys(duplicateOf).length > 0 ? duplicateOf : undefined,
        withNotes: withNotes.length > 0 ? withNotes : undefined,
        // メモの ID と本文（order ごと）。消すときは remove_sentence_note に id を渡す
        notes: withNotes.length > 0 ? Object.fromEntries(withNotes.map((o) => [o, notesOf(document, window.find((s) => s.order === o)!.hash)])) : undefined,
        damaged:
          damaged.length > 0
            ? {
                orders: damaged,
                warning:
                  "これらの文は、本文として取り出せなかった行を挟んで組み立てられています。記号や語が抜けているおそれがあるので、" +
                  '訳す前に get_sentences で seam を確かめ、自信が持てなければ add_sentence_note に理由を残すか skip_sentences に reason="unreadable" で回してください。',
              }
            : undefined,
      });
    },
  },
  {
    name: "search_sentences",
    config: {
      title: "対訳の中を探す",
      description:
        "1 本の論文の対訳から、原文・訳文・文のメモを横断して探します。ヒットには訳文とメモも入るので、訳語の揺れをこのツールだけで確かめられ、直したい文の hash もそのまま返ります。" +
        "参考文献・図表キャプションなど本文として扱わなかった行も isBody:false で返ります（訳の対象ではありません）。" +
        "PDF の生の本文から探すなら find_in_paper、読解ノート（note.md）を論文横断で探すなら search_notes を使います。",
      inputSchema: {
        paper: PAPER,
        query: z.string().min(1).describe("探す語句"),
        limit: z.number().int().min(1).max(200).default(30),
        from: z.number().int().min(0).default(0).describe("ヒットの何件目から返すか"),
      },
      annotations: { readOnlyHint: true },
    },
    handler: async ({ paper, query, limit = 30, from = 0 }) => {
      if (query.length > MAX_QUERY_CHARS) {
        throw new Error(
          `検索語が長すぎます（${query.length} 文字 / 上限 ${MAX_QUERY_CHARS} 文字）。探したい語・固有名詞・1 文だけを渡してください。`,
        );
      }
      const document = await readyDocument(vault(), paper);
      const all = searchDocument(document, query, Number.MAX_SAFE_INTEGER);
      const hits = all.slice(from, from + limit);
      const nonBody = hits.filter((h) => !h.isBody).length;
      return compact({
        total: all.length,
        nextFrom: from + hits.length < all.length ? from + hits.length : null,
        hits: hits.map((h) => ({
          order: h.isBody ? h.sentence.order : undefined,
          afterOrder: h.isBody ? undefined : h.afterOrder,
          hash: h.sentence.hash,
          page: h.sentence.page,
          source: h.sentence.text,
          where: h.where,
          translation: h.translation ?? undefined,
          notes: h.notes.length > 0 ? h.notes : undefined,
          noteItems: h.notes.length > 0 ? notesOf(document, h.sentence.hash) : undefined,
          isBody: h.isBody,
          nonBodyKind: h.nonBodyKind ?? undefined,
        })),
        hint:
          all.length === 0
            ? `「${query}」に一致する文はありませんでした。`
            : hits.length === 0
              ? `from=${from} は末尾を越えています（全 ${all.length} 件）。`
              : nonBody > 0
                ? `このうち ${nonBody} 件は本文として扱わなかった行（isBody:false）です。訳の対象ではありません。`
                : undefined,
      });
    },
  },
];

const WRITE: Tool[] = [
  {
    name: "parse_sentences",
    config: {
      title: "文に分ける（再解析）",
      description:
        "論文の PDF を 1 文ずつに分けて、対訳の土台（sentences.json）を作ります。取り込み直後は自動で始まりますが、まだ無い・失敗した・区切りがおかしいときに呼びます。" +
        "再解析しても訳・メモ・用語集・区切りの直しは本文の hash で結び直されるので基本的に消えません。ただし order と hash は変わるので、返ってきた firstUntranslatedOrder から取り直してください。" +
        "parser: auto（GROBID があれば使う）/ grobid / fallback（pdf.js の簡易解析）。",
      inputSchema: {
        paper: PAPER,
        parser: z.enum(["auto", "grobid", "fallback"]).default("auto"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    handler: async ({ paper, parser = "auto" }) => {
      const v = vault();
      await requirePaper(v, paper);
      const before = await sentencesState(v, paper);
      const running = parseSentences(v, paper, parser);
      // 長い論文の GROBID は時間がかかる。呼び出しが時間切れになる前に、途中経過を返す
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PARSE_WAIT_MS);
      });
      running.catch(() => undefined);
      const done = await Promise.race([running, timeout]);
      clearTimeout(timer);
      if (!done) {
        return compact({
          status: "parsing",
          hint: "解析はまだ続いています。しばらく待ってから get_sentence_outline を呼んで、終わったか確かめてください。",
        });
      }
      if (done.status !== "ready") return compact({ status: done.status, hint: stateMessage(paper, done) });
      const document = done.document;
      const { remainingUnique, left } = remainingOf(document);
      const kept =
        before.status === "ready"
          ? (() => {
              const hashes = new Set(document.structure.sentences.map((s) => s.hash));
              return Object.keys(before.document.annotations.translations).filter((h) => hashes.has(h)).length;
            })()
          : undefined;
      return compact({
        status: "ready",
        parser: document.structure.parser,
        caveat: parseCaveat(document),
        sentences: document.structure.sentences.length,
        remainingUnique,
        firstUntranslatedOrder: left[0]?.order ?? null,
        translationsRebound: kept,
        hint:
          before.status === "ready"
            ? "再解析しました。以前の order と hash は無効です。firstUntranslatedOrder から取り直してください。"
            : "文に分けました。get_sentence_outline で構成を確かめてから get_translation_batch で訳し始めてください。",
      });
    },
  },
  {
    name: "set_translations",
    config: {
      title: "訳を書き込む",
      description:
        '訳をまとめて書き込みます。1 件は {"sentenceHash": "…", "text": "日本語訳"}。訳の項目名は text です（translation ではありません。translation は update_glossary の方）。' +
        `1 回に渡せるのは ${MAX_BATCH} 件まで。結果は JSON で返ります。` +
        "skipped の code が revised_by_human なら対応不要（人が直した訳は上書きしない仕様）、unknown_hash なら hash が間違っているので取り直してください。" +
        "remainingUnique が 0 になったら全文の翻訳は終わりです。",
      inputSchema: {
        paper: PAPER,
        translations: z
          .array(
            z.object({
              sentenceHash: z
                .string({ required_error: "文の指定は sentenceHash という項目名で送ってください（get_translation_batch の window が返した hash）。" })
                .describe("get_translation_batch の window が返した hash"),
              // 空の訳を通すと「訳し終わった」扱いになって二度と出てこない
              text: z
                .string({
                  required_error:
                    '訳の項目名は text です（translation ではありません）。例: {"sentenceHash": "…", "text": "日本語訳"}。',
                  invalid_type_error: "text は文字列で渡してください。",
                })
                .trim()
                .min(1, "訳が空です。訳せない文は skip_sentences に渡してください。")
                .describe("日本語訳（項目名は text。空にはできない）"),
            }),
          )
          .min(1)
          .max(MAX_BATCH),
      },
      annotations: { readOnlyHint: false },
    },
    handler: async ({ paper, translations }) => {
      const v = vault();
      const before = await readyDocument(v, paper);
      const known = new Set(before.structure.sentences.map((s) => s.hash));
      // 同じ hash が重なっていたら最後の訳を採る
      const byHash = new Map<string, string>();
      let duplicates = 0;
      for (const t of translations as { sentenceHash: string; text: string }[]) {
        if (byHash.has(t.sentenceHash)) duplicates++;
        byHash.set(t.sentenceHash, t.text.trim());
      }
      const skipped: { sentenceHash: string; code: "unknown_hash" | "revised_by_human"; reason: string }[] = [];
      const items: { hash: string; text: string }[] = [];
      for (const [hash, text] of byHash) {
        if (!known.has(hash)) skipped.push({ sentenceHash: hash, code: "unknown_hash", reason: "この論文に該当する文がありません" });
        else if (before.annotations.translations[hash]?.revisedByHuman) {
          skipped.push({ sentenceHash: hash, code: "revised_by_human", reason: "人手修正済みのため上書きしません" });
        } else items.push({ hash, text });
      }
      let after = before;
      let applied = 0;
      if (items.length > 0) {
        const r = await setTranslations(v, paper, items, "claude");
        after = r.document;
        applied = r.applied;
        // 読んでから書くまでの間に再解析が挟まると、hash が消えていることがある
        for (const hash of r.unknown) {
          if (!skipped.some((s) => s.sentenceHash === hash)) {
            skipped.push({ sentenceHash: hash, code: "unknown_hash", reason: "この論文に該当する文がありません" });
          }
        }
      }
      const written = new Set(items.map((i) => i.hash).filter((h) => !skipped.some((s) => s.sentenceHash === h)));
      const overwritten = [...written].filter((h) => before.annotations.translations[h]).length;
      const sentencesAffected = after.structure.sentences.filter((s) => written.has(s.hash)).length;
      const { remainingUnique, left } = remainingOf(after);
      const unknownCount = skipped.filter((s) => s.code === "unknown_hash").length;
      const hints: string[] = [];
      if (unknownCount > 0) hints.push(`${unknownCount} 件の hash がこの論文にありません。get_translation_batch を呼び直して hash を取り直してください。`);
      if (duplicates > 0) hints.push(`同じ hash が ${duplicates} 件重複していたので、最後の訳を採用しました。`);
      if (sentencesAffected > written.size) hints.push(`同じ本文が複数回現れるため、${written.size} 件の訳が ${sentencesAffected} 箇所に反映されました。`);
      if (overwritten > 0) hints.push(`${overwritten} 件は既にあった訳を置き換えました。`);
      return compact({
        applied,
        overwritten,
        sentencesAffected,
        remainingUnique,
        nextUntranslatedFrom: left[0]?.order ?? null,
        skipped,
        hint: hints.length > 0 ? hints.join(" ") : remainingUnique === 0 ? "未訳の文はもうありません。全文の翻訳は完了です。" : undefined,
      });
    },
  },
  {
    name: "add_sentence_note",
    config: {
      title: "文にメモを残す",
      description:
        "対訳の 1 文にメモを付けます。訳語の選択理由、原文の曖昧さ、原文が壊れている可能性など、訳文に押し込めない判断を残す場所です。存在しない hash は断ります。" +
        "論文全体についての考察は読解ノートの記録欄（set_fields）に、本文の文にマーカーを引くなら add_highlight を使います。",
      inputSchema: {
        paper: PAPER,
        sentence_hash: z.string().describe("メモを付ける文の hash"),
        body: z.string().min(1).describe("メモの本文"),
      },
      annotations: { readOnlyHint: false },
    },
    handler: async ({ paper, sentence_hash, body }) => {
      const v = vault();
      const before = await readyDocument(v, paper);
      if (!before.structure.sentences.some((s) => s.hash === sentence_hash)) {
        throw new Error(`hash ${sentence_hash} の文はこの論文にありません。get_sentences か search_sentences で hash を取り直してください。`);
      }
      const after = await addSentenceNote(v, paper, sentence_hash, body);
      const ids = new Set(before.annotations.notes.map((n) => n.id));
      const note = after.annotations.notes.find((n) => !ids.has(n.id));
      return compact({ applied: true, noteId: note?.id ?? null });
    },
  },
  {
    name: "update_glossary",
    config: {
      title: "訳語の対応表を更新",
      description:
        "この論文の訳語の対応表（用語集）を更新します。既定は追記で、既存の語は消しません。mode に replace を渡したときだけ全置換になります。1 語だけ消すなら remove_glossary_terms を使います。" +
        "以後の翻訳ではここに載っている訳語を優先してください。既存の訳文は自動では書き換わらないので、必要なら search_sentences で探して set_translations で直します。" +
        "用語の意味・説明をノートに残すのは add_term（Obsidian でリンクされる用語集）で、こちらは訳語の統一のためのものです。",
      inputSchema: {
        paper: PAPER,
        entries: z
          .array(
            z.object({
              term: z.string().min(1).describe("原語"),
              translation: z.string().min(1).describe("採用する訳語"),
              note: z.string().optional().describe("なぜその訳にしたか"),
            }),
          )
          .min(1, "entries が空です。用語集を空にしたい場合も、意図が読めないので受け付けません。")
          .max(500),
        mode: z.enum(["append", "replace"]).default("append").describe("append は追記（既定）。replace は既存の用語集を全部消して置き換える"),
      },
      annotations: { readOnlyHint: false },
    },
    handler: async ({ paper, entries, mode = "append" }) => {
      const v = vault();
      const before = await readyDocument(v, paper);
      const list = entries as { term: string; translation: string; note?: string }[];
      const key = (t: string) => t.toLowerCase();
      const existing = new Map(before.annotations.glossary.map((g) => [key(g.term), g]));
      let after = before;
      if (mode === "replace") {
        const keep = new Set(list.map((e) => key(e.term)));
        for (const g of before.annotations.glossary) if (!keep.has(key(g.term))) after = await removeGlossary(v, paper, g.term);
      }
      let added = 0;
      let updated = 0;
      for (const e of list) {
        const prev = existing.get(key(e.term));
        if (!prev) added++;
        else if (prev.translation !== e.translation || (prev.note ?? null) !== (e.note ?? null)) updated++;
        after = await upsertGlossary(v, paper, { term: e.term, translation: e.translation, note: e.note ?? null });
      }
      const total = after.annotations.glossary.length;
      return compact({
        added,
        updated,
        total,
        hint:
          mode === "replace"
            ? `用語集を ${total} 件で置き換えました（既存の内容は消えました）。`
            : `用語集を更新しました（新規 ${added} / 変更 ${updated} / 合計 ${total} 件）。`,
      });
    },
  },
  {
    name: "remove_glossary_terms",
    config: {
      title: "訳語の対応表から消す",
      description:
        "訳語の対応表（用語集）から、指定した原語の項目だけを消します（大文字と小文字は区別しません）。ほかの項目は残ります。" +
        "全体を作り直すなら update_glossary の mode=replace を使います。既存の訳文は変わりません。",
      inputSchema: {
        paper: PAPER,
        terms: z.array(z.string().min(1)).min(1).max(500).describe("消す原語（get_sentence_outline の glossary の term）"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    handler: async ({ paper, terms }) => {
      const v = vault();
      const before = await readyDocument(v, paper);
      const have = new Set(before.annotations.glossary.map((g) => g.term.toLowerCase()));
      const list = [...new Set((terms as string[]).map((t) => t.trim()).filter(Boolean))];
      const removed = list.filter((t) => have.has(t.toLowerCase()));
      const unknown = list.filter((t) => !have.has(t.toLowerCase()));
      let after = before;
      for (const t of removed) after = await removeGlossary(v, paper, t);
      return compact({
        removed,
        unknownTerms: unknown,
        total: after.annotations.glossary.length,
        hint: unknown.length > 0 ? `${unknown.length} 件は用語集にありませんでした。get_sentence_outline の glossary で原語を確かめてください。` : undefined,
      });
    },
  },
  {
    name: "remove_sentence_note",
    config: {
      title: "文のメモを消す",
      description:
        "add_sentence_note で付けた文のメモを 1 件消します。note_id は get_sentences・search_sentences の noteItems、get_translation_batch の notes にある id です。",
      inputSchema: { paper: PAPER, note_id: z.string().min(1).describe("メモの ID") },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    handler: async ({ paper, note_id }) => {
      const v = vault();
      const before = await readyDocument(v, paper);
      const note = before.annotations.notes.find((n) => n.id === note_id);
      if (!note) throw new Error(`メモが見つかりません: ${note_id}。get_sentences の noteItems で id を確かめてください。`);
      await removeSentenceNote(v, paper, note_id);
      return compact({ removed: note_id, sentenceHash: note.sentenceHash, body: note.body });
    },
  },
  {
    name: "clear_translations",
    config: {
      title: "訳を消す",
      description:
        "文の訳を消して未訳に戻します。訳し直す前や、訳の付いた文を skip_sentences で「訳さない」にしたいときに使います。" +
        "人が直した訳（revisedByHuman）は、include_human=true を渡さない限り消しません（keptHuman に載って返ります）。利用者に確かめてから true にしてください。",
      inputSchema: {
        paper: PAPER,
        sentence_hashes: z.array(z.string()).min(1).max(500).describe("訳を消す文の hash"),
        include_human: z.boolean().default(false).describe("true にすると、人が直した訳も消す"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    handler: async ({ paper, sentence_hashes, include_human = false }) => {
      const v = vault();
      const before = await readyDocument(v, paper);
      const hashes = [...new Set(sentence_hashes as string[])];
      const known = new Set(before.structure.sentences.map((s) => s.hash));
      const unknown = hashes.filter((h) => !known.has(h));
      const untranslated = hashes.filter((h) => known.has(h) && !before.annotations.translations[h]);
      const targets = hashes.filter((h) => known.has(h) && before.annotations.translations[h]);
      const r = targets.length > 0 ? await clearTranslations(v, paper, targets, !include_human) : { document: before, cleared: [], keptHuman: [] };
      const stats = progress(r.document);
      const hints: string[] = [];
      if (r.keptHuman.length > 0) hints.push(`${r.keptHuman.length} 件は人が直した訳なので消していません（消すなら利用者に確かめてから include_human=true）。`);
      if (unknown.length > 0) hints.push(`${unknown.length} 件の hash がこの論文にありません。get_sentences で取り直してください。`);
      return compact({
        cleared: r.cleared.length,
        keptHuman: r.keptHuman,
        unknownHashes: unknown,
        untranslated,
        translated: stats.translated,
        remainingUnique: remainingOf(r.document).remainingUnique,
        hint: hints.length > 0 ? hints.join(" ") : undefined,
      });
    },
  },
  {
    name: "skip_sentences",
    config: {
      title: "訳さないと記録する",
      description:
        "「この文は訳す対象ではない」と記録します。参考文献の断片・ページ番号・数式・柱など、本文に混ざったものに使います。" +
        "記録した文は未訳の集計から外れるので、これを使わずに飛ばすだけだと全文の翻訳がいつまでも終わりません。undo=true で取り消せます。",
      inputSchema: {
        paper: PAPER,
        sentence_hashes: z.array(z.string()).min(1).max(500),
        reason: z
          .enum(["reference", "figure", "table", "equation", "header", "footer", "unreadable", "other"])
          .default("other")
          .describe("訳さない理由。unreadable は「解析が崩れていて文として読めない」（再解析で直ったときに拾い直せるよう分けてある）"),
        undo: z.boolean().default(false).describe("true にすると「訳さない」を取り消す"),
      },
      annotations: { readOnlyHint: false },
    },
    handler: async ({ paper, sentence_hashes, reason = "other", undo = false }) => {
      const v = vault();
      const before = await readyDocument(v, paper);
      const hashes = [...new Set(sentence_hashes as string[])];
      if (undo) {
        const was = before.annotations.skipped ?? {};
        const restored = hashes.filter((h) => was[h]).length;
        const after = restored > 0 ? await unskipSentences(v, paper, hashes) : before;
        // 片方の分岐だけ形が違うと、片方を覚えた呼び出し側がもう片方で落ちる
        return compact({ skipped: 0, restored, unknownHashes: [], alreadyTranslated: [], remainingUnique: remainingOf(after).remainingUnique });
      }
      const known = new Set(before.structure.sentences.map((s) => s.hash));
      const unknown = hashes.filter((h) => !known.has(h));
      // 既に訳がある文は記録しない（未訳の集計が減らないので「対象外にした」が嘘になる）
      const alreadyTranslated = hashes.filter((h) => known.has(h) && before.annotations.translations[h]);
      const already = before.annotations.skipped ?? {};
      const targets = hashes.filter((h) => known.has(h) && !before.annotations.translations[h] && !already[h]);
      const after = targets.length > 0 ? await skipSentences(v, paper, targets, reason) : before;
      const hints: string[] = [];
      if (unknown.length > 0) hints.push(`${unknown.length} 件の hash がこの論文にありません。`);
      if (alreadyTranslated.length > 0) {
        hints.push(`${alreadyTranslated.length} 件は既に訳が付いているので対象外にしませんでした（外したいなら、clear_translations で訳を消してから記録してください）。`);
      }
      return compact({
        skipped: targets.length,
        restored: 0,
        unknownHashes: unknown,
        alreadyTranslated,
        remainingUnique: remainingOf(after).remainingUnique,
        hint: hints.length > 0 ? hints.join(" ") : undefined,
      });
    },
  },
  {
    name: "fix_sentence_boundary",
    config: {
      title: "文の区切りを直す",
      description:
        "文の切れ目がおかしいときに直します。merge は連続する 2 文以上を 1 文にまとめ、split は 1 文を文字位置で割り、drop は 1 文を本文から取り除いて「訳さないもの」へ移します（消えずに残ります）。" +
        "本文 1 文の真ん中に図の文字や表の行が割り込んでいるときは、split で 3 つに割り、割り込みを drop し、前後を merge すると 1 文に戻せます。" +
        "訳が「前半だけ」「2 文ぶん」になる原因はほぼここなので、訳す前に直す方が手戻りが少なくなります。" +
        "直すと文の hash が変わります（resultHashes が新しい hash）。直した内容は記録され、再解析しても流し直されます。action=\"undo\" で取り消せます（特定の編集だけなら undo_edit_id も指定）。",
      inputSchema: {
        paper: PAPER,
        action: z.enum(["merge", "split", "drop", "undo"]),
        sentence_hashes: z
          .array(z.string())
          .max(64)
          .default([])
          .describe("merge では結合する文の hash を本文の順に 2 件以上、split と drop では対象 1 件"),
        offsets: z
          .array(z.number().int().positive())
          .max(64)
          .default([])
          .describe("split のときの分割位置。原文テキストの先頭からの文字数で、切りたい文字の直前を指す"),
        undo_edit_id: z.string().optional().describe("undo のとき、特定の編集だけ取り消したい場合に指定"),
      },
      annotations: { readOnlyHint: false },
    },
    handler: async ({ paper, action, sentence_hashes = [], offsets = [], undo_edit_id }) => {
      const v = vault();
      const before = await readyDocument(v, paper);
      const edits = before.annotations.sentenceEdits ?? [];
      if (action === "undo") {
        // 外れている（detached）記録は今の構造に当たっていないので、「直前の編集」には数えない
        const target = undo_edit_id ?? [...edits].reverse().find((e) => !e.detached)?.id;
        if (!target) return compact({ applied: false, hint: "取り消せる区切りの変更がありません。" });
        try {
          await undoSentenceEdit(v, paper, target);
        } catch (e) {
          return compact({ applied: false, hint: `取り消せませんでした: ${errorMessage(e)}` });
        }
        return compact({ applied: true, undoneEditId: target, hint: "区切りの変更を取り消しました。hash が変わったので、窓を取り直してください。" });
      }
      const hashes = sentence_hashes as string[];
      if (action === "merge" && hashes.length < 2) {
        return compact({ applied: false, hint: "merge には本文の順に並んだ 2 件以上の sentence_hashes が要ります。" });
      }
      if (action === "split" && (hashes.length !== 1 || offsets.length === 0)) {
        return compact({ applied: false, hint: "split には sentence_hashes を 1 件と、offsets を 1 件以上指定してください。" });
      }
      if (action === "drop" && hashes.length !== 1) {
        return compact({ applied: false, hint: "drop には取り除く文の sentence_hashes を 1 件だけ指定してください。" });
      }
      let after: PaperDocument;
      try {
        after = await editSentenceBoundary(v, paper, { type: action, hashes, ...(action === "split" ? { offsets } : {}) });
      } catch (e) {
        return compact({
          applied: false,
          reason: errorMessage(e),
          hint: "get_sentences で今の区切りと hash を取り直してからやり直してください。",
        });
      }
      const ids = new Set(edits.map((e) => e.id));
      const editId = (after.annotations.sentenceEdits ?? []).find((e) => !ids.has(e.id))?.id ?? null;
      const beforeHashes = new Set(before.structure.sentences.map((s) => s.hash));
      const resultHashes = [...new Set(after.structure.sentences.map((s) => s.hash).filter((h) => !beforeHashes.has(h)))];
      const occurrences =
        action === "drop"
          ? before.structure.sentences.filter((s) => s.hash === hashes[0]).length
          : after.structure.sentences.filter((s) => s.hash === resultHashes[0]).length;
      const detached = detachedBetween(before, after);
      const lost = detached.translations + detached.notes + detached.skipped;
      return compact({
        applied: true,
        editId,
        occurrences,
        resultHashes,
        detached,
        hint:
          (action === "drop"
            ? "本文から取り除いて「訳さないもの」へ移しました（消えてはいません）。前後の文が隣り合ったので、1 文に戻すならこのまま merge できます。"
            : "区切りを変えた文は hash が変わりました。resultHashes が新しい文の hash です。") +
          (occurrences > 1 ? ` 同じ本文の ${occurrences} か所に適用されています。` : "") +
          (lost > 0
            ? ` 元の文に付いていた訳 ${detached.translations} 件・メモ ${detached.notes} 件は、どの文にも結び付かなくなりました（消えてはおらず、action="undo" で戻ります）。`
            : ""),
      });
    },
  },
];

export const SENTENCE_READ_TOOLS = READ;
export const SENTENCE_WRITE_TOOLS = WRITE;

/** 論文一覧に添える、対訳の進み具合。解析していない論文は status だけ返す。 */
export async function sentenceProgress(v: NodeVault, paper: string) {
  try {
    const s = await sentencesState(v, paper);
    if (s.status !== "ready") return { status: s.status };
    const p = progress(s.document);
    return { status: s.status, uniqueSentences: p.uniqueSentences, translated: p.translated, skipped: p.skipped, remaining: p.remaining };
  } catch {
    return { status: "none" as const };
  }
}

/** 全文翻訳の手順。read_paper / translate_paper のプロンプトと設定画面で使う。 */
export const TRANSLATION_WORKFLOW = [
  "get_sentence_outline で解析方式・但し書き（caveat）・節構成・用語集・進捗を確かめる。まだ解析していなければ parse_sentences を呼ぶ。firstUntranslatedOrder が再開位置。",
  "get_translation_batch を from=firstUntranslatedOrder（無ければ 0）で呼ぶ。window は [order, hash, 原文] の並びで、untranslated がそのうち訳すべき order（同じ本文は最初の 1 つだけ。残りは duplicateOf）。",
  '訳を set_translations でまとめて書き戻す。1 件は {"sentenceHash": "…", "text": "日本語訳"}（項目名は text）。1 回 120 件まで。',
  "返ってきた nextUntranslatedFrom を from にして 2 に戻る。終わりの判定は remainingUnique が 0 になったとき（nextUntranslatedFrom は末尾で先頭へ回り込む）。",
  "訳す対象でない文（参考文献の断片・ページ番号・数式だけの行）は skip_sentences に渡す。飛ばすだけでは残り続ける。",
  "1 文が途中で切れている・2 文が 1 つに入っていると気づいたら、訳で辻褄を合わせずに fix_sentence_boundary で直してから訳す（hash が変わる）。",
  "caveat・quality（読み順の崩れ・本文の欠落の疑い）と damaged の文は、最後に利用者へ報告する。",
] as const;

/** 訳し方の方針。 */
export const TRANSLATION_STYLE = [
  "1 文は 1 文として訳す。2 文に割ったり、隣の文と混ぜたりしない（画面で原文と 1 対 1 に並ぶため）。",
  "専門用語は用語集（glossary）に従う。用語集に無い重要語を決めたら update_glossary に足してから続ける。",
  "数式・記号・変数名・引用番号は原文のまま残す。",
  "原文が曖昧で複数に読める箇所は、片方を選んで訳し切ったうえで add_sentence_note に理由を書く。",
  "分からないところを、それらしい日本語で埋めない。分からないことは add_sentence_note に書く。",
  "人が直した訳（revisedByHuman）は上書きされない。set_translations の skipped に revised_by_human が出ても対応不要。",
] as const;
