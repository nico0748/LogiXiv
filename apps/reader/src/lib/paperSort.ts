// 論文一覧の並び順。左サイドバーの「並び順」で選ぶ。
//
// - 追加日: ノートの created が新しい順。日付が同じか無いものは、論文 ID の逆順（これまでの並び）
// - 題名: 日本語は読みではなく文字の順。大文字と小文字、全角と半角は区別しない
// - 発行年: 新しい順。年の無い論文は最後
// - 段階: 未読 → まとめ済みの順。テンプレートで足した段階は最後

import { STATUSES } from "./defaultTemplate.ts";
import type { PaperSummary } from "./papers.ts";

export const SORT_KEYS = ["created", "title", "year", "status"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const SORT_LABEL: Record<SortKey, string> = {
  created: "追加日が新しい順",
  title: "題名の順",
  year: "発行年が新しい順",
  status: "読解の段階の順",
};

export const isSortKey = (v: unknown): v is SortKey => SORT_KEYS.includes(v as SortKey);

const collator = new Intl.Collator("ja", { sensitivity: "base", numeric: true });
const byId = (a: PaperSummary, b: PaperSummary) => b.id.localeCompare(a.id);
const stage = (s: string) => {
  const i = (STATUSES as readonly string[]).indexOf(s);
  return i < 0 ? STATUSES.length : i;
};
const yearOf = (p: PaperSummary) => Number(p.year.replace(/\D/g, "").slice(0, 4)) || 0;

export function sortPapers(papers: PaperSummary[], key: SortKey): PaperSummary[] {
  const cmp: Record<SortKey, (a: PaperSummary, b: PaperSummary) => number> = {
    created: (a, b) => b.created.localeCompare(a.created),
    title: (a, b) => collator.compare(a.title.normalize("NFKC"), b.title.normalize("NFKC")),
    year: (a, b) => yearOf(b) - yearOf(a),
    status: (a, b) => stage(a.status) - stage(b.status),
  };
  return [...papers].sort((a, b) => cmp[key](a, b) || byId(a, b));
}
