// 画面の API と MCP サーバーが共通で使う操作。
// 論文フォルダの読み書きは src/lib/papers.ts（ブラウザ版と同じ処理）に任せ、
// ここでは Node.js でしかできないこと（PDF の本文取り出し、ファイルからの取り込み）を足す。

import fs from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  type Equation,
  type Highlight,
  type ListName,
  type MarkerColor,
  type Term,
  newId,
} from "../src/lib/model.ts";
import { changeAnnotations, checkId, importPaper, listPapers, loadAnnotations, loadNote, notePath, pdfPath } from "../src/lib/papers.ts";
import type { NodeVault } from "./nodeVault.ts";
import { type FmValue, fmText, readFrontmatter } from "../src/lib/frontmatter.ts";
import { type ArxivMeta, arxivQueue, fetchArxivMeta, normalizeSource } from "./arxiv.ts";
import { FetchFailed, FetchRefused, MAX_BODY, fetchPdf } from "./fetchpdf.ts";
import { findText, readPages } from "./pdftext.ts";

/** URL の最後の部分からファイル名を作る。 */
function fileNameOf(url: string) {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || "paper") || "paper";
  } catch {
    return "paper";
  }
}

/** PDF の文書情報から題名を取る。取れなければ null。 */
export async function pdfTitle(data: ArrayBuffer): Promise<string | null> {
  try {
    const doc = await getDocument({ data: new Uint8Array(data.slice(0)), isEvalSupported: false, verbosity: 0 }).promise;
    const meta = await doc.getMetadata();
    await doc.destroy();
    const t = (meta.info as { Title?: string } | undefined)?.Title?.trim();
    return t && t.length > 3 ? t : null;
  } catch {
    return null;
  }
}

export async function importBytes(vault: NodeVault, fileName: string, data: ArrayBuffer, title?: string) {
  if (!new TextDecoder().decode(new Uint8Array(data.slice(0, 5))).startsWith("%PDF")) {
    throw new Error("PDF ではないファイルは取り込めません。");
  }
  const t = title?.trim() || (await pdfTitle(data)) || fileName.replace(/\.pdf$/i, "");
  return importPaper(vault, fileName, data, t);
}

export interface ImportResult {
  id: string;
  /** 同じ論文が既にあり、取り込まなかった */
  existing: boolean;
  /** frontmatter に入れた書誌情報 */
  meta: Partial<ArxivMeta> & { arxiv?: string; url?: string };
}

// 取得の処理。テストでだけ差し替える（setFetchers）。外へ通信しないテストを書くため
const defaultFetchers = { pdf: (url: string) => fetchPdf(url), arxiv: (id: string) => fetchArxivMeta(id) };
let fetchers = defaultFetchers;
/** テスト専用: PDF と arXiv の書誌情報の取得を差し替える。引数なしで元に戻す */
export function setFetchers(f?: Partial<typeof defaultFetchers>) {
  fetchers = { ...defaultFetchers, ...f };
}

const BUSY = "arXiv が混み合っています。少し待ってからもう一度取り込んでください。";

/**
 * 端末にある PDF ファイル、URL、arXiv の番号から取り込む。端末のパスは MCP からだけ使う。
 *
 * 1. 入力を見分ける。DOI は論文のページを指すので止める
 * 2. arXiv は、取得の前に重複を確かめ、書誌情報を取る（取れなくても続ける）
 * 3. PDF を取る。arXiv が 429・503 を返したら、やり直さずに止める（接続の間隔の決まりを守るため）
 * 4. 題名を決め（引数 → arXiv → PDF の文書情報 → ファイル名）、フォルダ名と frontmatter を 1 回で作る
 */
