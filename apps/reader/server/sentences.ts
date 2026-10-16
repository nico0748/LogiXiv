// 1 文ずつの対訳（@paperlens/core の文分割と注釈）を論文フォルダに持つ。
//
// 置き場は papers/<id>/sentences.json（@paperlens/core の PaperDocument そのもの）。
// 解析の進み具合は papers/<id>/sentences.status.json に残す。画面のサーバーと MCP サーバーは
// 別のプロセスなので、「解析中」「失敗した」をメモリだけに置くと相手から見えない。
//
// 書き込みは論文ごとに 1 本の列に並べる（解析の後始末と訳の書き込みが同時に来ても、片方が消えない）。
// 解析そのもの（数秒〜数十秒）は列の外で回し、結果を当てるときだけ最新を読み直して applyStructure で重ねる。

import fs from "node:fs/promises";
import {
  addNote,
  applyStructure,
  createDocument,
  deleteNote,
  deleteTranslation,
  editSentenceBoundary as coreEditBoundary,
  FutureStructureError,
  migrateDocument,
  RECT_BAND_VERSION,
  removeGlossaryEntry,
  sanitizeDocument,
  setTranslation as coreSetTranslation,
  skipSentences as coreSkip,
  STRUCTURE_VERSION,
  undoSentenceEdit as coreUndoEdit,
  unskipSentences as coreUnskip,
  upsertGlossaryEntry,
  type DocumentStructure,
  type PaperDocument,
} from "@paperlens/core";
import { GrobidParseError, GrobidUnavailableError, parseWithPdfJs, processFulltext } from "@paperlens/server";
import { checkId, notePath, pdfPath, PAPERS_DIR } from "../src/lib/papers.ts";
import type { NodeVault } from "./nodeVault.ts";
import { readPages } from "./pdftext.ts";
import { type GlyphPage, glyphPagesFromText, refineStructureRects } from "./refineRects.ts";

export type ParserChoice = "auto" | "grobid" | "fallback";
export type SentencesState =
  | { status: "none" }
  | { status: "parsing"; startedAt: string }
  | { status: "failed"; error: string; code?: string }
  /** warning は直近の解析で起きたこと（GROBID が使えず簡易解析にした、再解析に失敗して前の結果を出している など）。 */
  | { status: "ready"; document: PaperDocument; warning?: string };

export const sentencesPath = (id: string) => `${PAPERS_DIR}/${id}/sentences.json`;
export const sentencesStatusPath = (id: string) => `${PAPERS_DIR}/${id}/sentences.status.json`;

/** 解析の進み具合。done は「最後の解析が終わった」で、警告だけを持つ。 */
type StatusFile =
  | { status: "parsing"; startedAt: string; pid: number }
  | { status: "failed"; error: string; code?: string; at: string }
  | { status: "done"; warning?: string; at: string };

export class SentencesError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

export const grobidUrl = () => (process.env.PAPERLENS_GROBID_URL || process.env.LOGIXIV_GROBID_URL || "http://localhost:8070").replace(/\/$/, "");

// --- 論文ごとの順番待ち ------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>();
function withLock<T>(vault: NodeVault, id: string, task: () => Promise<T>): Promise<T> {
  const key = `${vault.root}\0${id}`;
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  const tracked = next.catch(() => undefined);
  locks.set(key, tracked);
  void tracked.then(() => {
    if (locks.get(key) === tracked) locks.delete(key);
  });
  return next;
}

