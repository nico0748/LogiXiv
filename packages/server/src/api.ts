import {
  addNote,
  adoptSentenceEdits,
  applyStructure,
  createDocument,
  deleteNote,
  deleteTranslation,
  describeSanitizeReport,
  editSentenceBoundary,
  PAPERLENS_VERSION,
  mergeAnnotations,
  overlapRatio,
  parseExportHtml,
  applyTranslationEdits,
  progress,
  removeGlossaryEntry,
  replaceInTranslations,
  sanitizeTitle,
  upsertGlossaryEntry,
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
} from '@paperlens/core';
import type { Config } from './config.ts';
import { DocumentMissingError, DocumentStore } from './store.ts';
import { EventBus } from './bus.ts';
import { GrobidUnavailableError, isGrobidAlive, processFulltext } from './grobid.ts';
import { parseWithPdfJs } from './fallback.ts';
import { exportDocumentHtml } from './exporter.ts';
import { missingStoredPdf, pdfIngestAbandoned, PdfUnreadableError } from './pdf-failure.ts';

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
  /** 取り込んだ時点で分かる「この文書は書き出せるか」。詳細は Exportability を見ること。 */
  exportability: Exportability;
}

/**
 * 一覧 1 行ぶん。
 *
 * `unreadable` は「ディスクには在るが document.json を読めない」行。
 * 見えも消せもしない文書を作らないために行として出しているので、
 * **画面はこの行から削除できなければならない**（DELETE は読まずに消す）。
 */
export interface DocumentRow {
  id: string;
  title: string;
  updatedAt: string;
  parser: string;
  total: number;
  translated: number;
  /**
   * 「訳さない」と決めた文の数。
   *
   * これが無いと、82 訳 + 2「訳さない」で片付いた文書が一覧では「82 / 84 文」
   * としか出ず、進捗バーも最後まで埋まらない。読み手には「2 文残っている」
   * としか読めない。
   */
  skipped: number;
  remaining: number;
  unreadable: boolean;
  /** 読めなかった理由（英語の例外メッセージを含む）。読めた行では null。 */
  unreadableReason: string | null;
  /** この文書の置き場。壊れた文書を人が自分で覗きにいけるように返す。 */
  path: string;
}

/**
 * 「この文書は 1 枚の HTML に書き出せるか」。
 *
 * 訳し終わってから 413 で初めて知る、という順番をなくすために、
 * 取り込みの応答と GET /api/documents/:id の両方に載せる。
 */
export interface Exportability {
  /** source.pdf の大きさ（バイト）。PDF が見つからなければ null。 */
  pdfBytes: number | null;
  limitBytes: number;
  exportable: boolean;
  /** 書き出せないときだけ入る、人に見せられる日本語の理由。 */
  reason: string | null;
}

/**
 * 扱える PDF の上限。**取り込みと書き出しで同じ値を使う。**
 *
 * 以前は取り込み 100MB / 書き出し 60MB で、その間の PDF は
 * 「読めて訳せるが、訳を外に出せない」文書になっていた。しかも書き出しは
 * 訳し終わってから押すボタンなので、**作業をぜんぶ終えた後にしか気づけない**。
 * 上限が 2 つあること自体が事故なので、1 つにまとめて import と export の
 * 両方からこの定数を見る（片方だけ動かせないようにする）。
 *
 * 100MB という値の根拠（このファイルを直す人へ）:
 *  - 書き出しは PDF 全体を base64 にして 1 枚の HTML に載せる。100MB の PDF は
 *    135MB の HTML になり、組み立て中のサーバーの RSS は実測で 0.4GB → 0.7GB、
 *    所要 5 秒（60MB なら 0.5GB / 2 秒）。ここまでは手元の PC で問題なく通る。
 *  - これ以上に上げると Node の文字列上限（約 512MB）が先に見えてくるうえ、
 *    書き出した HTML を**ブラウザで開く側**が持たない。書き出しは配って読ませる
 *    ためのものなので、作れても開けないファイルを作れるようにする意味がない。
 *  - 論文 PDF は図をそのまま貼ったものでも通常 50MB 未満。100MB を超えるのは
 *    ほぼ「論文ではない何か」なので、入口で断る側に倒す。
 */
export const MAX_PDF_BYTES = 100 * 1024 * 1024;

