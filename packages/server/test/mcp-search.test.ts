import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { start } from '../src/start.ts';
import { createMcpServer } from '../../mcp/src/server.ts';
import { makeSamplePdf } from '../../../scripts/make-sample-pdf.ts';

/**
 * 「長い検索語を渡したときに、理由が届くか」の回帰テスト。
 *
 * 実測で固定してある壊れ方: `search_document({query: 'a'.repeat(20000)})` が
 * `isError: true` かつ `content[0].text` が空文字で返っていた。
 * 検索語を URL に載せていたので、17KB 付近から Node の既定ヘッダ上限に当たり、
 * 本体のコードに一度も届かないまま 431 が**本文なしで**返っていたのが原因。
 * Claude 側には理由が一文字も届かないので、同じ呼び出しを延々と繰り返すことになる。
 */

let baseUrl = '';
let port = 0;
let dataDir = '';
let documentId = '';
let close: () => Promise<void> = async () => {};
let mcp: Client;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'logixiv-mcp-search-test-'));
  const started = await start({ port: 0, dataDir, grobidUrl: 'http://127.0.0.1:9', webDir: null });
  baseUrl = started.url;
  port = (started.server.address() as { port: number }).port;
  close = started.close;

  const response = await fetch(`${baseUrl}/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', 'X-File-Name': 'sample.pdf' },
    body: makeSamplePdf(),
  });
  assert.equal(response.status, 201);
  documentId = ((await response.json()) as { documentId: string }).documentId;

  // MCP サーバーを本物のまま、プロセス内の配管でつなぐ。
  // 「Claude から見て何が返るか」を測るので、ツールの実装だけを呼ぶのでは足りない。
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  mcp = new Client({ name: 'test', version: '0' });
  await Promise.all([createMcpServer(baseUrl).connect(serverSide), mcp.connect(clientSide)]);
});

after(async () => {
  await mcp.close();
  await close();
  await rm(dataDir, { recursive: true, force: true });
});

async function searchViaMcp(query: string) {
  const result = (await mcp.callTool({
    name: 'search_document',
    arguments: { document_id: documentId, query },
  })) as { isError?: boolean; content: { type: string; text: string }[] };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

test('MCP の検索に長すぎる語を渡しても、中身の空なエラーは返らない', async () => {
  const { isError, text } = await searchViaMcp('a'.repeat(20_000));
  assert.equal(isError, true);
  // ここが空文字だったのが元の不具合。何が悪かったのかが一文字も届いていなかった。
  assert.notEqual(text.trim(), '');
  // 「長すぎる」ことと、どれくらい長かったのかが読み取れること。
  assert.match(text, /長すぎます/);
  assert.match(text, /20000 文字/);
});

test('段落ほどの長さの検索語は、そのまま検索できる（URL の上限に当たらない）', async () => {
  // 和文で測る。クエリ文字列に載せると 1 文字が %E3%81%82 の 9 バイトになるので、
  // 3000 文字で約 27KB — 上限（4000 文字）に収まる長さでも Node のヘッダ上限を軽く越える。
  // つまり「短くすれば通る」では済まない。だから経路そのものを本文に変えてある。
  const paragraph = 'この段落を丸ごと検索語にする。'.repeat(200).slice(0, 3_000);
  const { isError, text } = await searchViaMcp(paragraph);
  assert.equal(isError, false, `検索が失敗した: ${text}`);
  const parsed = JSON.parse(text) as { total: number };
  assert.equal(typeof parsed.total, 'number');
});

test('検索語の上限は本体側でも断り、理由を日本語で返す', async () => {
  const response = await fetch(`${baseUrl}/api/documents/${documentId}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: 'x'.repeat(20_000) }),
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /検索語が長すぎます/);
});

/** Host ヘッダや長い URL を自由に書くための生ソケット。 */
function rawRequest(line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`${line}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.setTimeout(5000, () => {
      socket.destroy();
      resolve(data);
    });
    socket.on('data', (chunk) => {
      data += chunk.toString();
    });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

test('ヘッダの上限を越えたリクエストにも、空ではない理由が返る', async () => {
  // Node が本体のコードに渡す前に撥ねる経路。ここが本文なしだったせいで、
  // 受け取った側には状態番号すら意味のある形で残らなかった。
  const raw = await rawRequest(`GET /api/documents/${documentId}/search?q=${'a'.repeat(20_000)} HTTP/1.1`);
  assert.match(raw, /^HTTP\/1\.1 431 /);
  assert.match(raw, /ヘッダ/);
  assert.match(raw, /header_too_large/);
});
