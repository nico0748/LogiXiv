// 保管庫の中の論文フォルダを扱う。
//
//   <保管庫>/
//     _templates/reading-note.md   読解ノートのテンプレート
//     papers/<論文ID>/
//       paper.pdf                  取り込んだ PDF
//       note.md                    読解ノート（テンプレートから作る）
//       paperlens.json             マーカー・用語・数式の位置などの補助データ

import { DEFAULT_TEMPLATE } from "./defaultTemplate.ts";
import {
  type AnnotationOp,
  type Annotations,
  applyOps,
  emptyAnnotations,
  renderEquations,
  renderHighlights,
  renderTerms,
} from "./model.ts";
import { type FmValue, fmText, readFrontmatter, setFrontmatterValue } from "./frontmatter.ts";
import { type FieldDef, fillPlaceholders, getFrontmatter, parseFields, setField, setList } from "./template.ts";
import type { Vault } from "./vault.ts";

export const TEMPLATE_PATH = "_templates/reading-note.md";
export const PAPERS_DIR = "papers";

export interface PaperSummary {
  id: string;
  title: string;
  status: string;
  year: string;
}

export const notePath = (id: string) => `${PAPERS_DIR}/${id}/note.md`;
export const pdfPath = (id: string) => `${PAPERS_DIR}/${id}/paper.pdf`;
export const dataPath = (id: string) => `${PAPERS_DIR}/${id}/paperlens.json`;

/** 論文 ID はフォルダ名そのもの。保管庫の外を指す ID は受け付けない。 */
export function checkId(id: string) {
  if (!id || /[\\/]/.test(id) || id === "." || id === "..") throw new Error(`論文 ID が正しくありません: ${id}`);
  return id;
}

export async function ensureLayout(vault: Vault) {
  if (!(await vault.exists(TEMPLATE_PATH))) {
    await vault.writeText(TEMPLATE_PATH, DEFAULT_TEMPLATE);
  }
}

