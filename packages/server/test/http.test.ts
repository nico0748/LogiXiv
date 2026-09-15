import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';

import { start } from '../src/start.ts';
import { makeSamplePdf } from '../../../scripts/make-sample-pdf.ts';

/**
 * サーバー層の回帰テスト。
 * サイクル1の批評で、実際にリクエストを投げて再現させた不具合を固定してある。
 */

let baseUrl = '';
let port = 0;
let dataDir = '';
let close: () => Promise<void> = async () => {};

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'logixiv-http-test-'));
  // 到達しないポートを指定して、フォールバック解析（ワーカー経路）を必ず通す。
  const started = await start({ port: 0, dataDir, grobidUrl: 'http://127.0.0.1:9', webDir: null });
  baseUrl = started.url;
  port = (started.server.address() as { port: number }).port;
  close = started.close;
});

after(async () => {
  await close();
  await rm(dataDir, { recursive: true, force: true });
});

async function ingest(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', 'X-File-Name': 'sample.pdf' },
    body: makeSamplePdf(),
  });
  assert.equal(response.status, 201);
  return ((await response.json()) as { documentId: string }).documentId;
}

/** Host ヘッダを自由に指定するための生ソケット。 */
function rawRequest(lines: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
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

test('解析中もサーバーが応答し続ける（イベントループを塞がない）', async () => {
  const started = Date.now();
  const ingesting = fetch(`${baseUrl}/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', 'X-File-Name': 'concurrent.pdf' },
    body: makeSamplePdf(),
  });
  // 解析が走っている最中に別のリクエストを通す。
  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.ok(Date.now() - started < 5000, '解析中に health が待たされている');
  assert.equal((await ingesting).status, 201);
});

test('壊れた document を新規取り込みしても、一覧 API が落ちない', async () => {
  const poisoned = JSON.stringify({
    format: 'logixiv-export',
    formatVersion: 1,
    pdfBase64: Buffer.from(makeSamplePdf()).toString('base64'),
    document: {
      title: 'poisoned',
      structure: { sentences: [{ hash: 'aa', text: 'A poisoned sentence.' }] },
      annotations: null,
    },
  });
  const html = `<script type="application/json" id="logixiv-data">${poisoned}</script>`;

  const seed = await ingest();
  const imported = await fetch(`${baseUrl}/api/documents/${seed}/import?merge=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/html' },
    body: html,
  });
  assert.equal(imported.status, 200);

  const list = await fetch(`${baseUrl}/api/documents`);
  const listBody = await list.text();
  assert.equal(list.status, 200, listBody);
  const documents = (JSON.parse(listBody) as { documents: { id: string }[] }).documents;
  assert.ok(documents.length >= 2);
});

test('非文字列のフィールドは 400 で弾かれ、保存されない', async () => {
  const id = await ingest();
  const document = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
    structure: { sentences: { hash: string }[] };
  };
  const hash = document.structure.sentences[0]!.hash;

  const badTranslation = await fetch(`${baseUrl}/api/documents/${id}/translations`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ sentenceHash: hash, text: { a: [1, 2] } }] }),
  });
  assert.equal(badTranslation.status, 400);

  const badGlossary = await fetch(`${baseUrl}/api/documents/${id}/glossary`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ term: { x: 1 }, translation: 123 }] }),
  });
  assert.equal(badGlossary.status, 400);

  // 検索が壊れていないこと（以前はここで恒久 500 になった）。
  const search = await fetch(`${baseUrl}/api/documents/${id}/search?q=the`);
  assert.equal(search.status, 200);
});

