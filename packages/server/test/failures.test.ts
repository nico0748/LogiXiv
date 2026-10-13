import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_PDF_BYTES } from '../src/api.ts';
import { start } from '../src/start.ts';
import { makeSamplePdf } from '../../../scripts/make-sample-pdf.ts';

/**
 * 「壊れた入力に当たったとき、人が次に何をすればいいか分かるか」の回帰テスト。
 *
 * 実機レビューで見つかった、サーバー側が人を裏切る箇所を固定してある:
 *  - 壊れた document.json の文書が、一覧には出るのに削除できない（DELETE が 500）
 *  - 壊れた PDF の失敗表示が pdf.js の英語（`No password given` など）のまま
 *  - 用語集の上限が、書き出し HTML の取り込み経路だけ効かない
 *  - 「取り込めたのに書き出せない」大きさの PDF が作れてしまう
 */

const here = dirname(fileURLToPath(import.meta.url));

let baseUrl = '';
let dataDir = '';
let close: () => Promise<void> = async () => {};

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'paperlens-failure-test-'));
  // 到達しないポートを指定して、フォールバック解析（pdf.js 経路）を必ず通す。
  const started = await start({ port: 0, dataDir, grobidUrl: 'http://127.0.0.1:9', webDir: null });
  baseUrl = started.url;
  close = started.close;
});

after(async () => {
  await close();
  await rm(dataDir, { recursive: true, force: true });
});

async function ingest(body: Uint8Array, fileName = 'sample.pdf'): Promise<Response> {
  return fetch(`${baseUrl}/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', 'X-File-Name': fileName },
    body,
  });
}

async function ingestOk(fileName = 'sample.pdf'): Promise<string> {
  const response = await ingest(makeSamplePdf(), fileName);
  assert.equal(response.status, 201);
  return ((await response.json()) as { documentId: string }).documentId;
}

interface Row {
  id: string;
  title: string;
  unreadable: boolean;
  unreadableReason: string | null;
  path: string;
}

async function listDocuments(): Promise<Row[]> {
  const response = await fetch(`${baseUrl}/api/documents`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { documents: Row[] }).documents;
}

// --- (1) 壊れた document.json --------------------------------------------

test('document.json が途中で切れた文書も、一覧の行から削除できる', async () => {
  const id = await ingestOk('broken.pdf');
  const documentPath = join(dataDir, 'documents', id, 'document.json');
  // 書き込み中に電源が落ちた状態を作る（JSON.parse が必ず落ちる長さで切る）。
  await writeFile(documentPath, (await readFile(documentPath, 'utf8')).slice(0, 500));

  const row = (await listDocuments()).find((d) => d.id === id);
  assert.ok(row, '読めない文書が一覧から消えている（見えも消せもしない文書になる）');
  assert.equal(row.unreadable, true);
  assert.ok(row.unreadableReason && row.unreadableReason.length > 0, '読めない理由が返っていない');
  // 画面が自分でファイルを見にいけるように、置き場も返す。
  assert.equal(row.path, join(dataDir, 'documents', id));

  const deleted = await fetch(`${baseUrl}/api/documents/${id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200, await deleted.text());
  assert.equal(
    (await listDocuments()).find((d) => d.id === id),
    undefined,
    '削除したはずの行が一覧に残っている',
  );
});

