import {
  addNote,
  applyStructure,
  createDocument,
  deleteNote,
  mergeAnnotations,
  parseExportHtml,
  progress,
  searchDocument,
  setTranslation,
  structureSummary,
  untranslatedSentences,
  updateNote,
  type GlossaryEntry,
  type PaperDocument,
} from '@logixiv/core';
import type { Config } from './config.ts';
import { DocumentStore } from './store.ts';
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

export type ParserPreference = 'auto' | 'grobid' | 'fallback';

export interface IngestResult {
  document: PaperDocument;
  usedFallback: boolean;
  warning: string | null;
}

export class LogiXivApi {
  readonly store: DocumentStore;
  readonly bus: EventBus;

  readonly config: Config;

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

  async listDocuments(): Promise<
    { id: string; title: string; updatedAt: string; parser: string; total: number; translated: number }[]
  > {
    const documents = await this.store.list();
    return documents.map((document) => {
      const stats = progress(document);
      return {
        id: document.id,
        title: document.title,
        updatedAt: document.updatedAt,
        parser: document.structure.parser,
        total: stats.total,
        translated: stats.translated,
      };
    });
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
    if (pdf.byteLength === 0) throw new BadRequestError('PDF が空です');
    if (!(pdf[0] === 0x25 && pdf[1] === 0x50 && pdf[2] === 0x44 && pdf[3] === 0x46)) {
      throw new BadRequestError('PDF ではないファイルのようです（先頭が %PDF ではありません）');
    }

    const { structure, usedFallback, warning } = await this.parseStructure(pdf, fileName, preference);
    const document = createDocument({ structure, sourceFileName: fileName });

    await this.store.writePdf(document.id, pdf);
    await this.store.write(document);
    this.bus.publish({ type: 'document.created', documentId: document.id });

    return { document, usedFallback, warning };
  }