/**
 * 用語集の上限。取り込み経路にも同じ値を効かせるために、ここに置いて共有する。
 *
 * 以前は HTTP の /glossary にしか置いていなかったので、書き出し HTML の取り込みは
 * 素通りし、3000 件の用語集がそのまま入った。上限を置いた理由は 2 つあって、
 * どちらも取り込み経路でも同じように効く:
 *  - 用語集は MCP の窓に「変わるたび」丸ごと載る。件数が増えるほど毎回の往復が太り、
 *    訳すための文脈をこれが押し出す。
 *  - 用語集は文のハッシュで弾けない唯一の注釈なので、混ざったものを後から
 *    1 件ずつ選り分けるのは人手でしかできない。数が多いほど取り返しがつかない。
 */
export const MAX_GLOSSARY_ENTRIES = 2000;

/**
 * 解析の同時実行数。
 * ワーカースレッドに逃がしたとはいえ、1 本あたり数百 MB 使うので無制限にはしない。
 */
const MAX_CONCURRENT_PARSES = 2;

/** 置き換え候補として画面に出す上限。全部見せるのが原則だが、青天井にはしない。 */
const MAX_REPLACEMENT_CANDIDATES = 500;

/**
 * 既存文書にマージするとき、これ未満の一致率なら止める。
 *
 * 別の論文の書き出しを落としても止まらないと、相手の用語集（＝訳語の方針）が
 * この文書に混ざり、以後 Claude はそれに従って訳す。訳とメモは hash で弾かれるが、
 * 用語集は全件入るので、被害はいちばん気づきにくい形で残る。
 * 「同じ論文の別バージョン」や「相手だけが区切りを直した」を巻き込まないよう
 * 境目は低めに置き、判断は人に返す（force で通せる）。
 */
const MIN_IMPORT_OVERLAP = 0.3;

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

export class PaperLensApi {
  readonly store: DocumentStore;
  readonly bus: EventBus;
  readonly config: Config;
  private readonly parseSlots = new Semaphore(MAX_CONCURRENT_PARSES);
  /** MCP から最後に呼ばれた時刻。プロセスを跨いで残す必要はない（今つながっているかの話）。 */
  private lastMcpContactAt: number | null = null;

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

