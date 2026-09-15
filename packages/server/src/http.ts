import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { ImportError } from '@logixiv/core';
import type { Config } from './config.ts';
import { BadRequestError, LogiXivApi, NotFoundError, TooLargeError, type ParserPreference } from './api.ts';
import { ViewerNotBuiltError } from './exporter.ts';
import { GrobidUnavailableError } from './grobid.ts';
import { FallbackParseError } from './fallback.ts';

/**
 * ローカル専用の HTTP 層。
 *
 * 既定で 127.0.0.1 にしか bind しないうえ、Host ヘッダも検証する。
 * ブラウザからの DNS リバインディングで、外部のページがこのサーバー越しに
 * 手元の論文を読みにくる経路を塞ぐため。
 *
 * 入力は全部この層で型を確認する。ここを素通りさせると非文字列が
 * document.json に書き込まれ、以後 search や export が実行時に落ちる
 * （しかもディスクに残るので再起動しても直らない）。
 */

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_FIELD = 20_000;
const MAX_NOTE_FIELD = 50_000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
};

/** 全レスポンスに付ける。MIME sniffing と iframe 埋め込みを止める。 */
const BASE_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage, limit = MAX_UPLOAD_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) {
      // 読みかけで抜けると、残りを抱えたソケットが開いたままになる。
      // その 1 本のせいで server.close() のコールバックが呼ばれず、
      // 終了処理（ロックの返却など）が走らないまま落ちる。
      request.destroy();
      throw new TooLargeError(`本文が大きすぎます（上限 ${Math.floor(limit / 1024 / 1024)}MB）`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const body = await readBody(request, MAX_JSON_BYTES);
  if (body.length === 0) throw new BadRequestError('JSON の本文がありません');
  try {
    return JSON.parse(body.toString('utf8')) as T;
  } catch {
    throw new BadRequestError('JSON を解析できませんでした');
  }
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new BadRequestError(`${field} は文字列である必要があります`);
  if (value.length > maxLength) throw new BadRequestError(`${field} が長すぎます（上限 ${maxLength} 文字）`);
  return value;
}

function optionalString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, field, maxLength);
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * localhost 以外の Host / Origin を弾く。
 * Host ヘッダが無い場合も拒否する（HTTP/1.1 のクライアントは必ず送る。
 * 「無いからローカル」という仮定は、前に何かを置いた瞬間に崩れる）。
 */
function isLocalRequest(request: IncomingMessage): boolean {
  const rawHost = request.headers.host ?? '';
  if (rawHost.length === 0) return false;
  const host = rawHost.startsWith('[') ? rawHost.slice(0, rawHost.indexOf(']') + 1) : (rawHost.split(':')[0] ?? '');
  const hostOk = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (!hostOk) return false;

  const origin = request.headers.origin;
  if (!origin || origin === 'null') return true;
  try {
    const originHost = new URL(origin).hostname;
    return originHost === 'localhost' || originHost === '127.0.0.1' || originHost === '::1' || originHost === '[::1]';
  } catch {
    return false;
  }
}

function errorStatus(error: unknown): number {
  if (error instanceof NotFoundError) return 404;
  if (error instanceof BadRequestError || error instanceof ImportError) return 400;
  if (error instanceof TooLargeError) return 413;
  if (error instanceof FallbackParseError) return 422;
  if (error instanceof GrobidUnavailableError) return 502;
  if (error instanceof ViewerNotBuiltError) return 503;
  return 500;
}

async function serveStatic(root: string, pathname: string, response: ServerResponse): Promise<boolean> {
  const decoded = safeDecode(pathname);
  if (decoded === null) return false;
  const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const rootReal = await realpath(root).catch(() => resolve(root));
  let filePath = resolve(join(rootReal, relative));

  let info = await stat(filePath).catch(() => null);
  if (info?.isDirectory()) {
    filePath = join(filePath, 'index.html');
    info = await stat(filePath).catch(() => null);
  }
  if (!info?.isFile()) return false;

  // シンボリックリンクで root の外へ出ていないか、実体のパスで確かめる。
  const real = await realpath(filePath).catch(() => null);
  if (real === null || (real !== rootReal && !real.startsWith(rootReal + sep))) return false;

  const isHtml = extname(real) === '.html';
  response.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': MIME[extname(real)] ?? 'application/octet-stream',
    'Content-Length': info.size,
    // ハッシュ付きのアセットは長期キャッシュ、HTML は毎回確認。
    'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(real).pipe(response);
  return true;
}