test('body の無いメモ PATCH は 400（body キーの消えたメモを作らない）', async () => {
  const id = await ingest();
  const document = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
    structure: { sentences: { hash: string }[] };
  };
  const created = await fetch(`${baseUrl}/api/documents/${id}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sentenceHash: document.structure.sentences[0]!.hash, body: 'メモ' }),
  });
  assert.equal(created.status, 201);
  const noteId = ((await created.json()) as { id: string }).id;

  const patched = await fetch(`${baseUrl}/api/documents/${id}/notes/${noteId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(patched.status, 400);
});

test('存在しない hash へのメモは 400 で拒否される', async () => {
  const id = await ingest();
  const response = await fetch(`${baseUrl}/api/documents/${id}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sentenceHash: 'deadbeefdeadbeef', body: 'どこにも出ないメモ' }),
  });
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { applied: boolean }).applied, false);
});

test('再解析中に入った翻訳が消えない', async () => {
  const id = await ingest();
  const document = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
    structure: { sentences: { hash: string }[] };
  };
  const hash = document.structure.sentences[0]!.hash;

  const reparsing = fetch(`${baseUrl}/api/documents/${id}/reparse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parser: 'fallback' }),
  });
  // 解析の最中に書き込む。
  const wrote = await fetch(`${baseUrl}/api/documents/${id}/translations/${hash}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '解析中に入れた訳', source: 'human' }),
  });
  assert.equal(wrote.status, 200);
  assert.equal((await reparsing).status, 200);

  const after = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
    annotations: { translations: Record<string, { text: string }> };
  };
  assert.equal(after.annotations.translations[hash]?.text, '解析中に入れた訳');
});

test('削除した文書が再解析でゾンビとして復活しない', async () => {
  const id = await ingest();
  const reparsing = fetch(`${baseUrl}/api/documents/${id}/reparse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parser: 'fallback' }),
  });
  const deleted = await fetch(`${baseUrl}/api/documents/${id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  const reparsed = await reparsing;
  assert.ok(reparsed.status === 404 || reparsed.status === 200);

  const list = (await (await fetch(`${baseUrl}/api/documents`)).json()) as { documents: { id: string }[] };
  const survivors = list.documents.filter((d) => d.id === id);
  if (survivors.length > 0) {
    // 残っているなら PDF も一緒に残っていること（document.json だけのゾンビは不可）。
    const pdf = await fetch(`${baseUrl}/api/documents/${id}/pdf`);
    assert.equal(pdf.status, 200);
  }
  const entries = await readdir(join(dataDir, 'documents')).catch(() => []);
  assert.ok(!entries.includes(id) || survivors.length > 0);
});

test('Host ヘッダが無い・空・外部ドメインのリクエストを拒否する', async () => {
  assert.match(await rawRequest(['GET /api/health HTTP/1.0']), /^HTTP\/1\.1 403/);
  assert.match(await rawRequest(['GET /api/health HTTP/1.1', 'Host: ']), /^HTTP\/1\.1 403/);
  assert.match(await rawRequest(['GET /api/health HTTP/1.1', 'Host: evil.com']), /^HTTP\/1\.1 403/);
  assert.match(await rawRequest(['GET /api/health HTTP/1.1', `Host: 127.0.0.1:${port}`]), /^HTTP\/1\.1 200/);
});

test('不正なパーセントエスケープで 500 にならない', async () => {
  const response = await fetch(`${baseUrl}/%`);
  assert.notEqual(response.status, 500);

  const upload = await fetch(`${baseUrl}/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', 'X-File-Name': '%E0%A4%A' },
    body: makeSamplePdf(),
  });
  assert.notEqual(upload.status, 500);
});

test('SSE は GET 以外を受け付けない', async () => {
  const response = await fetch(`${baseUrl}/api/events`, { method: 'POST' });
  assert.equal(response.status, 405);
});

test('レスポンスに nosniff が付く', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('書き込みを断った理由に機械可読なコードが付く', async () => {
  const id = await ingest();
  const document = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
    structure: { sentences: { hash: string }[] };
  };
  const hash = document.structure.sentences[0]!.hash;
  await fetch(`${baseUrl}/api/documents/${id}/translations/${hash}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '人手の訳', source: 'human' }),
  });

  const response = await fetch(`${baseUrl}/api/documents/${id}/translations`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'claude',
      entries: [
        { sentenceHash: hash, text: '機械の訳' },
        { sentenceHash: 'deadbeefdeadbeef', text: '存在しない文への訳' },
      ],
    }),
  });
  const result = (await response.json()) as { applied: number; skipped: { code: string }[] };
  assert.equal(result.applied, 0);
  assert.deepEqual(
    result.skipped.map((s) => s.code).sort(),
    ['revised_by_human', 'unknown_hash'],
  );
});

test('用語集は POST で追記でき、PUT で置換になる', async () => {
  const id = await ingest();
  await fetch(`${baseUrl}/api/documents/${id}/glossary`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ term: 'sparse', translation: '疎' }] }),
  });
  const appended = await fetch(`${baseUrl}/api/documents/${id}/glossary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ term: 'kernel', translation: 'カーネル' }] }),
  });
  assert.deepEqual(await appended.json(), { added: 1, updated: 0, total: 2 });

  const replaced = await fetch(`${baseUrl}/api/documents/${id}/glossary`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ term: 'only', translation: 'これだけ' }] }),
  });
  assert.equal(replaced.status, 200);
  const document = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
    annotations: { glossary: { term: string }[] };
  };
  assert.deepEqual(
    document.annotations.glossary.map((entry) => entry.term),
    ['only'],
  );

  // 空配列での置換は断る。確認も無く用語集が消えるのは、取り返しがつかない操作。
  const wiped = await fetch(`${baseUrl}/api/documents/${id}/glossary`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [] }),
  });
  assert.equal(wiped.status, 400);
});