test('document.json が 0 バイトでも削除できる', async () => {
  const id = await ingestOk('zero.pdf');
  await writeFile(join(dataDir, 'documents', id, 'document.json'), '');

  assert.ok(
    (await listDocuments()).some((d) => d.id === id),
    '0 バイトの文書が一覧に出ていない',
  );
  const deleted = await fetch(`${baseUrl}/api/documents/${id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200, await deleted.text());
});

test('document.json ごと無いディレクトリも、一覧に出て削除できる', async () => {
  // PDF だけ書けた直後に落ちた、という状態。消せないと永久にゴミが残る。
  const id = 'doc_orphan_dir_test';
  await mkdir(join(dataDir, 'documents', id), { recursive: true });
  await writeFile(join(dataDir, 'documents', id, 'source.pdf'), Buffer.from(makeSamplePdf()));

  assert.ok(
    (await listDocuments()).some((d) => d.id === id),
    'document.json の無いディレクトリが一覧に出ていない',
  );
  const deleted = await fetch(`${baseUrl}/api/documents/${id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200, await deleted.text());
});

test('存在しない文書の削除は 404（削除が何でも 200 を返すようにはしない）', async () => {
  const deleted = await fetch(`${baseUrl}/api/documents/doc_never_existed/`, { method: 'DELETE' });
  assert.equal(deleted.status, 404);
});

// --- (2) 壊れた PDF -------------------------------------------------------

interface Failure {
  error: string;
  code?: string;
  fileName?: string | null;
  detail?: string | null;
}

test('暗号化された PDF は「暗号化されている」と分かる日本語で断られる', async () => {
  const encrypted = await readFile(join(here, 'fixtures/encrypted.pdf'));
  const response = await ingest(encrypted, 'publisher-paper.pdf');
  assert.equal(response.status, 422);

  const body = (await response.json()) as Failure;
  assert.equal(body.code, 'pdf_encrypted');
  // 人が最初に読む文に、pdf.js の英語がそのまま出てはいけない。
  assert.doesNotMatch(body.error, /No password given/);
  assert.match(body.error, /publisher-paper\.pdf/, 'どのファイルの話か書かれていない');
  assert.match(body.error, /暗号化/, 'なぜ失敗したのかが書かれていない');
  assert.match(body.error, /取り込み直/, '次に何をすればいいのかが書かれていない');
  // 元の英語は原因を追うために残す（人が最初に読む文にはしない）。
  assert.equal(body.detail, 'No password given');
  assert.equal(body.fileName, 'publisher-paper.pdf');
});

test('途中で切れた PDF は「途中で切れている」と分かる日本語で断られる', async () => {
  const full = makeSamplePdf();
  // ダウンロードが最後まで終わらなかった状態（末尾の %%EOF が無い）。
  const truncated = full.slice(0, Math.floor(full.length * 0.6));
  const response = await ingest(truncated, 'half-downloaded.pdf');
  assert.equal(response.status, 422);

  const body = (await response.json()) as Failure;
  assert.equal(body.code, 'pdf_truncated');
  assert.doesNotMatch(body.error, /Invalid PDF structure/);
  assert.match(body.error, /half-downloaded\.pdf/);
  assert.match(body.error, /途中で切れ/);
  assert.match(body.error, /落とし直/, '次にやることが書かれていない');
  assert.equal(body.detail, 'Invalid PDF structure.');
});

test('中身が壊れた PDF は、途中で切れた PDF とは別の文言で断られる', async () => {
  // 末尾の %%EOF は残したまま中身だけ潰す。人がやるべきことが「落とし直す」ではないので、
  // 「途中で切れています」と言ってはいけない。
  const broken = Buffer.from(makeSamplePdf());
  broken.fill(0x41, 40, Math.floor(broken.length * 0.7));
  const response = await ingest(broken, 'corrupt.pdf');
  assert.equal(response.status, 422);

  const body = (await response.json()) as Failure;
  assert.equal(body.code, 'pdf_corrupt');
  assert.doesNotMatch(body.error, /Invalid PDF structure/);
  assert.match(body.error, /壊れ/);
  assert.ok(body.detail && body.detail.length > 0, '元の英語が残っていない');
});

test('PDF でないファイルは「PDF ではない」と分かる日本語で断られる', async () => {
  const response = await ingest(Buffer.from('<!doctype html><p>Access denied</p>'), 'paper.pdf');
  // 入口の検査で断っている（＝そもそも PDF を送ってきていない）ので 400。
  assert.equal(response.status, 400);
  const body = (await response.json()) as Failure;
  assert.equal(body.code, 'pdf_not_pdf');
  assert.match(body.error, /paper\.pdf/);
  assert.match(body.error, /PDF ではない/);

  const empty = await ingest(new Uint8Array(0), 'empty.pdf');
  assert.equal(empty.status, 400);
  assert.match(((await empty.json()) as Failure).error, /空/);
});

test('source.pdf が消えた文書は、生の ENOENT ではなく日本語で答える', async () => {
  const id = await ingestOk('lost.pdf');
  await rm(join(dataDir, 'documents', id, 'source.pdf'));

  for (const path of ['/pdf', '/export']) {
    const response = await fetch(`${baseUrl}/api/documents/${id}${path}`);
    // 文書は在るが中身が欠けている、という状態なので 404。
    assert.equal(response.status, 404, `${path} が 404 を返していない`);
    const body = (await response.json()) as Failure;
    assert.equal(body.code, 'pdf_missing');
    assert.doesNotMatch(body.error, /^ENOENT/, `${path} が生の ENOENT を返している`);
    assert.match(body.error, /source\.pdf/);
    assert.match(body.error, /取り込み直|削除/, '次にやることが書かれていない');
  }

  // 書き出せるかどうかの問い合わせも、落ちずに「書き出せない」と答える。
  const document = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
    exportability: { exportable: boolean; pdfBytes: number | null; reason: string | null };
  };
  assert.equal(document.exportability.exportable, false);
  assert.equal(document.exportability.pdfBytes, null);
  assert.ok(document.exportability.reason);
});

// --- (3) 書き出せるかどうかを取り込んだ時点で返す --------------------------