/** 解析は 1 本で数百 MB 使うので、同時に回すのは 2 本まで。 */
let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(task: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await task();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

// --- 読み書き ----------------------------------------------------------------------

async function requirePaper(vault: NodeVault, id: string) {
  if (!(await vault.exists(notePath(checkId(id))))) throw new SentencesError(404, `論文が見つかりません: ${id}`);
}

async function readStatus(vault: NodeVault, id: string): Promise<StatusFile | null> {
  try {
    return JSON.parse(await vault.readText(sentencesStatusPath(id))) as StatusFile;
  } catch {
    return null;
  }
}

const writeStatus = (vault: NodeVault, id: string, s: StatusFile) =>
  vault.writeText(sentencesStatusPath(id), `${JSON.stringify(s, null, 2)}\n`);

/** 壊れていて読めない sentences.json。再解析では退避してから作り直す。 */
class CorruptError extends Error {}

/**
 * sentences.json を読む。無ければ null。
 * 古い版の規則で書かれていれば移行し、形の崩れた要素は落としてから返す（直したものは書き戻す）。
 */
async function readDocument(vault: NodeVault, id: string): Promise<PaperDocument | null> {
  let raw: string;
  try {
    raw = await vault.readText(sentencesPath(id));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let parsed: PaperDocument;
  try {
    parsed = JSON.parse(raw) as PaperDocument;
    if (!parsed || typeof parsed !== "object" || !parsed.structure || !Array.isArray(parsed.structure.sentences)) {
      throw new Error("structure.sentences がありません");
    }
  } catch (e) {
    throw new CorruptError(
      `対訳データ（${sentencesPath(id)}）が壊れていて読めません。解析し直すと、壊れたファイルを退避して作り直します。（${e instanceof Error ? e.message : String(e)}）`,
    );
  }
  if (typeof parsed.structure.version === "number" && parsed.structure.version > STRUCTURE_VERSION) {
    throw new FutureStructureError(
      `この対訳データは新しい版で作られています（構造 v${parsed.structure.version} / このアプリは v${STRUCTURE_VERSION} まで）。アプリを更新してください。`,
    );
  }
  const migration = migrateDocument(parsed);
  const { document, report } = sanitizeDocument(migration.document, { id, sourceFileName: parsed.sourceFileName });
  // sanitize は更新時刻を今にするので、元の値に戻す（読むだけで「更新された」にしない）。
  const out: PaperDocument = { ...document, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : document.updatedAt };
  const dropped =
    report.droppedSentences + report.droppedTranslations + report.droppedNotes + report.droppedGlossary + report.droppedSkipped + report.droppedEdits;
  if (migration.migrated || dropped > 0) await writeDocument(vault, out);
  return out;
}

const writeDocument = (vault: NodeVault, doc: PaperDocument) => vault.writeText(sentencesPath(doc.id), JSON.stringify(doc));

/** 最新を読み直し、変更を当てて書く。文書がまだ無ければ断る。 */
function mutate(vault: NodeVault, id: string, fn: (doc: PaperDocument) => PaperDocument): Promise<PaperDocument> {
  return withLock(vault, id, async () => {
    await requirePaper(vault, id);
    let doc: PaperDocument | null;
    try {
      doc = await readDocument(vault, id);
    } catch (e) {
      throw new SentencesError(409, e instanceof Error ? e.message : String(e));
    }
    if (!doc) throw new SentencesError(409, "この論文はまだ文に分けられていません。先に解析してください。");
    const next = fn(doc);
    if (next !== doc) await writeDocument(vault, next);
    return next;
  });
}

/** core の「当てられなかった」を、理由付きの 400 にする。 */
function must<T extends { applied: boolean | number; reason?: string }>(r: T, fallback: string): T {
  if (!r.applied) throw new SentencesError(400, r.reason ?? fallback);
  return r;
}

// --- 状態 ------------------------------------------------------------------------

/** このプロセスで走っている解析。同じ論文の解析を二重に始めない。 */
const running = new Map<string, { startedAt: string; promise: Promise<SentencesState> }>();
const runKey = (vault: NodeVault, id: string) => `${vault.root}\0${id}`;

function pidAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function sentencesState(vault: NodeVault, id: string): Promise<SentencesState> {
  await requirePaper(vault, id);
  const mine = running.get(runKey(vault, id));
  if (mine) return { status: "parsing", startedAt: mine.startedAt };
  const st = await readStatus(vault, id);
  // 別のプロセス（MCP サーバー）が解析中。落ちたプロセスの印は無視する。
  if (st?.status === "parsing" && st.pid !== process.pid && pidAlive(st.pid)) {
    return { status: "parsing", startedAt: st.startedAt };
  }
  let doc: PaperDocument | null;
  try {
    doc = await withLock(vault, id, () => readDocument(vault, id));
  } catch (e) {
    return {
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
      code: e instanceof FutureStructureError ? "future-version" : "corrupt",
    };
  }
  if (!doc) {
    if (st?.status === "failed") return { status: "failed", error: st.error, code: st.code };
    return { status: "none" };
  }
  if (needsRectUpgrade(doc)) doc = await upgradeRects(vault, id, doc);
  const warning =
    st?.status === "failed"
      ? `解析し直せなかったため、前回の結果を表示しています: ${st.error}`
      : st?.status === "done" && st.warning
        ? st.warning
        : undefined;
  return warning ? { status: "ready", document: doc, warning } : { status: "ready", document: doc };
}

// --- 文の枠の端 --------------------------------------------------------------------

/**
 * PDF の各グリフの実際の位置（描画命令から求める。pdftext.ts がファイルごとに覚えておく）。
 * 読めなければ空（枠は見積もりのまま）。
 */
async function glyphPages(vault: NodeVault, id: string, structure: DocumentStructure): Promise<GlyphPage[]> {
  try {
    return glyphPagesFromText(await readPages(vault.resolve(pdfPath(id)), { glyphs: true }), structure.pageSizes);
  } catch {
    return [];
  }
}

/** 文の枠の文頭・文末を、実際のグリフの端に合わせる（文の分け方・本文・ハッシュは変えない）。 */
const withGlyphEdges = (doc: PaperDocument, pages: readonly GlyphPage[]): PaperDocument => ({
  ...doc,
  structure: refineStructureRects(doc.structure, pages).structure,
});

/**
 * 文の枠をいまの規則で作り直す必要があるか。
 * - rectEdges が無い: 端をグリフに合わせる前に解析した文書（文頭・文末が 1 文字ずれうる）。
 * - rectBand が古い: 縦の帯が古い式（ベースライン − 字高 〜 ベースライン）のまま。
 * どちらも枠の座標だけの話なので、再解析せずに読み込むときに直せる。
 */
export const needsRectUpgrade = (doc: PaperDocument) =>
  !doc.structure.rectEdges || (doc.structure.rectEdges === "glyph" && (doc.structure.rectBand ?? 0) < RECT_BAND_VERSION);

/** 同じ文書を同時に何度も直さない。 */
const upgrading = new Map<string, Promise<PaperDocument>>();

/**
 * 古い文書の枠を、PDF のグリフに合わせ直して書き戻す（文の分け方・本文・ハッシュ・訳は変えない）。
 * グリフが読めない PDF は「見積もり」の印だけ付けて、次からは試さない。失敗しても元の文書を返す。
 */
function upgradeRects(vault: NodeVault, id: string, doc: PaperDocument): Promise<PaperDocument> {
  const key = runKey(vault, id);
  const hit = upgrading.get(key);
  if (hit) return hit;
  const task = (async () => {
    try {
      // グリフの読み取り（数秒）は列の外で済ませ、書くときだけ最新を読み直す
      const pages = await glyphPages(vault, id, doc.structure);
      return await withLock(vault, id, async () => {
        const current = await readDocument(vault, id);
        if (!current || !needsRectUpgrade(current)) return current ?? doc;
        const next: PaperDocument = pages.length
          ? withGlyphEdges(current, pages)
          : { ...current, structure: { ...current.structure, rectEdges: current.structure.rectEdges ?? "estimate" } };
        await writeDocument(vault, next);
        return next;
      });
    } catch {
      return doc;
    } finally {
      upgrading.delete(key);
    }
  })();
  upgrading.set(key, task);
  return task;
}

// --- 解析 ------------------------------------------------------------------------

/** 失敗を「人が読める日本語」と「画面が分岐できる短い印」にする。 */
function describeFailure(e: unknown): { error: string; code: string } {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof SentencesError) return { error: msg, code: e.status === 404 ? "missing" : "other" };
  // @paperlens/server の PdfUnreadableError は reason（encrypted / truncated / corrupt / timeout …）を持つ。
  const reason = (e as { reason?: unknown } | null)?.reason;
  if (typeof reason === "string") return { error: msg, code: reason };
  if (e instanceof GrobidUnavailableError) return { error: msg, code: "grobid-unavailable" };
  if (e instanceof GrobidParseError) return { error: msg, code: "grobid-failed" };
  if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { error: "論文の PDF（paper.pdf）が見つかりません。", code: "missing" };
  return { error: `文に分けられませんでした: ${msg}`, code: "unknown" };
}

async function parseStructure(pdf: Uint8Array, parser: ParserChoice): Promise<{ structure: DocumentStructure; warning?: string }> {
  return slot(async () => {
    if (parser === "fallback") return { structure: await parseWithPdfJs(pdf, { fileName: "paper.pdf" }) };
    try {
      const { structure } = await processFulltext(pdf, "paper.pdf", { baseUrl: grobidUrl() });
      if (structure.sentences.length === 0) throw new GrobidUnavailableError("GROBID は本文の文を 1 つも返しませんでした");
      return { structure };
    } catch (e) {
      if (parser === "grobid") throw e;
      // 簡易解析も失敗したら、そちら（＝この PDF そのものの話）を前に出す。
      const reason = e instanceof Error ? e.message : String(e);
      return {
        structure: await parseWithPdfJs(pdf, { fileName: "paper.pdf" }),
        warning: `GROBID を使えなかったため簡易解析（pdf.js）で文に分けました: ${reason}`,
      };
    }
  });
}

async function runParse(vault: NodeVault, id: string, parser: ParserChoice, startedAt: string): Promise<SentencesState> {
  try {
    await writeStatus(vault, id, { status: "parsing", startedAt, pid: process.pid });
    const bytes = await fs.readFile(vault.resolve(pdfPath(id)));
    const { structure, warning } = await parseStructure(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), parser);
    if (structure.sentences.length === 0) {
      throw new SentencesError(422, "本文の文を 1 つも取り出せませんでした。本文が画像（スキャン）だけの PDF かもしれません。");
    }
    const glyphs = await glyphPages(vault, id, structure);
    await withLock(vault, id, async () => {
      // 解析の間に論文が消されていたら、何も書かない（消したフォルダを作り直さない）。
      await requirePaper(vault, id);
      let current: PaperDocument | null = null;
      try {
        current = await readDocument(vault, id);
      } catch (e) {
        if (!(e instanceof CorruptError)) throw e;
        // 壊れたファイルは捨てずに横へ置く。手で中身を拾える余地を残す。
        await fs.rename(vault.resolve(sentencesPath(id)), vault.resolve(`${PAPERS_DIR}/${id}/sentences.corrupt-${Date.now()}.json`));
      }
      // 区切りの直し（分割）を当て直したあとの枠も含めて、端をグリフに合わせる
      const next = withGlyphEdges(
        current ? applyStructure(current, structure).document : createDocument({ structure, sourceFileName: "paper.pdf", id }),
        glyphs,
      );
      await writeDocument(vault, next);
      await writeStatus(vault, id, { status: "done", at: new Date().toISOString(), ...(warning ? { warning } : {}) });
    });
  } catch (e) {
    const f = describeFailure(e);
    try {
      if (await vault.exists(notePath(id))) await writeStatus(vault, id, { status: "failed", ...f, at: new Date().toISOString() });
    } catch {
      // 印が書けなくても、返す状態で伝わる
    }
    running.delete(runKey(vault, id));
    return { status: "failed", ...f };
  }
  running.delete(runKey(vault, id));
  return sentencesState(vault, id).catch((e) => ({ status: "failed" as const, ...describeFailure(e) }));
}