export async function importFrom(vault: NodeVault, source: string, title?: string): Promise<ImportResult> {
  const n = normalizeSource(source);
  if (n.kind === "doi") throw new FetchRefused("DOI のリンクは論文のページを指すため取り込めません。PDF の URL を指定してください。");

  if (n.kind === "url" && !n.pdfUrl) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) throw new FetchRefused("http または https で始まる URL を指定してください。");
    const file = path.resolve(source);
    if ((await fs.stat(file)).size > MAX_BODY) throw new FetchRefused(`PDF が ${MAX_BODY / 1024 / 1024}MB を超えているため取り込めません。`);
    const b = await fs.readFile(file);
    const id = await importBytes(vault, path.basename(source), b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, title);
    return { id, existing: false, meta: {} };
  }

  const papers = await listPapers(vault);
  let meta: ImportResult["meta"] = {};
  let got: { data: ArrayBuffer; finalUrl: string };
  if (n.kind === "arxiv") {
    const id = n.arxivId!;
    const same = papers.find((p) => p.arxiv === id);
    if (same) return { id: same.id, existing: true, meta: {} };
    const am = await fetchers.arxiv(id);
    meta = { ...(am ?? {}), arxiv: id, url: `https://arxiv.org/abs/${id}${n.version ?? ""}` };
    try {
      got = await arxivQueue.run(() => fetchers.pdf(n.pdfUrl!));
    } catch (e) {
      if (e instanceof FetchFailed && (e.status === 429 || e.status === 503)) {
        throw new FetchFailed(e.retryAfter ? `${BUSY}待つ時間の目安は ${e.retryAfter} 秒です。` : BUSY, e.status, e.retryAfter);
      }
      throw e;
    }
  } else {
    got = await fetchers.pdf(n.pdfUrl!);
    // arXiv でない URL は、取得した後の最終 URL で重複を見分ける
    for (const p of papers) {
      const fm = readFrontmatter(await loadNote(vault, p.id));
      if (fmText(fm.url) === got.finalUrl) return { id: p.id, existing: true, meta: {} };
    }
    meta = { url: got.finalUrl };
  }

  const head = new TextDecoder().decode(new Uint8Array(got.data.slice(0, 5)));
  if (!head.startsWith("%PDF")) throw new FetchRefused("PDF ではないため取り込めません。論文のページではなく、PDF の URL を指定してください。");
  const name = fileNameOf(got.finalUrl);
  const fileName = name.endsWith(".pdf") ? name : `${name}.pdf`;
  const t = title?.trim() || meta.title || (await pdfTitle(got.data)) || fileName.replace(/\.pdf$/i, "");
  const fm: Record<string, FmValue> = {};
  if (meta.authors?.length) fm.authors = meta.authors;
  for (const k of ["year", "venue", "doi", "arxiv", "url"] as const) if (meta[k]) fm[k] = meta[k]!;
  const id = await importPaper(vault, fileName, got.data, t, { slugFrom: t, meta: fm });
  return { id, existing: false, meta };
}

/** 論文が無ければ、一覧の調べ方を添えて止める。 */
export async function requirePaper(vault: NodeVault, id: string) {
  if (!(await vault.exists(notePath(checkId(id))))) {
    throw new Error(`論文が見つかりません: ${id}。list_papers で ID を確かめてください。`);
  }
  return id;
}

const pdfFile = (vault: NodeVault, id: string) => vault.resolve(pdfPath(checkId(id)));

/** 論文の本文をページごとに返す。from/to で範囲を絞れる。 */
export async function paperText(vault: NodeVault, id: string, from = 1, to?: number) {
  const pages = await readPages(pdfFile(vault, id));
  const last = Math.min(to ?? pages.length, pages.length);
  return {
    pages: pages.length,
    text: pages.slice(Math.max(0, from - 1), last).map((p) => ({ page: p.page, text: p.text })),
  };
}

