// 画面から見た保存先。
//
// - ServerBackend: ローカルサーバー（npm start やデスクトップ版）経由で、保存先フォルダを読み書きする。
//   MCP サーバーや Obsidian がファイルを書き換えたときは、サーバーから通知が届く。
// - VaultBackend: サーバーなしで動かすとき。ブラウザで選んだフォルダか、メモリ上の保管庫を直接読み書きする。

import type { FmValue } from "./frontmatter.ts";
import type { AnnotationOp, Annotations } from "./model.ts";
import {
  type PaperSummary,
  type SearchHit,
  changeAnnotations,
  collectGraph,
  ensureLayout,
  importPaper,
  listPapers,
  loadAnnotations,
  loadNote,
  loadPdf,
  readTemplate,
  searchNotes,
  writeField,
  writeMeta,
  writeTemplate,
} from "./papers.ts";
import { type MarkupOp, type SlideDeck, changeMarkups, loadDeck, loadSlidesPdf, putSlides } from "./slides.ts";
import { openPdf } from "./pdf.ts";
import type { Vault } from "./vault.ts";

export type Link = { paper: string; term: string };

/** 保存先で起きた変更。paper が無いものは論文一覧やテンプレートの変更。 */
export interface ChangeEvent {
  kind: "papers" | "note" | "annotations" | "sentences" | "slides" | "template" | "config";
  paper?: string;
}

export interface Meta {
  dataRoot: string;
  dataRootSource: "env" | "config" | "default";
  desktop: boolean;
  version: string;
}

export interface Backend {
  kind: "server" | "browser";
  /** 画面に出す保存先の名前 */
  name: string;
  /** true のとき、端末のフォルダに保存される */
  persistent: boolean;
  listPapers(): Promise<PaperSummary[]>;
  importPaper(fileName: string, data: ArrayBuffer, title: string): Promise<string>;
  /** URL か arXiv の番号から取り込む。サーバー版だけが持つ（単体 HTML 版では、他のサイトの PDF を取得できないため） */
  importUrl?(url: string): Promise<{ id: string; existing: boolean }>;
  loadPdf(id: string): Promise<ArrayBuffer>;
  loadNote(id: string): Promise<string>;
  loadAnnotations(id: string): Promise<Annotations>;
  writeField(id: string, field: string, value: string): Promise<string>;
  /** frontmatter の1項目を書く。一覧の項目は配列で渡す */
  writeMeta(id: string, key: string, value: FmValue): Promise<string>;
  changeAnnotations(id: string, ops: AnnotationOp[]): Promise<{ annotations: Annotations; note: string }>;
  readTemplate(): Promise<string>;
  writeTemplate(text: string): Promise<void>;
  graph(): Promise<Link[]>;
  /** すべての読解ノートから語句を探す */
  search(q: string): Promise<SearchHit[]>;
  /** 論文に付けた発表スライド。無ければ null */
  loadSlides(id: string): Promise<SlideDeck | null>;
  loadSlidesPdf(id: string): Promise<ArrayBuffer>;
  /** PDF か PPTX のスライドを取り込む。PPTX はサーバー版だけ（PDF に変換するため） */
  importSlides(id: string, fileName: string, data: ArrayBuffer): Promise<SlideDeck>;
  changeMarkups(id: string, ops: MarkupOp[]): Promise<{ deck: SlideDeck; note: string }>;
  /** 変更の通知を受け取る。戻り値を呼ぶと止まる。 */
  subscribe(fn: (e: ChangeEvent) => void): () => void;
}

// --- ブラウザだけで動かす ----------------------------------------------------

