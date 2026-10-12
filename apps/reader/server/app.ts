// PaperLens のローカルサーバー。
// 127.0.0.1 だけで待ち受け、画面（dist/）と API を配る。データは保存先フォルダの普通のファイルにだけ置く。
// デスクトップ版（electron/main.js）も、この startServer を同じプロセスで呼ぶ。

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AnnotationOp } from "../src/lib/model.ts";
import {
  PAPERS_DIR,
  TEMPLATE_PATH,
  changeAnnotations,
  collectGraph,
  ensureLayout,
  listPapers,
  loadAnnotations,
  loadNote,
  paperDetail,
  pdfPath,
  readTemplate,
  searchNotes,
  writeField,
  writeMeta,
  writeTemplate,
} from "../src/lib/papers.ts";
import { APP_ROOT, dataRoot, readConfig, writeConfig } from "./config.ts";
import { mcpInfo } from "./mcpinfo.ts";
import { NodeVault } from "./nodeVault.ts";
import { importBytes, paperText, requirePaper } from "./service.ts";
import { VERSION } from "./version.ts";

export { VERSION };

// --- デスクトップ版だけが持つ機能 ---------------------------------------------

export interface HostBridge {
  pickFolder(current: string): Promise<string>;
  reveal(target: string): Promise<void>;
}
let host: HostBridge | null = null;
export function setHostBridge(b: HostBridge | null) {
  host = b;
}

// --- 変更の通知 ---------------------------------------------------------------
// 保存先フォルダを見張り、MCP サーバーや Obsidian が書き換えたときも画面へ知らせる。
// このサーバー自身が書いたファイルには、書き込みを頼んだ画面の ID を添える（その画面は通知を無視する）。

type Change = { kind: "papers" | "note" | "annotations" | "template" | "config"; paper?: string; origin?: string };

const clients = new Set<http.ServerResponse>();
/** このサーバーが最後に書いたときの更新時刻。同じなら自分の書き込み、違えば別のプロセスの書き込み。 */
const recent = new Map<string, { origin: string; mtime: number }>();
const mtimeOf = (rel: string) => {
  try {
    return fs.statSync(path.join(watchedRoot, rel)).mtimeMs;
  } catch {
    return -1;
  }
};
let watchedRoot = "";
const pending = new Map<string, NodeJS.Timeout>();

function broadcast(e: Change) {
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const c of clients) c.write(line);
}

function classify(rel: string): Change | null {
  const parts = rel.split("/");
  if (parts[0] === "_templates") return { kind: "template" };
  if (parts[0] !== PAPERS_DIR || !parts[1]) return null;
  const paper = parts[1];
  if (parts[2] === "note.md") return { kind: "note", paper };
  if (parts[2] === "paperlens.json") return { kind: "annotations", paper };
  if (parts.length === 2 || parts[2] === "paper.pdf") return { kind: "papers", paper };
  return null;
}

// フォルダごとに見張る。Linux の recursive な見張りは、置き換えられたファイルの変更を
// 2回目以降に取りこぼすため使わない（書き込みは一時ファイルからの置き換えで行う）。
const dirWatchers = new Map<string, fs.FSWatcher>();

function watchDir(rel: string) {
  if (dirWatchers.has(rel)) return;
  try {
    const w = fs.watch(path.join(watchedRoot, rel), (_ev, name) => {
      if (name) onFsEvent(rel ? `${rel}/${name}` : String(name));
    });
    w.on("error", () => {
      w.close();
      dirWatchers.delete(rel);
    });
    dirWatchers.set(rel, w);
  } catch {
    // まだ無いフォルダは、作られたときに見張り始める
  }
}

function onFsEvent(rel: string) {
  if (rel.endsWith(".tmp")) return;
  const parts = rel.split("/");
  // 新しくできたフォルダも見張る
  if ((parts.length === 1 && (rel === PAPERS_DIR || rel === "_templates")) || (parts.length === 2 && parts[0] === PAPERS_DIR)) {
    watchDir(rel);
  }
  const e = classify(rel);
  if (!e) return;
  const key = `${e.kind}:${e.paper ?? ""}`;
  clearTimeout(pending.get(key));
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key);
      const r = recent.get(rel);
      broadcast({ ...e, origin: r && r.mtime === mtimeOf(rel) ? r.origin : "external" });
    }, 120),
  );
}

function unwatch() {
  for (const w of dirWatchers.values()) w.close();
  dirWatchers.clear();
  watchedRoot = "";
}

