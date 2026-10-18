// 対訳（1 文ずつの訳）の画面で使う、副作用の無い計算。
//
// 画面の部品とサーバーから切り離してあるので、node --test だけで確かめられる。
// @paperlens/core は型だけを読む（本体は node:crypto を読むため、ブラウザには持ち込めない）。
// 差し込み位置の規則だけは core と共有する。依存の無い 1 ファイルなので直接読む。

import type {
  DocumentStructure,
  NonBodySentence,
  Note,
  PageSize,
  PaperDocument,
  Rect as CoreRect,
  Sentence,
} from "@paperlens/core";
import { placeNonBody } from "../../../../packages/core/src/nonbody.ts";
import type { Equation } from "./model.ts";

/** PaperLens 側の矩形（ページに対する割合、左上原点）。 */
export interface FracRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 1 つのマーカー（文の 1 行ぶん）。 */
export interface SentenceMark {
  id: string;
  hash: string;
  rect: FracRect;
  translated: boolean;
}

// --- 座標 -------------------------------------------------------------------

/**
 * core の矩形（PDF ユーザー空間、左上原点、1 始まりのページ）を、ページに対する割合にする。
 * ページの大きさが分からないときは null（位置を当て推量で描くと別の文を指してしまう）。
 */
export function toPageFraction(rect: CoreRect, pageSizes: readonly PageSize[]): (FracRect & { page: number }) | null {
  const size = pageSizes.find((p) => p.page === rect.page);
  if (!size || !(size.width > 0) || !(size.height > 0)) return null;
  // はみ出したときだけ切り詰める（いつも差で求めると丸め誤差が乗る）
  const span = (start: number, len: number, total: number): [number, number] => {
    const a = start / total;
    const b = (start + len) / total;
    if (a >= 0 && b <= 1) return [a, len / total];
    const ca = Math.min(1, Math.max(0, a));
    return [ca, Math.min(1, Math.max(0, b)) - ca];
  };
  const [x, w] = span(rect.x, rect.w, size.width);
  const [y, h] = span(rect.y, rect.h, size.height);
  return { page: rect.page, x, y, w, h };
}

/** ページ番号 → そのページに描くマーカー。 */
export function marksByPage(document: PaperDocument): Map<number, SentenceMark[]> {
  const { pageSizes, sentences } = document.structure;
  const translations = document.annotations.translations;
  const map = new Map<number, SentenceMark[]>();
  for (const s of sentences) {
    for (const r of s.rects) {
      const f = toPageFraction(r, pageSizes);
      if (!f || f.w <= 0 || f.h <= 0) continue;
      const list = map.get(f.page) ?? [];
      list.push({ id: s.id, hash: s.hash, rect: { x: f.x, y: f.y, w: f.w, h: f.h }, translated: Boolean(translations[s.hash]) });
      map.set(f.page, list);
    }
  }
  return map;
}

/**
 * ページ上の点（割合）に重なる文。重なりが複数あるときは小さい矩形を採る
 * （行の矩形が隣の文の行と少し重なることがあり、狭い方が指したい文であることが多い）。
 */
export function hitTest(marks: readonly SentenceMark[], fx: number, fy: number): SentenceMark | null {
  let best: SentenceMark | null = null;
  let bestArea = Infinity;
  for (const m of marks) {
    const r = m.rect;
    if (fx < r.x || fx > r.x + r.w || fy < r.y || fy > r.y + r.h) continue;
    const area = r.w * r.h;
    if (area < bestArea) {
      best = m;
      bestArea = area;
    }
  }
  return best;
}

/**
 * 結合・分割で消えた文の、後を継いだ文。
 * 結合なら元の文を含む文、分割なら元の文の先頭の断片。どちらも元の文の書き出しで見分け、
 * 同じ書き出しが何度も出るときは元の位置（order）に近いものを採る。見つからなければ null。
 */
