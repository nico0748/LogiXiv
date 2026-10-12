// 論文1本ぶんの注釈データ。papers/<id>/paperlens.json に保存する。
// 読解ノート（note.md）の「マーカーと訳」「用語」「数式」の節は、このデータから書き出す。

export interface Rect {
  /** ページ幅・高さに対する割合（0〜1）。拡大率を変えても位置がずれない。 */
  x: number;
  y: number;
  w: number;
  h: number;
}

export type MarkerColor = "yellow" | "cyan" | "magenta" | "green";

export interface Highlight {
  id: string;
  page: number;
  rects: Rect[];
  text: string;
  color: MarkerColor;
  translation: string;
  memo: string;
  createdAt: string;
}

export interface Term {
  id: string;
  term: string;
  reading: string;
  short: string;
  detail: string;
  inPaper: string;
  related: string[];
  page?: number;
  createdAt: string;
}

export interface Equation {
  id: string;
  label: string;
  tex: string;
  explanation: string;
  page?: number;
  source: string;
  createdAt: string;
}

export interface Annotations {
  version: 1;
  highlights: Highlight[];
  terms: Term[];
  equations: Equation[];
}

export const emptyAnnotations = (): Annotations => ({
  version: 1,
  highlights: [],
  terms: [],
  equations: [],
});

export const MARKER_LABEL: Record<MarkerColor, string> = {
  yellow: "黄",
  cyan: "水色",
  magenta: "桃",
  green: "緑",
};

export function newId(prefix: string) {
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}${r}`;
}

// --- note.md へ書き出す Markdown ------------------------------------------

export function renderHighlights(list: Highlight[]): string {
  return [...list]
    .sort((a, b) => a.page - b.page || a.rects[0]?.y - b.rects[0]?.y)
    .map((h) => {
      const lines = [
        `> [!quote] p.${h.page}（${MARKER_LABEL[h.color]}）`,
        ...quote(h.text),
      ];
      if (h.translation.trim()) lines.push(">", ...quote(`訳: ${h.translation.trim()}`));
      if (h.memo.trim()) lines.push(">", ...quote(`メモ: ${h.memo.trim()}`));
      return `${lines.join("\n")}\n^${h.id}`;
    })
    .join("\n\n");
}

export function renderTerms(list: Term[]): string {
  return list
    .map((t) => {
      const head = `### [[${t.term}]]${t.reading ? `（${t.reading}）` : ""}`;
      const body = [
        t.short.trim(),
        t.detail.trim(),
        t.inPaper.trim() ? `この論文での使われ方: ${t.inPaper.trim()}` : "",
        t.related.length ? `関連: ${t.related.map((r) => `[[${r}]]`).join("、")}` : "",
        t.page ? `出典: p.${t.page}` : "",
      ].filter(Boolean);
      return [head, "", ...body.flatMap((b) => [b, ""])].join("\n").trimEnd();
    })
    .join("\n\n");
}

export function renderEquations(list: Equation[]): string {
  return list
    .map((e) => {
      const head = `### ${e.label || "数式"}${e.page ? `（p.${e.page}）` : ""}`;
      const parts = [head, "", "$$", e.tex.trim(), "$$"];
      if (e.explanation.trim()) parts.push("", e.explanation.trim());
      return parts.join("\n");
    })
    .join("\n\n");
}

function quote(text: string) {
  return text
    .trim()
    .split("\n")
    .map((l) => `> ${l}`);
}