test('取り込みの応答に「書き出せるか」が入っている（訳し終わってから知らせない）', async () => {
  const response = await ingest(makeSamplePdf(), 'exportable.pdf');
  assert.equal(response.status, 201);
  const body = (await response.json()) as {
    documentId: string;
    exportability: { pdfBytes: number; limitBytes: number; exportable: boolean; reason: string | null };
  };
  assert.equal(body.exportability.exportable, true);
  assert.ok(body.exportability.pdfBytes > 0);
  assert.equal(body.exportability.reason, null);

  // GET /api/documents/:id からも同じ判断が読める。
  const document = (await (await fetch(`${baseUrl}/api/documents/${body.documentId}`)).json()) as {
    exportability: { limitBytes: number; exportable: boolean };
  };
  assert.equal(document.exportability.exportable, true);
  assert.equal(document.exportability.limitBytes, body.exportability.limitBytes);
});

test('書き出せない大きさかどうかは、書き出す前に読める', async () => {
  const id = await ingestOk('limits.pdf');
  // 100MB を実際に流すとテストが遅くなるので、疎ファイルで大きさだけ作る。
  const pdfPath = join(dataDir, 'documents', id, 'source.pdf');
  await writeFile(pdfPath, '');
  await truncate(pdfPath, MAX_PDF_BYTES + 1);

  const document = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
    exportability: { pdfBytes: number; limitBytes: number; exportable: boolean; reason: string | null };
  };
  // 取り込みの上限（http.ts の MAX_UPLOAD_BYTES）はこの定数から作られているので、
  // 2 つの上限がずれること自体が起こらない。
  assert.equal(document.exportability.limitBytes, MAX_PDF_BYTES);
  assert.equal(document.exportability.exportable, false);
  assert.match(document.exportability.reason ?? '', /大きすぎ/);

  // 実際に押したときも同じ判断になる。
  const exported = await fetch(`${baseUrl}/api/documents/${id}/export`);
  assert.equal(exported.status, 413);
});

// --- (4) 用語集の上限は取り込み経路にも効く --------------------------------

/** 書き出し HTML の体裁だけを作る（埋め込み JS は使わないので JSON だけで足りる）。 */
function exportHtmlWith(document: unknown): string {
  const payload = JSON.stringify({ format: 'paperlens-export', formatVersion: 1, document });
  return `<script type="application/json" id="paperlens-data">${payload}</script>`;
}

function glossaryOf(count: number, prefix = 'term'): { term: string; translation: string; note: null }[] {
  return Array.from({ length: count }, (_, index) => ({
    term: `${prefix}${index}`,
    translation: `訳${index}`,
    note: null,
  }));
}

test('用語集の上限は、書き出し HTML の取り込みにも効く', async () => {
  const id = await ingestOk('glossary.pdf');
  const document = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
    annotations: Record<string, unknown>;
  };

  // 直接の PUT/POST では 2000 件で断られる経路。
  const direct = await fetch(`${baseUrl}/api/documents/${id}/glossary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: glossaryOf(3000) }),
  });
  assert.equal(direct.status, 400);

  // 取り込み経路も同じ上限で断る（ここが素通りしていて 3000 件入った）。
  const imported = await fetch(`${baseUrl}/api/documents/${id}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/html' },
    body: exportHtmlWith({
      ...document,
      annotations: { ...document.annotations, glossary: glossaryOf(3000) },
    }),
  });
  const importedBody = (await imported.json()) as { error: string };
  assert.equal(imported.status, 400, importedBody.error);
  assert.match(importedBody.error, /用語集/);

  const after = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
    annotations: { glossary: unknown[] };
  };
  assert.equal(after.annotations.glossary.length, 0, '断ったはずの用語集が入っている');
});

test('上限内の取り込みを重ねても、合計で上限を超えたら断る', async () => {
  const id = await ingestOk('glossary-sum.pdf');
  const document = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
    annotations: Record<string, unknown>;
  };
  const importGlossary = (entries: unknown[]): Promise<Response> =>
    fetch(`${baseUrl}/api/documents/${id}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/html' },
      body: exportHtmlWith({ ...document, annotations: { ...document.annotations, glossary: entries } }),
    });

  const first = await importGlossary(glossaryOf(1500, 'a'));
  assert.equal(first.status, 200, await first.text());

  const second = await importGlossary(glossaryOf(1500, 'b'));
  assert.equal(second.status, 400, '足し上げると上限を超える取り込みが通っている');

  const after = (await (await fetch(`${baseUrl}/api/documents/${id}`)).json()) as {
    annotations: { glossary: unknown[] };
  };
  assert.equal(after.annotations.glossary.length, 1500, '断ったのに用語集が増えている');
});