export function successorSentence(gone: Sentence, sentences: readonly Sentence[]): Sentence | null {
  const head = (t: string) => t.slice(0, 40);
  let best: Sentence | null = null;
  for (const s of sentences) {
    if (!s.text || !gone.text) continue;
    const merged = s.text.includes(head(gone.text));
    const split = gone.text.startsWith(head(s.text));
    if (!merged && !split) continue;
    if (!best || Math.abs(s.order - gone.order) < Math.abs(best.order - gone.order)) best = s;
  }
  return best;
}

/** 文の先頭の位置（スクロール先）。座標の無い文は null。 */
export function sentenceAnchor(document: PaperDocument, id: string): { page: number; y: number } | null {
  const s = document.structure.sentences.find((x) => x.id === id);
  if (!s) return null;
  for (const r of s.rects) {
    const f = toPageFraction(r, document.structure.pageSizes);
    if (f) return { page: f.page, y: f.y };
  }
  return s.page ? { page: s.page, y: 0 } : null;
}

// --- 絞り込み ---------------------------------------------------------------

export function notesByHash(document: PaperDocument): Map<string, Note[]> {
  const map = new Map<string, Note[]>();
  for (const n of document.annotations.notes) {
    const list = map.get(n.sentenceHash);
    if (list) list.push(n);
    else map.set(n.sentenceHash, [n]);
  }
  return map;
}

/** まだ訳す必要がある文か（訳が無く、「訳さない」にも入っていない）。 */
export function needsTranslation(document: PaperDocument, s: Sentence): boolean {
  return !document.annotations.translations[s.hash] && !document.annotations.skipped?.[s.hash];
}

export interface SentenceFilter {
  query: string;
  onlyUntranslated: boolean;
}

/** 原文・訳文・メモを横断して絞る。「未訳だけ」は訳さない文も外す。 */
export function filterSentences(document: PaperDocument, f: SentenceFilter, notes = notesByHash(document)): Sentence[] {
  const needle = f.query.trim().toLowerCase();
  return document.structure.sentences.filter((s) => {
    if (f.onlyUntranslated && !needsTranslation(document, s)) return false;
    if (!needle) return true;
    const hay = [s.text, document.annotations.translations[s.hash]?.text ?? "", ...(notes.get(s.hash) ?? []).map((n) => n.body)]
      .join(" ")
      .toLowerCase();
    return hay.includes(needle);
  });
}

/**
 * 絞り込みに一致した「訳さない行」（参考文献・キャプションなど）。
 * 「未訳だけ」のときは出さない（訳す対象ではないので、残りの作業に混ぜると紛らわしい）。
 */
export function filterNonBody(structure: DocumentStructure, f: SentenceFilter): NonBodySentence[] {
  if (f.onlyUntranslated) return [];
  const all = structure.nonBody ?? [];
  const needle = f.query.trim().toLowerCase();
  if (!needle) return all;
  return all.filter((x) => x.text.toLowerCase().includes(needle));
}

// --- 並べ方 -----------------------------------------------------------------

export type Row =
  | { kind: "heading"; key: string; title: string }
  | { kind: "sentence"; key: string; sentence: Sentence; next: Sentence | null; repeat: boolean; mergeCount: number; splitCount: number }
  | { kind: "nonbody"; key: string; item: NonBodySentence }
  | { kind: "formula"; key: string; item: NonBodySentence; equation: Equation };

/**
 * 対訳に載せない「訳さない行」。訳せず、読んでも意味の取れない断片（PDF から崩れて取れた式・表のセル・柱・ページ番号）。
 * 数式だけは、数式タブに登録した式と対応が付けば、その式（TeX）として差し込む。
 */
const HIDDEN_NONBODY = new Set<NonBodySentence["kind"]>(["formula", "table", "runningHead", "pageNumber"]);

/** 式番号（「(10)」「(3a)」）。行の中で最後に出てきたもの。 */
export function equationNumber(text: string): string | null {
  const all = [...text.matchAll(/\((\d{1,3}[a-z]?)\)/g)];
  return all.length ? all[all.length - 1]![1]! : null;
}

/**
 * 解析で数式と判断した行に対応する、数式タブの式。
 * 1. 同じページで位置が重なる式（PDF で選択・囲んで登録した式）
 * 2. 同じページ（ページ不明の式も含む）で式番号が同じ式。番号は見出しの「(10)」か、登録時の元の文字列から取る
 *    （見出しの既定値「式3」は登録した順の番号なので使わない）
 * どちらも無ければ null。
 */