/**
 * 解析を始める（このプロセスで走っていれば、それを待つ）。終わると結果の状態で解決する。決して reject しない。
 * 再解析では訳・メモ・区切りの直しを applyStructure で引き継ぐ。
 * 呼び出し直後に sentencesState を見れば "parsing" が返る。
 */
export function parseSentences(vault: NodeVault, id: string, parser: ParserChoice = "auto"): Promise<SentencesState> {
  try {
    checkId(id);
  } catch (e) {
    return Promise.resolve({ status: "failed", ...describeFailure(new SentencesError(400, (e as Error).message)) });
  }
  const key = runKey(vault, id);
  const existing = running.get(key);
  if (existing) return existing.promise;
  const startedAt = new Date().toISOString();
  const entry = { startedAt, promise: Promise.resolve<SentencesState>({ status: "parsing", startedAt }) };
  running.set(key, entry);
  entry.promise = (async () => {
    try {
      await requirePaper(vault, id);
    } catch (e) {
      running.delete(key);
      return { status: "failed" as const, ...describeFailure(e) };
    }
    return runParse(vault, id, parser, startedAt);
  })();
  return entry.promise;
}

/** このプロセスで解析中か。 */
export const isParsing = (vault: NodeVault, id: string) => running.has(runKey(vault, id));