export class VaultBackend implements Backend {
  kind = "browser" as const;
  vault: Vault;
  constructor(vault: Vault) {
    this.vault = vault;
  }
  get name() {
    return this.vault.name;
  }
  get persistent() {
    return this.vault.persistent;
  }
  async listPapers() {
    await ensureLayout(this.vault);
    return listPapers(this.vault);
  }
  importPaper(fileName: string, data: ArrayBuffer, title: string) {
    return importPaper(this.vault, fileName, data, title);
  }
  loadPdf(id: string) {
    return loadPdf(this.vault, id);
  }
  loadNote(id: string) {
    return loadNote(this.vault, id);
  }
  loadAnnotations(id: string) {
    return loadAnnotations(this.vault, id);
  }
  writeField(id: string, field: string, value: string) {
    return writeField(this.vault, id, field, value);
  }
  writeMeta(id: string, key: string, value: FmValue) {
    return writeMeta(this.vault, id, key, value);
  }
  changeAnnotations(id: string, ops: AnnotationOp[]) {
    return changeAnnotations(this.vault, id, ops);
  }
  readTemplate() {
    return readTemplate(this.vault);
  }
  writeTemplate(text: string) {
    return writeTemplate(this.vault, text);
  }
  async graph() {
    return collectGraph(this.vault, await listPapers(this.vault));
  }
  search(q: string) {
    return searchNotes(this.vault, q);
  }
  loadSlides(id: string) {
    return loadDeck(this.vault, id);
  }
  loadSlidesPdf(id: string) {
    return loadSlidesPdf(this.vault, id);
  }
  async importSlides(id: string, fileName: string, data: ArrayBuffer) {
    if (/\.pptx?$/i.test(fileName)) {
      throw new Error("1 ファイル版では PPTX を変換できません。PowerPoint などで PDF に書き出してから取り込んでください。");
    }
    // 中身が壊れた PDF で、今のスライドを上書きしない
    const doc = await openPdf(data).promise.catch((e: unknown) => {
      throw new Error(`スライドの PDF を開けませんでした（${e instanceof Error ? e.message : String(e)}）。今のスライドはそのまま残しています。`);
    });
    void doc.destroy();
    return putSlides(this.vault, id, fileName, data);
  }
  changeMarkups(id: string, ops: MarkupOp[]) {
    return changeMarkups(this.vault, id, ops);
  }
  subscribe() {
    return () => undefined;
  }
}

// --- ローカルサーバー経由 ----------------------------------------------------

/** この画面を見分ける ID。自分の書き込みで届いた通知を無視するのに使う。 */
const CLIENT_ID = Math.random().toString(36).slice(2);

/** サーバーが断ったときの誤り。status は HTTP の状態（409 は書き換えられない frontmatter の項目） */
export class ApiError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { "x-paperlens-client": CLIENT_ID };
  if (typeof init.body === "string") headers["content-type"] = "application/json";
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  if (!res.ok) {
    const text = await res.text();
    let msg = `通信に失敗しました（${res.status}）`;
    try {
      msg = (JSON.parse(text) as { error?: string }).error || msg;
    } catch {
      // 本文が JSON でないときは状態コードだけを伝える
    }
    throw new ApiError(res.status, msg);
  }
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return (await res.json()) as T;
  if (type.includes("text/")) return (await res.text()) as T;
  return (await res.arrayBuffer()) as T;
}

const json = (v: unknown) => JSON.stringify(v);
const enc = encodeURIComponent;

export const serverApi = {
  meta: () => call<Meta>("/api/meta"),
  setDataRoot: (dataRoot: string) => call<Meta>("/api/meta/data-root", { method: "PUT", body: json({ dataRoot }) }),
  pickFolder: (current: string) => call<{ path: string }>("/api/desktop/pick-folder", { method: "POST", body: json({ current }) }),
  reveal: (path: string) => call<{ ok: boolean }>("/api/desktop/reveal", { method: "POST", body: json({ path }) }),
  mcp: () => call<McpInfo>("/api/mcp"),
};

export interface McpInfo {
  node: string;
  script: string;
  dataRoot: string;
  built: boolean;
  desktopConfig: string;
  desktopConfigReadOnly: string;
  claudeCode: string;
  claudeCodeReadOnly: string;
  desktopConfigPath: string;
  tools: { name: string; title: string; write: boolean }[];
}

