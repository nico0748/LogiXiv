// 保管庫のすべての論文から、単語帳（用語）と数式帳（数式）を集める。
//   用語: paperlens.json の terms と、sentences.json（対訳）の annotations.glossary
//   数式: paperlens.json の equations
// sentences.json は無い論文もあるので、無い・壊れているときは用語集なしとして扱う。

import { PAPERS_DIR, listPapers, loadAnnotations } from "../src/lib/papers.ts";
import type { FormulaItem, ListsResponse, VocabItem } from "../src/lib/lists.ts";
import type { NodeVault } from "./nodeVault.ts";

export const sentencesPath = (id: string) => `${PAPERS_DIR}/${id}/sentences.json`;

type Glossary = { term: string; translation: string; note?: string | null };

/** sentences.json から用語集だけを取り出す。形が違う項目は飛ばす。 */
async function loadGlossary(vault: NodeVault, id: string): Promise<Glossary[]> {
  try {
    if (!(await vault.exists(sentencesPath(id)))) return [];
    const doc = JSON.parse(await vault.readText(sentencesPath(id))) as { annotations?: { glossary?: unknown } };
    const list = doc?.annotations?.glossary;
    if (!Array.isArray(list)) return [];
    return list.filter(
      (g): g is Glossary => !!g && typeof g === "object" && typeof g.term === "string" && g.term.trim() !== "",
    );
  } catch {
    return [];
  }
}

export async function collectLists(vault: NodeVault): Promise<ListsResponse> {
  const vocab: VocabItem[] = [];
  const formulas: FormulaItem[] = [];
  for (const p of await listPapers(vault)) {
    const a = await loadAnnotations(vault, p.id);
    for (const t of a.terms ?? []) {
      if (!t?.term?.trim()) continue;
      const detail = [t.detail?.trim(), t.inPaper?.trim() ? `この論文での使われ方: ${t.inPaper.trim()}` : ""]
        .filter(Boolean)
        .join("\n\n");
      vocab.push({
        key: `${p.id}:term:${t.id}`,
        paperId: p.id,
        paperTitle: p.title,
        source: "term",
        term: t.term.trim(),
        reading: t.reading?.trim() || undefined,
        meaning: t.short?.trim() ?? "",
        detail: detail || undefined,
        page: t.page,
        createdAt: t.createdAt || undefined,
      });
    }
    for (const g of await loadGlossary(vault, p.id)) {
      vocab.push({
        key: `${p.id}:glossary:${g.term}`,
        paperId: p.id,
        paperTitle: p.title,
        source: "glossary",
        term: g.term.trim(),
        meaning: typeof g.translation === "string" ? g.translation.trim() : "",
        detail: typeof g.note === "string" && g.note.trim() ? g.note.trim() : undefined,
      });
    }
    for (const e of a.equations ?? []) {
      if (!e?.tex?.trim() && !e?.label?.trim()) continue;
      formulas.push({
        key: `${p.id}:eq:${e.id}`,
        paperId: p.id,
        paperTitle: p.title,
        id: e.id,
        label: e.label?.trim() ?? "",
        tex: e.tex ?? "",
        explanation: e.explanation?.trim() ?? "",
        page: e.page,
        createdAt: e.createdAt || undefined,
      });
    }
  }
  return { vocab, formulas };
}
