import {
  addNote,
  adoptSentenceEdits,
  applyStructure,
  createDocument,
  deleteNote,
  describeSanitizeReport,
  editSentenceBoundary,
  LOGIXIV_VERSION,
  mergeAnnotations,
  parseExportHtml,
  progress,
  searchDocument,
  sentenceEditsOf,
  sentencesByHash,
  setTranslation,
  skipSentences,
  skippedOf,
  STRUCTURE_VERSION,
  unskipSentences,
  structureSummary,
  undoSentenceEdit,
  untranslatedSentences,
  updateNote,
  type GlossaryEntry,
  type PaperDocument,
} from '@logixiv/core';
import type { Config } from './config.ts';
import { DocumentMissingError, DocumentStore } from './store.ts';
import { EventBus } from './bus.ts';
import { GrobidUnavailableError, isGrobidAlive, processFulltext } from './grobid.ts';
import { parseWithPdfJs } from './fallback.ts';
import { exportDocumentHtml } from './exporter.ts';

/**
 * HTTP からも MCP からも同じ入口を通すためのアプリケーション層。
 * ここに副作用（保存と SSE 通知）をまとめ、ルーティングは薄く保つ。
 */

export class NotFoundError extends Error {}
export class BadRequestError extends Error {}
export class TooLargeError extends Error {}

export type ParserPreference = 'auto' | 'grobid' | 'fallback';

export interface IngestResult {
  document: PaperDocument;
  usedFallback: boolean;
  warning: string | null;
}

/** 書き出しは PDF 全体を base64 にしてメモリに載せるので、上限を切っておく。 */
const MAX_EXPORT_PDF_BYTES = 60 * 1024 * 1024;

/**
 * 解析の同時実行数。
 * ワーカースレッドに逃がしたとはいえ、1 本あたり数百 MB 使うので無制限にはしない。
 */
const MAX_CONCURRENT_PARSES = 2;

class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export class LogiXivApi {
  readonly store: DocumentStore;
  readonly bus: EventBus;
  readonly config: Config;
  private readonly parseSlots = new Semaphore(MAX_CONCURRENT_PARSES);

  constructor(config: Config, bus?: EventBus) {
    this.config = config;
    this.store = new DocumentStore(config);
    this.bus = bus ?? new EventBus();
  }

  async init(): Promise<void> {
    await this.store.init();
  }

  private async require(id: string): Promise<PaperDocument> {
    if (!(await this.store.exists(id))) throw new NotFoundError(`文書が見つかりません: ${id}`);
    return this.store.read(id);
  }

  /** store.update の「消えていた」を API 層の 404 に翻訳する。 */
  private async mutate(
    id: string,
    mutate: (document: PaperDocument) => PaperDocument | Promise<PaperDocument>,
  ): Promise<PaperDocument> {
    try {
      return await this.store.update(id, mutate);
    } catch (error) {
      if (error instanceof DocumentMissingError) throw new NotFoundError(error.message);
      throw error;
    }
  }

  async listDocuments(): Promise<
    {
      id: string;
      title: string;
      updatedAt: string;
      parser: string;
      total: number;
      translated: number;
      remaining: number;
    }[]
  > {
    const documents = await this.store.list();
    const rows = [];
    for (const document of documents) {
      // 1 件が壊れていても一覧全体を落とさない。
      try {
        const stats = progress(document);
        rows.push({
          id: document.id,
          title: document.title,
          updatedAt: document.updatedAt,
          parser: document.structure.parser,
          total: stats.uniqueSentences,
          translated: stats.translated,
          remaining: stats.remaining,
        });
      } catch {
        rows.push({
          id: document.id,
          title: `${document.id}（読み込めませんでした）`,
          updatedAt: document.updatedAt ?? new Date(0).toISOString(),
          parser: 'unknown',
          total: 0,
          translated: 0,
          remaining: 0,
        });
      }
    }
    // 読み出しそのものに失敗したものも行として出す（消せなくならないように）。
    for (const [id, reason] of this.store.unreadable) {
      rows.push({
        id,
        title: `${id}（開けません: ${reason.slice(0, 120)}）`,
        updatedAt: new Date(0).toISOString(),
        parser: 'unknown',
        total: 0,
        translated: 0,
        remaining: 0,
      });
    }
    return rows;
  }

