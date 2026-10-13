// URL から PDF などを取得する。取り込みの経路（MCP の import_paper、画面の「URL から追加」）はすべてここを通す。
//
// 守ること:
//   - http と https だけ。利用者名やパスワードを含む URL は断る
//   - 接続先の IP を確かめ、端末内やローカルネットワーク（ループバック・プライベート・リンクローカルなど）には接続しない。
//     リダイレクトのたびに確かめ直す。PAPERLENS_ALLOW_PRIVATE_URLS=1 のときだけ、この確認を止める（構内の機関リポジトリ用）
//   - リダイレクトは 5 回まで、時間は合計 60 秒まで、大きさは 200MB まで
//   - PDF は最初の数バイトで確かめ、PDF でなければ最後まで読まない
//
// 残る隙間: 確かめた後に fetch が名前をもう一度解決するので、その間に答えを変える手口（DNS rebinding）は防げない。
// node:https の request() に lookup を渡せば解決結果を固定できるが、今回は見送った（docs/design.md）。

import dns from "node:dns";
import net from "node:net";
import { VERSION } from "./version.ts";

/** 受け取る大きさの上限。画面からの取り込み（server/app.ts）と共通 */
export const MAX_BODY = 200 * 1024 * 1024;

export interface FetchLimits {
  maxBytes: number;
  /** 接続から本文の読み終わりまでの合計 */
  timeoutMs: number;
  maxRedirects: number;
}
const DEFAULTS: FetchLimits = { maxBytes: MAX_BODY, timeoutMs: 60_000, maxRedirects: 5 };

export const USER_AGENT = `PaperLens/${VERSION} (+https://github.com/nico0748/LogiXiv)`;

/** 規則により断った。文言は利用者に見せてよいものだけを持つ（画面の API では 400） */
export class FetchRefused extends Error {}

/** 取得に失敗した（通信の失敗、時間切れ、相手の応答の状態）。画面の API では 502 */
export class FetchFailed extends Error {
  status?: number;
  /** 応答の Retry-After（秒）。無ければ undefined */
  retryAfter?: number;
  constructor(msg: string, status?: number, retryAfter?: number) {
    super(msg);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

type Lookup = (host: string, opts: { all: true }) => Promise<{ address: string; family: number }[]>;
export interface FetchOptions {
  /** テスト用に、名前の解決を差し替える */
  lookup?: Lookup;
}

const allowPrivate = () => process.env.PAPERLENS_ALLOW_PRIVATE_URLS === "1";

/** p を待つ。signal が先に止まったら、その理由で失敗する（dns.lookup は AbortSignal を受け取らないため） */
function untilAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e) => (signal.removeEventListener("abort", onAbort), reject(e)),
    );
  });
}

/** 接続してよい URL か。だめなら FetchRefused を投げる。signal が止まったら、名前の解決も待たない */
export async function checkUrl(u: URL, lookup: Lookup = dns.promises.lookup as Lookup, signal?: AbortSignal): Promise<void> {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new FetchRefused("http または https で始まる URL を指定してください。");
  if (u.username || u.password) throw new FetchRefused("利用者名やパスワードを含む URL は使えません。");
  if (allowPrivate()) return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addrs: { address: string }[];
  try {
    // IP の文字列もここを通す（dns.lookup は IP をそのまま返す）
    addrs = await untilAbort(lookup(host, { all: true }), signal);
  } catch (e) {
    throw new FetchFailed(failText(e));
  }
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new FetchRefused("この URL からは取り込めません（端末内やローカルネットワークの URL は使えません）。");
  }
}

// --- IP の判定 -------------------------------------------------------------------

const v4 = (ip: string) => ip.split(".").reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
const inV4 = (n: number, base: string, bits: number) => bits === 0 || (n >>> (32 - bits)) === (v4(base) >>> (32 - bits));

const PRIVATE_V4: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3], // 224 以上（マルチキャストと予約）
];

function privateV4(n: number) {
  return PRIVATE_V4.some(([base, bits]) => inV4(n, base, bits));
}

