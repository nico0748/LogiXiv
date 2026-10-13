// arXiv の入力の見分け、書誌情報の読み取り、接続の間隔、混み合っているときの扱い。外へは通信しない。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createQueue, fetchArxivMeta, normalizeSource, parseArxivAtom } from "./arxiv.ts";
import { FetchFailed } from "./fetchpdf.ts";
import { NodeVault } from "./nodeVault.ts";
import { importFrom, setFetchers } from "./service.ts";

test("入力の見分け（F 5.1 の表）", () => {
  const pdf = (id: string) => `https://arxiv.org/pdf/${id}`;
  const cases: [string, ReturnType<typeof normalizeSource>][] = [
    ["https://arxiv.org/abs/2410.12345", { kind: "arxiv", arxivId: "2410.12345", version: "", pdfUrl: pdf("2410.12345") }],
    ["https://arxiv.org/abs/2410.12345v2", { kind: "arxiv", arxivId: "2410.12345", version: "v2", pdfUrl: pdf("2410.12345v2") }],
    ["https://arxiv.org/pdf/2410.12345v2.pdf", { kind: "arxiv", arxivId: "2410.12345", version: "v2", pdfUrl: pdf("2410.12345v2") }],
    ["http://export.arxiv.org/abs/2410.12345", { kind: "arxiv", arxivId: "2410.12345", version: "", pdfUrl: pdf("2410.12345") }],
    ["arXiv:2410.12345", { kind: "arxiv", arxivId: "2410.12345", version: "", pdfUrl: pdf("2410.12345") }],
    ["2410.12345", { kind: "arxiv", arxivId: "2410.12345", version: "", pdfUrl: pdf("2410.12345") }],
    ["0704.0001", { kind: "arxiv", arxivId: "0704.0001", version: "", pdfUrl: pdf("0704.0001") }],
    ["https://arxiv.org/abs/hep-th/9901001", { kind: "arxiv", arxivId: "hep-th/9901001", version: "", pdfUrl: pdf("hep-th/9901001") }],
    ["hep-th/9901001v1", { kind: "arxiv", arxivId: "hep-th/9901001", version: "v1", pdfUrl: pdf("hep-th/9901001v1") }],
    ["math.GT/0309136", { kind: "arxiv", arxivId: "math.GT/0309136", version: "", pdfUrl: pdf("math.GT/0309136") }],
    ["https://doi.org/10.1145/3292500.3330701", { kind: "doi" }],
    ["https://dx.doi.org/10.1145/3292500.3330701", { kind: "doi" }],
    ["10.1145/3292500.3330701", { kind: "doi" }],
    ["https://example.com/paper.pdf", { kind: "url", pdfUrl: "https://example.com/paper.pdf" }],
    ["/home/me/paper.pdf", { kind: "url" }],
  ];
  for (const [input, want] of cases) assert.deepEqual(normalizeSource(input), want, input);
});

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title type="html">ArXiv Query: id_list=1706.03762</title>
  <id>http://arxiv.org/api/abc</id>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All
      You Need &amp; More</title>
    <author><name>Ashish Vaswani</name></author>
    <author>
      <name>Noam Shazeer</name>
    </author>
    <author><name>Niki Parmar</name><arxiv:affiliation>Google</arxiv:affiliation></author>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.48550/arXiv.1706.03762</arxiv:doi>
    <arxiv:journal_ref xmlns:arxiv="http://arxiv.org/schemas/atom">Advances in Neural Information Processing Systems 30 (NIPS 2017)</arxiv:journal_ref>
  </entry>
</feed>`;

const ERROR_ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><title>ArXiv Query</title>
  <entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_9999.99999</id><title>Error</title><summary>incorrect id format</summary></entry></feed>`;

test("Atom: 題名・著者 3 人・年・DOI・掲載先を読む", () => {
  assert.deepEqual(parseArxivAtom(ATOM), {
    title: "Attention Is All You Need & More",
    authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"],
    year: "2017",
    doi: "10.48550/arXiv.1706.03762",
    venue: "Advances in Neural Information Processing Systems 30 (NIPS 2017)",
  });
});

test("Atom: ID が存在しないときと、entry が無いときは null", () => {
  assert.equal(parseArxivAtom(ERROR_ATOM), null);
  assert.equal(parseArxivAtom("<feed></feed>"), null);
});

test("キュー: 2 件目は、1 件目が終わってから 3 秒以上あとに始まる", async () => {
  let t = 0;
  const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
  const q = createQueue(3000, clock);
  const starts: number[] = [];
  let firstEnd = 0;
  const a = q.run(async () => {
    starts.push(t);
    t += 1000; // 1 件目に 1 秒かかった
    firstEnd = t;
  });
  const b = q.run(async () => {
    starts.push(t);
  });
  await Promise.all([a, b]);
  assert.equal(starts[0], 0);
  assert.ok(starts[1] - firstEnd >= 3000, `${starts[1]} - ${firstEnd}`);
  // 失敗した接続のあとも間隔を守る
  await q.run(async () => { throw new Error("x"); }).catch(() => undefined);
  const before = t;
  await q.run(async () => starts.push(t));
  assert.ok(starts[2] - before >= 3000);
});

// --- 429・503 -------------------------------------------------------------------

const data = fs.mkdtempSync(path.join(os.tmpdir(), "paperlens-arxiv-"));
let server: http.Server | null = null;
after(() => {
  setFetchers();
  server?.close();
  fs.rmSync(data, { recursive: true, force: true });
});

test("書誌情報の取得が 503 なら、書誌情報なしで続ける（null）", async () => {
  let hits = 0;
  server = http.createServer((_q, res) => {
    hits++;
    res.writeHead(503, { "retry-after": "30" }).end("busy");
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/query`;
  process.env.PAPERLENS_ALLOW_PRIVATE_URLS = "1";
  try {
    assert.equal(await fetchArxivMeta("1706.03762", { endpoint, queue: createQueue(0) }), null);
  } finally {
    delete process.env.PAPERLENS_ALLOW_PRIVATE_URLS;
  }
  assert.equal(hits, 1);
});

test("PDF の取得が 429 なら、やり直さずに止め、待つ時間を添える", async () => {
  let pdfCalls = 0;
  setFetchers({
    arxiv: async () => null,
    pdf: async () => {
      pdfCalls++;
      throw new FetchFailed("PDF を取得できませんでした（429）。", 429, 30);
    },
  });
  const v = new NodeVault(data);
  await assert.rejects(importFrom(v, "2410.12345"), (e) => e instanceof FetchFailed && /arXiv が混み合っています/.test(e.message) && /30 秒/.test(e.message));
  assert.equal(pdfCalls, 1);
  assert.equal(fs.existsSync(path.join(data, "papers")), false);
});