  async getDocument(id: string): Promise<PaperDocument> {
    return this.require(id);
  }

  async getPdf(id: string): Promise<Buffer> {
    await this.require(id);
    return this.store.readPdf(id);
  }

  /** PDF を解析して新規文書にする。GROBID が落ちていたら黙って劣化させず、警告を返す。 */
  async ingestPdf(pdf: Uint8Array, fileName: string, preference: ParserPreference = 'auto'): Promise<IngestResult> {
    this.assertLooksLikePdf(pdf);

    const { structure, usedFallback, warning } = await this.parseStructure(pdf, fileName, preference);
    const document = createDocument({ structure, sourceFileName: fileName });

    try {
      await this.store.writePdf(document.id, pdf);
      await this.store.write(document);
    } catch (error) {
      // 書けなかったときに作りかけを残さない。document.json の無いディレクトリは
      // 一覧に出ないので、利用者からは見えも消せもしないゴミになる。
      await this.store.remove(document.id).catch(() => undefined);
      throw error;
    }
    this.bus.publish({ type: 'document.created', documentId: document.id });

    return { document, usedFallback, warning };
  }

  /** アップロードでも取り込みでも同じ入口検査を通す。 */
  private assertLooksLikePdf(pdf: Uint8Array): void {
    if (pdf.byteLength === 0) throw new BadRequestError('PDF が空です');
    if (!(pdf[0] === 0x25 && pdf[1] === 0x50 && pdf[2] === 0x44 && pdf[3] === 0x46)) {
      throw new BadRequestError('PDF ではないファイルのようです（先頭が %PDF ではありません）');
    }
  }

  private async parseStructure(pdf: Uint8Array, fileName: string, preference: ParserPreference) {
    return this.parseSlots.run(async () => {
      if (preference === 'fallback') {
        return { structure: await parseWithPdfJs(pdf), usedFallback: true, warning: null as string | null };
      }

      try {
        const { structure } = await processFulltext(pdf, fileName, { baseUrl: this.config.grobidUrl });
        if (structure.sentences.length === 0) {
          throw new GrobidUnavailableError('GROBID は本文の文を 1 つも返しませんでした');
        }
        return { structure, usedFallback: false, warning: null as string | null };
      } catch (error) {
        if (preference === 'grobid') throw error;
        const reason = error instanceof Error ? error.message : String(error);
        return {
          structure: await parseWithPdfJs(pdf),
          usedFallback: true,
          warning: `GROBID を使えなかったため簡易解析に切り替えました: ${reason}`,
        };
      }
    });
  }

  /**
   * 同じ PDF を解析し直して構造だけ差し替える。訳とメモはハッシュで再結合される。
   *
   * 解析は数十秒かかるので、その間に届いた翻訳・メモを消さないよう、
   * 構造の適用は必ず store.update の中（最新を読み直した後）で行う。
   */
  async reparse(
    id: string,
    preference: ParserPreference = 'auto',
  ): Promise<{
    document: PaperDocument;
    rebound: number;
    orphaned: number;
    editsReapplied: number;
    editsDropped: number;
    warning: string | null;
  }> {
    const existing = await this.require(id);
    const pdf = await this.store.readPdf(id);
    const { structure, warning } = await this.parseStructure(pdf, existing.sourceFileName, preference);

    let rebound = 0;
    let orphaned = 0;
    let editsReapplied = 0;
    let editsDropped = 0;
    const document = await this.mutate(id, (current) => {
      const result = applyStructure(current, structure);
      rebound = result.rebound;
      orphaned = result.orphaned;
      editsReapplied = result.editsReapplied;
      editsDropped = result.editsDropped;
      return result.document;
    });

    this.bus.publish({ type: 'document.updated', documentId: id, reason: 'reparse' });
    return { document, rebound, orphaned, editsReapplied, editsDropped, warning };
  }

  async setTranslation(
    id: string,
    sentenceHash: string,
    text: string,
    options: { source?: 'claude' | 'human'; revisedByHuman?: boolean } = {},
  ): Promise<{ applied: boolean; reason?: string }> {
    let outcome: { applied: boolean; reason?: string } = { applied: false };
    await this.mutate(id, (current) => {
      const result = setTranslation(current, sentenceHash, text, options);
      outcome = { applied: result.applied, reason: result.reason };
      return result.document;
    });
    if (outcome.applied) {
      this.bus.publish({ type: 'translation.updated', documentId: id, sentenceHash });
    }
    return outcome;
  }