function watch(root: string) {
  if (watchedRoot === root) return;
  unwatch();
  watchedRoot = root;
  watchDir("");
  watchDir("_templates");
  watchDir(PAPERS_DIR);
  try {
    for (const d of fs.readdirSync(path.join(root, PAPERS_DIR))) watchDir(`${PAPERS_DIR}/${d}`);
  } catch {
    // 論文がまだ無い
  }
}

function vaultFor(origin: string) {
  const root = dataRoot();
  watch(root);
  return new NodeVault(root, (rel) => recent.set(rel, { origin, mtime: mtimeOf(rel) }));
}

// --- 小さなルーター -------------------------------------------------------------

type Req = { req: http.IncomingMessage; res: http.ServerResponse; params: string[]; query: URLSearchParams; origin: string; body: () => Promise<Buffer> };
type Handler = (r: Req) => Promise<unknown>;
const routes: { method: string; re: RegExp; fn: Handler }[] = [];
const route = (method: string, pattern: string, fn: Handler) =>
  routes.push({ method, re: new RegExp(`^${pattern.replace(/:\w+/g, "([^/]+)")}$`), fn });

class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

const MAX_BODY = 200 * 1024 * 1024;
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "ファイルが大きすぎます（200MB まで）。"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function jsonBody<T>(r: Req): Promise<T> {
  try {
    return JSON.parse((await r.body()).toString("utf8") || "{}") as T;
  } catch {
    throw new HttpError(400, "送られた内容を JSON として読めませんでした。");
  }
}

const str = (v: unknown, name: string) => {
  if (typeof v !== "string") throw new HttpError(400, `${name} を文字列で指定してください。`);
  return v;
};

class Raw {
  type: string;
  data: Buffer | string;
  constructor(type: string, data: Buffer | string) {
    this.type = type;
    this.data = data;
  }
}

// --- API ------------------------------------------------------------------------

route("GET", "/api/meta", async () => meta());
route("PUT", "/api/meta/data-root", async (r) => {
  const { dataRoot: next } = await jsonBody<{ dataRoot?: string }>(r);
  const p = str(next, "dataRoot").trim();
  if (!path.isAbsolute(p.replace(/^~/, "/"))) throw new HttpError(400, "保存先は絶対パスで指定してください。");
  if (process.env.PAPERLENS_DATA) throw new HttpError(400, "環境変数 PAPERLENS_DATA で保存先が決まっているため、画面からは変えられません。");
  writeConfig({ dataRoot: p });
  await ensureLayout(vaultFor(r.origin));
  broadcast({ kind: "config", origin: r.origin });
  return meta();
});

route("GET", "/api/papers", async (r) => {
  const v = vaultFor(r.origin);
  await ensureLayout(v);
  return listPapers(v);
});
route("POST", "/api/papers", async (r) => {
  const data = await r.body();
  const id = await importBytes(vaultFor(r.origin), r.query.get("name") || "paper.pdf", data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, r.query.get("title") ?? undefined);
  return { id };
});
route("GET", "/api/papers/:id", async (r) => paperDetail(vaultFor(r.origin), r.params[0]));
route("GET", "/api/papers/:id/pdf", async (r) => {
  const v = vaultFor(r.origin);
  await requirePaper(v, r.params[0]);
  return new Raw("application/pdf", await fs.promises.readFile(v.resolve(pdfPath(r.params[0]))));
});
route("GET", "/api/papers/:id/note", async (r) => new Raw("text/markdown; charset=utf-8", await loadNote(vaultFor(r.origin), r.params[0])));
route("PUT", "/api/papers/:id/fields/:field", async (r) => {
  const { value } = await jsonBody<{ value?: string }>(r);
  const v = vaultFor(r.origin);
  await requirePaper(v, r.params[0]);
  return { note: await writeField(v, r.params[0], r.params[1], str(value, "value")) };
});
route("PUT", "/api/papers/:id/meta", async (r) => {
  const { key, value } = await jsonBody<{ key?: string; value?: string }>(r);
  if (!/^[\w-]+$/.test(str(key, "key"))) throw new HttpError(400, "key には英数字・ハイフン・下線だけを使えます。");
  const v = vaultFor(r.origin);
  await requirePaper(v, r.params[0]);
  return { note: await writeMeta(v, r.params[0], key as string, str(value, "value")) };
});
route("GET", "/api/papers/:id/annotations", async (r) => loadAnnotations(vaultFor(r.origin), r.params[0]));
route("PATCH", "/api/papers/:id/annotations", async (r) => {
  const { ops } = await jsonBody<{ ops?: AnnotationOp[] }>(r);
  if (!Array.isArray(ops)) throw new HttpError(400, "ops を配列で指定してください。");
  const v = vaultFor(r.origin);
  await requirePaper(v, r.params[0]);
  return changeAnnotations(v, r.params[0], ops);
});
route("GET", "/api/papers/:id/text", async (r) => {
  const v = vaultFor(r.origin);
  await requirePaper(v, r.params[0]);
  return paperText(v, r.params[0], Number(r.query.get("from") || 1), r.query.get("to") ? Number(r.query.get("to")) : undefined);
});