test('空の訳は入口で断る（永久に「訳し終わった」ことにしない）', async () => {
  const id = await ingest();
  const document = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
    structure: { sentences: { hash: string }[] };
  };
  const hash = document.structure.sentences[0]!.hash;

  const single = await fetch(`${baseUrl}/api/documents/${id}/translations/${hash}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '   ', source: 'human' }),
  });
  assert.equal(single.status, 400);

  const batch = await fetch(`${baseUrl}/api/documents/${id}/translations`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ sentenceHash: hash, text: '' }] }),
  });
  assert.equal(batch.status, 400);

  const after = (await (await fetch(`${baseUrl}/api/documents/${id}/untranslated?limit=5`)).json()) as {
    sentences: { sentenceHash: string }[];
  };
  assert.ok(after.sentences.some((s) => s.sentenceHash === hash), '空の訳で未訳から外れている');
});

test('hash から文を引ける', async () => {
  const id = await ingest();
  const document = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
    structure: { sentences: { hash: string; text: string }[] };
  };
  const target = document.structure.sentences[1]!;
  const response = await fetch(`${baseUrl}/api/documents/${id}/sentences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes: [target.hash] }),
  });
  const result = (await response.json()) as { sentences: { text: string; order: number }[] };
  assert.equal(result.sentences.length, 1);
  assert.equal(result.sentences[0]!.text, target.text);
});

test('訳さないと記録した文が未訳から外れる', async () => {
  const id = await ingest();
  const document = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
    structure: { sentences: { hash: string }[] };
  };
  const hash = document.structure.sentences[0]!.hash;

  const before = (await (await fetch(`${baseUrl}/api/documents/${id}/untranslated?limit=50`)).json()) as {
    sentences: { sentenceHash: string }[];
  };
  assert.ok(before.sentences.some((s) => s.sentenceHash === hash));

  const skipped = await fetch(`${baseUrl}/api/documents/${id}/skip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes: [hash], reason: 'reference' }),
  });
  assert.equal(skipped.status, 200);
  assert.equal(((await skipped.json()) as { applied: number }).applied, 1);

  const after = (await (await fetch(`${baseUrl}/api/documents/${id}/untranslated?limit=50`)).json()) as {
    sentences: { sentenceHash: string }[];
  };
  assert.ok(!after.sentences.some((s) => s.sentenceHash === hash), '訳さない記録が効いていない');

  // 取り消せる。
  const undone = await fetch(`${baseUrl}/api/documents/${id}/skip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes: [hash], undo: true }),
  });
  assert.equal(((await undone.json()) as { applied: number }).applied, 1);
  const restored = (await (await fetch(`${baseUrl}/api/documents/${id}/untranslated?limit=50`)).json()) as {
    sentences: { sentenceHash: string }[];
  };
  assert.ok(restored.sentences.some((s) => s.sentenceHash === hash));
});

test('同じ hash を重複して送ると 1 件として扱われ、波及件数が返る', async () => {
  const id = await ingest();
  const document = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
    structure: { sentences: { hash: string }[] };
  };
  const hash = document.structure.sentences[0]!.hash;
  const response = await fetch(`${baseUrl}/api/documents/${id}/translations`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'claude',
      entries: [
        { sentenceHash: hash, text: '訳A' },
        { sentenceHash: hash, text: '訳B' },
      ],
    }),
  });
  const result = (await response.json()) as { applied: number; duplicates: string[]; sentencesAffected: number };
  assert.equal(result.applied, 1, '重複が 2 件と数えられている');
  assert.deepEqual(result.duplicates, [hash]);
  assert.ok(result.sentencesAffected >= 1);

  const after = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
    annotations: { translations: Record<string, { text: string }> };
  };
  assert.equal(after.annotations.translations[hash]!.text, '訳B', '後勝ちになっていない');
});