/** 論文の中で語句を探し、ページと前後の文を返す。 */
export async function findInPaper(vault: NodeVault, id: string, query: string, limit = 20) {
  const pages = await readPages(pdfFile(vault, id));
  const needle = query.toLowerCase().replace(/\s+/g, " ");
  const hits: { page: number; snippet: string }[] = [];
  for (const p of pages) {
    const flat = p.text.replace(/\s+/g, " ");
    const lower = flat.toLowerCase();
    for (let at = lower.indexOf(needle); at >= 0 && hits.length < limit; at = lower.indexOf(needle, at + needle.length)) {
      hits.push({ page: p.page, snippet: flat.slice(Math.max(0, at - 120), at + needle.length + 120) });
    }
  }
  return hits;
}

const COLORS: MarkerColor[] = ["yellow", "cyan", "magenta", "green"];

export interface HighlightInput {
  text: string;
  page?: number;
  color?: MarkerColor;
  translation?: string;
  memo?: string;
}

/** 本文の文を探してマーカーを引く。PDF 上で見つかれば、その位置に色が付く。 */
export async function addHighlight(vault: NodeVault, id: string, input: HighlightInput) {
  await requirePaper(vault, id);
  // マーカーの端を文字にぴったり合わせるため、各文字の実際の位置も読む
  const pages = await readPages(pdfFile(vault, id), { glyphs: true });
  const m = findText(pages, input.text, input.page);
  if (!m && !input.page) {
    throw new Error("本文の中にその文が見つかりませんでした。PDF の文字どおりに指定するか、page を指定してください。");
  }
  const color = input.color && COLORS.includes(input.color) ? input.color : "yellow";
  const item: Highlight = {
    id: newId("h"),
    page: m?.page ?? input.page ?? 1,
    rects: m?.rects ?? [],
    text: m?.text ?? input.text.trim(),
    color,
    translation: input.translation?.trim() ?? "",
    memo: input.memo?.trim() ?? "",
    createdAt: new Date().toISOString(),
  };
  const r = await changeAnnotations(vault, id, [{ op: "add", list: "highlights", item }]);
  return { highlight: item, located: !!m, around: m?.around ?? "", note: r.note };
}

export type TermInput = Partial<Omit<Term, "id" | "createdAt">> & { term: string };

export async function addTerm(vault: NodeVault, id: string, input: TermInput) {
  await requirePaper(vault, id);
  const item: Term = {
    id: newId("t"),
    term: input.term.trim(),
    reading: input.reading ?? "",
    short: input.short ?? "",
    detail: input.detail ?? "",
    inPaper: input.inPaper ?? "",
    related: input.related ?? [],
    page: input.page,
    createdAt: new Date().toISOString(),
  };
  await changeAnnotations(vault, id, [{ op: "add", list: "terms", item }]);
  return item;
}

export type EquationInput = Partial<Omit<Equation, "id" | "createdAt">> & { tex: string };

export async function addEquation(vault: NodeVault, id: string, input: EquationInput) {
  await requirePaper(vault, id);
  const a = await loadAnnotations(vault, id);
  const item: Equation = {
    id: newId("e"),
    label: input.label || `式${a.equations.length + 1}`,
    tex: input.tex.trim(),
    explanation: input.explanation ?? "",
    page: input.page,
    source: input.source ?? "",
    createdAt: new Date().toISOString(),
  };
  await changeAnnotations(vault, id, [{ op: "add", list: "equations", item }]);
  return item;
}

export async function updateItem(vault: NodeVault, id: string, list: ListName, itemId: string, patch: Record<string, unknown>) {
  await requirePaper(vault, id);
  const r = await changeAnnotations(vault, id, [{ op: "update", list, id: itemId, patch }]);
  const item = (r.annotations[list] as { id: string }[]).find((x) => x.id === itemId);
  if (!item) throw new Error(`見つかりません: ${itemId}`);
  return item;
}

export async function removeItem(vault: NodeVault, id: string, list: ListName, itemId: string) {
  await requirePaper(vault, id);
  const before = await loadAnnotations(vault, id);
  if (!(before[list] as { id: string }[]).some((x) => x.id === itemId)) throw new Error(`見つかりません: ${itemId}`);
  await changeAnnotations(vault, id, [{ op: "remove", list, id: itemId }]);
  return { removed: itemId };
}
