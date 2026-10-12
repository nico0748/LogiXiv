import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { start } from '../src/start.ts';
import { parseWithPdfJs } from '../src/fallback.ts';
import { PdfUnreadableError } from '../src/pdf-failure.ts';
import { makePaperPdf } from '../../../scripts/make-paper-pdf.ts';

/**
 * 「1 本の取り込みがサーバー全体を止めない」ことの回帰テスト。
 *
 * 実測で固定してある壊れ方:
 *  - 60 ページの PDF を 1 本入れると、その間 /api/health が 9 秒返らない
 *    （450 ページでは 7 分近く、ブラウザは真っ白のまま）
 *  - timeoutMs=120 秒を宣言しているのに、450 ページの取り込みが 411 秒走り切る
 *  - クライアントが諦めた後に、文書が黙って一覧に現れる
 *  - 長すぎる検索語が、理由の書かれていない空の失敗になって返る
 */

let baseUrl = '';
let port = 0;
let dataDir = '';
let close: () => Promise<void> = async () => {};

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'logixiv-heavy-test-'));
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

/**
 * 解析が重くなるページ数。
 *
 * 小さすぎると、直す前のコードでも偶然すり抜ける（数百 ms しか塞がない）。
 * 40 ページは、直す前の実測でメインスレッドが 3〜4 秒止まる大きさ。
 */
const HEAVY_PAGES = 40;
/** 時間の上限を測る側は、上限と実際の所要時間がはっきり離れる大きさにする。 */
const TIMEOUT_PAGES = 60;

/**
 * /api/health を叩き続ける見張りを、**別スレッド**に置く。
 *
 * 同じスレッドから測ってはいけない。測る側の `setTimeout` も一緒に止まるので、
 * 「止まっていた時間」がそっくり待ち時間の中に吸い込まれ、応答時間は速いままに見える
 * （実測: 直す前のコードで 4.7 秒塞がっているのに、同スレッドの計測では最悪 34ms）。
 * 人が困っているのは「別のタブから開けない」なので、測る側も別の実行単位に置く。
 */
function startHealthWatcher(url: string): { stop: () => Promise<number> } {
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    let worst = 0;
    let running = true;
    parentPort.on('message', () => { running = false; });
    (async () => {
      while (running) {
        const startedAt = Date.now();
        try {
          const response = await fetch(workerData.url + '/api/health');
          await response.text();
        } catch {
          // 接続そのものが返らないのも「塞がっている」側。時間だけ数える。
        }
        worst = Math.max(worst, Date.now() - startedAt);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      parentPort.postMessage(worst);
    })();
    `,
    { eval: true, workerData: { url } },
  );
  return {
    stop: () =>
      new Promise<number>((resolve) => {
        worker.once('message', (worst: number) => {
          void worker.terminate();
          resolve(worst);
        });
        worker.postMessage('stop');
      }),
  };
}

test('大きな PDF の取り込み中でも、他のリクエストはすぐ返る', async () => {
  const pdf = makePaperPdf({ pages: HEAVY_PAGES }).pdf;
  const watcher = startHealthWatcher(baseUrl);
  // 見張りが最初の 1 往復を終えるのを待ってから取り込みを始める。
  await new Promise((resolve) => setTimeout(resolve, 200));

  const response = await fetch(`${baseUrl}/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', 'X-File-Name': 'heavy.pdf' },
    body: pdf,
  });
  assert.equal(response.status, 201);
  await response.json();
  const worst = await watcher.stop();

  // 直す前は、同じ条件でここが数千 ms（60 ページで 9 秒、450 ページでは 30 秒でも
  // 返らない）だった。1 秒は「人が固まったと感じない」側に十分な余裕を取った線。
  assert.ok(worst < 1000, `取り込み中の /api/health が ${worst}ms かかった（塞がっている）`);
});

test('解析の時間の上限が実際に効き、打ち切りを日本語で伝える', async () => {
  // この PDF の解析はいま約 1.5 秒（組み立ての二乗を潰す前は約 11 秒だった）。
  // 上限は、その 1/3 に取って差がはっきり出るようにしてある。
  // 速くなるたびにここが通らなくなるので、実測に合わせて下げること。
  const pdf = makePaperPdf({ pages: TIMEOUT_PAGES }).pdf;
  const timeoutMs = 500;
  const startedAt = Date.now();
  const error = await parseWithPdfJs(pdf, {
    fileName: 'heavy.pdf',
    limits: { maxPages: 400, maxChunks: 400_000, timeoutMs },
  }).then(
    () => null,
    (reason: unknown) => reason,
  );
  const elapsed = Date.now() - startedAt;

  // 直す前は、重い処理がメインスレッドにあったせいで打ち切りの setTimeout が
  // そもそも発火せず、上限の何倍でも走り切っていた（120 秒の宣言に対し実測 411 秒）。
  assert.ok(error instanceof PdfUnreadableError, `打ち切りの失敗が返らなかった: ${String(error)}`);
  assert.equal((error as PdfUnreadableError).reason, 'timeout');
  // 人が読んで次に何をすればいいか分かる日本語であること。
  assert.match((error as PdfUnreadableError).message, /打ち切りました/);
  assert.match((error as PdfUnreadableError).message, /GROBID/);
  // 「いつか止まる」ではなく「上限で止まる」こと。最後まで走り切る壊れ方と区別する。
  assert.ok(elapsed < 6_000, `上限 ${timeoutMs}ms に対して ${elapsed}ms かかった（効いていない）`);
});

test('クライアントが諦めた取り込みは、文書として残らない', async () => {
  const before = (await (await fetch(`${baseUrl}/api/documents`)).json()) as { documents: unknown[] };

  const controller = new AbortController();
  const pdf = makePaperPdf({ pages: HEAVY_PAGES }).pdf;
  const ingest = fetch(`${baseUrl}/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', 'X-File-Name': 'abandoned.pdf' },
    body: pdf,
    signal: controller.signal,
  }).catch(() => null);

  // 本文を送り終えて解析に入ったあたりで諦める。
  await new Promise((resolve) => setTimeout(resolve, 600));
  controller.abort();
  await ingest;

  // 直す前は、諦めた後（450 ページでは 11 分後）に文書が黙って現れていた。
  // 「今はまだ出ていない」では足りないので、放っておいたら現れる時間ぶん見張る。
  // この PDF は直す前なら約 5 秒で解析し終わる（＝そこで黙って現れていた）。
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const after = (await (await fetch(`${baseUrl}/api/documents`)).json()) as {
      documents: { title: string }[];
    };
    assert.equal(
      after.documents.length,
      before.documents.length,
      `諦めた取り込みが文書として残っている: ${JSON.stringify(after.documents.map((d) => d.title))}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
});
