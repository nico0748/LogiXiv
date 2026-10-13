// arXiv の論文を取り込むための処理。入力の見分け、書誌情報の取得、接続の間隔。
//
// arXiv の利用条件は「3 秒に 1 回、同時に 1 接続」である。arxiv.org と export.arxiv.org への接続は、
// すべて arxivQueue を通し、前の接続が終わってから 3 秒空けて次を送る。
// キューはプロセスごとに持つ。ローカルサーバーと MCP サーバーが同時に取り込むと、合わせて 3 秒以内に 2 回接続しうる（docs/design.md）。

import { fetchChecked } from "./fetchpdf.ts";

export interface Normalized {
  kind: "arxiv" | "doi" | "url";
  /** 取りに行く PDF の URL（doi と、URL でない入力のときは無し） */
  pdfUrl?: string;
  /** 版の番号を除いた arXiv ID（例 2410.12345、hep-th/9901001） */
  arxivId?: string;
  /** 版の番号（例 "v2"）。無ければ "" */
  version?: string;
}

const NEW_ID = /^(\d{4}\.\d{4,5})(v\d+)?$/;
const OLD_ID = /^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?$/;
const ARXIV_URL = /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\/(.+?)(?:\.pdf)?\/?(?:[?#].*)?$/i;

function arxivOf(id: string): Normalized | null {
  const m = id.match(NEW_ID) ?? id.match(OLD_ID);
  if (!m) return null;
  const version = m[2] ?? "";
  // 取得は https の arxiv.org にそろえる（export.arxiv.org は API 用）
  return { kind: "arxiv", arxivId: m[1], version, pdfUrl: `https://arxiv.org/pdf/${m[1]}${version}` };
}

/** 取り込みの入力（URL、arXiv の番号、DOI、端末のパス）を見分ける。 */
export function normalizeSource(input: string): Normalized {
  const s = input.trim();
  const u = s.match(ARXIV_URL);
  if (u) {
    const a = arxivOf(u[1]);
    if (a) return a;
  }
  const bare = arxivOf(s.replace(/^arxiv:\s*/i, ""));
  if (bare) return bare;
  if (/^https?:\/\/(dx\.)?doi\.org\//i.test(s) || /^10\.\d{4,9}\/\S+$/.test(s)) return { kind: "doi" };
  if (/^https?:\/\//i.test(s)) return { kind: "url", pdfUrl: s };
  return { kind: "url" };
}

// --- 接続の間隔 ------------------------------------------------------------------

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** 1 つずつ順に実行し、前の実行が終わってから gapMs 空けて次を始めるキュー。 */
export function createQueue(gapMs: number, clock: Clock = realClock) {
  let tail: Promise<unknown> = Promise.resolve();
  let lastEnd = -Infinity;
  return {
    run<T>(job: () => Promise<T>): Promise<T> {
      const next = tail.catch(() => undefined).then(async () => {
        const wait = lastEnd + gapMs - clock.now();
        if (wait > 0) await clock.sleep(wait);
        try {
          return await job();
        } finally {
          lastEnd = clock.now();
        }
      });
      tail = next;
      return next;
    },
  };
}

/** arxiv.org と export.arxiv.org への接続は、すべてこのキューを通す（プロセスごと） */
export const arxivQueue = createQueue(3000);

// --- 書誌情報 --------------------------------------------------------------------

export interface ArxivMeta {
  title: string;
  authors: string[];
  year: string;
  doi: string;
  venue: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m,
  );
const clean = (s: string) => decode(s).replace(/\s+/g, " ").trim();
const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))?.[1];

/** arXiv API の Atom を読む。entry が無いとき、ID が存在しないとき（api/errors）は null。 */
export function parseArxivAtom(xml: string): ArxivMeta | null {
  const entry = tag(xml, "entry");
  if (!entry) return null;
  if ((tag(entry, "id") ?? "").includes("api/errors")) return null;
  const title = clean(tag(entry, "title") ?? "");
  if (!title) return null;
  const authors = [...entry.matchAll(/<author(?:\s[^>]*)?>\s*<name(?:\s[^>]*)?>([\s\S]*?)<\/name>/g)].map((m) => clean(m[1])).filter(Boolean);
  return {
    title,
    authors,
    year: (tag(entry, "published") ?? "").trim().slice(0, 4),
    doi: clean(tag(entry, "arxiv:doi") ?? ""),
    venue: clean(tag(entry, "arxiv:journal_ref") ?? "") || "arXiv",
  };
}

/**
 * arXiv API から書誌情報を取る。取れなければ null（通信の失敗、時間切れ、429・503 も含む）。
 * 書誌情報が無くても取り込みは続けられるため、ここでは止めない。
 */
export async function fetchArxivMeta(id: string, opts: { endpoint?: string; queue?: ReturnType<typeof createQueue> } = {}): Promise<ArxivMeta | null> {
  const endpoint = opts.endpoint ?? "https://export.arxiv.org/api/query";
  try {
    const r = await (opts.queue ?? arxivQueue).run(() =>
      fetchChecked(`${endpoint}?id_list=${encodeURIComponent(id)}&max_results=1`, { timeoutMs: 15_000, maxBytes: 1024 * 1024 }, "any"),
    );
    return parseArxivAtom(new TextDecoder().decode(r.data));
  } catch {
    return null;
  }
}
