/**
 * E2E スモークテスト。
 *
 * 単体テストで押さえきれない「つなぎ目」だけを通す:
 *   PDF 取り込み → 文構造化 → 訳の書き込み → SSE でブラウザへ通知
 *   → 自己完結 HTML の書き出し → 取り込み → MCP の stdio 起動とツール列挙
 *
 * GROBID は起動していない前提で、到達しない URL を渡してフォールバック経路を通す。
 * 本番の経路（GROBID あり）は docker compose を上げたうえで LOGIXIV_GROBID_URL を
 * 指定すれば同じスクリプトで確認できる。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { start } from '../packages/server/src/start.ts';
import { TOOL_NAMES } from '../packages/mcp/src/server.ts';
import { makeSamplePdf } from './make-sample-pdf.ts';

const steps: string[] = [];
function step(label: string): void {
  steps.push(label);
  console.log(`  ✓ ${label}`);
}

const dataDir = await mkdtemp(join(tmpdir(), 'logixiv-e2e-'));

const { url, close, config } = await start({
  port: 0,
  dataDir,
  // 到達しないポートを指定して、フォールバック解析を必ず通す。
  grobidUrl: 'http://127.0.0.1:9',
});
step(`サーバー起動 ${url}（データ: ${config.dataDir}）`);

let failure: unknown = null;
try {
  // --- SSE を先に張っておく ------------------------------------------------
  const events: string[] = [];
  const sseController = new AbortController();
  const sseResponse = await fetch(`${url}/api/events`, { signal: sseController.signal });
  const reader = sseResponse.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split('\n')) {
          if (line.startsWith('event: ')) events.push(line.slice(7).trim());
        }
      }
    } catch {
      // 終了時の abort は想定内。
    }
  })();
  step('SSE を購読');

  // --- 取り込み ------------------------------------------------------------
  const pdf = makeSamplePdf();
  const ingest = await fetch(`${url}/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', 'X-File-Name': 'sample.pdf' },
    body: pdf,
  });
  const ingestBody = await ingest.text();
  assert.equal(ingest.status, 201, ingestBody);
  const ingested = JSON.parse(ingestBody) as { documentId: string; usedFallback: boolean; sentences: number };
  assert.equal(ingested.usedFallback, true, 'GROBID 不在ならフォールバックになるはず');
  assert.ok(ingested.sentences >= 4, `文が少なすぎます: ${ingested.sentences}`);
  const id = ingested.documentId;
  step(`PDF 取り込み: ${ingested.sentences} 文（フォールバック解析）`);

  // PDF でないものは弾く。
  const rejected = await fetch(`${url}/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', 'X-File-Name': 'not.pdf' },
    body: Buffer.from('hello'),
  });
  assert.equal(rejected.status, 400);
  step('PDF でないアップロードを拒否');

  // --- 文の取得と座標 ------------------------------------------------------
  const document = (await (await fetch(`${url}/api/documents/${id}`)).json()) as {
    structure: { parser: string; sentences: { hash: string; text: string; rects: unknown[] }[] };
  };
  assert.equal(document.structure.parser, 'fallback');
  const withRects = document.structure.sentences.filter((s) => s.rects.length > 0).length;
  assert.ok(withRects > 0, '座標付きの文が 1 つも無い');
  step(`文に座標が付いている: ${withRects}/${document.structure.sentences.length}`);

  // --- 訳の一括書き込み ----------------------------------------------------
  const entries = document.structure.sentences.slice(0, 3).map((sentence, index) => ({
    sentenceHash: sentence.hash,
    text: `テスト訳 ${index + 1}`,
  }));
  const write = await fetch(`${url}/api/documents/${id}/translations`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries, source: 'claude' }),
  });
  assert.equal(write.status, 200);
  assert.equal(((await write.json()) as { applied: number }).applied, 3);
  step('訳を 3 件まとめて書き込み');

  // 人手修正 → 機械訳では上書きされない。
  const target = entries[0]!.sentenceHash;
  await fetch(`${url}/api/documents/${id}/translations/${target}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '人手で直した訳', source: 'human' }),
  });
  const overwrite = await fetch(`${url}/api/documents/${id}/translations`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ sentenceHash: target, text: '機械が上書きを試みる' }], source: 'claude' }),
  });
  const overwriteResult = (await overwrite.json()) as { applied: number; skipped: unknown[] };
  assert.equal(overwriteResult.applied, 0);
  assert.equal(overwriteResult.skipped.length, 1);
  step('人手修正済みの訳が機械訳に上書きされない');

  // --- メモ ---------------------------------------------------------------
  const note = await fetch(`${url}/api/documents/${id}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sentenceHash: target, body: 'ここが主張の核心', author: 'e2e' }),
  });
  assert.equal(note.status, 201);
  step('メモを追加');

  // --- SSE が届いていること ------------------------------------------------
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(events.includes('document.created'), `SSE に document.created が無い: ${events.join(',')}`);
  assert.ok(events.includes('note.changed'), `SSE に note.changed が無い: ${events.join(',')}`);
  step(`SSE で ${events.length} 件のイベントを受信`);

  // --- 書き出し ------------------------------------------------------------
  const exported = await fetch(`${url}/api/documents/${id}/export`);
  assert.equal(exported.status, 200);
  const html = await exported.text();
  assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(html), '書き出し HTML が外部 URL を参照している');
  assert.ok(html.includes('人手で直した訳'), '静的フォールバックに訳が入っていない');
  assert.ok(html.includes('ここが主張の核心'), '静的フォールバックにメモが入っていない');
  const exportPath = join(dataDir, 'export.html');
  await writeFile(exportPath, html, 'utf8');
  step(`自己完結 HTML を書き出し（${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB、外部参照ゼロ）`);

  // --- 取り込み ------------------------------------------------------------
  const second = await fetch(`${url}/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', 'X-File-Name': 'sample-copy.pdf' },
    body: pdf,
  });
  const secondId = ((await second.json()) as { documentId: string }).documentId;
  const imported = await fetch(`${url}/api/documents/${secondId}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/html' },
    body: html,
  });
  assert.equal(imported.status, 200);
  const report = ((await imported.json()) as { report: Record<string, number> }).report;
  assert.ok(report['translationsAdded']! >= 3, `訳が復元されていない: ${JSON.stringify(report)}`);
  assert.equal(report['notesAdded'], 1);
  step(`別文書へ取り込み: 訳 +${report['translationsAdded']} / メモ +${report['notesAdded']}`);

  // --- MCP を stdio で起動 -------------------------------------------------
  const mcp = spawn(process.execPath, ['--experimental-strip-types', 'packages/mcp/src/index.ts'], {
    env: { ...process.env, LOGIXIV_URL: url, NODE_NO_WARNINGS: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const responses = new Map<number, unknown>();
  const rl = createInterface({ input: mcp.stdout });
  rl.on('line', (line) => {
    try {
      const message = JSON.parse(line) as { id?: number };
      if (typeof message.id === 'number') responses.set(message.id, message);
    } catch {
      // JSON-RPC 以外は無視。
    }
  });

  const send = (payload: unknown): void => {
    mcp.stdin.write(`${JSON.stringify(payload)}\n`);
  };
  const waitFor = async (requestId: number, timeoutMs = 10_000): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = responses.get(requestId);
      if (found) return found as Record<string, unknown>;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`MCP の応答待ちがタイムアウトしました (id=${requestId})`);
  };

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'logixiv-e2e', version: '0.1.0' },
    },
  });
  await waitFor(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  step('MCP を stdio で起動して初期化');

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = (await waitFor(2)) as { result: { tools: { name: string }[] } };
  assert.deepEqual(
    tools.result.tools.map((t) => t.name).sort(),
    [...TOOL_NAMES].sort(),
    'ツールの一覧が TOOL_NAMES と食い違っている',
  );
  step(`MCP ツール ${tools.result.tools.length} 個を列挙: ${tools.result.tools.map((t) => t.name).join(', ')}`);

  send({ jsonrpc: '2.0', id: 3, method: 'prompts/list' });
  const prompts = (await waitFor(3)) as { result: { prompts: { name: string }[] } };
  assert.equal(prompts.result.prompts.length, 1);
  step(`MCP プロンプト ${prompts.result.prompts.length} 個を列挙: ${prompts.result.prompts[0]!.name}`);

  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_documents', arguments: {} } });
  const listed = (await waitFor(4)) as { result: { content: { text: string }[] } };
  assert.ok(listed.result.content[0]!.text.includes(id), 'MCP から文書一覧が取れていない');
  step('MCP の list_documents が本体の文書を返した');

  send({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'get_translation_batch', arguments: { document_id: id, from: 0, limit: 5 } },
  });
  const batch = (await waitFor(5)) as { result: { content: { text: string }[] } };
  const batchPayload = JSON.parse(batch.result.content[0]!.text) as {
    window: unknown[][];
    untranslated: number[];
    nextUntranslatedFrom: number | null;
  };
  assert.ok(batchPayload.window.length > 0, '文脈の窓が空');
  assert.ok(batchPayload.untranslated.length > 0, '未訳の一覧が空');
  // 文脈が重複展開されていないこと（原文 1 文につき 1 回だけ現れる）。
  const raw = batch.result.content[0]!.text;
  const firstText = String(batchPayload.window[0]![2]);
  const occurrences = raw.split(firstText.slice(0, 30)).length - 1;
  assert.equal(occurrences, 1, `文脈が重複して展開されている（${occurrences} 回出現）`);
  step(`MCP の get_translation_batch が重複なしで ${batchPayload.window.length} 文を返した`);

  // 訳さないと記録した文は、未訳として返ってこなくなる。
  const targetHash = String(batchPayload.window[0]![1]);
  send({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'skip_sentences', arguments: { document_id: id, sentence_hashes: [targetHash], reason: 'reference' } },
  });
  const skipResult = (await waitFor(6)) as { result: { content: { text: string }[] } };
  assert.ok(JSON.parse(skipResult.result.content[0]!.text).skipped >= 1, '訳さない記録が効いていない');

  send({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'get_translation_batch', arguments: { document_id: id, from: 0, limit: 5 } },
  });
  const afterSkip = (await waitFor(7)) as { result: { content: { text: string }[] } };
  const afterPayload = JSON.parse(afterSkip.result.content[0]!.text) as {
    window: unknown[][];
    untranslated: number[];
  };
  const skippedOrder = Number(batchPayload.window[0]![0]);
  assert.ok(!afterPayload.untranslated.includes(skippedOrder), '訳さないと記録した文がまた未訳で返っている');
  step('MCP の skip_sentences で未訳から外れることを確認');

  // 文の区切りを MCP から直せること。直すと hash が変わるので、返答がそれを伝えること。
  const mergeA = String(afterPayload.window[0]![1]);
  const mergeB = String(afterPayload.window[1]![1]);
  send({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: {
      name: 'fix_sentence_boundary',
      arguments: { document_id: id, action: 'merge', sentence_hashes: [mergeA, mergeB] },
    },
  });
  const fixResult = (await waitFor(8)) as { result: { content: { text: string }[] } };
  const fixPayload = JSON.parse(fixResult.result.content[0]!.text) as {
    applied: boolean;
    editId: string;
    hint: string;
  };
  assert.equal(fixPayload.applied, true, '文の結合が適用されていない');
  assert.match(fixPayload.hint, /ハッシュが変わりました/, '結合後の注意書きが返っていない');

  const mergedDocument = (await (await fetch(`${url}/api/documents/${id}`)).json()) as {
    structure: { sentences: { hash: string; text: string }[] };
  };
  assert.ok(
    mergedDocument.structure.sentences.every((s) => s.hash !== mergeA && s.hash !== mergeB),
    '結合前の文が残っている',
  );
  step('MCP の fix_sentence_boundary で 2 文を 1 文に結合');

  send({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: 'fix_sentence_boundary', arguments: { document_id: id, action: 'undo' } },
  });
  const undoResult = (await waitFor(9)) as { result: { content: { text: string }[] } };
  assert.match(undoResult.result.content[0]!.text, /取り消しました/, '区切りの取り消しが効いていない');
  const restoredDocument = (await (await fetch(`${url}/api/documents/${id}`)).json()) as {
    structure: { sentences: { hash: string }[] };
  };
  assert.ok(
    restoredDocument.structure.sentences.some((s) => s.hash === mergeA),
    '取り消しで元の文が戻っていない',
  );
  step('MCP の fix_sentence_boundary で区切りを元に戻せることを確認');

  mcp.kill('SIGTERM');
  sseController.abort();
} catch (error) {
  failure = error;
} finally {
  await close();
  await rm(dataDir, { recursive: true, force: true });
}

if (failure) {
  console.error('\nE2E スモークテスト失敗:');
  console.error(failure);
  process.exit(1);
}

console.log(`\nE2E スモークテスト成功（${steps.length} ステップ）`);
