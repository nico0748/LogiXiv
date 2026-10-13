// URL 取得の安全策のテスト。外へは通信しない（127.0.0.1 に立てたサーバーだけを使う）。
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { FetchFailed, FetchRefused, fetchPdf, isPrivateAddress } from "./fetchpdf.ts";

const PDF = Buffer.from("%PDF-1.4\n%テスト\n");
let base = "";
let server: http.Server;
let hits = 0;

before(async () => {
  server = http.createServer((req, res) => {
    hits++;
    const u = new URL(req.url ?? "/", "http://x");
    const p = u.pathname;
    if (p === "/a.pdf") return res.writeHead(200, { "content-type": "application/pdf" }).end(PDF);
    if (p === "/to-local") return res.writeHead(302, { location: "http://127.0.0.1:9/secret.pdf" }).end();
    if (p.startsWith("/loop/")) {
      const n = Number(p.split("/")[2]);
      return res.writeHead(302, { location: n > 1 ? `/loop/${n - 1}` : "/a.pdf" }).end();
    }
    if (p === "/huge") return res.writeHead(200, { "content-length": String(300 * 1024 * 1024) }).end();
    if (p === "/chunked") {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.write("%PDF-");
      res.write(Buffer.alloc(2048, 0x41));
      return res.end();
    }
    if (p === "/slow") return; // 応答を返さない
    if (p === "/html") return res.writeHead(200, { "content-type": "text/html" }).end("<html><body>論文のページ</body></html>");
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

/** 公開 IP を返す名前の解決。テストのサーバー（127.0.0.1）に、公開の接続先として接続させる */
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const pub = { lookup: publicLookup };

test("1. ループバック・プライベート・リンクローカルなどは true", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.31.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "192.0.0.8", "0.0.0.0", "224.0.0.1", "::"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
});

test("2. 公開の IP は false", () => {
  for (const ip of ["8.8.8.8", "172.32.0.1", "2001:4860::1", "64:ff9b::808:808", "2002:808:808::1"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("N-10. NAT64 と 6to4 は中の IPv4 で判定する", () => {
  assert.equal(isPrivateAddress("64:ff9b::7f00:1"), true);
  assert.equal(isPrivateAddress("2002:c0a8:0001::1"), true);
});

test("3. ローカルの URL は断る", async () => {
  await assert.rejects(fetchPdf(`${base}/a.pdf`), (e) => e instanceof FetchRefused && /ローカルネットワーク/.test(e.message));
});

test("4. http(s) 以外と、利用者名を含む URL は断る", async () => {
  for (const u of ["file:///etc/passwd", "ftp://x/a.pdf", "https://u:p@example.com/a.pdf"]) {
    await assert.rejects(fetchPdf(u, {}, pub), FetchRefused, u);
  }
});

test("5. リダイレクト先がローカルなら断る", async () => {
  let calls = 0;
  // 1 回目だけ公開 IP を返し、2 回目（リダイレクト先）は本物の解決を使う
  const lookup = async (host: string, o: { all: true }) => (calls++ === 0 ? publicLookup() : (await import("node:dns")).promises.lookup(host, o));
  await assert.rejects(fetchPdf(`${base}/to-local`, {}, { lookup }), (e) => e instanceof FetchRefused && /ローカルネットワーク/.test(e.message));
  assert.equal(calls, 2);
});

test("6. リダイレクトは 5 回まで", async () => {
  assert.equal((await fetchPdf(`${base}/loop/5`, {}, pub)).finalUrl, `${base}/a.pdf`);
  await assert.rejects(fetchPdf(`${base}/loop/6`, {}, pub), /リダイレクトが多すぎる/);
});

test("7. content-length が上限を超えていれば、本文を読まずに止める", async () => {
  await assert.rejects(fetchPdf(`${base}/huge`, {}, pub), (e) => e instanceof FetchRefused && /200MB を超えて/.test(e.message));
});

test("8. content-length が無くても、読みながら上限を確かめる", async () => {
  await assert.rejects(fetchPdf(`${base}/chunked`, { maxBytes: 1024 }, pub), /1KB を超えて/);
});

test("9. 時間内に応答が無ければ止める", async () => {
  await assert.rejects(fetchPdf(`${base}/slow`, { timeoutMs: 200 }, pub), (e) => e instanceof FetchFailed && /秒以内に取得できなかった/.test(e.message));
});

test("10. PDF でなければ取り込まない", async () => {
  await assert.rejects(fetchPdf(`${base}/html`, {}, pub), (e) => e instanceof FetchRefused && /PDF ではない/.test(e.message));
});

test("11. PAPERLENS_ALLOW_PRIVATE_URLS=1 なら、ローカルの URL も取得できる", async () => {
  process.env.PAPERLENS_ALLOW_PRIVATE_URLS = "1";
  try {
    const r = await fetchPdf(`${base}/a.pdf`);
    assert.equal(Buffer.from(r.data).toString("latin1").slice(0, 5), "%PDF-");
  } finally {
    delete process.env.PAPERLENS_ALLOW_PRIVATE_URLS;
  }
  assert.ok(hits > 0);
});