  /** 訳をまとめて書き込む。Claude が 20 文ずつ返してくるので、1 文ずつ往復させない。 */
  async setTranslations(
    id: string,
    entries: { sentenceHash: string; text: string }[],
    options: { source?: 'claude' | 'human'; revisedByHuman?: boolean } = {},
  ): Promise<{
    applied: number;
    /** 新しく訳が付いた数。 */
    created: number;
    /** 既にあった訳を置き換えた数。 */
    overwritten: number;
    /** 訳が付いた文の延べ数。同じ文が複数回出る文書では applied より大きくなる。 */
    sentencesAffected: number;
    /** 同じ hash が 1 回の呼び出しに複数回入っていたもの。 */
    duplicates: string[];
    skipped: { sentenceHash: string; reason: string; code: SkipCode }[];
  }> {
    let applied = 0;
    let created = 0;
    let overwritten = 0;
    let sentencesAffected = 0;
    const duplicates: string[] = [];
    const skipped: { sentenceHash: string; reason: string; code: SkipCode }[] = [];

    // 同じ hash が 2 回来たら後勝ちで 1 件として扱う。訳は hash に付くので、
    // 重複を 2 件と数えると進捗が実際より進んで見える。
    const unique = new Map<string, string>();
    for (const entry of entries) {
      if (unique.has(entry.sentenceHash)) duplicates.push(entry.sentenceHash);
      unique.set(entry.sentenceHash, entry.text);
    }

    await this.mutate(id, (current) => {
      let working = current;
      const occurrences = new Map<string, number>();
      for (const sentence of current.structure.sentences) {
        occurrences.set(sentence.hash, (occurrences.get(sentence.hash) ?? 0) + 1);
      }
      for (const [sentenceHash, text] of unique) {
        const had = Boolean(working.annotations.translations[sentenceHash]);
        const result = setTranslation(working, sentenceHash, text, options);
        working = result.document;
        if (result.applied) {
          applied++;
          if (had) overwritten++;
          else created++;
          sentencesAffected += occurrences.get(sentenceHash) ?? 1;
        } else {
          const reason = result.reason ?? '不明';
          skipped.push({ sentenceHash, reason, code: skipCodeOf(reason) });
        }
      }
      return working;
    });
    if (applied > 0) this.bus.publish({ type: 'document.updated', documentId: id, reason: 'translations' });
    return { applied, created, overwritten, sentencesAffected, duplicates, skipped };
  }

  async addNote(
    id: string,
    sentenceHash: string,
    body: string,
    author: string | null = null,
  ): Promise<{ applied: boolean; id?: string; reason?: string }> {
    let outcome: { applied: boolean; id?: string; reason?: string } = { applied: false };
    await this.mutate(id, (current) => {
      const result = addNote(current, sentenceHash, body, author);
      outcome = result.applied
        ? { applied: true, id: result.note!.id }
        : { applied: false, reason: result.reason };
      return result.document;
    });
    if (outcome.applied) this.bus.publish({ type: 'note.changed', documentId: id, sentenceHash });
    return outcome;
  }

  async updateNote(id: string, noteId: string, body: string): Promise<boolean> {
    let applied = false;
    await this.mutate(id, (current) => {
      const result = updateNote(current, noteId, body);
      applied = result.applied;
      return result.document;
    });
    if (applied) this.bus.publish({ type: 'note.changed', documentId: id, sentenceHash: null });
    return applied;
  }

  async deleteNote(id: string, noteId: string): Promise<boolean> {
    let applied = false;
    await this.mutate(id, (current) => {
      const result = deleteNote(current, noteId);
      applied = result.applied;
      return result.document;
    });
    if (applied) this.bus.publish({ type: 'note.changed', documentId: id, sentenceHash: null });
    return applied;
  }

  async setGlossary(id: string, entries: GlossaryEntry[]): Promise<PaperDocument> {
    const document = await this.mutate(id, (current) => ({
      ...current,
      updatedAt: new Date().toISOString(),
      annotations: { ...current.annotations, glossary: entries },
    }));
    this.bus.publish({ type: 'document.updated', documentId: id, reason: 'glossary' });
    return document;
  }