export class ServerBackend implements Backend {
  kind = "server" as const;
  persistent = true;
  meta: Meta;
  constructor(meta: Meta) {
    this.meta = meta;
  }
  get name() {
    return this.meta.dataRoot.split(/[\\/]/).filter(Boolean).pop() ?? this.meta.dataRoot;
  }
  listPapers() {
    return call<PaperSummary[]>("/api/papers");
  }
  async importPaper(fileName: string, data: ArrayBuffer, title: string) {
    const r = await call<{ id: string }>(`/api/papers?name=${enc(fileName)}&title=${enc(title)}`, {
      method: "POST",
      body: data,
      headers: { "content-type": "application/pdf" },
    });
    return r.id;
  }
  importUrl(url: string) {
    return call<{ id: string; existing: boolean }>("/api/papers/from-url", { method: "POST", body: json({ url }) });
  }
  loadPdf(id: string) {
    return call<ArrayBuffer>(`/api/papers/${enc(id)}/pdf`);
  }
  loadNote(id: string) {
    return call<string>(`/api/papers/${enc(id)}/note`);
  }
  loadAnnotations(id: string) {
    return call<Annotations>(`/api/papers/${enc(id)}/annotations`);
  }
  async writeField(id: string, field: string, value: string) {
    return (await call<{ note: string }>(`/api/papers/${enc(id)}/fields/${enc(field)}`, { method: "PUT", body: json({ value }) })).note;
  }
  async writeMeta(id: string, key: string, value: FmValue) {
    return (await call<{ note: string }>(`/api/papers/${enc(id)}/meta`, { method: "PUT", body: json({ key, value }) })).note;
  }
  changeAnnotations(id: string, ops: AnnotationOp[]) {
    return call<{ annotations: Annotations; note: string }>(`/api/papers/${enc(id)}/annotations`, { method: "PATCH", body: json({ ops }) });
  }
  readTemplate() {
    return call<string>("/api/template");
  }
  async writeTemplate(text: string) {
    await call("/api/template", { method: "PUT", body: json({ text }) });
  }
  graph() {
    return call<Link[]>("/api/graph");
  }
  search(q: string) {
    return call<SearchHit[]>(`/api/search?q=${enc(q)}`);
  }
  async loadSlides(id: string) {
    return (await call<{ deck: SlideDeck | null }>(`/api/papers/${enc(id)}/slides`)).deck;
  }
  loadSlidesPdf(id: string) {
    return call<ArrayBuffer>(`/api/papers/${enc(id)}/slides/pdf`);
  }
  async importSlides(id: string, fileName: string, data: ArrayBuffer) {
    const r = await call<{ deck: SlideDeck }>(`/api/papers/${enc(id)}/slides?name=${enc(fileName)}`, {
      method: "POST",
      body: data,
      headers: { "content-type": "application/octet-stream" },
    });
    return r.deck;
  }
  changeMarkups(id: string, ops: MarkupOp[]) {
    return call<{ deck: SlideDeck; note: string }>(`/api/papers/${enc(id)}/slides/markups`, { method: "PATCH", body: json({ ops }) });
  }
  subscribe(fn: (e: ChangeEvent) => void) {
    const es = new EventSource("/api/events");
    es.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data as string) as ChangeEvent & { origin?: string };
        if (e.origin !== CLIENT_ID) fn(e);
      } catch {
        // 壊れた通知は捨てる
      }
    };
    return () => es.close();
  }
}

/** ローカルサーバーで動いていればその保存先を返す。単体の HTML として開いたときは null。 */
export async function connectServer(): Promise<ServerBackend | null> {
  if (typeof location === "undefined" || !location.protocol.startsWith("http")) return null;
  try {
    const res = await fetch("/api/meta");
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
    return new ServerBackend((await res.json()) as Meta);
  } catch {
    return null;
  }
}