  private async parseStructure(pdf: Uint8Array, fileName: string, preference: ParserPreference) {
    if (preference === 'fallback') {
      return { structure: await parseWithPdfJs(pdf), usedFallback: true, warning: null as string | null };
    }

    try {
      const { structure } = await processFulltext(pdf, fileName, { baseUrl: this.config.grobidUrl });
      if (structure.sentences.length === 0) {
        throw new GrobidUnavailableError('GROBID は文を 1 つも返しませんでした');
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
  }

  /** 同じ PDF を解析し直して構造だけ差し替える。訳とメモはハッシュで再結合される。 */
  async reparse(id: string, preference: ParserPreference = 'auto'): Promise<{ document: PaperDocument; rebound: number; orphaned: number; warning: string | null }> {
    const existing = await this.require(id);
    const pdf = await this.store.readPdf(id);
    const { structure, warning } = await this.parseStructure(pdf, existing.sourceFileName, preference);

    const result = applyStructure(existing, structure);
    await this.store.write(result.document);
    this.bus.publish({ type: 'document.updated', documentId: id, reason: 'reparse' });
    return { ...result, warning };
  }

  async setTranslation(
    id: string,
    sentenceHash: string,
    text: string,
    options: { source?: 'claude' | 'human'; revisedByHuman?: boolean } = {},
  ): Promise<{ applied: boolean; reason?: string }> {
    await this.require(id);
    let outcome: { applied: boolean; reason?: string } = { applied: false };
    await this.store.update(id, (current) => {
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
  ): Promise<{ applied: number; skipped: { sentenceHash: string; reason: string }[] }> {
    await this.require(id);
    let applied = 0;
    const skipped: { sentenceHash: string; reason: string }[] = [];
    await this.store.update(id, (current) => {
      let working = current;
      for (const entry of entries) {
        const result = setTranslation(working, entry.sentenceHash, entry.text, options);
        working = result.document;
        if (result.applied) applied++;
        else skipped.push({ sentenceHash: entry.sentenceHash, reason: result.reason ?? '不明' });
      }
      return working;
    });
    if (applied > 0) this.bus.publish({ type: 'document.updated', documentId: id, reason: 'translations' });
    return { applied, skipped };
  }

  async addNote(id: string, sentenceHash: string, body: string, author: string | null = null) {
    await this.require(id);
    let created: { id: string } | null = null;
    await this.store.update(id, (current) => {
      const result = addNote(current, sentenceHash, body, author);
      created = { id: result.note.id };
      return result.document;
    });
    this.bus.publish({ type: 'note.changed', documentId: id, sentenceHash });
    return created;
  }

  async updateNote(id: string, noteId: string, body: string): Promise<boolean> {
    await this.require(id);
    let applied = false;
    await this.store.update(id, (current) => {
      const result = updateNote(current, noteId, body);
      applied = result.applied;
      return result.document;
    });
    if (applied) this.bus.publish({ type: 'note.changed', documentId: id, sentenceHash: null });
    return applied;
  }

  async deleteNote(id: string, noteId: string): Promise<boolean> {
    await this.require(id);
    let applied = false;
    await this.store.update(id, (current) => {
      const result = deleteNote(current, noteId);
      applied = result.applied;
      return result.document;
    });
    if (applied) this.bus.publish({ type: 'note.changed', documentId: id, sentenceHash: null });
    return applied;
  }

  async setGlossary(id: string, entries: GlossaryEntry[]): Promise<PaperDocument> {
    await this.require(id);
    const document = await this.store.update(id, (current) => ({
      ...current,
      updatedAt: new Date().toISOString(),
      annotations: { ...current.annotations, glossary: entries },
    }));
    this.bus.publish({ type: 'document.updated', documentId: id, reason: 'glossary' });
    return document;
  }

  async search(id: string, query: string, limit = 30) {
    const document = await this.require(id);
    return searchDocument(document, query, limit).map((hit) => ({
      sentenceId: hit.sentence.id,
      sentenceHash: hit.sentence.hash,
      page: hit.sentence.page,
      text: hit.sentence.text,
      where: hit.where,
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
    const pdf = await this.store.readPdf(id);
    const html = await exportDocumentHtml(this.config, document, pdf);
    const safeTitle = document.title.replace(/[^\p{L}\p{N} ._-]/gu, '').trim() || document.id;
    return { html, fileName: `${safeTitle}.logixiv.html` };
  }

  /**
   * 書き出し HTML の取り込み。埋め込まれた JS は実行せず、JSON だけを取り出してマージする。
   * targetId を省略すると PDF ごと新しい文書として取り込む。
   */
  async importHtml(html: string, targetId: string | null): Promise<{ documentId: string; report: unknown; note: string }> {
    const parsed = parseExportHtml(html);

    if (targetId) {
      const target = await this.require(targetId);
      const hashes = new Set(target.structure.sentences.map((s) => s.hash));
      const { annotations, report } = mergeAnnotations(target.annotations, parsed.annotations, hashes);
      await this.store.update(targetId, (current) => ({
        ...current,
        updatedAt: new Date().toISOString(),
        annotations,
      }));
      this.bus.publish({ type: 'document.updated', documentId: targetId, reason: 'import' });
      return { documentId: targetId, report, note: '既存の文書に注釈をマージしました' };
    }

    if (!parsed.pdfBase64 || !parsed.raw) {
      throw new BadRequestError('この書き出しには PDF が含まれていないため、新規文書として取り込めません');
    }
    const document: PaperDocument = {
      ...parsed.raw.document,
      id: createDocument({ structure: parsed.raw.document.structure, sourceFileName: 'imported.pdf' }).id,
      updatedAt: new Date().toISOString(),
    };
    await this.store.writePdf(document.id, Buffer.from(parsed.pdfBase64, 'base64'));
    await this.store.write(document);
    this.bus.publish({ type: 'document.created', documentId: document.id });
    return { documentId: document.id, report: null, note: '新しい文書として取り込みました' };
  }

  async deleteDocument(id: string): Promise<void> {
    await this.require(id);
    await this.store.remove(id);
    this.bus.publish({ type: 'document.deleted', documentId: id });
  }

  async health(): Promise<{ ok: true; version: string; grobid: 'up' | 'down'; grobidUrl: string; dataDir: string }> {
    return {
      ok: true,
      version: '0.1.0',
      grobid: (await isGrobidAlive(this.config.grobidUrl)) ? 'up' : 'down',
      grobidUrl: this.config.grobidUrl,
      dataDir: this.config.dataDir,
    };
  }

  async summary(id: string): Promise<string> {
    const document = await this.require(id);
    const stats = progress(document);
    return `${document.title} — ${structureSummary(document.structure)} translated=${stats.translated}/${stats.total} human=${stats.revisedByHuman}`;
  }
}
