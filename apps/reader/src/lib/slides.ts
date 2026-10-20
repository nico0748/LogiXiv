// 論文発表会のスライドと、論文の該当箇所との対応。
//
//   papers/<論文ID>/
//     slides.pdf     表示に使うスライド（PPTX は取り込むときに PDF へ変換する）
//     slides.pptx    PPTX から取り込んだときの元のファイル（残すだけで、表示には使わない）
//     slides.json    スライドを四角で囲んだ部分（マークアップ）と、論文の該当箇所へのリンク
//
// マークアップは「スライドのページ番号.そのページで何個目か」で呼ぶ（Markup-03.02 = 3 ページ目の 2 個目）。
// 番号は作ったときに決めて変えない。途中のものを消しても、ほかの名前はずれない（ノートや会話で名前を使うため）。
// 消して空いた番号は、そのページで次に作るものに使う（番号が抜けたままにならないように）。
// 画面・ローカルサーバー・MCP サーバーで同じ処理を使うので、Node.js の機能は使わない。

import type { Rect } from "./model.ts";
import { setList } from "./template.ts";
import type { Vault } from "./vault.ts";
import { PAPERS_DIR, checkId, updateNote } from "./papers.ts";

/** 論文側の該当箇所の種類 */
export type LinkKind = "text" | "figure" | "equation";

export const LINK_KIND_LABEL: Record<LinkKind, string> = { text: "文章", figure: "図", equation: "数式" };

/** 論文の該当箇所。座標は論文の PDF のページに対する割合 */
export interface SlideLink {
  id: string;
  kind: LinkKind;
  page: number;
  rects: Rect[];
  /** 文章なら選んだ文字列。図・数式なら、囲んだ範囲にある文字（無ければ空） */
  text: string;
  createdAt: string;
}

/** スライドを四角で囲んだ部分。1 つが 1 グループで、論文の該当箇所へ何本でもリンクできる */
export interface SlideMarkup {
  id: string;
  /** スライドのページ番号（1 から） */
  page: number;
  /** そのページで何個目か（1 から）。作ったときに決めて変えない。消して空いた番号は、次に作るものが使う */
  index: number;
  /** スライドのページに対する割合 */
  rect: Rect;
  /** グループの色（GROUP_COLORS の番号） */
  color: number;
  memo: string;
  links: SlideLink[];
  createdAt: string;
}

export interface SlideDeck {
  version: 1;
  /** 取り込んだファイルの名前 */
  source: string;
  /** PPTX から変換したときの元の形式 */
  convertedFrom?: "pptx";
  importedAt: string;
  /** 以前の版が書いていた、ページごとに使った最大の番号。今は読まない（消した番号を使い直すため） */
  used?: Record<string, number>;
  markups: SlideMarkup[];
}

/** グループの色。白い紙（スライドと論文のページ）の上に描くので、明暗の表示で共通の値にする。
 *  順番は固定（色覚の型が違っても隣り合う色を見分けやすい並び）。名前のラベルを必ず添え、色だけで見分けさせない */
export const GROUP_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];

export const slidesPdfPath = (id: string) => `${PAPERS_DIR}/${checkId(id)}/slides.pdf`;
export const slidesSourcePath = (id: string) => `${PAPERS_DIR}/${checkId(id)}/slides.pptx`;
export const slidesDataPath = (id: string) => `${PAPERS_DIR}/${checkId(id)}/slides.json`;

const pad = (n: number) => String(n).padStart(2, "0");

/** Markup-03.02 の形の名前 */
export const markupName = (m: Pick<SlideMarkup, "page" | "index">) => `Markup-${pad(m.page)}.${pad(m.index)}`;

/** 名前（Markup-03.02、03.02、3.2）か ID からマークアップを探す */
export function findMarkup(deck: SlideDeck, key: string): SlideMarkup | undefined {
  const byId = deck.markups.find((m) => m.id === key);
  if (byId) return byId;
  const m = key.trim().match(/^(?:markup-)?(\d+)\.(\d+)$/i);
  if (!m) return undefined;
  const page = Number(m[1]);
  const index = Number(m[2]);
  return deck.markups.find((x) => x.page === page && x.index === index);
}

/** そのページで次に使う番号。空いている番号のうち最も小さいもの（消した番号を使い直し、抜けたままにしない） */
export function nextIndex(markups: SlideMarkup[], page: number) {
  const taken = new Set(markups.filter((m) => m.page === page).map((m) => m.index));
  let n = 1;
  while (taken.has(n)) n++;
  return n;
}