/** IPv6 を 8 つの 16 ビットに分ける。読めなければ null。 */
function v6groups(ip: string): number[] | null {
  let s = ip.split("%")[0];
  // 末尾の IPv4 の表記（::ffff:1.2.3.4）を 16 ビット 2 つに直す
  const m = s.match(/(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    if (!net.isIPv4(m[2])) return null;
    const n = v4(m[2]);
    s = `${m[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail, extra] = s.split("::");
  if (extra !== undefined) return null;
  const part = (x: string) => (x ? x.split(":").map((g) => parseInt(g, 16)) : []);
  const a = part(head);
  const b = tail === undefined ? [] : part(tail);
  const fill = tail === undefined ? 0 : 8 - a.length - b.length;
  const g = [...a, ...Array(fill).fill(0), ...b];
  return g.length === 8 && g.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? g : null;
}

/** IP がループバック・プライベート・リンクローカル・マルチキャストなどか。読めない IP も true（接続しない）。 */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return privateV4(v4(ip));
  if (!net.isIPv6(ip)) return true;
  const g = v6groups(ip);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => privateV4(((hi << 16) | lo) >>> 0);
  // ::/96（:: と ::1 を含む）と ::ffff:0:0/96（IPv4 を写したもの）は、中の IPv4 で判定する
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff)) return embedded(g[6], g[7]);
  // NAT64（64:ff9b::/96）も中の IPv4 で判定する
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6], g[7]);
  // 6to4（2002::/16）は、続く 32 ビットが IPv4
  if (g[0] === 0x2002) return embedded(g[1], g[2]);
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 一意ローカル
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 リンクローカル
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 マルチキャスト
  return false;
}

// --- 取得 ------------------------------------------------------------------------

const sizeText = (n: number) => (n % (1024 * 1024) === 0 ? `${n / 1024 / 1024}MB` : `${Math.ceil(n / 1024)}KB`);
const tooLarge = (n: number) => new FetchRefused(`PDF が ${sizeText(n)} を超えているため取り込めません。`);
const notPdf = () => new FetchRefused("PDF ではないため取り込めません。論文のページではなく、PDF の URL を指定してください。");

function failText(e: unknown) {
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  const why = cause?.code ?? cause?.message ?? (e instanceof Error ? e.message : String(e));
  return `PDF を取得できませんでした（${why}）。ネットワークの設定を確かめるか、PDF を保存してから取り込んでください。`;
}

/**
 * URL を確かめてから本文を読む。リダイレクトは 1 回ずつ確かめ直す。
 * accept が "pdf" のときは、最初の部分が %PDF- でなければ読むのを止める。
 */
export async function fetchChecked(
  url: string,
  limits: Partial<FetchLimits> = {},
  accept: "pdf" | "any" = "pdf",
  opts: FetchOptions = {},
): Promise<{ data: ArrayBuffer; finalUrl: string; contentType: string }> {
  const lim = { ...DEFAULTS, ...limits };
  const signal = AbortSignal.timeout(lim.timeoutMs);
  const timeoutText = `${lim.timeoutMs / 1000} 秒以内に取得できなかったため止めました。`;
  const headers = { "user-agent": USER_AGENT, accept: accept === "pdf" ? "application/pdf,*/*;q=0.5" : "*/*" };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new FetchRefused("http または https で始まる URL を指定してください。");
  }
  for (let redirects = 0; ; redirects++) {
    try {
      await checkUrl(u, opts.lookup, signal);
    } catch (e) {
      // 名前の解決が終わらないまま時間切れになったときも、時間切れの文言にする
      if (signal.aborted && !(e instanceof FetchRefused)) throw new FetchFailed(timeoutText);
      throw e;
    }
    let res: Response;
    try {
      res = await fetch(u, { redirect: "manual", signal, headers });
    } catch (e) {
      if (signal.aborted) throw new FetchFailed(timeoutText);
      throw new FetchFailed(failText(e));
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      await res.body?.cancel().catch(() => undefined);
      const loc = res.headers.get("location");
      if (!loc) throw new FetchFailed(`PDF を取得できませんでした（${res.status}）。`, res.status);
      if (redirects >= lim.maxRedirects) throw new FetchRefused("リダイレクトが多すぎるため取り込めません。");
      u = new URL(loc, u);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      const ra = Number(res.headers.get("retry-after"));
      throw new FetchFailed(`PDF を取得できませんでした（${res.status}）。`, res.status, Number.isFinite(ra) && ra > 0 ? ra : undefined);
    }
    const len = Number(res.headers.get("content-length"));
    if (Number.isFinite(len) && len > lim.maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw tooLarge(lim.maxBytes);
    }
    const data = await readBody(res, lim.maxBytes, accept === "pdf", signal, timeoutText);
    return { data, finalUrl: u.toString(), contentType: res.headers.get("content-type") ?? "" };
  }
}

async function readBody(res: Response, maxBytes: number, pdf: boolean, signal: AbortSignal, timeoutText: string) {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let checked = !pdf;
  if (!res.body) return new ArrayBuffer(0);
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge(maxBytes);
      }
      // 先頭の 5 バイトがそろった時点で PDF かを確かめる。論文のページの HTML を最後まで読まない
      if (!checked && total >= 5) {
        checked = true;
        if (!isPdf(concat(chunks, total))) {
          await reader.cancel().catch(() => undefined);
          throw notPdf();
        }
      }
    }
  } catch (e) {
    if (e instanceof FetchRefused) throw e;
    if (signal.aborted) throw new FetchFailed(timeoutText);
    throw new FetchFailed(failText(e));
  }
  const all = concat(chunks, total);
  if (!checked && !isPdf(all)) throw notPdf();
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) as ArrayBuffer;
}

function concat(chunks: Uint8Array[], total: number) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const isPdf = (b: Uint8Array) => b.length >= 5 && new TextDecoder().decode(b.subarray(0, 5)) === "%PDF-";

/** URL を確かめてから PDF を読む。戻り値は本文と、リダイレクト後の最終 URL。 */
export async function fetchPdf(url: string, limits?: Partial<FetchLimits>, opts?: FetchOptions) {
  const r = await fetchChecked(url, limits, "pdf", opts);
  return { data: r.data, finalUrl: r.finalUrl };
}