// --- 注釈の操作 --------------------------------------------------------------------

export function setTranslation(vault: NodeVault, id: string, hash: string, text: string, source: "claude" | "human") {
  return mutate(vault, id, (doc) => must(coreSetTranslation(doc, hash, text, { source }), "訳を書き込めませんでした").document);
}

export async function setTranslations(
  vault: NodeVault,
  id: string,
  items: { hash: string; text: string }[],
  source: "claude" | "human",
): Promise<{ document: PaperDocument; applied: number; unknown: string[] }> {
  let applied = 0;
  const unknown: string[] = [];
  const document = await mutate(vault, id, (doc) => {
    let working = doc;
    for (const it of items) {
      const r = coreSetTranslation(working, it.hash, it.text, { source });
      if (r.applied) {
        applied++;
        working = r.document;
      } else unknown.push(it.hash);
    }
    return working;
  });
  return { document, applied, unknown };
}

export function clearTranslation(vault: NodeVault, id: string, hash: string) {
  return mutate(vault, id, (doc) => deleteTranslation(doc, hash).document);
}

export function addSentenceNote(vault: NodeVault, id: string, hash: string, body: string) {
  return mutate(vault, id, (doc) => must(addNote(doc, hash, body), "メモを付けられませんでした").document);
}

export function removeSentenceNote(vault: NodeVault, id: string, noteId: string) {
  return mutate(vault, id, (doc) => must(deleteNote(doc, noteId), `メモが見つかりません: ${noteId}`).document);
}

