// 保管庫（ローカルフォルダ）への読み書き。
//
// ブラウザの File System Access API で、利用者が選んだフォルダを直接読み書きする。
// データベースは使わず、すべてフォルダ内の普通のファイルとして残る。
// API が使えないブラウザやプレビュー環境では、メモリ上の保管庫で動かす。

export interface Entry {
  name: string;
  kind: "file" | "directory";
}

export interface Vault {
  name: string;
  /** true のとき、ファイルは端末のフォルダに保存される。false はメモリのみ。 */
  persistent: boolean;
  list(path: string): Promise<Entry[]>;
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
}

const split = (p: string) => p.split("/").filter(Boolean);

// --- フォルダ保管庫 ---------------------------------------------------------

export class FsVault implements Vault {
  persistent = true;
  private root: FileSystemDirectoryHandle;
  constructor(root: FileSystemDirectoryHandle) {
    this.root = root;
  }
  get name() {
    return this.root.name;
  }

  private async dir(parts: string[], create: boolean) {
    let d = this.root;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create });
    return d;
  }

  private async file(path: string, create: boolean) {
    const parts = split(path);
    const name = parts.pop()!;
    const d = await this.dir(parts, create);
    return d.getFileHandle(name, { create });
  }

  async list(path: string) {
    const d = await this.dir(split(path), false);
    const out: Entry[] = [];
    // entries() は TypeScript の版によって型定義に含まれないため、型を明示する
    const entries = (d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
    for await (const [name, h] of entries) out.push({ name, kind: h.kind });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async exists(path: string) {
    try {
      await this.file(path, false);
      return true;
    } catch {
      try {
        await this.dir(split(path), false);
        return true;
      } catch {
        return false;
      }
    }
  }

  async readText(path: string) {
    return (await (await this.file(path, false)).getFile()).text();
  }

  async readBinary(path: string) {
    return (await (await this.file(path, false)).getFile()).arrayBuffer();
  }

  async writeText(path: string, text: string) {
    await this.write(path, text);
  }

  async writeBinary(path: string, data: ArrayBuffer) {
    await this.write(path, data);
  }

  private async write(path: string, data: string | ArrayBuffer) {
    const h = await this.file(path, true);
    const w = await h.createWritable();
    await w.write(data);
    await w.close();
  }
}

// --- メモリ保管庫（お試し用） ------------------------------------------------

export class MemoryVault implements Vault {
  persistent = false;
  name = "お試し用の保管庫";
  private files = new Map<string, string | ArrayBuffer>();

  private norm(p: string) {
    return split(p).join("/");
  }

  async list(path: string) {
    const base = this.norm(path);
    const prefix = base ? `${base}/` : "";
    const seen = new Map<string, Entry>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length).split("/");
      const kind = rest.length > 1 ? "directory" : "file";
      seen.set(rest[0], { name: rest[0], kind });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async exists(path: string) {
    const p = this.norm(path);
    if (this.files.has(p)) return true;
    for (const k of this.files.keys()) if (k.startsWith(`${p}/`)) return true;
    return false;
  }

  async readText(path: string) {
    const v = this.files.get(this.norm(path));
    if (v === undefined) throw new Error(`ファイルがありません: ${path}`);
    return typeof v === "string" ? v : new TextDecoder().decode(v);
  }

  async readBinary(path: string) {
    const v = this.files.get(this.norm(path));
    if (v === undefined) throw new Error(`ファイルがありません: ${path}`);
    return typeof v === "string" ? new TextEncoder().encode(v).buffer : v.slice(0);
  }

  async writeText(path: string, text: string) {
    this.files.set(this.norm(path), text);
  }

  async writeBinary(path: string, data: ArrayBuffer) {
    this.files.set(this.norm(path), data.slice(0));
  }
}

// --- 前回の保管庫を覚えておく ----------------------------------------------
// フォルダのハンドルは IndexedDB に保存できる。次回は権限の確認だけで開ける。

const DB = "paperlens";
const STORE = "handles";

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function rememberVault(h: FileSystemDirectoryHandle) {
  try {
    const db = await idb();
    db.transaction(STORE, "readwrite").objectStore(STORE).put(h, "last");
  } catch {
    // 保存できなくても、次回フォルダを選び直せば使える
  }
}

export async function recallVault(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await idb();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get("last");
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export const canUseFolders = () =>
  typeof window !== "undefined" && "showDirectoryPicker" in window;
