// 「リスト」（単語帳・数式帳）の型と、絞り込み・並べ替えの純粋な関数。
// 保管庫のすべての論文から集めた用語と数式を、画面（ListModal）とサーバー（server/lists.ts）で共有する。
// Node の機能は使わない。

export type VocabItem = {
  key: string;
  paperId: string;
  paperTitle: string;
  /** term は paperlens.json の用語、glossary は sentences.json の対訳用語集 */
  source: "term" | "glossary";
  term: string;
  reading?: string;
  meaning: string;
  detail?: string;
  page?: number;
  createdAt?: string;
};

export type FormulaItem = {
  key: string;
  paperId: string;
  paperTitle: string;
  id: string;
  label: string;
  tex: string;
  explanation: string;
  page?: number;
  createdAt?: string;
};

export type ListsResponse = { vocab: VocabItem[]; formulas: FormulaItem[] };

export type SortMode = "paper" | "alpha";

// 日本語（かな・漢字）と英字を混ぜても自然な順になるよう、ja の照合順序を使う。
// numeric: "式 2" が "式 10" より前に来る。
const collator = new Intl.Collator("ja", { sensitivity: "base", numeric: true });
export const compareText = (a: string, b: string) => collator.compare(a, b);

/** 同じ用語かどうかの判定に使う形。全角・半角と大文字・小文字、前後の空白の違いは無視する。 */
export function normTerm(s: string) {
  return s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** 空白で区切った語をすべて含むものだけを残す（AND 検索）。 */
function matcher(query: string) {
  const words = normTerm(query).split(" ").filter(Boolean);
  return (fields: (string | undefined)[]) => {
    if (!words.length) return true;
    const hay = normTerm(fields.filter(Boolean).join("\n"));
    return words.every((w) => hay.includes(w));
  };
}

export function filterVocab(items: VocabItem[], query: string, paperId?: string | null): VocabItem[] {
  const hit = matcher(query);
  return items.filter(
    (v) => (!paperId || v.paperId === paperId) && hit([v.term, v.reading, v.meaning, v.detail, v.paperTitle]),
  );
}

export function filterFormulas(items: FormulaItem[], query: string, paperId?: string | null): FormulaItem[] {
  const hit = matcher(query);
  return items.filter(
    (f) => (!paperId || f.paperId === paperId) && hit([f.label, f.tex, f.explanation, f.paperTitle]),
  );
}

/**
 * 同じ用語は1行にまとめる。複数の論文で調べた用語は、論文ごとの意味を並べて見比べられる。
 * reading は最初に見つかった空でないものを使う。
 */
export type VocabRow = { key: string; term: string; reading?: string; entries: VocabItem[] };

export function mergeVocab(items: VocabItem[]): VocabRow[] {
  const rows = new Map<string, VocabRow>();
  for (const v of items) {
    const k = normTerm(v.term);
    const row = rows.get(k);
    if (row) {
      row.entries.push(v);
      if (!row.reading && v.reading) row.reading = v.reading;
    } else {
      rows.set(k, { key: `row:${k}`, term: v.term, reading: v.reading || undefined, entries: [v] });
    }
  }
  for (const r of rows.values()) r.entries.sort(byPaperThenPage);
  return [...rows.values()];
}

/** 用語は読みがあれば読みで並べる（「埋め込み」を「うめこみ」の位置に置く）。 */
const sortKey = (r: VocabRow) => r.reading || r.term;

export function sortVocabRows(rows: VocabRow[]): VocabRow[] {
  return [...rows].sort((a, b) => compareText(sortKey(a), sortKey(b)) || compareText(a.term, b.term));
}

export function sortFormulas(items: FormulaItem[]): FormulaItem[] {
  return [...items].sort((a, b) => compareText(a.label || a.tex, b.label || b.tex) || byPaperThenPage(a, b));
}

function byPaperThenPage(a: { paperTitle: string; paperId: string; page?: number }, b: typeof a) {
  return (
    compareText(a.paperTitle, b.paperTitle) ||
    a.paperId.localeCompare(b.paperId) ||
    (a.page ?? Infinity) - (b.page ?? Infinity)
  );
}

export type Section<T> = { key: string; paperId: string; title: string; items: T[] };

/** 論文ごとに分ける。論文は題名順、中身はページ順（ページが無いものは後ろ）、同じページなら名前順。 */
export function sectionsByPaper<T extends { paperId: string; paperTitle: string; page?: number }>(
  items: T[],
  name: (x: T) => string,
): Section<T>[] {
  const map = new Map<string, Section<T>>();
  for (const x of items) {
    let s = map.get(x.paperId);
    if (!s) map.set(x.paperId, (s = { key: `paper:${x.paperId}`, paperId: x.paperId, title: x.paperTitle, items: [] }));
    s.items.push(x);
  }
  const out = [...map.values()].sort((a, b) => compareText(a.title, b.title) || a.paperId.localeCompare(b.paperId));
  for (const s of out) {
    s.items.sort((a, b) => (a.page ?? Infinity) - (b.page ?? Infinity) || compareText(name(a), name(b)));
  }
  return out;
}

/** 論文ごとの件数。ナビの論文絞り込みに使う。 */
export function countByPaper(items: { paperId: string; paperTitle: string }[]) {
  const map = new Map<string, { paperId: string; title: string; count: number }>();
  for (const x of items) {
    const c = map.get(x.paperId);
    if (c) c.count++;
    else map.set(x.paperId, { paperId: x.paperId, title: x.paperTitle, count: 1 });
  }
  return [...map.values()].sort((a, b) => compareText(a.title, b.title));
}