  /** 用語集に追記する（既存の語は上書きせず残す）。 */
  async addGlossaryEntries(
    id: string,
    entries: GlossaryEntry[],
  ): Promise<{ added: number; updated: number; total: number }> {
    let added = 0;
    let updated = 0;
    let total = 0;
    await this.mutate(id, (current) => {
      const glossary = [...current.annotations.glossary];
      const seen = new Map(glossary.map((entry, index) => [entry.term.toLowerCase(), index]));
      for (const entry of entries) {
        const key = entry.term.toLowerCase();
        const at = seen.get(key);
        if (at === undefined) {
          seen.set(key, glossary.length);
          glossary.push(entry);
          added++;
        } else {
          // 既存語の訳語を差し替える。added に数えないので、別途 updated で報告する。
          if (glossary[at]!.translation !== entry.translation) updated++;
          glossary[at] = entry;
        }
      }
      total = glossary.length;
      return { ...current, updatedAt: new Date().toISOString(), annotations: { ...current.annotations, glossary } };
    });
    this.bus.publish({ type: 'document.updated', documentId: id, reason: 'glossary' });
    return { added, updated, total };
  }

  /** 「これは訳す対象ではない」と記録する。未訳の集計から外れる。 */
  async skipSentences(
    id: string,
    sentenceHashes: string[],
    reason: string,
  ): Promise<{ applied: number; unknown: string[]; alreadyTranslated: string[]; remaining: number }> {
    let applied = 0;
    let unknown: string[] = [];
    let alreadyTranslated: string[] = [];
    let remaining = 0;
    await this.mutate(id, (current) => {
      const result = skipSentences(current, sentenceHashes, reason);
      applied = result.applied;
      unknown = result.unknown;
      alreadyTranslated = result.alreadyTranslated;
      remaining = progress(result.document).remaining;
      return result.document;
    });
    if (applied > 0) this.bus.publish({ type: 'document.updated', documentId: id, reason: 'skip' });
    return { applied, unknown, alreadyTranslated, remaining };
  }

  async unskipSentences(id: string, sentenceHashes: string[]): Promise<{ applied: number; remaining: number }> {
    let applied = 0;
    let remaining = 0;
    await this.mutate(id, (current) => {
      const result = unskipSentences(current, sentenceHashes);
      applied = result.applied;
      remaining = progress(result.document).remaining;
      return result.document;
    });
    if (applied > 0) this.bus.publish({ type: 'document.updated', documentId: id, reason: 'skip' });
    return { applied, remaining };
  }

  /**
   * 文の区切りを直す（結合・分割）。
   *
   * 直した結果は構造に反映し、手順も残す。再解析のときに流し直されるので、
   * GROBID の誤分割を毎回手で直し続ける必要がなくなる。
   */
  async editSentenceBoundary(
    id: string,
    input: { type: 'merge' | 'split'; hashes: string[]; offsets?: number[] },
  ): Promise<SentenceEditOutcome> {
    let outcome: SentenceEditOutcome = {
      applied: false,
      occurrences: 0,
      resultHashes: [],
      detached: { translations: 0, notes: 0, skipped: 0 },
    };
    await this.mutate(id, (current) => {
      const result = editSentenceBoundary(current, input);
      outcome = result.applied
        ? {
            applied: true,
            occurrences: result.occurrences,
            editId: result.edit!.id,
            // 結合なら結合後の文、分割なら分割後の断片。画面が選択を追うのに使う。
            resultHashes: result.edit!.undo?.hashes ?? [],
            detached: result.detached,
          }
        : {
            applied: false,
            occurrences: 0,
            resultHashes: [],
            detached: { translations: 0, notes: 0, skipped: 0 },
            reason: result.reason,
          };
      return result.document;
    });
    if (outcome.applied) this.bus.publish({ type: 'document.updated', documentId: id, reason: 'sentence-edit' });
    return outcome;
  }

  /** 直前の（または指定した）区切り直しを取り消す。再解析は要らない。 */
  async undoSentenceEdit(id: string, editId?: string): Promise<{ applied: boolean; reason?: string }> {
    let outcome: { applied: boolean; reason?: string } = { applied: false };
    await this.mutate(id, (current) => {
      const result = undoSentenceEdit(current, editId);
      outcome = { applied: result.applied, reason: result.reason };
      return result.document;
    });
    if (outcome.applied) this.bus.publish({ type: 'document.updated', documentId: id, reason: 'sentence-edit' });
    return outcome;
  }

