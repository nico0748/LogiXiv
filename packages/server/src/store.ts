import { mkdir, readdir, readFile, rename, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateDocument, type PaperDocument } from '@logixiv/core';
import { type Config, documentDir, documentsDir } from './config.ts';

/**
 * ストレージは「アプリを捨てても人が読める」形にしてある。
 * DB は使わず ~/.logixiv/documents/<id>/ に document.json と source.pdf を置くだけ。
 *
 * 書き込みは必ず一時ファイル → rename。JSON を途中まで書いた状態で電源が落ちても、
 * 前のバージョンの document.json がそのまま残る。
 */

const DOCUMENT_FILE = 'document.json';
const PDF_FILE = 'source.pdf';

export class DocumentMissingError extends Error {}

/**
 * 文書ごとの直列化。SSE や MCP からの同時更新で JSON を壊さないための最小限のロック。
 * 使い終わったキーは掃除する（取り込んだ文書の数だけ単調に増えるのを防ぐ）。
 */
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(id: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tracked = next.catch(() => undefined);
  locks.set(id, tracked);
  void tracked.then(() => {
    // 自分が最後のチェーンなら解放する。
    if (locks.get(id) === tracked) locks.delete(id);
  });
  return next;
}

/** ID をパスに使う前の検証。パストラバーサルを入口で止める。 */
export function assertSafeId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new Error(`不正な文書 ID です: ${id}`);
  }
  return id;
}

export class DocumentStore {
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async init(): Promise<void> {
    await mkdir(documentsDir(this.config), { recursive: true });
  }

  private dir(id: string): string {
    return documentDir(this.config, assertSafeId(id));
  }

  async list(): Promise<PaperDocument[]> {
    await this.init();
    const entries = await readdir(documentsDir(this.config), { withFileTypes: true });
    const documents: PaperDocument[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        documents.push(await this.read(entry.name));
      } catch {
        // 壊れた・書きかけのディレクトリは一覧から黙って外す（一覧が開けなくなる方が困る）。
      }
    }
    return documents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * 読み出し時に旧バージョンの構造を移行する。訳は原文から再計算したハッシュで付け替わる。
   *
   * 書き戻しは `write()` ではなく `update()` を通す。`write()` はロックの外で読んだ内容を
   * そのまま上書きするので、(a) 並行して走っている更新の結果を古い内容で潰す、
   * (b) その間に削除された文書のディレクトリを作り直してゾンビにする、の 2 つが起きる。
   * `update()` はロックの中で読み直し、消えていれば中断する。
   */
  async read(id: string): Promise<PaperDocument> {
    const raw = await readFile(join(this.dir(id), DOCUMENT_FILE), 'utf8');
    const parsed = JSON.parse(raw) as PaperDocument;
    const migration = migrateDocument(parsed);
    if (!migration.migrated) return parsed;
    // update() の中でもう一度 migrate が走るので、mutate は素通しでよい。
    await this.update(id, (current) => current).catch(() => undefined);
    return migration.document;
  }

  async exists(id: string): Promise<boolean> {
    try {
      await stat(join(this.dir(id), DOCUMENT_FILE));
      return true;
    } catch {
      return false;
    }
  }

  private async writeAtomic(dir: string, file: string, data: string | Uint8Array): Promise<void> {
    const target = join(dir, file);
    const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`;
    await writeFile(temporary, data);
    await rename(temporary, target);
  }

  async write(document: PaperDocument): Promise<void> {
    await withLock(document.id, async () => {
      const dir = this.dir(document.id);
      await mkdir(dir, { recursive: true });
      await this.writeAtomic(dir, DOCUMENT_FILE, `${JSON.stringify(document, null, 2)}\n`);
    });
  }

  /**
   * 読み → 変更 → 書き を 1 つのロックの中で行う。
   * 長い処理（再解析など）を挟むときも、必ずこの中で最新を読み直してから適用すること。
   * ロックの外で読んだ文書に対して書き戻すと、その間に入った翻訳やメモが黙って消える。
   *
   * 途中で文書が削除されていたら DocumentMissingError を投げる（ディレクトリを
   * 作り直して「PDF の無いゾンビ文書」を復活させないため）。
   */
  async update(
    id: string,
    mutate: (document: PaperDocument) => PaperDocument | Promise<PaperDocument>,
  ): Promise<PaperDocument> {
    return withLock(id, async () => {
      const dir = this.dir(id);
      let raw: string;
      try {
        raw = await readFile(join(dir, DOCUMENT_FILE), 'utf8');
      } catch {
        throw new DocumentMissingError(`文書が見つかりません: ${id}`);
      }
      const current = migrateDocument(JSON.parse(raw) as PaperDocument).document;
      const next = await mutate(current);
      await this.writeAtomic(dir, DOCUMENT_FILE, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    });
  }

  async writePdf(id: string, bytes: Uint8Array): Promise<void> {
    await withLock(id, async () => {
      const dir = this.dir(id);
      await mkdir(dir, { recursive: true });
      await this.writeAtomic(dir, PDF_FILE, bytes);
    });
  }

  async readPdf(id: string): Promise<Buffer> {
    return readFile(join(this.dir(id), PDF_FILE));
  }

  async pdfSize(id: string): Promise<number> {
    return (await stat(join(this.dir(id), PDF_FILE))).size;
  }

  async remove(id: string): Promise<void> {
    await withLock(id, async () => {
      await rm(this.dir(id), { recursive: true, force: true });
    });
  }
}