export function matchEquation(item: NonBodySentence, equations: readonly Equation[], pageSizes: readonly PageSize[]): Equation | null {
  const rects = item.rects.map((r) => toPageFraction(r, pageSizes)).filter((r): r is NonNullable<typeof r> => r !== null);
  const overlaps = (e: Equation) =>
    e.page === item.page &&
    (e.rects ?? []).some((a) =>
      rects.some((b) => {
        const v = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        return v > 0.3 * Math.min(a.h, b.h);
      }),
    );
  const byPlace = equations.find((e) => e.tex.trim() && overlaps(e)) ?? equations.find(overlaps);
  if (byPlace) return byPlace;
  const no = equationNumber(item.text);
  if (!no) return null;
  const numberOf = (e: Equation) => {
    const m = e.label.match(/\((\d{1,3}[a-z]?)\)/);
    return m ? m[1]! : equationNumber(e.source);
  };
  const same = equations.filter((e) => numberOf(e) === no);
  return same.find((e) => e.page === item.page) ?? same.find((e) => e.page === undefined) ?? null;
}

/**
 * カードの並び。本文の並びでたどり、節が変わるところに見出しを、
 * 本文として扱わなかった行を本来の位置に差し込む。
 * 結合の相手は絞り込み後ではなく本文の並びで決める（見えている次のカードと結合すると結果が食い違う）。
 */
export function buildRows(
  document: PaperDocument,
  visible: readonly Sentence[],
  visibleNonBody: readonly NonBodySentence[],
  equations: readonly Equation[] = [],
): Row[] {
  const { sentences, sections, nonBody } = document.structure;
  const titles = new Map(sections.map((s) => [s.id, s.title]));
  const visibleIds = new Set(visible.map((s) => s.id));
  const nbIds = new Set(visibleNonBody.map((x) => x.id));
  const placement = placeNonBody(sentences, nonBody);

  const hashCounts = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i]!;
    hashCounts.set(s.hash, (hashCounts.get(s.hash) ?? 0) + 1);
    const n = sentences[i + 1];
    if (n) pairCounts.set(`${s.hash}|${n.hash}`, (pairCounts.get(`${s.hash}|${n.hash}`) ?? 0) + 1);
  }

  const rows: Row[] = [];
  const pushNb = (items: readonly NonBodySentence[] | undefined) => {
    for (const item of items ?? []) {
      if (!nbIds.has(item.id)) continue;
      if (item.kind === "formula") {
        const equation = matchEquation(item, equations, document.structure.pageSizes);
        if (equation) rows.push({ kind: "formula", key: `eq-${item.id}`, item, equation });
      } else if (!HIDDEN_NONBODY.has(item.kind)) rows.push({ kind: "nonbody", key: `nb-${item.id}`, item });
    }
  };
  pushNb(placement.head);
  const seen = new Set<string>();
  let lastSection: string | null | undefined;
  sentences.forEach((s, i) => {
    const repeat = seen.has(s.hash);
    seen.add(s.hash);
    if (visibleIds.has(s.id)) {
      if (s.sectionId !== lastSection) {
        const title = titles.get(s.sectionId ?? "");
        if (title) rows.push({ kind: "heading", key: `h-${s.sectionId}-${s.id}`, title });
        lastSection = s.sectionId;
      }
      const next = sentences[i + 1] ?? null;
      rows.push({
        kind: "sentence",
        key: s.id,
        sentence: s,
        next,
        repeat,
        mergeCount: next ? (pairCounts.get(`${s.hash}|${next.hash}`) ?? 1) : 0,
        splitCount: hashCounts.get(s.hash) ?? 1,
      });
    }
    pushNb(placement.after.get(s.id));
  });
  return rows;
}

// --- 進み具合と移動 ---------------------------------------------------------

export interface SentenceProgress {
  /** 異なり文の数。訳はこの単位で付く。 */
  total: number;
  translated: number;
  skipped: number;
  remaining: number;
  /** 延べの文の数（同じ本文が何度も出ると total より多い）。 */
  occurrences: number;
}