/** 次のグループの色。使っている数が最も少ない色を、並びの順に選ぶ */
export function nextColor(markups: SlideMarkup[]) {
  const used = GROUP_COLORS.map((_, i) => markups.filter((m) => m.color === i).length);
  return used.indexOf(Math.min(...used));
}

/** スライドの並び順（ページ、番号の順） */
export const sortMarkups = (ms: SlideMarkup[]) => [...ms].sort((a, b) => a.page - b.page || a.index - b.index);

export const emptyDeck = (source: string, convertedFrom?: "pptx"): SlideDeck => ({
  version: 1,
  source,
  ...(convertedFrom ? { convertedFrom } : {}),
  importedAt: new Date().toISOString(),
  markups: [],
});

/** 範囲を 0〜1 に収め、幅と高さを正にする */
export function normalizeRect(r: Rect): Rect {
  const x1 = clamp01(Math.min(r.x, r.x + r.w));
  const y1 = clamp01(Math.min(r.y, r.y + r.h));
  const x2 = clamp01(Math.max(r.x, r.x + r.w));
  const y2 = clamp01(Math.max(r.y, r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** 複数の矩形を囲む矩形 */
export function boundsOf(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** 2 つの矩形が重なる割合（a の面積に対して） */
export function overlapRatio(a: Rect, b: Rect) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0 || a.w <= 0 || a.h <= 0) return 0;
  return (w * h) / (a.w * a.h);
}

/** 同じ行に並ぶ矩形をまとめる。テキスト層は単語ごとに分かれているため */
export function mergeLineRects(rs: Rect[]): Rect[] {
  const sorted = [...rs].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: Rect[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - r.y) < r.h * 0.5 && r.x <= last.x + last.w + 0.02) {
      const x2 = Math.max(last.x + last.w, r.x + r.w);
      const y2 = Math.max(last.y + last.h, r.y + r.h);
      last.x = Math.min(last.x, r.x);
      last.y = Math.min(last.y, r.y);
      last.w = x2 - last.x;
      last.h = y2 - last.y;
    } else out.push({ ...r });
  }
  return out;
}

// --- 変更の操作 ------------------------------------------------------------
// 注釈（model.ts）と同じく、丸ごと上書きせず操作で書く。画面と AI エージェントが同時に書いても消し合わない。
// リンクは 1 本ずつの操作にする（配列ごと置き換えると、別の書き手が同時に足したリンクを消してしまうため）。

export type MarkupPatch = Partial<Pick<SlideMarkup, "rect" | "color" | "memo">>;

export type LinkPatch = Partial<Pick<SlideLink, "kind" | "rects">>;

export type MarkupOp =
  | { op: "add"; item: SlideMarkup }
  /** 消したグループを元に戻す。同じ名前のものが今無ければ番号を変えない（名前を変えない） */
  | { op: "restore"; item: SlideMarkup }
  | { op: "update"; id: string; patch: MarkupPatch }
  | { op: "remove"; id: string }
  | { op: "addLink"; id: string; link: SlideLink }
  | { op: "updateLink"; id: string; link: string; patch: LinkPatch }
  | { op: "removeLink"; id: string; link: string };

export function applyMarkupOps(deck: SlideDeck, ops: MarkupOp[]): SlideDeck {
  const list = [...deck.markups];
  for (const op of ops) {
    const id = op.op === "add" || op.op === "restore" ? op.item.id : op.id;
    const i = list.findIndex((m) => m.id === id);
    if (op.op === "add" || op.op === "restore") {
      if (i >= 0) continue; // 同じ ID が既にあれば、先に足した側を残す
      // 同じ名前が既にある（別の書き手が同じページに足した、か消した番号を別の部分が使った）なら、空いている番号にずらす。
      // 元に戻すときも、その番号が空いていれば消した番号のまま戻す（名前を変えない）
      const clash = list.some((m) => m.page === op.item.page && m.index === op.item.index);
      list.push(clash ? { ...op.item, index: nextIndex(list, op.item.page) } : op.item);
      continue;
    }
    if (i < 0) continue; // 別の書き手が消したグループへの操作は捨てる
    const m = list[i];
    if (op.op === "remove") list.splice(i, 1);
    // 名前を決める項目（ページと番号）と ID は書き換えない
    else if (op.op === "update") list[i] = { ...m, ...op.patch, id: m.id, page: m.page, index: m.index, links: m.links };
    else if (op.op === "addLink") {
      if (!m.links.some((l) => l.id === op.link.id)) list[i] = { ...m, links: [...m.links, op.link] };
    } else if (op.op === "updateLink") list[i] = { ...m, links: m.links.map((l) => (l.id === op.link ? { ...l, ...op.patch } : l)) };
    else list[i] = { ...m, links: m.links.filter((l) => l.id !== op.link) };
  }
  const { used: _old, ...rest } = deck;
  return { ...rest, markups: list };
}