export function createHttpServer(config: Config, api: LogiXivApi): Server {
  return createServer((request, response) => {
    handle(config, api, request, response).catch((error: unknown) => {
      const status = errorStatus(error);
      if (status === 500) console.error('[logixiv]', error);
      if (!response.headersSent) {
        sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
      } else {
        response.end();
      }
    });
  });
}

async function handle(
  config: Config,
  api: LogiXivApi,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!isLocalRequest(request)) {
    sendJson(response, 403, { error: 'ローカルからのリクエストのみ受け付けます' });
    return;
  }

  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = request.method ?? 'GET';

  if (method === 'OPTIONS') {
    response.writeHead(204, { ...BASE_HEADERS, Allow: 'GET, POST, PUT, PATCH, DELETE' });
    response.end();
    return;
  }

  if (path === '/api/health') {
    sendJson(response, 200, await api.health());
    return;
  }

  if (path === '/api/events') {
    if (method !== 'GET') {
      sendJson(response, 405, { error: 'GET のみ受け付けます' });
      return;
    }
    api.bus.subscribe(response);
    return;
  }

  if (path === '/api/documents' && method === 'GET') {
    sendJson(response, 200, { documents: await api.listDocuments() });
    return;
  }

  /**
   * 他人の書き出しを**新しい文書として**取り込む。
   *
   * これまでは既存の文書 ID を経路に書いて `?merge=false` を付けるしかなく、
   * その ID は読み捨てられていた。1 本も持っていない人には書ける ID が無いので、
   * README が書いている「他人の書き出しを取り込む」が実際には到達不能だった。
   */
  if (path === '/api/import' && method === 'POST') {
    const html = (await readBody(request)).toString('utf8');
    sendJson(response, 201, await api.importHtml(html, null));
    return;
  }

  if (path === '/api/documents' && method === 'POST') {
    // multipart は使わない。本文は PDF そのもので、ファイル名はヘッダで受け取る。
    const rawName = String(request.headers['x-file-name'] ?? 'paper.pdf');
    const fileName = (safeDecode(rawName) ?? rawName).slice(0, 300);
    const requested = String(request.headers['x-parser'] ?? 'auto');
    const preference: ParserPreference =
      requested === 'grobid' || requested === 'fallback' ? requested : 'auto';
    const pdf = await readBody(request);
    const result = await api.ingestPdf(pdf, fileName, preference);
    sendJson(response, 201, {
      documentId: result.document.id,
      usedFallback: result.usedFallback,
      warning: result.warning,
      parserNote: result.document.structure.parserNote,
      sentences: result.document.structure.sentences.length,
    });
    return;
  }

  const documentMatch = /^\/api\/documents\/([A-Za-z0-9_-]{1,64})(\/.*)?$/.exec(path);
  if (documentMatch) {
    const id = documentMatch[1]!;
    const rest = documentMatch[2] ?? '';

    if (rest === '' && method === 'GET') {
      sendJson(response, 200, await api.getDocument(id));
      return;
    }
    if (rest === '' && method === 'DELETE') {
      await api.deleteDocument(id);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (rest === '/pdf' && method === 'GET') {
      const pdf = await api.getPdf(id);
      response.writeHead(200, {
        ...BASE_HEADERS,
        'Content-Type': 'application/pdf',
        'Content-Length': pdf.length,
        'Cache-Control': 'no-store',
      });
      response.end(pdf);
      return;
    }
    if (rest === '' && method === 'PATCH') {
      const body = await readJson<{ title?: unknown }>(request);
      const title = requireString(body.title, 'title', 300);
      const document = await api.renameDocument(id, title);
      sendJson(response, 200, { id: document.id, title: document.title });
      return;
    }
    if (rest === '/reparse' && method === 'POST') {
      const body = await readJson<{ parser?: string }>(request).catch(() => ({}) as { parser?: string });
      const preference: ParserPreference =
        body.parser === 'grobid' || body.parser === 'fallback' ? body.parser : 'auto';
      sendJson(response, 200, await api.reparse(id, preference));
      return;
    }
    if (rest === '/export' && method === 'GET') {
      const { html, fileName } = await api.exportHtml(id);
      response.writeHead(200, {
        ...BASE_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      });
      response.end(html);
      return;
    }
    if (rest === '/import' && method === 'POST') {
      const html = (await readBody(request)).toString('utf8');
      const target = url.searchParams.get('merge') === 'false' ? null : id;
      sendJson(response, 200, await api.importHtml(html, target));
      return;
    }
    // 書き換わる候補を「1 件残らず」返す。書き込みはしない。
    if (rest === '/glossary/preview-replace' && method === 'POST') {
      const body = await readJson<{ from?: unknown; to?: unknown }>(request);
      const from = requireString(body.from, 'from', 500);
      const to = optionalString(body.to, 'to', 500) ?? '';
      sendJson(response, 200, await api.previewTermReplacement(id, from, to));
      return;
    }
    // 画面で選んだ行だけを、見せた内容と一致する場合に限って書き換える。
    if (rest === '/translations/apply-edits' && method === 'POST') {
      const body = await readJson<{ edits?: unknown }>(request);
      if (!Array.isArray(body.edits)) throw new BadRequestError('edits が配列ではありません');
      if (body.edits.length > 1000) throw new BadRequestError('edits は 1000 件までです');
      const edits = body.edits.map((raw, index) => {
        if (typeof raw !== 'object' || raw === null) {
          throw new BadRequestError(`edits[${index}] がオブジェクトではありません`);
        }
        const item = raw as Record<string, unknown>;
        return {
          sentenceHash: requireString(item['sentenceHash'], `edits[${index}].sentenceHash`, 64),
          before: requireString(item['before'], `edits[${index}].before`, MAX_TEXT_FIELD),
          after: requireString(item['after'], `edits[${index}].after`, MAX_TEXT_FIELD),
        };
      });
      sendJson(response, 200, await api.applyTranslationEdits(id, edits));
      return;
    }
    // 用語集は 1 件ずつ触れる経路も持つ。画面が持っている古い一覧で
    // 全体を上書きすると、その間に Claude が足した語が消える。
    if (rest === '/glossary/entry' && method === 'PUT') {
      const body = await readJson<{ term?: unknown; translation?: unknown; note?: unknown }>(request);
      sendJson(
        response,
        200,
        await api.upsertGlossaryEntry(id, {
          term: requireString(body.term, 'term', 500),
          translation: requireString(body.translation, 'translation', 500),
          note: optionalString(body.note, 'note', 2000),
        }),
      );
      return;
    }
    if (rest === '/glossary/entry' && method === 'DELETE') {
      const term = url.searchParams.get('term') ?? '';
      if (term.length === 0) throw new BadRequestError('term がありません');
      sendJson(response, 200, await api.removeGlossaryEntry(id, term));
      return;
    }
    if (rest === '/search' && method === 'GET') {
      const query = url.searchParams.get('q') ?? '';
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '30', 10);
      const from = Number.parseInt(url.searchParams.get('from') ?? '0', 10);
      sendJson(
        response,
        200,
        await api.search(
          id,
          query,
          Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 30,
          Number.isFinite(from) && from > 0 ? from : 0,
        ),
      );
      return;
    }

    if (rest === '/skip' && method === 'POST') {
      const body = await readJson<{ hashes?: unknown; reason?: unknown; undo?: unknown }>(request);
      if (!Array.isArray(body.hashes)) throw new BadRequestError('hashes が配列ではありません');
      if (body.hashes.length > 500) throw new BadRequestError('hashes は 500 件までです');
      const hashes = body.hashes.map((raw, index) => requireString(raw, `hashes[${index}]`, 64));
      if (body.undo === true) {
        sendJson(response, 200, await api.unskipSentences(id, hashes));
      } else {
        const reason = optionalString(body.reason, 'reason', 200) ?? 'other';
        sendJson(response, 200, await api.skipSentences(id, hashes, reason));
      }
      return;
    }
    if (rest === '/untranslated' && method === 'GET') {
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
      sendJson(response, 200, { sentences: await api.untranslated(id, Number.isFinite(limit) ? limit : 20) });
      return;
    }
    if (rest === '/translations' && method === 'PUT') {
      const body = await readJson<{ entries?: unknown; source?: unknown }>(request);
      if (!Array.isArray(body.entries)) throw new BadRequestError('entries が配列ではありません');
      if (body.entries.length > 500) throw new BadRequestError('entries は 1 回あたり 500 件までです');
      const entries = body.entries.map((raw, index) => {
        if (typeof raw !== 'object' || raw === null) {
          throw new BadRequestError(`entries[${index}] がオブジェクトではありません`);
        }
        const item = raw as Record<string, unknown>;
        const text = requireString(item['text'], `entries[${index}].text`, MAX_TEXT_FIELD);
        // 空の訳を通すと、その文は永久に「訳し終わった」ことになって二度と出てこない。
        // 生成が途中で切れたときに静かに欠落するので、入口で断る。
        if (text.trim().length === 0) throw new BadRequestError(`entries[${index}].text が空です`);
        return {
          sentenceHash: requireString(item['sentenceHash'], `entries[${index}].sentenceHash`, 64),
          text,
        };
      });
      const source = body.source === 'claude' ? 'claude' : 'human';
      sendJson(response, 200, await api.setTranslations(id, entries, { source }));
      return;
    }

    const translationMatch = /^\/translations\/([0-9a-f]{4,64})$/.exec(rest);
    if (translationMatch && method === 'PUT') {
      const body = await readJson<{ text?: unknown; source?: unknown }>(request);
      const text = requireString(body.text, 'text', MAX_TEXT_FIELD);
      if (text.trim().length === 0) throw new BadRequestError('text が空です');
      const source = body.source === 'claude' ? 'claude' : 'human';
      sendJson(response, 200, await api.setTranslation(id, translationMatch[1]!, text, { source }));
      return;
    }

    if (rest === '/notes' && method === 'POST') {
      const body = await readJson<{ sentenceHash?: unknown; body?: unknown; author?: unknown }>(request);
      const sentenceHash = requireString(body.sentenceHash, 'sentenceHash', 64);
      const noteBody = requireString(body.body, 'body', MAX_NOTE_FIELD);
      const author = optionalString(body.author, 'author', 200);
      const result = await api.addNote(id, sentenceHash, noteBody, author);
      sendJson(response, result.applied ? 201 : 400, result);
      return;
    }

    const noteMatch = /^\/notes\/([A-Za-z0-9_-]{1,64})$/.exec(rest);
    if (noteMatch && method === 'PATCH') {
      const body = await readJson<{ body?: unknown }>(request);
      const applied = await api.updateNote(id, noteMatch[1]!, requireString(body.body, 'body', MAX_NOTE_FIELD));
      sendJson(response, applied ? 200 : 404, { applied });
      return;
    }
    if (noteMatch && method === 'DELETE') {
      const applied = await api.deleteNote(id, noteMatch[1]!);
      sendJson(response, applied ? 200 : 404, { applied });
      return;
    }

    if ((rest === '/glossary' && method === 'PUT') || (rest === '/glossary' && method === 'POST')) {
      const body = await readJson<{ entries?: unknown }>(request);
      if (!Array.isArray(body.entries)) throw new BadRequestError('entries が配列ではありません');
      // 空配列での置換は、確認も無く用語集を消す操作になる。意図が読めないので断る。
      if (body.entries.length === 0) throw new BadRequestError('entries が空です');
      if (body.entries.length > 2000) throw new BadRequestError('entries は 2000 件までです');
      const entries = body.entries.map((raw, index) => {
        if (typeof raw !== 'object' || raw === null) {
          throw new BadRequestError(`entries[${index}] がオブジェクトではありません`);
        }
        const item = raw as Record<string, unknown>;
        return {
          term: requireString(item['term'], `entries[${index}].term`, 500),
          translation: requireString(item['translation'], `entries[${index}].translation`, 500),
          note: optionalString(item['note'], `entries[${index}].note`, 2000),
        };
      });
      if (method === 'POST') {
        // 追記。既存の用語集を消さない。
        sendJson(response, 200, await api.addGlossaryEntries(id, entries));
      } else {
        await api.setGlossary(id, entries);
        sendJson(response, 200, { ok: true, total: entries.length });
      }
      return;
    }

    // 文の区切り直し。結合は連続する 2 文以上、分割は 1 文と文字位置。
    if (rest === '/sentence-edits' && method === 'GET') {
      sendJson(response, 200, { edits: await api.listSentenceEdits(id) });
      return;
    }
    if (rest === '/sentence-edits' && method === 'POST') {
      const body = await readJson<{ type?: unknown; hashes?: unknown; offsets?: unknown }>(request);
      const type = requireString(body.type, 'type', 16);
      if (type !== 'merge' && type !== 'split') throw new BadRequestError('type は merge か split です');
      if (!Array.isArray(body.hashes)) throw new BadRequestError('hashes が配列ではありません');
      if (body.hashes.length > 64) throw new BadRequestError('一度に扱えるのは 64 文までです');
      const hashes = body.hashes.map((raw, index) => requireString(raw, `hashes[${index}]`, 64));
      if (type === 'merge' && hashes.length < 2) throw new BadRequestError('結合には 2 文以上が要ります');
      if (type === 'split' && hashes.length !== 1) throw new BadRequestError('分割の対象は 1 文です');

      let offsets: number[] | undefined;
      if (type === 'split') {
        if (!Array.isArray(body.offsets)) throw new BadRequestError('offsets が配列ではありません');
        if (body.offsets.length === 0 || body.offsets.length > 64) {
          throw new BadRequestError('offsets は 1〜64 件です');
        }
        offsets = body.offsets.map((raw, index) => {
          if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
            throw new BadRequestError(`offsets[${index}] が正の数ではありません`);
          }
          return Math.floor(raw);
        });
      }

      // 断られた場合も 200 で返し、applied と reason で伝える。
      // setTranslation と同じ約束にしておかないと、呼び出し側が二通りの失敗を扱う羽目になる。
      const result = await api.editSentenceBoundary(id, { type, hashes, offsets });
      sendJson(response, 200, result);
      return;
    }
    if (rest === '/sentence-edits' && method === 'DELETE') {
      const editId = url.searchParams.get('editId');
      if (editId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(editId)) {
        throw new BadRequestError('editId の形式が不正です');
      }
      const result = await api.undoSentenceEdit(id, editId ?? undefined);
      sendJson(response, 200, result);
      return;
    }

    if (rest === '/sentences' && method === 'POST') {
      const body = await readJson<{ hashes?: unknown }>(request);
      if (!Array.isArray(body.hashes)) throw new BadRequestError('hashes が配列ではありません');
      if (body.hashes.length > 500) throw new BadRequestError('hashes は 500 件までです');
      const hashes = body.hashes.map((raw, index) => requireString(raw, `hashes[${index}]`, 64));
      sendJson(response, 200, { sentences: await api.sentencesByHash(id, hashes) });
      return;
    }

    sendJson(response, 404, { error: `見つかりません: ${method} ${path}` });
    return;
  }

  if (path.startsWith('/api/')) {
    sendJson(response, 404, { error: `見つかりません: ${method} ${path}` });
    return;
  }

  if (config.webDir && method === 'GET') {
    if (await serveStatic(config.webDir, path, response)) return;
    // SPA なので、静的ファイルに当たらないパスは index.html に落とす。
    if (await serveStatic(config.webDir, '/index.html', response)) return;
  }

  sendJson(response, 404, {
    error: 'UI がビルドされていません。npm run build を実行するか、npm run dev で開発サーバーを使ってください。',
  });
}