  async listSentenceEdits(id: string) {
    const document = await this.require(id);
    return sentenceEditsOf(document).map((edit) => ({
      id: edit.id,
      type: edit.type,
      hashes: edit.hashes,
      offsets: edit.offsets ?? [],
      createdAt: edit.createdAt,
    }));
  }

  /** 訳す必要がある最初の文の通し番号。再開の起点に使う。 */
  async firstUntranslatedOrder(id: string): Promise<number | null> {
    const document = await this.require(id);
    const skipped = skippedOf(document);
    const found = document.structure.sentences.find(
      (s) => !document.annotations.translations[s.hash] && !skipped[s.hash],
    );
    return found?.order ?? null;
  }

  async search(id: string, query: string, limit = 30, from = 0) {
    const document = await this.require(id);
    // 総数は打ち切らずに数える。以前は from+limit+1 までしか走査していなかったので、
    // total が limit に連動する（limit=5 なら 6、limit=200 なら 201）ただの上限値だった。
    // 走査は線形なので、全件見ても論文 1 本ぶんなら問題にならない。
    const all = searchDocument(document, query, Number.POSITIVE_INFINITY);
    const page = all.slice(from, from + limit);
    return {
      total: all.length,
      truncated: all.length > from + limit,
      hits: page.map((hit) => ({
        sentenceId: hit.sentence.id,
        sentenceHash: hit.sentence.hash,
        order: hit.sentence.order,
        page: hit.sentence.page,
        text: hit.sentence.text,
        translation: hit.translation,
        notes: hit.notes,
        where: hit.where,
      })),
    };
  }

  async sentencesByHash(id: string, hashes: string[]) {
    const document = await this.require(id);
    return sentencesByHash(document, hashes).map((sentence) => ({
      sentenceHash: sentence.hash,
      order: sentence.order,
      page: sentence.page,
      text: sentence.text,
      translation: document.annotations.translations[sentence.hash]?.text ?? null,
      revisedByHuman: document.annotations.translations[sentence.hash]?.revisedByHuman ?? false,
      notes: document.annotations.notes.filter((n) => n.sentenceHash === sentence.hash).map((n) => n.body),
    }));
  }

  async untranslated(id: string, limit = 20) {
    const document = await this.require(id);
    return untranslatedSentences(document, limit).map((sentence) => ({
      sentenceHash: sentence.hash,
      order: sentence.order,
      page: sentence.page,
      text: sentence.text,
    }));
  }

  async exportHtml(id: string): Promise<{ html: string; fileName: string }> {
    const document = await this.require(id);
    const size = await this.store.pdfSize(id);
    if (size > MAX_EXPORT_PDF_BYTES) {
      throw new TooLargeError(
        `PDF が大きすぎて 1 ファイルに書き出せません（${Math.round(size / 1024 / 1024)}MB / 上限 ${MAX_EXPORT_PDF_BYTES / 1024 / 1024}MB）`,
      );
    }
    const pdf = await this.store.readPdf(id);
    const html = await exportDocumentHtml(this.config, document, pdf);
    const safeTitle = document.title.replace(/[^\p{L}\p{N} ._-]/gu, '').trim() || document.id;
    return { html, fileName: `${safeTitle}.logixiv.html` };
  }