export function skipSentences(vault: NodeVault, id: string, hashes: string[], reason: string | null) {
  return mutate(vault, id, (doc) => coreSkip(doc, hashes, reason?.trim() || "other").document);
}

export function unskipSentences(vault: NodeVault, id: string, hashes: string[]) {
  return mutate(vault, id, (doc) => coreUnskip(doc, hashes).document);
}

/**
 * 区切りの直しで作り直した枠（分割した文の境目は字幅の見積もり）も、グリフに合わせる。
 * グリフに合わせて解析した文書だけ。古い文書は再解析を案内しているので、ここでは触らない。
 */
async function boundaryMutate(vault: NodeVault, id: string, fn: (doc: PaperDocument) => PaperDocument) {
  let pages: GlyphPage[] | null = null;
  try {
    const doc = await withLock(vault, id, () => readDocument(vault, id));
    if (doc?.structure.rectEdges === "glyph") pages = await glyphPages(vault, id, doc.structure);
  } catch {
    // 読めないときは mutate が理由付きで断る
  }
  return mutate(vault, id, (doc) => {
    const next = fn(doc);
    return pages?.length && next.structure.rectEdges === "glyph" ? withGlyphEdges(next, pages) : next;
  });
}

export function editSentenceBoundary(
  vault: NodeVault,
  id: string,
  edit: { type: "merge" | "split" | "drop"; hashes: string[]; offsets?: number[] },
) {
  return boundaryMutate(vault, id, (doc) => must(coreEditBoundary(doc, edit), "文の区切りを直せませんでした").document);
}

export function undoSentenceEdit(vault: NodeVault, id: string, editId: string) {
  return boundaryMutate(vault, id, (doc) => must(coreUndoEdit(doc, editId), "取り消せる編集がありません").document);
}

export function upsertGlossary(vault: NodeVault, id: string, entry: { term: string; translation: string; note?: string | null }) {
  const term = entry.term.trim();
  const translation = entry.translation.trim();
  if (!term) return Promise.reject(new SentencesError(400, "原語が空です"));
  if (!translation) return Promise.reject(new SentencesError(400, "訳語が空です"));
  return mutate(vault, id, (doc) => upsertGlossaryEntry(doc, { term, translation, note: entry.note?.trim() || null }).document);
}

export function removeGlossary(vault: NodeVault, id: string, term: string) {
  return mutate(vault, id, (doc) => removeGlossaryEntry(doc, term).document);
}