  async listDocuments(): Promise<DocumentRow[]> {
    const documents = await this.store.list();
    const rows: DocumentRow[] = [];
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
          skipped: stats.skipped,
          remaining: stats.remaining,
          unreadable: false,
          unreadableReason: null,
          path: this.store.pathOf(document.id),
        });
      } catch (error) {
        rows.push({
          id: document.id,
          title: `${document.id}（読み込めませんでした）`,
          updatedAt: document.updatedAt ?? new Date(0).toISOString(),
          parser: 'unknown',
          total: 0,
          translated: 0,
          skipped: 0,
          remaining: 0,
          unreadable: true,
          unreadableReason: error instanceof Error ? error.message : String(error),
          path: this.store.pathOf(document.id),
        });
      }
    }
    // 読み出しそのものに失敗したものも行として出す（消せなくならないように）。
    // 理由と置き場を機械可読な形でも返す。題名に埋めた文字列だけだと、
    // 画面側は「この行は壊れている」を日本語の部分一致で判定するしかない。
    for (const [id, reason] of this.store.unreadable) {
      rows.push({
        id,
        title: `${id}（開けません: ${reason.slice(0, 120)}）`,
        updatedAt: new Date(0).toISOString(),
        parser: 'unknown',
        total: 0,
        translated: 0,
        skipped: 0,
        remaining: 0,
        unreadable: true,
        unreadableReason: reason,
        path: this.store.pathOf(id),
      });
    }
    return rows;
  }

  async getDocument(id: string): Promise<PaperDocument> {
    return this.require(id);
  }

  /**
   * 題名を付け直す。
   *
   * 自動で当てた題名は、簡易解析だと著者行まで拾うなど当たり外れがある。
   * 推測を賢くするより、直せるようにする方が確実に効く。
   */
  async renameDocument(id: string, title: string): Promise<PaperDocument> {
    // 制御文字・双方向の上書き記号を落としてから空かどうかを見る。
    // 「\u202e だけ」の題名は trim では空にならないが、出せる文字は無い。
    const trimmed = sanitizeTitle(title);
    if (trimmed.length === 0) throw new BadRequestError('題名が空です');
    const document = await this.mutate(id, (current) => ({
      ...current,
      title: trimmed.slice(0, 300),
      updatedAt: new Date().toISOString(),
    }));
    this.bus.publish({ type: 'document.updated', documentId: id, reason: 'rename' });
    return document;
  }

  async getPdf(id: string): Promise<Buffer> {
    await this.require(id);
    return this.readPdf(id);
  }

  /**
   * 保存してある PDF 本体を読む。
   *
   * `ENOENT: … /home/…/source.pdf` を素のまま返していた頃は、読んだ人に
   * 「何が起きたのか・自分に何ができるのか」が一切伝わらなかった。
   * 文書の記録だけ残って PDF が消えている、という状態は実際に起きる
   * （書き込み途中の電源断、置き場を手で整理した後など）ので、専用の言い方を持たせる。
   */
  private async readPdf(id: string): Promise<Buffer> {
    try {
      return await this.store.readPdf(id);
    } catch (error) {
      throw this.translatePdfIoError(id, error);
    }
  }

  private async pdfSize(id: string): Promise<number> {
    try {
      return await this.store.pdfSize(id);
    } catch (error) {
      throw this.translatePdfIoError(id, error);
    }
  }

  private translatePdfIoError(id: string, error: unknown): unknown {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') return error;
    return missingStoredPdf(
      id,
      this.store.pdfPathOf(id),
      error instanceof Error ? error.message : String(error),
    );
  }

  /**
   * PDF を解析して新規文書にする。GROBID が落ちていたら黙って劣化させず、警告を返す。
   *
   * `signal` は「この取り込みを頼んだ人がまだ待っているか」。ブラウザのタブを閉じる、
   * 待ちきれずに再読み込みする、といった切断で落ちる。以前はこれを見ていなかったので、
   * **誰も待っていない解析が最後まで走り切り、その結果が黙って一覧に現れていた**
   * （実測: 450 ページで、クライアントが諦めた 11 分後）。取り込みを途中で捨てるなら、
   * 置き場も残さない。
   */
  async ingestPdf(
    pdf: Uint8Array,
    fileName: string,
    preference: ParserPreference = 'auto',
    options: { signal?: AbortSignal } = {},
  ): Promise<IngestResult> {
    this.assertLooksLikePdf(pdf, fileName);
    const signal = options.signal;
    // 関数にしておく。`signal.aborted` を直接書くと、型の絞り込みが
    // 「一度 false だったのだから以後も false」と判断してしまう（実際には後から立つ）。
    const clientGone = (): boolean => signal?.aborted === true;

    const { structure, usedFallback, warning } = await this.parseStructure(
      pdf,
      fileName,
      preference,
      signal,
    );
    // 解析が終わった瞬間にもう一度見る。解析中に切れた場合は上の await が
    // 中止で抜けるが、解析が先に終わっていた（＝ここまで来た）ときは
    // この一行だけが「書かない」を決める最後の場所になる。
    if (clientGone()) throw pdfIngestAbandoned(fileName);
    const document = createDocument({ structure, sourceFileName: fileName });

    try {
      await this.store.writePdf(document.id, pdf);
      await this.store.write(document);
      // 書き込みの最中に切れることもある。半分だけ置いて帰らないよう、
      // 書き終えてから消す（消せる状態にしてから判定する）。
      if (clientGone()) throw pdfIngestAbandoned(fileName);
    } catch (error) {
      // 書けなかったときに作りかけを残さない。document.json の無いディレクトリは
      // 一覧に出ないので、利用者からは見えも消せもしないゴミになる。
      await this.store.remove(document.id).catch(() => undefined);
      throw error;
    }
    this.bus.publish({ type: 'document.created', documentId: document.id });

    // 「訳せるが書き出せない」文書を、訳し終わってからではなく**この時点で**伝える。
    return { document, usedFallback, warning, exportability: this.judgeExportability(pdf.byteLength) };
  }

  /** アップロードでも取り込みでも同じ入口検査を通す。 */
  private assertLooksLikePdf(pdf: Uint8Array, fileName: string | null = null): void {
    const name = fileName === null || fileName.length === 0 ? 'このファイル' : `「${fileName}」`;
    if (pdf.byteLength === 0) {
      throw new PdfUnreadableError(
        'not-pdf',
        `${name}は中身が空のファイルです（0 バイト）。` +
          'ダウンロードが始まる前のファイルを掴んでいる可能性があります。落とし直してから取り込んでください。',
        { fileName },
      );
    }
    if (!(pdf[0] === 0x25 && pdf[1] === 0x50 && pdf[2] === 0x44 && pdf[3] === 0x46)) {
      throw new PdfUnreadableError(
        'not-pdf',
        `${name}は PDF ではないようです（ファイルの先頭が %PDF で始まっていません）。` +
          '論文のページを保存した HTML や、中身がエラーページになっているファイルでよく起きます。' +
          'PDF そのものを取り込んでください。',
        { fileName },
      );
    }
    if (pdf.byteLength > MAX_PDF_BYTES) {
      // 取り込みの上限＝書き出しの上限。ここを通したものは必ず書き出せる。
      throw new TooLargeError(
        `${name}は大きすぎて扱えません（${Math.round(pdf.byteLength / 1024 / 1024)}MB / ` +
          `上限 ${MAX_PDF_BYTES / 1024 / 1024}MB）。この上限は書き出しの上限と同じ値で、` +
          '取り込めた PDF は必ず 1 枚の HTML に書き出せるようにしてあります。',
      );
    }
  }

  private async parseStructure(
    pdf: Uint8Array,
    fileName: string,
    preference: ParserPreference,
    signal?: AbortSignal,
  ) {
    return this.parseSlots.run(async () => {
      // 順番待ちの間に切れていることがある。待たせた末に「今から 2 分かけて解析します」
      // では、待ち行列が誰も見ない仕事で埋まる。
      if (signal?.aborted === true) throw pdfIngestAbandoned(fileName);
      if (preference === 'fallback') {
        return {
          structure: await parseWithPdfJs(pdf, { fileName, signal }),
          usedFallback: true,
          warning: null as string | null,
        };
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
        // 簡易解析も失敗したときは、そちらの失敗（＝この PDF そのものの話）を前に出す。
        // 「GROBID が使えなかった」を被せると、暗号化された PDF を入れた人に
        // GROBID の設定を疑わせることになる。
        return {
          structure: await parseWithPdfJs(pdf, { fileName, signal }),
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
    const pdf = await this.readPdf(id);
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

  /**
   * 訳を消す。`alsoSkip` を立てると、消したうえで「訳さない」に移す。
   *
   * この 2 つを 1 回にしたのは、既訳の文を対象外にしたいときの唯一の道だから。
   * 別々に呼ばせると、消した直後の一瞬だけ「未訳」に見える状態が画面に出る。
   */
  async deleteTranslation(
    id: string,
    sentenceHash: string,
    options: { alsoSkip?: boolean } = {},
  ): Promise<{ deleted: boolean; skipped: boolean }> {
    let deleted = false;
    let skipped = false;
    await this.mutate(id, (current) => {
      const removed = deleteTranslation(current, sentenceHash);
      deleted = removed.deleted;
      if (!options.alsoSkip) return removed.document;
      const result = skipSentences(removed.document, [sentenceHash], 'other');
      skipped = result.applied > 0;
      return result.document;
    });
    if (deleted || skipped) {
      this.bus.publish({ type: 'translation.updated', documentId: id, sentenceHash });
    }
    return { deleted, skipped };
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
      // 追記も積み上げれば上限を越えられる。1 回ぶんの件数ではなく、結果で見る。
      if (glossary.length > MAX_GLOSSARY_ENTRIES) {
        throw new BadRequestError(
          `用語集が ${glossary.length} 語になり、上限の ${MAX_GLOSSARY_ENTRIES} 語を超えます` +
            `（今は ${current.annotations.glossary.length} 語）。使っていない語を消してから足してください。`,
        );
      }
      total = glossary.length;
      return { ...current, updatedAt: new Date().toISOString(), annotations: { ...current.annotations, glossary } };
    });
    this.bus.publish({ type: 'document.updated', documentId: id, reason: 'glossary' });
    return { added, updated, total };
  }

  /**
   * 訳語の一括置換。既に書いた訳を、新しい訳語に追随させる。
   * dryRun のときは何も書かず、対象の件数と最初の数件だけ返す。
   */
  /**
   * 訳語を変えたときに書き換わる候補を、**1 件残らず**返す。書き込みはしない。
   *
   * 件数だけを見せて走らせる設計にしてはいけない。日本語には語の切れ目が無いので、
   * 「学習 → ラーニング」は機械学習も学習率も巻き込む。何がどう変わるかを
   * 目で見て選べることが、この機能が壊れ物にならない最低条件。
   */
  async previewTermReplacement(
    id: string,
    from: string,
    to: string,
  ): Promise<{
    total: number;
    revisedByHuman: number;
    /** 実際に返した候補の件数。total より少なければ打ち切っている。 */
    shown: number;
    /** 打ち切ったか。true のとき、超えた分は選択肢に現れないので置換もされない。 */
    truncated: boolean;
    /** 打ち切りの上限（画面に「n 件ずつ」と出せるように返す）。 */
    limit: number;
    candidates: {
      sentenceHash: string;
      before: string;
      after: string;
      revisedByHuman: boolean;
      /** どの文の訳かを突き合わせるための原文と位置。 */
      text: string;
      order: number;
      page: number;
    }[];
  }> {
    if (from.trim().length === 0) throw new BadRequestError('置き換える語が空です');
    const document = await this.require(id);
    // replaceInTranslations は今の構造に在る文の訳だけを候補にする。
    // 候補には原文・通し番号・ページが付くので、画面で実物と突き合わせられる。
    const { replacements } = replaceInTranslations(document, from, to);
    const candidates = replacements.slice(0, MAX_REPLACEMENT_CANDIDATES);
    return {
      total: replacements.length,
      revisedByHuman: replacements.filter((r) => r.revisedByHuman).length,
      // 打ち切りは黙って起こしてはいけない。超えた分は選択肢に出ないまま
      // 置き換えられずに残るので、前半と後半で訳語が違う論文がそのままできる。
      shown: candidates.length,
      truncated: replacements.length > candidates.length,
      limit: MAX_REPLACEMENT_CANDIDATES,
      candidates,
    };
  }

  /** 画面で選んだ行だけを、見せた内容と一致する場合に限って書き換える。 */
  async applyTranslationEdits(
    id: string,
    edits: { sentenceHash: string; before: string; after: string }[],
  ): Promise<{ applied: number; stale: string[] }> {
    let applied = 0;
    let stale: string[] = [];
    await this.mutate(id, (current) => {
      const result = applyTranslationEdits(current, edits);
      applied = result.applied;
      stale = result.stale;
      return result.document;
    });
    if (applied > 0) this.bus.publish({ type: 'document.updated', documentId: id, reason: 'glossary-replace' });
    return { applied, stale };
  }

  /** 用語集の 1 件だけを足す・直す（画面の古い一覧で全体を上書きしないため）。 */
  async upsertGlossaryEntry(id: string, entry: GlossaryEntry): Promise<{ added: boolean; total: number }> {
    if (entry.term.trim().length === 0) throw new BadRequestError('原語が空です');
    if (entry.translation.trim().length === 0) throw new BadRequestError('訳語が空です');
    let added = false;
    const document = await this.mutate(id, (current) => {
      const result = upsertGlossaryEntry(current, entry);
      added = result.added;
      return result.document;
    });
    this.bus.publish({ type: 'document.updated', documentId: id, reason: 'glossary' });
    return { added, total: document.annotations.glossary.length };
  }

  /** 用語集の 1 件だけを消す。 */
  async removeGlossaryEntry(id: string, term: string): Promise<{ removed: boolean; total: number }> {
    let removed = false;
    const document = await this.mutate(id, (current) => {
      const result = removeGlossaryEntry(current, term);
      removed = result.removed;
      return result.document;
    });
    if (removed) this.bus.publish({ type: 'document.updated', documentId: id, reason: 'glossary' });
    return { removed, total: document.annotations.glossary.length };
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
    input: { type: 'merge' | 'split' | 'drop'; hashes: string[]; offsets?: number[] },
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
            // 取り除きは新しい文を作らないので空。undo.hashes は取り除いた文そのものなので、
            // そのまま返すと「これが結果です」と読めてしまう。
            resultHashes: result.edit!.type === 'drop' ? [] : (result.edit!.undo?.hashes ?? []),
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
        // 本文として扱わなかった行には本文の通し番号が無い。付物の並び順を order として
        // 返すと本文の番号と混ざるので、null にして afterOrder（直前の本文）で位置を示す。
        order: hit.isBody ? hit.sentence.order : null,
        page: hit.sentence.page,
        text: hit.sentence.text,
        translation: hit.translation,
        notes: hit.notes,
        where: hit.where,
        // 訳せる文かどうかを機械的に分かる形で返す。画面には出ているのに
        // 検索が拾わなかった行（参考文献など）をここで拾えるようにしたぶん、
        // 受け取った側が「訳してよい文」と取り違えないための印が要る。
        isBody: hit.isBody,
        nonBodyKind: hit.nonBodyKind,
        afterOrder: hit.afterOrder,
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

  /**
   * この文書を 1 枚の HTML に書き出せるか。書き出す前に、取り込んだ直後に答える。
   *
   * 判断材料は PDF の大きさだけなので、stat 1 回で済む。
   * 画面はこれを見て、「書き出せません」を**訳す前に**出せる。
   */
  private judgeExportability(pdfBytes: number | null): Exportability {
    if (pdfBytes === null) {
      return {
        pdfBytes: null,
        limitBytes: MAX_PDF_BYTES,
        exportable: false,
        reason:
          'PDF 本体（source.pdf）が見つからないため、書き出せません。元の PDF を取り込み直してください。',
      };
    }
    if (pdfBytes > MAX_PDF_BYTES) {
      return {
        pdfBytes,
        limitBytes: MAX_PDF_BYTES,
        exportable: false,
        reason:
          `PDF が大きすぎて 1 ファイルに書き出せません（${Math.round(pdfBytes / 1024 / 1024)}MB / ` +
          `上限 ${MAX_PDF_BYTES / 1024 / 1024}MB）。書き出し HTML は PDF を base64 で丸ごと抱えるので、` +
          'この大きさを超えると、作れてもブラウザで開けないファイルになります。',
      };
    }
    return { pdfBytes, limitBytes: MAX_PDF_BYTES, exportable: true, reason: null };
  }

  /** 画面と MCP から「書き出せるか」を先に問い合わせるための入口。 */
  async exportability(id: string): Promise<Exportability> {
    await this.require(id);
    try {
      return this.judgeExportability(await this.store.pdfSize(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return this.judgeExportability(null);
      throw error;
    }
  }

  async exportHtml(id: string): Promise<{ html: string; fileName: string }> {
    const document = await this.require(id);
    // 取り込みの上限と同じ値で見る。取り込めたものは必ず書き出せる、を保つ
    // （2 つの上限がずれていた頃は、訳し終えてからでないと気づけなかった）。
    const verdict = this.judgeExportability(await this.pdfSize(id));
    if (!verdict.exportable) throw new TooLargeError(verdict.reason ?? '書き出せません');
    const pdf = await this.readPdf(id);
    const html = await exportDocumentHtml(this.config, document, pdf);
    const safeTitle = document.title.replace(/[^\p{L}\p{N} ._-]/gu, '').trim() || document.id;
    return { html, fileName: `${safeTitle}.paperlens.html` };
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
    options: { force?: boolean } = {},
  ): Promise<{
    documentId: string;
    report: unknown;
    note: string;
    warning: string | null;
    /** 取り込み元と取り込み先がどれだけ同じ文を持っていたか（新規取り込みでは null）。 */
    overlap: number | null;
    /** 新規文書として取り込んだときだけ。既存へのマージでは PDF が変わらないので null。 */
    exportability?: Exportability;
  }> {
    const parsed = parseExportHtml(html);
    const warnings: string[] = [];
    const sanitizeWarning = describeSanitizeReport(parsed.sanitizeReport);
    if (sanitizeWarning) warnings.push(sanitizeWarning);
    // 旧版の書き出しは、構造も注釈も今の規則に揃えてから使う（core の sanitize が行う）。
    // 何件張り替えたかは黙って飲み込まない — 訳が別の文に付いたように見えたときに
    // 原因を辿れる唯一の手がかりなので、必ず返す。
    if (parsed.sanitizeReport.rekeyedAnnotations > 0) {
      warnings.push(
        `古い版（構造 v${parsed.declaredStructureVersion ?? '不明'}）の書き出しなので、` +
          `注釈 ${parsed.sanitizeReport.rekeyedAnnotations} 件を今の文のハッシュに張り替えました`,
      );
    }

    // 版の判定は、payload が名乗っていた値で行う。sanitize 後の structure.version は
    // 今の規則に揃えた結果なので、ここでは判断材料にならない。
    // **新規取り込みだけでなくマージでも見る。** 新しい版の注釈をこちらの規則で
    // 読んで混ぜると、片方の規則で付けた訳が混ざった文書ができあがる。
    const declared = parsed.declaredStructureVersion;
    if (declared !== null && declared > STRUCTURE_VERSION) {
      throw new BadRequestError(
        `この書き出しは新しい版の PaperLens で作られています（構造 v${declared} / ` +
          `このプログラムは v${STRUCTURE_VERSION} まで）。PaperLens を更新してください。`,
      );
    }

    // 用語集の上限は取り込み経路にも効かせる。
    // HTTP の /glossary だけに置いていた頃は、書き出し HTML を落とすだけで
    // 3000 件の用語集が入った（＝上限がある意味が無かった）。
    // ここで断るのは、混ざった用語集を後から選り分ける手段が人手しか無いため。
    if (parsed.annotations.glossary.length > MAX_GLOSSARY_ENTRIES) {
      throw new BadRequestError(
        `この書き出しの用語集は ${parsed.annotations.glossary.length} 語で、上限の ` +
          `${MAX_GLOSSARY_ENTRIES} 語を超えています。用語集は文のハッシュで弾けないので、` +
          '取り込むと以後の訳語の方針がそのまま置き換わります。' +
          '取り込み元で用語集を整理してから書き出し直してください。',
      );
    }

    if (targetId) {
      let report: unknown = null;
      let adoptedEdits = 0;
      let detachedByAdoption = { translations: 0, notes: 0 };
      let overlap = 0;
      await this.mutate(targetId, (current) => {
        // 相手が直した文の区切りを先に取り込む。順番が逆だと、まとめた文に付いた訳が
        // 「対応なし」として捨てられる（区切りが違うだけで hash が当たらないため）。
        const adopted = adoptSentenceEdits(current, parsed.annotations.sentenceEdits ?? []);
        adoptedEdits = adopted.adopted;
        detachedByAdoption = adopted.detached;
        const base = adopted.document;

        // 「これは同じ論文か」の関門。区切りを揃えた**後**に測る。
        // 前に測ると、相手だけが文をまとめている書き出しを別の論文と誤判定する。
        // ここで投げれば store.update は書き込みに進まないので、
        // 区切りの取り込みごと無かったことになる（中途半端な状態を残さない）。
        overlap = overlapRatio(parsed, base);
        const judgeable = parsed.sentenceHashes.length > 0;
        if (judgeable && overlap < MIN_IMPORT_OVERLAP && options.force !== true) {
          throw new BadRequestError(
            `この書き出しは、取り込み先の文書とほとんど同じ文を持っていません` +
              `（一致率 ${Math.round(overlap * 100)}% / 目安 ${Math.round(MIN_IMPORT_OVERLAP * 100)}%）。` +
              '別の論文の書き出しではありませんか。' +
              '用語集は文のハッシュで弾けないので、取り込むと以後の訳語の方針がそのまま混ざります。' +
              // 画面には「それでも取り込む」の道がある。API の引数名を人に読ませない。
              'それでも取り込むなら、あらためて取り込み直してください（?force=true）。',
          );
        }

        const hashes = new Set(base.structure.sentences.map((s) => s.hash));
        const merged = mergeAnnotations(base.annotations, parsed.annotations, hashes);
        // 足した結果でも上限を見る。1 回ぶんが上限内でも、重ねれば超えられてしまう。
        // 投げれば store.update は書き込みに進まないので、区切りの取り込みごと無かったことになる。
        if (merged.annotations.glossary.length > MAX_GLOSSARY_ENTRIES) {
          throw new BadRequestError(
            `取り込むと用語集が ${merged.annotations.glossary.length} 語になり、上限の ` +
              `${MAX_GLOSSARY_ENTRIES} 語を超えます（今は ${base.annotations.glossary.length} 語）。` +
              'この文書の用語集から使っていない語を消すか、取り込み元で整理してから書き出し直してください。',
          );
        }
        report = merged.report;
        return { ...base, updatedAt: new Date().toISOString(), annotations: merged.annotations };
      });
      const merged = report as {
        glossaryAdded: number;
        glossaryAddedTerms: string[];
        skippedAdded: number;
      };
      if (parsed.sentenceHashes.length === 0) {
        warnings.push('この書き出しには本文が入っていないため、同じ論文かどうかを確かめられませんでした');
      } else if (overlap < MIN_IMPORT_OVERLAP) {
        warnings.push(`一致率 ${Math.round(overlap * 100)}% のまま force で取り込みました`);
      }
      // 用語集と「訳さない」は、こちらの作業内容を静かに書き換える 2 つ。
      // 件数を返すだけでなく警告に載せる（呼び出し側が report を読み落としても届くように）。
      if (merged.glossaryAdded > 0) {
        warnings.push(
          `用語集に ${merged.glossaryAdded} 語（${merged.glossaryAddedTerms.slice(0, 10).join(', ')}` +
            `${merged.glossaryAddedTerms.length > 10 ? ' …' : ''}）が追加されました。以後の訳はこれに従います`,
        );
      }
      if (merged.skippedAdded > 0) {
        warnings.push(
          `取り込み元の判断により ${merged.skippedAdded} 文が「訳さない」に移りました（残件がその数だけ減ります）`,
        );
      }
      this.bus.publish({ type: 'document.updated', documentId: targetId, reason: 'import' });
      return {
        documentId: targetId,
        report: {
          ...(report as Record<string, unknown>),
          sentenceEditsAdopted: adoptedEdits,
          detachedTranslations: detachedByAdoption.translations,
          detachedNotes: detachedByAdoption.notes,
          rekeyedAnnotations: parsed.sanitizeReport.rekeyedAnnotations,
        },
        note: '既存の文書に注釈をマージしました',
        warning: warnings.length > 0 ? warnings.join(' / ') : null,
        overlap,
      };
    }

    if (!parsed.pdfBase64 || !parsed.document) {
      throw new BadRequestError('この書き出しには PDF か本文が含まれていないため、新規文書として取り込めません');
    }
    const document = parsed.document;
    // 取り込み経路もアップロードと同じ入口検査を通す。ここを素通しにすると、
    // 任意のバイト列が source.pdf として保存され、/pdf が application/pdf として配る。
    const pdf = Buffer.from(parsed.pdfBase64, 'base64');
    this.assertLooksLikePdf(pdf, `${parsed.documentTitle}（取り込んだ書き出しの PDF）`);
    // 新しい版は上で断り済み（判定は payload が名乗っていた版で行う）。
    try {
      await this.store.writePdf(document.id, pdf);
      await this.store.write(document);
    } catch (error) {
      // 取り込みでも、書けなかったときに作りかけを残さない。
      await this.store.remove(document.id).catch(() => undefined);
      throw error;
    }
    this.bus.publish({ type: 'document.created', documentId: document.id });
    return {
      documentId: document.id,
      report: null,
      note: '新しい文書として取り込みました',
      warning: warnings.length > 0 ? warnings.join(' / ') : null,
      overlap: null,
      // アップロードと同じく、書き出せるかどうかを取り込んだ時点で返す。
      exportability: this.judgeExportability(pdf.byteLength),
    };
  }

  /**
   * 文書を消す。**中身を読まずに消す。**
   *
   * 以前はここで require() → JSON.parse まで通していたので、document.json が
   * 途中で切れている文書は削除そのものが 500 になった。一覧は「見えも消せもしない
   * 文書を作らないため」にわざわざ壊れた行を出しているのに、その行から消せない
   * ——ファイルを手で消す以外に逃げ道が無い、という状態だった。
   *
   * 削除に文書の中身は要らない。置き場が在るかどうかだけ見て、あれば消す。
   */
  async deleteDocument(id: string): Promise<void> {
    if (!(await this.store.dirExists(id))) {
      throw new NotFoundError(`文書が見つかりません: ${id}`);
    }
    await this.store.remove(id);
    this.bus.publish({ type: 'document.deleted', documentId: id });
  }

  /** MCP から呼ばれたことを記録する（health で「つながっている」を出すため）。 */
  noteMcpContact(): void {
    this.lastMcpContactAt = Date.now();
  }

  async health(): Promise<{
    ok: true;
    version: string;
    grobid: 'up' | 'down';
    grobidUrl: string;
    dataDir: string;
    mcp: {
      entry: string | null;
      url: string;
      configPath: string;
      addCommand: string | null;
      lastContactAt: number | null;
    };
  }> {
    return {
      ok: true,
      version: PAPERLENS_VERSION,
      grobid: (await isGrobidAlive(this.config.grobidUrl)) ? 'up' : 'down',
      grobidUrl: this.config.grobidUrl,
      dataDir: this.config.dataDir,
      // 画面から Claude の設定をそのまま貼れるようにする。
      // 手順書にしか無い状態だと、翻訳の始め方が製品の中のどこにも書かれていない。
      // 貼り先のファイルと、端末なら 1 行で済むコマンドも一緒に出す。
      // JSON だけ渡して「MCP 設定に足す」と言うのは、道具の置き場所を
      // 教えずに「工具箱に入れて」と言うのと同じだった。
      mcp: {
        entry: this.config.mcpEntry,
        url: this.config.publicUrl,
        configPath: this.config.claudeConfigPath,
        addCommand: this.config.mcpEntry
          ? `claude mcp add-json paperlens-server '${JSON.stringify({
              command: 'node',
              args: [this.config.mcpEntry],
              env: { PAPERLENS_SERVER_URL: this.config.publicUrl },
            })}'`
          : null,
        lastContactAt: this.lastMcpContactAt,
      },
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