  /**
   * 書き出し HTML の取り込み。埋め込まれた JS は実行せず、JSON だけを取り出してマージする。
   * targetId を省略すると PDF ごと新しい文書として取り込む。
   *
   * 新規取り込みでも、core が検証して組み直した document だけを保存する。
   * 生の JSON をそのまま保存すると、`annotations: null` のような値がディスクに残り、
   * 一覧 API が恒久的に 500 になる（再起動しても直らない）。
   */
  async importHtml(
    html: string,
    targetId: string | null,
  ): Promise<{ documentId: string; report: unknown; note: string; warning: string | null }> {
    const parsed = parseExportHtml(html);
    const warning = describeSanitizeReport(parsed.sanitizeReport);

    if (targetId) {
      let report: unknown = null;
      let adoptedEdits = 0;
      let detachedByAdoption = { translations: 0, notes: 0 };
      await this.mutate(targetId, (current) => {
        // 相手が直した文の区切りを先に取り込む。順番が逆だと、まとめた文に付いた訳が
        // 「対応なし」として捨てられる（区切りが違うだけで hash が当たらないため）。
        const adopted = adoptSentenceEdits(current, parsed.annotations.sentenceEdits ?? []);
        adoptedEdits = adopted.adopted;
        detachedByAdoption = adopted.detached;
        const base = adopted.document;
        const hashes = new Set(base.structure.sentences.map((s) => s.hash));
        const merged = mergeAnnotations(base.annotations, parsed.annotations, hashes);
        report = merged.report;
        return { ...base, updatedAt: new Date().toISOString(), annotations: merged.annotations };
      });
      this.bus.publish({ type: 'document.updated', documentId: targetId, reason: 'import' });
      return {
        documentId: targetId,
        report: {
          ...(report as Record<string, number>),
          sentenceEditsAdopted: adoptedEdits,
          detachedTranslations: detachedByAdoption.translations,
          detachedNotes: detachedByAdoption.notes,
        },
        note: '既存の文書に注釈をマージしました',
        warning,
      };
    }

    if (!parsed.pdfBase64 || !parsed.document) {
      throw new BadRequestError('この書き出しには PDF か本文が含まれていないため、新規文書として取り込めません');
    }
    const document = parsed.document;
    // 取り込み経路もアップロードと同じ入口検査を通す。ここを素通しにすると、
    // 任意のバイト列が source.pdf として保存され、/pdf が application/pdf として配る。
    const pdf = Buffer.from(parsed.pdfBase64, 'base64');
    this.assertLooksLikePdf(pdf);
    // 新しい版で書かれたものは保存しない。保存できてしまうと、一覧に出ないのに
    // ディスクには在って、開くと 500 になる文書ができる。
    if (document.structure.version > STRUCTURE_VERSION) {
      throw new BadRequestError(
        `この書き出しは新しい版の LogiXiv で作られています（構造 v${document.structure.version} / ` +
          `このプログラムは v${STRUCTURE_VERSION} まで）。LogiXiv を更新してください。`,
      );
    }
    try {
      await this.store.writePdf(document.id, pdf);
      await this.store.write(document);
    } catch (error) {
      // 取り込みでも、書けなかったときに作りかけを残さない。
      await this.store.remove(document.id).catch(() => undefined);
      throw error;
    }
    this.bus.publish({ type: 'document.created', documentId: document.id });
    return { documentId: document.id, report: null, note: '新しい文書として取り込みました', warning };
  }

  async deleteDocument(id: string): Promise<void> {
    await this.require(id);
    await this.store.remove(id);
    this.bus.publish({ type: 'document.deleted', documentId: id });
  }

  async health(): Promise<{ ok: true; version: string; grobid: 'up' | 'down'; grobidUrl: string; dataDir: string }> {
    return {
      ok: true,
      version: LOGIXIV_VERSION,
      grobid: (await isGrobidAlive(this.config.grobidUrl)) ? 'up' : 'down',
      grobidUrl: this.config.grobidUrl,
      dataDir: this.config.dataDir,
    };
  }

  async summary(id: string): Promise<string> {
    const document = await this.require(id);
    const stats = progress(document);
    return `${document.title} — ${structureSummary(document.structure)} translated=${stats.translated}/${stats.uniqueSentences} human=${stats.revisedByHuman} skipped=${stats.skipped}`;
  }
}

/**
 * 書き込みを断った理由の機械可読なコード。
 * 「人手修正済み（＝放置してよい）」と「該当する文が無い（＝hash を取り直すべき）」は
 * 必要な対応が正反対なので、文字列の比較で分岐させない。
 */
export interface SentenceEditOutcome {
  applied: boolean;
  occurrences: number;
  editId?: string;
  /** 編集の結果できた文の hash。 */
  resultHashes: string[];
  /** どの文にも結び付かなくなった注釈の数（消してはいない）。 */
  detached: { translations: number; notes: number; skipped: number };
  reason?: string;
}

export type SkipCode = 'revised_by_human' | 'unknown_hash' | 'other';

function skipCodeOf(reason: string): SkipCode {
  if (reason.includes('人手修正済み')) return 'revised_by_human';
  if (reason.includes('該当する文がありません')) return 'unknown_hash';
  return 'other';
}
