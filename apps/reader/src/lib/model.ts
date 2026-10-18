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
  /** 論文中で出てきた場所（PDF で選択して登録したとき）。無ければ page の本文から語を探す。 */
  rects?: Rect[];
  createdAt: string;
}

/** 数式の記号が表す値の種類。 */
export type SymbolKind = "scalar" | "vector" | "matrix" | "tensor" | "set" | "function" | "other";

export const SYMBOL_KIND_LABEL: Record<SymbolKind, string> = {
  scalar: "スカラー",
  vector: "ベクトル",
  matrix: "行列",
  tensor: "テンソル",
  set: "集合",
  function: "関数",
  other: "その他",
};

/** 数式に出てくる記号（x, y, W など）と、論文中での意味。 */
export interface MathSymbol {
  /** TeX（例: \mathbf{x}、W_{q}） */
  symbol: string;
  /** 種類が分からないときは空 */
  kind: SymbolKind | "";
  /** 論文中で何を表すか */
  meaning: string;
  /** 次元や値の範囲（例: \mathbb{R}^{d}、n \times d）。TeX で書く */
  shape?: string;
}

export interface Equation {
  id: string;
  label: string;
  tex: string;
  explanation: string;
  /** 式に出てくる記号の一覧 */
  symbols?: MathSymbol[];
  page?: number;
  /** 論文中で式がある場所（PDF で選択した範囲、または囲んだ枠） */
  rects?: Rect[];
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
    .sort((a, b) => a.page - b.page || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0))
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

// numeric: "式(2)" が "式(10)" より前に来る。
const labelCollator = new Intl.Collator("ja", { sensitivity: "base", numeric: true });

/** ページ内の上下の位置（出てきた場所が分かるものだけ）。 */
const topOf = (x: { rects?: Rect[] }) => x.rects?.[0]?.y ?? Infinity;

/**
 * 数式を論文のページ順に並べる（同じページなら上から、位置が分からなければ見出しの番号順）。
 * ページの無いもの（手入力したばかりの数式）は、すぐ書き始められるよう先頭に置く。
 */
export function sortEquationsByPage(list: Equation[]): Equation[] {
  return [...list].sort(
    (a, b) =>
      (a.page ?? -Infinity) - (b.page ?? -Infinity) || topOf(a) - topOf(b) || labelCollator.compare(a.label, b.label),
  );
}

/** 用語を論文のページ順に並べる（同じページなら上から、次に見出し語順）。ページの無いものは先頭。 */
export function sortTermsByPage(list: Term[]): Term[] {
  return [...list].sort(
    (a, b) => (a.page ?? -Infinity) - (b.page ?? -Infinity) || topOf(a) - topOf(b) || labelCollator.compare(a.term, b.term),
  );
}

export function renderEquations(list: Equation[]): string {
  return sortEquationsByPage(list)
    .map((e) => {
      const head = `### ${e.label || "数式"}${e.page ? `（p.${e.page}）` : ""}`;
      const parts = [head, "", "$$", e.tex.trim(), "$$"];
      if (e.explanation.trim()) parts.push("", e.explanation.trim());
      const syms = (e.symbols ?? []).filter((x) => x.symbol.trim() || x.meaning.trim());
      if (syms.length) {
        parts.push("", "| 記号 | 種類 | 意味 | 次元・範囲 |", "| --- | --- | --- | --- |");
        for (const x of syms) {
          const tex = (t: string) => (t.trim() ? `$${t.trim()}$` : "");
          parts.push(`| ${[tex(x.symbol), x.kind ? SYMBOL_KIND_LABEL[x.kind] : "", x.meaning.trim(), tex(x.shape ?? "")].map(cell).join(" | ")} |`);
        }
      }
      return parts.join("\n");
    })
    .join("\n\n");
}

/** 表の 1 マス。| と改行は表を壊すので逃がす。 */
function cell(text: string) {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

function quote(text: string) {
  return text
    .trim()
    .split("\n")
    .map((l) => `> ${l}`);
}

// --- 注釈の差分 -------------------------------------------------------------
// 画面と AI エージェント（MCP）が同じ論文を同時に触っても上書きし合わないように、
// 注釈は「丸ごと保存」ではなく「追加・更新・削除の操作」で書き込む。
// 書き込む側は保存直前にファイルを読み直し、そこへ操作を当てる。

export type ListName = "highlights" | "terms" | "equations";
type Item<L extends ListName> = Annotations[L][number];

export type AnnotationOp =
  | { op: "add"; list: ListName; item: Highlight | Term | Equation }
  | { op: "update"; list: ListName; id: string; patch: Partial<Highlight & Term & Equation> }
  | { op: "remove"; list: ListName; id: string };

export const LISTS: ListName[] = ["highlights", "terms", "equations"];

/** マーカーは末尾に、用語と数式は先頭に足す（画面で新しいものが上に来る並び）。 */
const PREPEND: Record<ListName, boolean> = { highlights: false, terms: true, equations: true };

export function applyOps(a: Annotations, ops: AnnotationOp[]): Annotations {
  const out: Annotations = { ...a, highlights: [...a.highlights], terms: [...a.terms], equations: [...a.equations] };
  for (const op of ops) {
    const list = out[op.list] as Item<ListName>[];
    if (op.op === "add") {
      const i = list.findIndex((x) => x.id === op.item.id);
      if (i >= 0) list[i] = { ...list[i], ...op.item } as Item<ListName>;
      else if (PREPEND[op.list]) list.unshift(op.item);
      else list.push(op.item);
    } else if (op.op === "update") {
      const i = list.findIndex((x) => x.id === op.id);
      if (i >= 0) list[i] = { ...list[i], ...op.patch, id: op.id } as Item<ListName>;
    } else {
      const i = list.findIndex((x) => x.id === op.id);
      if (i >= 0) list.splice(i, 1);
    }
  }
  return out;
}

/** base から next への変化を操作の列にする。 */
export function diffAnnotations(base: Annotations, next: Annotations): AnnotationOp[] {
  const ops: AnnotationOp[] = [];
  for (const list of LISTS) {
    const before = new Map((base[list] as Item<ListName>[]).map((x) => [x.id, x]));
    const after = next[list] as Item<ListName>[];
    const ids = new Set(after.map((x) => x.id));
    for (const x of before.values()) if (!ids.has(x.id)) ops.push({ op: "remove", list, id: x.id });
    const added = after.filter((x) => !before.has(x.id));
    // 先頭に足す一覧は、逆順に足すと画面と同じ並びになる
    for (const x of PREPEND[list] ? [...added].reverse() : added) ops.push({ op: "add", list, item: x });
    for (const x of after) {
      const b = before.get(x.id);
      if (!b || JSON.stringify(b) === JSON.stringify(x)) continue;
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(x)) if (JSON.stringify((b as unknown as Record<string, unknown>)[k]) !== JSON.stringify(v)) patch[k] = v;
      ops.push({ op: "update", list, id: x.id, patch });
    }
  }
  return ops;
}
