import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { ImportError } from '@logixiv/core';
import type { Config } from './config.ts';
import { BadRequestError, LogiXivApi, NotFoundError, type ParserPreference } from './api.ts';
import { ViewerNotBuiltError } from './exporter.ts';
import { GrobidUnavailableError } from './grobid.ts';

/**
 * ローカル専用の HTTP 層。
 *
 * 既定で 127.0.0.1 にしか bind しないうえ、Host ヘッダも検証する。
 * ブラウザからの DNS リバインディングで、外部のページがこのサーバー越しに
 * 手元の論文を読みにくる経路を塞ぐため。
 */

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

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

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
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
    if (size > limit) throw new BadRequestError(`本文が大きすぎます（上限 ${Math.floor(limit / 1024 / 1024)}MB）`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const body = await readBody(request, 8 * 1024 * 1024);
  if (body.length === 0) throw new BadRequestError('JSON の本文がありません');
  try {
    return JSON.parse(body.toString('utf8')) as T;
  } catch {
    throw new BadRequestError('JSON を解析できませんでした');
  }
}

/** localhost 以外の Host / Origin を弾く。 */
function isLocalRequest(request: IncomingMessage): boolean {
  const host = (request.headers.host ?? '').split(':')[0] ?? '';
  const hostOk = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === '';
  const origin = request.headers.origin;
  if (!origin) return hostOk;
  try {
    const originHost = new URL(origin).hostname;
    return hostOk && (originHost === 'localhost' || originHost === '127.0.0.1' || originHost === '::1');
  } catch {
    return false;
  }
}

function errorStatus(error: unknown): number {
  if (error instanceof NotFoundError) return 404;
  if (error instanceof BadRequestError || error instanceof ImportError) return 400;
  if (error instanceof GrobidUnavailableError) return 502;
  if (error instanceof ViewerNotBuiltError) return 503;
  return 500;
}

async function serveStatic(root: string, pathname: string, response: ServerResponse): Promise<boolean> {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let filePath = resolve(join(root, relative));
  if (!filePath.startsWith(resolve(root))) return false;

  let info = await stat(filePath).catch(() => null);
  if (info?.isDirectory()) {
    filePath = join(filePath, 'index.html');
    info = await stat(filePath).catch(() => null);
  }
  if (!info?.isFile()) return false;

  response.writeHead(200, {
    'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
    'Content-Length': info.size,
  });
  createReadStream(filePath).pipe(response);
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
    response.writeHead(204, { Allow: 'GET, POST, PUT, PATCH, DELETE' });
    response.end();
    return;
  }

  if (path === '/api/health') {
    sendJson(response, 200, await api.health());
    return;
  }

  if (path === '/api/events') {
    api.bus.subscribe(response);
    return;
  }

  if (path === '/api/documents' && method === 'GET') {
    sendJson(response, 200, { documents: await api.listDocuments() });
    return;
  }

  if (path === '/api/documents' && method === 'POST') {
    // multipart は使わない。本文は PDF そのもので、ファイル名はヘッダで受け取る。
    const fileName = decodeURIComponent(String(request.headers['x-file-name'] ?? 'paper.pdf'));
    const preference = (String(request.headers['x-parser'] ?? 'auto') as ParserPreference) ?? 'auto';
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
        'Content-Type': 'application/pdf',
        'Content-Length': pdf.length,
        'Cache-Control': 'no-store',
      });
      response.end(pdf);
      return;
    }
    if (rest === '/reparse' && method === 'POST') {
      const body = await readJson<{ parser?: ParserPreference }>(request).catch(() => ({}) as { parser?: ParserPreference });
      sendJson(response, 200, await api.reparse(id, body.parser ?? 'auto'));
      return;
    }
    if (rest === '/export' && method === 'GET') {
      const { html, fileName } = await api.exportHtml(id);
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
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
    if (rest === '/search' && method === 'GET') {
      const query = url.searchParams.get('q') ?? '';
      sendJson(response, 200, { hits: await api.search(id, query) });
      return;
    }
    if (rest === '/untranslated' && method === 'GET') {
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
      sendJson(response, 200, { sentences: await api.untranslated(id, Number.isFinite(limit) ? limit : 20) });
      return;
    }
    if (rest === '/translations' && method === 'PUT') {
      const body = await readJson<{
        entries: { sentenceHash: string; text: string }[];
        source?: 'claude' | 'human';
      }>(request);
      if (!Array.isArray(body.entries)) throw new BadRequestError('entries が配列ではありません');
      sendJson(response, 200, await api.setTranslations(id, body.entries, { source: body.source ?? 'human' }));
      return;
    }

    const translationMatch = /^\/translations\/([0-9a-f]{4,64})$/.exec(rest);
    if (translationMatch && method === 'PUT') {
      const body = await readJson<{ text: string; source?: 'claude' | 'human' }>(request);
      if (typeof body.text !== 'string') throw new BadRequestError('text が必要です');
      sendJson(
        response,
        200,
        await api.setTranslation(id, translationMatch[1]!, body.text, { source: body.source ?? 'human' }),
      );
      return;
    }

    if (rest === '/notes' && method === 'POST') {
      const body = await readJson<{ sentenceHash: string; body: string; author?: string }>(request);
      if (!body.sentenceHash || typeof body.body !== 'string') {
        throw new BadRequestError('sentenceHash と body が必要です');
      }
      sendJson(response, 201, await api.addNote(id, body.sentenceHash, body.body, body.author ?? null));
      return;
    }

    const noteMatch = /^\/notes\/([A-Za-z0-9_-]{1,64})$/.exec(rest);
    if (noteMatch && method === 'PATCH') {
      const body = await readJson<{ body: string }>(request);
      const applied = await api.updateNote(id, noteMatch[1]!, body.body);
      sendJson(response, applied ? 200 : 404, { applied });
      return;
    }
    if (noteMatch && method === 'DELETE') {
      const applied = await api.deleteNote(id, noteMatch[1]!);
      sendJson(response, applied ? 200 : 404, { applied });
      return;
    }

    if (rest === '/glossary' && method === 'PUT') {
      const body = await readJson<{ entries: { term: string; translation: string; note?: string }[] }>(request);
      if (!Array.isArray(body.entries)) throw new BadRequestError('entries が配列ではありません');
      await api.setGlossary(
        id,
        body.entries.map((entry) => ({ term: entry.term, translation: entry.translation, note: entry.note ?? null })),
      );
      sendJson(response, 200, { ok: true });
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