export function sentenceProgress(document: PaperDocument): SentenceProgress {
  const hashes = new Set(document.structure.sentences.map((s) => s.hash));
  const tr = document.annotations.translations;
  const sk = document.annotations.skipped ?? {};
  let translated = 0;
  let skipped = 0;
  for (const h of hashes) {
    if (tr[h]) translated++;
    else if (sk[h]) skipped++;
  }
  return { total: hashes.size, translated, skipped, remaining: hashes.size - translated - skipped, occurrences: document.structure.sentences.length };
}

/** j/k（1 文ずつ）と n（次の未訳）の行き先。 */
export function moveTarget(
  document: PaperDocument,
  list: readonly Sentence[],
  currentId: string | null,
  step: 1 | -1 | "next-untranslated",
): Sentence | null {
  if (!list.length) return null;
  const at = currentId === null ? -1 : list.findIndex((s) => s.id === currentId);
  if (step === "next-untranslated") {
    const needs = (s: Sentence) => needsTranslation(document, s);
    return list.slice(at + 1).find(needs) ?? list.find(needs) ?? null;
  }
  if (at < 0) return step === 1 ? list[0]! : list[list.length - 1]!;
  return list[Math.min(Math.max(at + step, 0), list.length - 1)] ?? null;
}

// --- 文の区切り -------------------------------------------------------------

/** 語の切れ目。分割はここにしか置かない（単語の途中で切ると読めない断片ができる）。 */
export function wordBoundaries(text: string): number[] {
  const out: number[] = [];
  const word = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = word.exec(text)) !== null) if (m.index > 0) out.push(m.index);
  return out;
}

// --- 解析の確からしさ -------------------------------------------------------

export interface Caveat {
  level: "info" | "warn" | "danger";
  label: string;
  detail: string;
}

/**
 * 解析結果について、画面に正直に出す注意書き。
 * 完璧に取れた文書にも崩れた文書にも同じ顔をさせないため、実際に痕跡があるときだけ強く言う。
 */
export function qualityCaveats(structure: DocumentStructure): Caveat[] {
  const out: Caveat[] = [];
  if (structure.parser === "fallback")
    out.push({ level: "warn", label: "簡易解析", detail: structure.parserNote || "GROBID を使わずに解析しました。" });
  const q = structure.quality;
  if (q?.readingOrderRisk === "high") out.push({ level: "danger", label: "読み順に崩れの疑い", detail: q.reason });
  if (q?.coverageRisk === "high")
    out.push({ level: "danger", label: "本文の欠落の疑い", detail: q.coverageReason ?? "本文として読める行を落としている疑いがあります。" });
  const seams = structure.sentences.filter((s) => s.seam).length;
  if (seams > 0)
    out.push({ level: "warn", label: `抜けのある文 ${seams}`, detail: `${seams} 文に、本文として取り出せなかった行（数式・表など）が挟まっています。該当する文のカードに印があります。` });
  const noCoords = structure.sentences.filter((s) => s.rects.length === 0).length;
  if (noCoords > 0 && noCoords === structure.sentences.length)
    out.push({ level: "info", label: "位置なし", detail: "文の位置が取れなかったため、PDF に枠を描けません。" });
  return out;
}

export const NONBODY_LABEL: Record<NonBodySentence["kind"], string> = {
  frontMatter: "表題・著者",
  runningHead: "柱",
  pageNumber: "ページ番号",
  caption: "図表キャプション",
  reference: "参考文献",
  footnote: "脚注",
  formula: "数式",
  table: "表",
  other: "本文以外",
};

/** 継ぎ目に挟まっていたものの呼び方。2 つまで。 */
export function seamLabel(kinds: readonly NonBodySentence["kind"][]): string {
  const names = kinds.map((k) => NONBODY_LABEL[k] ?? "行");
  if (!names.length) return "行";
  return names.length <= 2 ? names.join("と") : `${names.slice(0, 2).join("と")}など`;
}

/** 経過時間（解析中の表示）。 */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}
