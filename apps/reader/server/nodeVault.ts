// 保存先フォルダを Node.js のファイル操作で読み書きする保管庫。
// 画面（ブラウザ版）と同じ Vault の形にそろえ、論文フォルダの扱いは src/lib/papers.ts を共有する。

import fs from "node:fs/promises";
import path from "node:path";
import type { Entry, Vault } from "../src/lib/vault.ts";

/** ファイルの中身が同じかの目印。置き換え（rename）で inode が、書き換えで更新時刻と大きさが変わる。 */
export async function fileSignature(full: string): Promise<string | null> {
  try {
    const st = await fs.stat(full, { bigint: true });
    return `${st.ino}:${st.mtimeNs}:${st.size}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

// memo の置き場。保管庫は要求ごとに作り直すので、プロセスで 1 つ持つ（キーは絶対パス）。
// 別のプロセス（MCP サーバー、Obsidian）の書き込みも、次に読むときの stat で気づく。
const memos = new Map<string, { sig: string; values: Map<string, unknown> }>();
const MAX_MEMO_FILES = 4000;

export class NodeVault implements Vault {
  persistent = true;
  root: string;
  private onWrite?: (rel: string) => void;
  constructor(root: string, onWrite?: (rel: string) => void) {
    this.root = path.resolve(root);
    this.onWrite = onWrite;
  }
  get name() {
    return path.basename(this.root);
  }

  /** 保管庫の外を指すパスは受け付けない。 */
  resolve(rel: string) {
    const full = path.resolve(this.root, rel);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error(`保存先フォルダの外は読み書きできません: ${rel}`);
    }
    return full;
  }

  async list(rel: string): Promise<Entry[]> {
    const entries = await fs.readdir(this.resolve(rel), { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() || e.isDirectory())
      .map((e) => ({ name: e.name, kind: e.isDirectory() ? ("directory" as const) : ("file" as const) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async exists(rel: string) {
    try {
      await fs.stat(this.resolve(rel));
      return true;
    } catch {
      return false;
    }
  }

  async memo<T>(rel: string, tag: string, derive: (text: string) => T): Promise<T> {
    const full = this.resolve(rel);
    const sig = await fileSignature(full);
    if (sig === null) return derive(await this.readText(rel)); // 無ければ readText と同じ失敗にする
    let entry = memos.get(full);
    if (entry?.sig === sig && entry.values.has(tag)) {
      // 使った順に並べ直す（古いものから捨てる）
      memos.delete(full);
      memos.set(full, entry);
      return entry.values.get(tag) as T;
    }
    if (!entry || entry.sig !== sig) entry = { sig, values: new Map() };
    // stat の後に書き換わっても、次の stat で目印が変わるので作り直される
    const value = derive(await fs.readFile(full, "utf8"));
    entry.values.set(tag, value);
    memos.delete(full);
    memos.set(full, entry);
    if (memos.size > MAX_MEMO_FILES) memos.delete(memos.keys().next().value as string);
    return value;
  }

  readText(rel: string) {
    return fs.readFile(this.resolve(rel), "utf8");
  }

  async readBinary(rel: string) {
    const b = await fs.readFile(this.resolve(rel));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }

  writeText(rel: string, text: string) {
    return this.write(rel, text);
  }

  writeBinary(rel: string, data: ArrayBuffer) {
    return this.write(rel, new Uint8Array(data));
  }

  /** 一時ファイルに書いてから置き換える。途中で止まっても中途半端なファイルが残らない。 */
  private async write(rel: string, data: string | Uint8Array) {
    const full = this.resolve(rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    const tmp = `${full}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, full);
    this.onWrite?.(rel);
  }
}
