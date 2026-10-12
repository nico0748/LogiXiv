// 保存先フォルダを Node.js のファイル操作で読み書きする保管庫。
// 画面（ブラウザ版）と同じ Vault の形にそろえ、論文フォルダの扱いは src/lib/papers.ts を共有する。

import fs from "node:fs/promises";
import path from "node:path";
import type { Entry, Vault } from "../src/lib/vault.ts";

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