/** 消したグループを、消す前の位置（at 番目）に同じ ID・リンクのまま戻す。既にあれば何もしない。
 *  消したあとに同じ番号を別の部分が使っていたら、空いている番号にずらす */
export function restoreMarkup(deck: SlideDeck, item: SlideMarkup, at: number): SlideDeck {
  if (deck.markups.some((m) => m.id === item.id)) return deck;
  const clash = deck.markups.some((m) => m.page === item.page && m.index === item.index);
  const markups = [...deck.markups];
  markups.splice(Math.min(Math.max(0, at), markups.length), 0, clash ? { ...item, index: nextIndex(deck.markups, item.page) } : item);
  return { ...deck, markups };
}

/** 消したリンクを、元のグループの消す前の位置（at 番目）に戻す。グループが無いか、リンクが既にあれば何もしない */
export function restoreLink(deck: SlideDeck, markupId: string, link: SlideLink, at: number): SlideDeck {
  const m = deck.markups.find((x) => x.id === markupId);
  if (!m || m.links.some((l) => l.id === link.id)) return deck;
  const links = [...m.links];
  links.splice(Math.min(Math.max(0, at), links.length), 0, link);
  return { ...deck, markups: deck.markups.map((x) => (x.id === markupId ? { ...x, links } : x)) };
}

/** base から next への操作。restored に入っている ID のグループを足すときは、元に戻す操作にする */
export function diffMarkups(base: SlideDeck, next: SlideDeck, restored: ReadonlySet<string> = new Set()): MarkupOp[] {
  const ops: MarkupOp[] = [];
  const before = new Map(base.markups.map((m) => [m.id, m]));
  const ids = new Set(next.markups.map((m) => m.id));
  for (const m of base.markups) if (!ids.has(m.id)) ops.push({ op: "remove", id: m.id });
  for (const m of next.markups) {
    const b = before.get(m.id);
    if (!b) {
      ops.push({ op: restored.has(m.id) ? "restore" : "add", item: m });
      continue;
    }
    if (JSON.stringify(b) === JSON.stringify(m)) continue;
    const patch: MarkupPatch = {};
    for (const k of ["rect", "color", "memo"] as const) if (JSON.stringify(b[k]) !== JSON.stringify(m[k])) Object.assign(patch, { [k]: m[k] });
    if (Object.keys(patch).length) ops.push({ op: "update", id: m.id, patch });
    const old = new Map(b.links.map((l) => [l.id, l]));
    const now = new Set(m.links.map((l) => l.id));
    for (const l of b.links) if (!now.has(l.id)) ops.push({ op: "removeLink", id: m.id, link: l.id });
    for (const l of m.links) {
      const o = old.get(l.id);
      if (!o) {
        ops.push({ op: "addLink", id: m.id, link: l });
        continue;
      }
      const lp: LinkPatch = {};
      if (o.kind !== l.kind) lp.kind = l.kind;
      if (JSON.stringify(o.rects) !== JSON.stringify(l.rects)) lp.rects = l.rects;
      if (Object.keys(lp).length) ops.push({ op: "updateLink", id: m.id, link: l.id, patch: lp });
    }
  }
  return ops;
}

// --- 入力の検証 ------------------------------------------------------------
// 保存先に書く前に、形を確かめて整える。画面・MCP・手で編集した slides.json のどれから来ても壊れないように。

export class SlidesInputError extends Error {}
const bad = (msg: string): never => {
  throw new SlidesInputError(msg);
};
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const posInt = (v: unknown, name: string) => (Number.isInteger(v) && (v as number) >= 1 ? (v as number) : bad(`${name} は 1 以上の整数で指定してください。`));
const str = (v: unknown, name: string) => (typeof v === "string" ? v : bad(`${name} は文字列で指定してください。`));
const KINDS: LinkKind[] = ["text", "figure", "equation"];
const kindOf = (v: unknown) => (KINDS.includes(v as LinkKind) ? (v as LinkKind) : bad("kind は text / figure / equation のどれかです。"));
const colorOf = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < GROUP_COLORS.length ? (v as number) : bad(`color は 0〜${GROUP_COLORS.length - 1} の整数で指定してください。`));