route("GET", "/api/template", async (r) => new Raw("text/markdown; charset=utf-8", await readTemplate(vaultFor(r.origin))));
route("PUT", "/api/template", async (r) => {
  const { text } = await jsonBody<{ text?: string }>(r);
  await writeTemplate(vaultFor(r.origin), str(text, "text"));
  return { file: TEMPLATE_PATH };
});
route("GET", "/api/graph", async (r) => {
  const v = vaultFor(r.origin);
  return collectGraph(v, await listPapers(v));
});
route("GET", "/api/search", async (r) => searchNotes(vaultFor(r.origin), str(r.query.get("q") ?? undefined, "q")));
route("GET", "/api/mcp", async () => mcpInfo());

route("POST", "/api/desktop/pick-folder", async (r) => {
  if (!host) throw new HttpError(400, "フォルダの選択はデスクトップ版でだけ使えます。");
  const { current } = await jsonBody<{ current?: string }>(r);
  return { path: await host.pickFolder(current ?? "") };
});
route("POST", "/api/desktop/reveal", async (r) => {
  if (!host) throw new HttpError(400, "フォルダを開く操作はデスクトップ版でだけ使えます。");
  const { path: target } = await jsonBody<{ path?: string }>(r);
  const root = dataRoot();
  const full = path.resolve(root, target ?? "");
  if (full !== root && !full.startsWith(root + path.sep)) throw new HttpError(400, "保存先フォルダの外は開けません。");
  await host.reveal(full);
  return { ok: true };
});

function meta() {
  const c = readConfig();
  return { dataRoot: c.dataRoot, dataRootSource: c.dataRootSource, desktop: !!host, version: VERSION };
}

// --- 静的ファイル ----------------------------------------------------------------

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

function serveStatic(res: http.ServerResponse, pathname: string) {
  const dist = path.join(APP_ROOT, "dist");
  let file = path.resolve(dist, `.${decodeURIComponent(pathname)}`);
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(dist, "index.html");
  }
  if (!fs.existsSync(file)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("画面がまだビルドされていません。apps/reader で npm run build を実行してください。");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

// --- 入口 ------------------------------------------------------------------------

/** 別のサイトからこのサーバーを操作されないよう、Host と Origin を確かめる。 */
function allowed(req: http.IncomingMessage) {
  const hostName = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(hostName)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (!allowed(req)) {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "このサーバーは同じ端末の画面からだけ使えます。" }));
    return;
  }
  if (!url.pathname.startsWith("/api/")) return serveStatic(res, url.pathname);

  if (url.pathname === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": connected\n\n");
    watch(dataRoot());
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  const origin = String(req.headers["x-paperlens-client"] ?? "");
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    try {
      const params = m.slice(1).map(decodeURIComponent);
      const out = await r.fn({ req, res, params, query: url.searchParams, origin, body: () => readBody(req) });
      if (out instanceof Raw) {
        res.writeHead(200, { "content-type": out.type });
        res.end(out.data);
      } else {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(out));
      }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : (e as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 400;
      const msg = (e as NodeJS.ErrnoException).code === "ENOENT" ? "ファイルが見つかりません。" : e instanceof Error ? e.message : String(e);
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: msg }));
    }
    return;
  }
  res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "その API はありません。" }));
}

export async function startServer(opts: { port?: number; host?: string } = {}) {
  const port = opts.port ?? readConfig().port;
  const server = http.createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, opts.host ?? "127.0.0.1", resolve);
  });
  const addr = server.address() as { port: number };
  const root = dataRoot();
  await ensureLayout(new NodeVault(root));
  watch(root);
  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    dataRoot: root,
    close: () =>
      new Promise<void>((resolve) => {
        unwatch();
        for (const c of clients) c.end();
        clients.clear();
        server.close(() => resolve());
      }),
  };
}