test('検索に総数と打ち切りフラグが付く', async () => {
  const id = await ingest();
  const result = (await (await fetch(`${baseUrl}/api/documents/${id}/search?q=the&limit=2`)).json()) as {
    total: number;
    truncated: boolean;
    hits: unknown[];
  };
  assert.ok(result.hits.length <= 2);
  assert.equal(typeof result.total, 'number');
  assert.equal(typeof result.truncated, 'boolean');
});

test('検索結果に訳文が入る', async () => {
  const id = await ingest();
  const document = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
    structure: { sentences: { hash: string }[] };
  };
  await fetch(`${baseUrl}/api/documents/${id}/translations/${document.structure.sentences[0]!.hash}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '疎な注意機構を検討する', source: 'human' }),
  });
  const hits = (await (await fetch(`${baseUrl}/api/documents/${id}/search?q=${encodeURIComponent('注意機構')}`)).json()) as {
    hits: { translation: string | null; order: number }[];
  };
  assert.equal(hits.hits.length, 1);
  assert.equal(hits.hits[0]!.translation, '疎な注意機構を検討する');
  assert.equal(typeof hits.hits[0]!.order, 'number');
});

test('文の結合と分割ができ、再解析しても保たれる', async () => {
  const id = await ingest();
  const read = async () =>
    (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
      structure: { sentences: { hash: string; text: string }[] };
      annotations: { sentenceEdits?: { id: string }[] };
    };

  const before = await read();
  const [first, second] = before.structure.sentences;
  const expected = `${first!.text} ${second!.text}`.replace(/\s+/g, ' ').trim();

  const merged = (await (
    await fetch(`${baseUrl}/api/documents/${id}/sentence-edits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'merge', hashes: [first!.hash, second!.hash] }),
    })
  ).json()) as { applied: boolean; occurrences: number; editId?: string };
  assert.equal(merged.applied, true);
  assert.ok(merged.occurrences >= 1);

  const afterMerge = await read();
  assert.equal(afterMerge.structure.sentences.length, before.structure.sentences.length - merged.occurrences);
  assert.equal(afterMerge.structure.sentences[0]!.text, expected);
  assert.equal(afterMerge.annotations.sentenceEdits?.length, 1);

  // 結合した文に訳を付けてから再解析し、区切りごと残ることを確かめる。
  const mergedHash = afterMerge.structure.sentences[0]!.hash;
  const put = await fetch(`${baseUrl}/api/documents/${id}/translations/${mergedHash}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '結合した文の訳', source: 'human' }),
  });
  assert.equal(put.status, 200);

  const reparsed = (await (
    await fetch(`${baseUrl}/api/documents/${id}/reparse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parser: 'fallback' }),
    })
  ).json()) as { editsReapplied: number; editsDropped: number };
  assert.equal(reparsed.editsReapplied, 1);
  assert.equal(reparsed.editsDropped, 0);

  const afterReparse = await read();
  assert.equal(afterReparse.structure.sentences[0]!.text, expected);

  // 取り消すと元の 2 文に戻り、記録も消える。
  const undone = (await (
    await fetch(`${baseUrl}/api/documents/${id}/sentence-edits`, { method: 'DELETE' })
  ).json()) as { applied: boolean };
  assert.equal(undone.applied, true);

  const restored = await read();
  assert.equal(restored.structure.sentences[0]!.text, first!.text);
  assert.equal(restored.structure.sentences[1]!.text, second!.text);
  assert.equal(restored.annotations.sentenceEdits?.length, 0);
});