export async function listPapers(vault: Vault): Promise<PaperSummary[]> {
  if (!(await vault.exists(PAPERS_DIR))) return [];
  const dirs = (await vault.list(PAPERS_DIR)).filter((e) => e.kind === "directory");
  const out: PaperSummary[] = [];
  for (const d of dirs) {
    try {
      const fm = getFrontmatter(await vault.readText(notePath(d.name)));
      out.push({
        id: d.name,
        title: fm.title || d.name,
        status: fm.status || "未読",
        year: fm.year || "",
      });
    } catch {
      // note.md が無いフォルダは論文として扱わない
    }
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

export function slugify(name: string) {
  const base = name
    .replace(/\.pdf$/i, "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|#^[\]]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 60);
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `${ymd}-${base || "paper"}`;
}

export async function importPaper(
  vault: Vault,
  fileName: string,
  data: ArrayBuffer,
  title: string,
): Promise<string> {
  let id = slugify(fileName);
  for (let i = 2; await vault.exists(`${PAPERS_DIR}/${id}`); i++) {
    id = `${slugify(fileName)}-${i}`;
  }
  await ensureLayout(vault);
  const template = await vault.readText(TEMPLATE_PATH);
  const filled = fillPlaceholders(template, {
    title: title.replace(/\n/g, " "),
    date: new Date().toISOString().slice(0, 10),
    pdf: "paper.pdf",
    id,
  });
  // コロンなどを含む題名でも YAML として読めるように、frontmatter は引用符付きで入れ直す
  const note = "title" in readFrontmatter(filled) ? setFrontmatterValue(filled, "title", title.replace(/\n/g, " ")) : filled;
  await vault.writeBinary(pdfPath(id), data);
  await vault.writeText(notePath(id), note);
  await vault.writeText(dataPath(id), JSON.stringify(emptyAnnotations(), null, 2));
  return id;
}

export async function loadPdf(vault: Vault, id: string) {
  return vault.readBinary(pdfPath(checkId(id)));
}

export async function loadNote(vault: Vault, id: string) {
  return vault.readText(notePath(checkId(id)));
}

export async function loadAnnotations(vault: Vault, id: string): Promise<Annotations> {
  try {
    const parsed = JSON.parse(await vault.readText(dataPath(checkId(id)))) as Annotations;
    return { ...emptyAnnotations(), ...parsed };
  } catch {
    return emptyAnnotations();
  }
}

/**
 * 読解ノートを更新する。
 * 書き込む直前にファイルを読み直し、指定した範囲だけを書き換える。
 * Obsidian など別のアプリで同時に編集していても、範囲外の変更は残る。
 */
// 同じファイルへの書き込みは順番に処理する。読み直しと書き込みの間に別の更新が入らないようにする。
const queues = new Map<string, Promise<unknown>>();

function serial<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(job);
  queues.set(key, next);
  return next;
}

export function updateNote(
  vault: Vault,
  id: string,
  edit: (md: string) => string,
): Promise<string> {
  const path = notePath(checkId(id));
  return serial(path, async () => {
    const current = await vault.readText(path);
    const next = edit(current);
    if (next !== current) await vault.writeText(path, next);
    return next;
  });
}

export const writeField = (vault: Vault, id: string, field: string, value: string) =>
  updateNote(vault, id, (md) => setField(md, field, value));

export const writeStatus = (vault: Vault, id: string, status: string) =>
  updateNote(vault, id, (md) => setFrontmatterValue(md, "status", status));

/** frontmatter の1項目を書く。一覧の項目は配列で渡す。複数行の値の項目は FrontmatterError になる。 */
export const writeMeta = (vault: Vault, id: string, key: string, value: FmValue) =>
  updateNote(vault, id, (md) => setFrontmatterValue(md, key, value));

const renderLists = (md: string, a: Annotations) => {
  let out = setList(md, "highlights", renderHighlights(a.highlights), "マーカーと訳");
  out = setList(out, "terms", renderTerms(a.terms), "用語");
  out = setList(out, "equations", renderEquations(a.equations), "数式");
  return out;
};

/** 補助データを丸ごと保存し、ノートの一覧部分を書き直す。 */
export async function saveAnnotations(vault: Vault, id: string, a: Annotations) {
  await serial(dataPath(checkId(id)), () => vault.writeText(dataPath(id), JSON.stringify(a, null, 2)));
  return updateNote(vault, id, (md) => renderLists(md, a));
}

/**
 * 注釈に操作を当てて保存し、ノートの一覧部分を書き直す。
 * 保存直前に読み直すので、別の書き手（画面と AI エージェントなど）の変更を消さない。
 */
export async function changeAnnotations(vault: Vault, id: string, ops: AnnotationOp[]) {
  const path = dataPath(checkId(id));
  const annotations = await serial(path, async () => {
    const next = applyOps(await loadAnnotations(vault, id), ops);
    await vault.writeText(path, JSON.stringify(next, null, 2));
    return next;
  });
  const note = await updateNote(vault, id, (md) => renderLists(md, annotations));
  return { annotations, note };
}

export async function readTemplate(vault: Vault) {
  return (await vault.exists(TEMPLATE_PATH)) ? vault.readText(TEMPLATE_PATH) : DEFAULT_TEMPLATE;
}

export async function writeTemplate(vault: Vault, text: string) {
  await vault.writeText(TEMPLATE_PATH, text);
}

export interface PaperDetail extends PaperSummary {
  /** 一覧の項目（authors・tags など）は配列のまま返す */
  frontmatter: Record<string, FmValue>;
  fields: FieldDef[];
  annotations: Annotations;
}

/** 論文1本の記録をまとめて返す。AI エージェント向け。 */
export async function paperDetail(vault: Vault, id: string): Promise<PaperDetail> {
  const note = await loadNote(vault, checkId(id));
  const fm = readFrontmatter(note);
  return {
    id,
    title: fmText(fm.title) || id,
    status: fmText(fm.status) || "未読",
    year: fmText(fm.year),
    frontmatter: fm,
    fields: parseFields(note),
    annotations: await loadAnnotations(vault, id),
  };
}

export interface SearchHit {
  paper: string;
  file: string;
  line: number;
  text: string;
}

/** すべての読解ノートから語句を含む行を探す。大文字と小文字は区別しない。 */
export async function searchNotes(vault: Vault, query: string, limit = 50): Promise<SearchHit[]> {
  const needle = query.toLowerCase();
  const hits: SearchHit[] = [];
  for (const p of await listPapers(vault)) {
    const lines = (await loadNote(vault, p.id)).split("\n");
    for (let i = 0; i < lines.length && hits.length < limit; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        hits.push({ paper: p.id, file: notePath(p.id), line: i + 1, text: lines[i].trim().slice(0, 300) });
      }
    }
    if (hits.length >= limit) break;
  }
  return hits;
}

/** 保管庫全体の用語リンクを集める。グラフ表示に使う。 */
export async function collectGraph(vault: Vault, papers: PaperSummary[]) {
  const links: { paper: string; term: string }[] = [];
  for (const p of papers) {
    const a = await loadAnnotations(vault, p.id);
    for (const t of a.terms) links.push({ paper: p.id, term: t.term });
    for (const t of a.terms) for (const r of t.related) links.push({ paper: p.id, term: r });
  }
  return links;
}
