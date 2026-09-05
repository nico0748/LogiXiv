import { mkdir, readdir, readFile, rename, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { PaperDocument } from '@logixiv/core';
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

/** 文書ごとの直列化。SSE や MCP からの同時更新で JSON を壊さないための最小限のロック。 */
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(id: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const next = previous.then(task, task);
  locks.set(
    id,
    next.catch(() => undefined),
  );
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

  async read(id: string): Promise<PaperDocument> {
    const raw = await readFile(join(this.dir(id), DOCUMENT_FILE), 'utf8');
    return JSON.parse(raw) as PaperDocument;
  }

  async exists(id: string): Promise<boolean> {
    try {
      await stat(join(this.dir(id), DOCUMENT_FILE));
      return true;
    } catch {
      return false;
    }
  }

  async write(document: PaperDocument): Promise<void> {
    await withLock(document.id, async () => {
      const dir = this.dir(document.id);
      await mkdir(dir, { recursive: true });
      const target = join(dir, DOCUMENT_FILE);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      await rename(temporary, target);
    });
  }

  /** 読み → 変更 → 書き を 1 つのロックの中で行う。競合更新で片方が消えるのを防ぐ。 */
  async update(id: string, mutate: (document: PaperDocument) => PaperDocument | Promise<PaperDocument>): Promise<PaperDocument> {
    return withLock(id, async () => {
      const dir = this.dir(id);
      const current = JSON.parse(await readFile(join(dir, DOCUMENT_FILE), 'utf8')) as PaperDocument;
      const next = await mutate(current);
      const target = join(dir, DOCUMENT_FILE);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await rename(temporary, target);
      return next;
    });
  }

  async writePdf(id: string, bytes: Uint8Array): Promise<void> {
    const dir = this.dir(id);
    await mkdir(dir, { recursive: true });
    const target = join(dir, PDF_FILE);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  }

  async readPdf(id: string): Promise<Buffer> {
    return readFile(join(this.dir(id), PDF_FILE));
  }

  async remove(id: string): Promise<void> {
    await rm(this.dir(id), { recursive: true, force: true });
  }
}