test('分割は文字位置で行われ、当てられない指定は 200 + applied:false で返る', async () => {
  const id = await ingest();
  const document = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
    structure: { sentences: { hash: string; text: string }[] };
  };
  const target = document.structure.sentences.find((s) => s.text.length > 20)!;
  const at = 10;

  const split = (await (
    await fetch(`${baseUrl}/api/documents/${id}/sentence-edits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'split', hashes: [target.hash], offsets: [at] }),
    })
  ).json()) as { applied: boolean };
  assert.equal(split.applied, true);

  const after = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
    structure: { sentences: { text: string }[] };
  };
  assert.ok(after.structure.sentences.some((s) => s.text === target.text.slice(0, at).trim()));
  assert.ok(after.structure.sentences.some((s) => s.text === target.text.slice(at).trim()));

  const missing = await fetch(`${baseUrl}/api/documents/${id}/sentence-edits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'split', hashes: ['0123456789abcdef'], offsets: [3] }),
  });
  assert.equal(missing.status, 200);
  const body = (await missing.json()) as { applied: boolean; reason?: string };
  assert.equal(body.applied, false);
  assert.match(body.reason ?? '', /見つかりません/);
});

test('区切り直しの入力検証（型・件数）', async () => {
  const id = await ingest();
  const post = (payload: unknown) =>
    fetch(`${baseUrl}/api/documents/${id}/sentence-edits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  assert.equal((await post({ type: 'nope', hashes: ['a', 'b'] })).status, 400);
  assert.equal((await post({ type: 'merge', hashes: ['a'] })).status, 400);
  assert.equal((await post({ type: 'split', hashes: ['a', 'b'], offsets: [1] })).status, 400);
  assert.equal((await post({ type: 'split', hashes: ['a'], offsets: [] })).status, 400);
  assert.equal((await post({ type: 'split', hashes: ['a'], offsets: [-1] })).status, 400);
  assert.equal((await post({ type: 'merge', hashes: [1, 2] })).status, 400);
});

test('区切りを直すと、外れる注釈の件数が返る', async () => {
  const id = await ingest();
  const document = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
    structure: { sentences: { hash: string }[] };
  };
  const [first, second] = document.structure.sentences;
  await fetch(`${baseUrl}/api/documents/${id}/translations/${first!.hash}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '一文目の訳', source: 'human' }),
  });
  await fetch(`${baseUrl}/api/documents/${id}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sentenceHash: first!.hash, body: 'メモ' }),
  });

  const merged = (await (
    await fetch(`${baseUrl}/api/documents/${id}/sentence-edits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'merge', hashes: [first!.hash, second!.hash] }),
    })
  ).json()) as {
    applied: boolean;
    resultHashes: string[];
    detached: { translations: number; notes: number; skipped: number };
  };
  assert.equal(merged.applied, true);
  assert.equal(merged.detached.translations, 1);
  assert.equal(merged.detached.notes, 1);
  assert.equal(merged.resultHashes.length, 1);

  const after = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
    structure: { sentences: { hash: string }[] };
  };
  assert.equal(after.structure.sentences[0]!.hash, merged.resultHashes[0]);
});

