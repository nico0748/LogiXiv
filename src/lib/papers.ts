// 保管庫の中の論文フォルダを扱う。
//
//   <保管庫>/
//     _templates/reading-note.md   読解ノートのテンプレート
//     papers/<論文ID>/
//       paper.pdf                  取り込んだ PDF
//       note.md                    読解ノート（テンプレートから作る）
//       paperlens.json             マーカー・用語・数式の位置などの補助データ

import { DEFAULT_TEMPLATE } from "./defaultTemplate";
import {
  type Annotations,
  emptyAnnotations,
  renderEquations,
  renderHighlights,
  renderTerms,
} from "./model";
import {
  fillPlaceholders,
  getFrontmatter,
  setField,
  setFrontmatter,
  setList,
} from "./template";
import type { Vault } from "./vault";

export const TEMPLATE_PATH = "_templates/reading-note.md";
export const PAPERS_DIR = "papers";

export interface PaperSummary {
  id: string;
  title: string;
  status: string;
  year: string;
}

const notePath = (id: string) => `${PAPERS_DIR}/${id}/note.md`;
const pdfPath = (id: string) => `${PAPERS_DIR}/${id}/paper.pdf`;
const dataPath = (id: string) => `${PAPERS_DIR}/${id}/paperlens.json`;

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
  const note = /^---\n[\s\S]*?^title:/m.test(filled)
    ? setFrontmatter(filled, "title", title.replace(/\n/g, " "))
    : filled;
  await vault.writeBinary(pdfPath(id), data);
  await vault.writeText(notePath(id), note);
  await vault.writeText(dataPath(id), JSON.stringify(emptyAnnotations(), null, 2));
  return id;
}

export async function loadPdf(vault: Vault, id: string) {
  return vault.readBinary(pdfPath(id));
}

export async function loadNote(vault: Vault, id: string) {
  return vault.readText(notePath(id));
}

export async function loadAnnotations(vault: Vault, id: string): Promise<Annotations> {
  try {
    const parsed = JSON.parse(await vault.readText(dataPath(id))) as Annotations;
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
// 同じノートへの書き込みは順番に処理する。読み直しと書き込みの間に別の更新が入らないようにする。
const queues = new Map<string, Promise<unknown>>();

export function updateNote(
  vault: Vault,
  id: string,
  edit: (md: string) => string,
): Promise<string> {
  const path = notePath(id);
  const prev = queues.get(path) ?? Promise.resolve();
  const job = prev
    .catch(() => undefined)
    .then(async () => {
      const current = await vault.readText(path);
      const next = edit(current);
      if (next !== current) await vault.writeText(path, next);
      return next;
    });
  queues.set(path, job);
  return job;
}

export const writeField = (vault: Vault, id: string, field: string, value: string) =>
  updateNote(vault, id, (md) => setField(md, field, value));

export const writeStatus = (vault: Vault, id: string, status: string) =>
  updateNote(vault, id, (md) => setFrontmatter(md, "status", status));

export const writeMeta = (vault: Vault, id: string, key: string, value: string) =>
  updateNote(vault, id, (md) => setFrontmatter(md, key, value));

/** 補助データを保存し、ノートの一覧部分を書き直す。 */
export async function saveAnnotations(vault: Vault, id: string, a: Annotations) {
  await vault.writeText(dataPath(id), JSON.stringify(a, null, 2));
  return updateNote(vault, id, (md) => {
    let out = setList(md, "highlights", renderHighlights(a.highlights), "マーカーと訳");
    out = setList(out, "terms", renderTerms(a.terms), "用語");
    out = setList(out, "equations", renderEquations(a.equations), "数式");
    return out;
  });
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