/** 0〜1 に収め、面積のある四角だけを受け付ける */
export function rectOf(v: unknown, name = "rect"): Rect {
  if (!isObj(v) || !["x", "y", "w", "h"].every((k) => Number.isFinite(v[k]))) bad(`${name} は数値の x, y, w, h で指定してください。`);
  const r = normalizeRect(v as unknown as Rect);
  if (r.w <= 0 || r.h <= 0) bad(`${name} がページの外にあるか、幅か高さが 0 です。x, y, w, h はページに対する割合（0〜1）で指定してください。`);
  return r;
}

export function linkOf(v: unknown): SlideLink {
  if (!isObj(v)) return bad("link はオブジェクトで指定してください。");
  if (!Array.isArray(v.rects) || !v.rects.length) bad("link.rects を 1 つ以上の四角の配列で指定してください。");
  return {
    id: str(v.id, "link.id"),
    kind: kindOf(v.kind),
    page: posInt(v.page, "link.page"),
    rects: (v.rects as unknown[]).map((r) => rectOf(r, "link.rects")),
    text: typeof v.text === "string" ? v.text : "",
    createdAt: typeof v.createdAt === "string" ? v.createdAt : "",
  };
}

export function markupOf(v: unknown): SlideMarkup {
  if (!isObj(v)) return bad("item はオブジェクトで指定してください。");
  if (v.links !== undefined && !Array.isArray(v.links)) bad("links は配列で指定してください。");
  return {
    id: str(v.id, "id"),
    page: posInt(v.page, "page"),
    index: posInt(v.index, "index"),
    rect: rectOf(v.rect),
    color: v.color === undefined ? 0 : colorOf(v.color),
    memo: v.memo === undefined ? "" : str(v.memo, "memo"),
    links: ((v.links as unknown[] | undefined) ?? []).map(linkOf),
    createdAt: typeof v.createdAt === "string" ? v.createdAt : "",
  };
}

/** 送られた操作の列を確かめる。1 つでも正しくなければ、何も書かずに SlidesInputError */
export function parseMarkupOps(raw: unknown): MarkupOp[] {
  if (!Array.isArray(raw)) return bad("ops を配列で指定してください。");
  return raw.map((o): MarkupOp => {
    if (!isObj(o)) return bad("ops の各要素はオブジェクトで指定してください。");
    switch (o.op) {
      case "add":
        return { op: "add", item: markupOf(o.item) };
      case "restore":
        return { op: "restore", item: markupOf(o.item) };
      case "remove":
        return { op: "remove", id: str(o.id, "id") };
      case "update": {
        if (!isObj(o.patch)) return bad("patch はオブジェクトで指定してください。");
        const p = o.patch;
        const patch: MarkupPatch = {};
        if (p.rect !== undefined) patch.rect = rectOf(p.rect);
        if (p.color !== undefined) patch.color = colorOf(p.color);
        if (p.memo !== undefined) patch.memo = str(p.memo, "memo");
        return { op: "update", id: str(o.id, "id"), patch };
      }
      case "addLink":
        return { op: "addLink", id: str(o.id, "id"), link: linkOf(o.link) };
      case "updateLink": {
        if (!isObj(o.patch)) return bad("patch はオブジェクトで指定してください。");
        const p = o.patch;
        const patch: LinkPatch = {};
        if (p.kind !== undefined) patch.kind = kindOf(p.kind);
        if (p.rects !== undefined) {
          if (!Array.isArray(p.rects) || !p.rects.length) bad("patch.rects を 1 つ以上の四角の配列で指定してください。");
          patch.rects = (p.rects as unknown[]).map((r) => rectOf(r, "patch.rects"));
        }
        return { op: "updateLink", id: str(o.id, "id"), link: str(o.link, "link"), patch };
      }
      case "removeLink":
        return { op: "removeLink", id: str(o.id, "id"), link: str(o.link, "link") };
      default:
        return bad(`op は add / restore / update / remove / addLink / updateLink / removeLink のどれかです（${String(o.op)}）。`);
    }
  });
}

/** 手で書き換えられた slides.json でも読めるよう、壊れたグループとリンクは捨てる */
function tidyMarkups(raw: unknown): SlideMarkup[] {
  if (!Array.isArray(raw)) return [];
  const out: SlideMarkup[] = [];
  for (const m of raw) {
    try {
      const links = isObj(m) && Array.isArray(m.links) ? m.links : [];
      const ok = markupOf({ ...(m as object), links: [] });
      for (const l of links) {
        try {
          ok.links.push(linkOf(l));
        } catch {
          // 壊れたリンクだけを捨てる
        }
      }
      out.push(ok);
    } catch {
      // 壊れたグループは読まない
    }
  }
  return out;
}