test('他人の書き出しに入っていた区切りの直しを取り込み、訳を拾える', async () => {
  const source = await ingest();
  const target = await ingest();

  const document = (await (await fetch(`${baseUrl}/api/documents/${source}`)).json()) as {
    structure: { sentences: { hash: string }[] };
  };
  const [first, second] = document.structure.sentences;
  await fetch(`${baseUrl}/api/documents/${source}/sentence-edits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'merge', hashes: [first!.hash, second!.hash] }),
  });
  const mergedDocument = (await (await fetch(`${baseUrl}/api/documents/${source}`)).json()) as {
    structure: { sentences: { hash: string }[] };
  };
  const mergedHash = mergedDocument.structure.sentences[0]!.hash;
  await fetch(`${baseUrl}/api/documents/${source}/translations/${mergedHash}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'まとめた文の訳', source: 'human' }),
  });

  const html = await (await fetch(`${baseUrl}/api/documents/${source}/export`)).text();
  const imported = (await (
    await fetch(`${baseUrl}/api/documents/${target}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/html' },
      body: html,
    })
  ).json()) as { report: { translationsAdded: number; orphaned: number; sentenceEditsAdopted: number } };

  assert.equal(imported.report.sentenceEditsAdopted, 1, '区切りの直しが取り込まれていない');
  assert.equal(imported.report.orphaned, 0, '区切りを揃えたのに訳が捨てられている');

  const result = (await (await fetch(`${baseUrl}/api/documents/${target}`)).json()) as {
    structure: { sentences: { hash: string }[] };
    annotations: { translations: Record<string, { text: string }> };
  };
  assert.equal(result.structure.sentences[0]!.hash, mergedHash);
  assert.equal(result.annotations.translations[mergedHash]?.text, 'まとめた文の訳');
});

test('他人の書き出しを、1 本も持っていない状態から取り込める', async () => {
  // 以前は既存の文書 ID を経路に書いて ?merge=false を付けるしかなく、
  // 0 本のときは書ける ID が無いので実際には到達できなかった。
  const source = await ingest();
  const html = await (await fetch(`${baseUrl}/api/documents/${source}/export`)).text();

  const response = await fetch(`${baseUrl}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/html' },
    body: html,
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const { documentId } = JSON.parse(text) as { documentId: string };
  assert.notEqual(documentId, source, '同じ文書に上書きしている');

  const imported = (await (await fetch(`${baseUrl}/api/documents/${documentId}`)).json()) as {
    structure: { sentences: unknown[] };
  };
  assert.ok(imported.structure.sentences.length > 0);
  // PDF も一緒に入る（本文だけでは元のページを見られない）。
  assert.equal((await fetch(`${baseUrl}/api/documents/${documentId}/pdf`)).status, 200);
});

test('PDF でないバイト列は、取り込み経路からも入れない', async () => {
  const source = await ingest();
  const html = await (await fetch(`${baseUrl}/api/documents/${source}/export`)).text();
  const notPdf = Buffer.from('<html>not a pdf at all</html>', 'utf8').toString('base64');
  const tampered = html.replace(/"pdfBase64":"[^"]*"/, `"pdfBase64":"${notPdf}"`);
  assert.notEqual(tampered, html, '前提: pdfBase64 を差し替えられている');

  const response = await fetch(`${baseUrl}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/html' },
    body: tampered,
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /PDF ではない/);
});

test('新しい版で書かれた書き出しは、保存せずに断る', async () => {
  // 保存できてしまうと、一覧に出ないのにディスクには在って、開くと 500 になる
  // 文書ができる。利用者からは見えも消せもしない。
  const source = await ingest();
  const html = await (await fetch(`${baseUrl}/api/documents/${source}/export`)).text();
  const future = html.replace(/"version":\s*\d+/, '"version":999');
  assert.notEqual(future, html, '前提: 構造バージョンを差し替えられている');

  const before = ((await (await fetch(`${baseUrl}/api/documents`)).json()) as { documents: unknown[] }).documents
    .length;
  const response = await fetch(`${baseUrl}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/html' },
    body: future,
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /新しい版/);

  const after = ((await (await fetch(`${baseUrl}/api/documents`)).json()) as { documents: unknown[] }).documents
    .length;
  assert.equal(after, before, '断ったはずの文書が保存されている');
});

test('読めない文書も一覧に行として出る（見えも消せもしない状態を作らない）', async () => {
  const id = await ingest();
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await writeFile(join(dataDir, 'documents', id, 'document.json'), '{ this is not json', 'utf8');

  const list = (await (await fetch(`${baseUrl}/api/documents`)).json()) as {
    documents: { id: string; title: string }[];
  };
  const row = list.documents.find((d) => d.id === id);
  assert.ok(row, '読めない文書が一覧から消えている');
  assert.match(row!.title, /開けません|読み込めませんでした/);
});

test('画面に出す Claude の設定が、実際に開いた URL と一致する', async () => {
  // ここがずれると、貼った設定で Claude が本体に繋がらない。
  const health = (await (await fetch(`${baseUrl}/api/health`)).json()) as {
    mcp: { entry: string | null; url: string };
  };
  assert.equal(health.mcp.url, baseUrl);
  assert.ok(health.mcp.entry === null || health.mcp.entry.endsWith('packages/mcp/dist/index.js'));
});

test('題名は直せる', async () => {
  const id = await ingest();
  const response = await fetch(`${baseUrl}/api/documents/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '  ブロック疎な注意機構  ' }),
  });
  assert.equal(response.status, 200);
  const document = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as { title: string };
  assert.equal(document.title, 'ブロック疎な注意機構');

  const empty = await fetch(`${baseUrl}/api/documents/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '   ' }),
  });
  assert.equal(empty.status, 400);
});