// --- 読み書き -------------------------------------------------------------

export async function hasSlides(vault: Vault, id: string) {
  return vault.exists(slidesPdfPath(id));
}

/** スライドが無ければ null */
export async function loadDeck(vault: Vault, id: string): Promise<SlideDeck | null> {
  if (!(await hasSlides(vault, id))) return null;
  if (!(await vault.exists(slidesDataPath(id)))) return emptyDeck("slides.pdf");
  let raw: Partial<SlideDeck>;
  try {
    raw = JSON.parse(await vault.readText(slidesDataPath(id))) as Partial<SlideDeck>;
  } catch {
    // 空として扱うと、次の書き込みで中身を消してしまう。直してもらうまで書かない
    throw new Error(`${slidesDataPath(id)} を JSON として読めません。手で直すか、ファイルを消してから開き直してください。`);
  }
  // 以前の版の used（使った最大の番号）は読まない。次に書くときに消える
  const { used: _old, ...rest } = isObj(raw) ? raw : ({} as Partial<SlideDeck>);
  return { ...emptyDeck("slides.pdf"), ...rest, version: 1, markups: tidyMarkups(raw?.markups) };
}

export function loadSlidesPdf(vault: Vault, id: string) {
  return vault.readBinary(slidesPdfPath(id));
}

const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, job: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(job);
  queues.set(key, next);
  return next;
}

/**
 * スライドを置く。既にあれば差し替え、マークアップは残す（スライドを少し直して入れ直す使い方のため）。
 * pdf は表示に使う PDF。original は PPTX から変換したときの元のファイル。
 */
export async function putSlides(vault: Vault, id: string, fileName: string, pdf: ArrayBuffer, original?: ArrayBuffer) {
  if (!new TextDecoder().decode(new Uint8Array(pdf.slice(0, 5))).startsWith("%PDF")) {
    throw new Error("スライドは PDF か PPTX で指定してください。");
  }
  return serial(slidesDataPath(id), async () => {
    const prev = await loadDeck(vault, id);
    await vault.writeBinary(slidesPdfPath(id), pdf);
    if (original) await vault.writeBinary(slidesSourcePath(id), original);
    const deck: SlideDeck = { ...emptyDeck(fileName, original ? "pptx" : undefined), markups: prev?.markups ?? [] };
    await vault.writeText(slidesDataPath(id), JSON.stringify(deck, null, 2));
    return deck;
  });
}

/** マークアップに操作を当てて保存し、ノートの「発表スライドとの対応」を書き直す */
export async function changeMarkups(vault: Vault, id: string, raw: unknown) {
  // 書く前に確かめる。途中まで書いてから失敗すると、画面と保存先の状態がずれる
  const ops = parseMarkupOps(raw);
  const deck = await serial(slidesDataPath(id), async () => {
    const cur = await loadDeck(vault, id);
    if (!cur) throw new Error("この論文にはスライドがありません。先にスライドを取り込んでください。");
    const next = applyMarkupOps(cur, ops);
    await vault.writeText(slidesDataPath(id), JSON.stringify(next, null, 2));
    return next;
  });
  const note = await updateNote(vault, id, (md) =>
    deck.markups.length || md.includes("<!-- list: slides -->") ? setList(md, "slides", renderSlideLinks(deck), "発表スライドとの対応") : md,
  );
  return { deck, note };
}

// --- note.md へ書き出す Markdown ------------------------------------------

/** ノートの一覧の範囲（HTML コメント）を壊さないよう、コメントの記号を書き換える */
const safe = (t: string) => t.replace(/<!--/g, "<!‐‐").replace(/-->/g, "‐‐>");

export function renderSlideLinks(deck: SlideDeck): string {
  return sortMarkups(deck.markups)
    .map((m) => {
      const lines = [`### ${markupName(m)}（スライド p.${m.page}）`];
      if (m.memo.trim()) lines.push("", safe(m.memo.trim()));
      if (m.links.length) {
        lines.push("");
        for (const l of [...m.links].sort((a, b) => a.page - b.page || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0))) {
          const t = safe(l.text.replace(/\s+/g, " ").trim());
          lines.push(`- ${LINK_KIND_LABEL[l.kind]}: p.${l.page}${t ? `「${t.length > 80 ? `${t.slice(0, 80)}…` : t}」` : ""}`);
        }
      } else lines.push("", "（論文の該当箇所はまだありません）");
      return lines.join("\n");
    })
    .join("\n\n");
}
