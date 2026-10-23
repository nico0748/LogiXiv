// 端末ごとの設定（表示・AI など）をここに集める。値は localStorage に置き、変更を購読できる。
//
// - キー名は以前のもの（paperlens.theme / paperlens.ai / paperlens.sentenceMarks / paperlens.ui.paperSort など）をそのまま使う
// - 保管庫に置くもの（テンプレート、workspace.json）はここでは扱わない
// - localStorage が使えない環境（プライベートウィンドウ、テストの Node.js など）では、この画面を開いている間だけ覚える
// - 壊れた値や知らない値は、読むときに初期値へ戻す

import { useSyncExternalStore } from "react";
import { STATUSES } from "./defaultTemplate.ts";
import { SORT_KEYS, type SortKey } from "./paperSort.ts";

// --- 型 ------------------------------------------------------------------

export type ThemePref = "light" | "dark" | "system";
export const ACCENTS = ["indigo", "blue", "green", "orange", "rose"] as const;
export type Accent = (typeof ACCENTS)[number];
export type Leading = "compact" | "normal" | "relaxed";
export type Startup = "last" | "list";
export type ContextSize = "less" | "normal" | "more";
export type TargetLang = "ja" | "en";

/** 訳語の固定。英語の語を、決めた日本語で訳してもらう */
export interface GlossPair {
  en: string;
  ja: string;
}

export interface AiSettings {
  apiKey: string;
  model: string;
  /** 訳と説明の文体。言語ごとに持つ。空なら初期値 */
  style?: Partial<Record<TargetLang, string>>;
  glossary?: GlossPair[];
  /** 前後の本文をどれだけ送るか */
  context?: ContextSize;
  /** 訳す言語 */
  lang?: TargetLang;
}

export const DEFAULT_MODEL = "claude-opus-5-5";

export interface DisplayPrefs {
  /** 補足情報（訳・用語・対訳のカード）の文字の大きさ（px） */
  fontBody: number;
  /** 記録欄（ノート）の文字の大きさ（px） */
  fontNote: number;
  /** 左サイドバー（論文一覧・検索）の文字の大きさ（px） */
  fontSidebar: number;
  leading: Leading;
}

export interface Prefs {
  theme: ThemePref;
  accent: Accent;
  display: DisplayPrefs;
  /** PDF を開いたときの倍率。1 は幅に合わせた大きさ */
  pdfZoom: number;
  sentenceMarks: boolean;
  paperSort: SortKey;
  startup: Startup;
  /** 取り込んだ論文の段階。空なら「未読」（テンプレートのまま） */
  importStatus: string;
  ai: AiSettings;
}
export type PrefName = keyof Prefs;

export const FONT_MIN = 11;
export const FONT_MAX = 20;
export const FONT_DEFAULT = 13;
export const PDF_ZOOMS = [0.75, 1, 1.25, 1.5, 2] as const;

// --- 値の決まり ----------------------------------------------------------

interface Def<T> {
  key: string;
  def: T;
  /** 保存した文字列から読む。読めなければ undefined */
  decode: (raw: string) => unknown;
  /** 保存する文字列。null のときはキーを消す */
  encode: (v: T) => string | null;
  /** 任意の値（読み込んだ JSON など）を正しい形にする */
  normalize: (u: unknown) => T;
}

const json = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};
const oneOf = <T extends string>(list: readonly T[], def: T) => (u: unknown): T => (list.includes(u as T) ? (u as T) : def);
const str = (u: unknown, max = 20000) => (typeof u === "string" ? u.slice(0, max) : "");
const clampFont = (u: unknown) => (typeof u === "number" && Number.isFinite(u) ? Math.round(Math.min(FONT_MAX, Math.max(FONT_MIN, u))) : FONT_DEFAULT);

const DEFAULT_DISPLAY: DisplayPrefs = { fontBody: FONT_DEFAULT, fontNote: FONT_DEFAULT, fontSidebar: FONT_DEFAULT, leading: "normal" };

function normalizeAi(u: unknown): AiSettings {
  const r = u && typeof u === "object" ? (u as Record<string, unknown>) : {};
  const style = r.style && typeof r.style === "object" ? (r.style as Record<string, unknown>) : {};
  // 訳語の行は入力の途中（訳語が空、末尾に空白）でも残す。空白を除くのはプロンプトを作るとき（aiPrompt.ts）
  const glossary = Array.isArray(r.glossary)
    ? r.glossary.flatMap((g) => {
        const p = g && typeof g === "object" ? (g as Record<string, unknown>) : {};
        const en = str(p.en, 200);
        const ja = str(p.ja, 200);
        return en.trim() ? [{ en, ja }] : [];
      })
    : [];
  const out: AiSettings = { apiKey: str(r.apiKey, 400).trim(), model: str(r.model, 200).trim() || DEFAULT_MODEL };
  const s: Partial<Record<TargetLang, string>> = {};
  if (typeof style.ja === "string" && style.ja) s.ja = str(style.ja);
  if (typeof style.en === "string" && style.en) s.en = str(style.en);
  if (s.ja || s.en) out.style = s;
  if (glossary.length) out.glossary = glossary;
  const context = oneOf<ContextSize>(["less", "normal", "more"], "normal")(r.context);
  if (context !== "normal") out.context = context;
  const lang = oneOf<TargetLang>(["ja", "en"], "ja")(r.lang);
  if (lang !== "ja") out.lang = lang;
  return out;
}

const DEFS: { [K in PrefName]: Def<Prefs[K]> } = {
  // 以前は "light" / "dark" だけを保存し、無いときは端末に合わせていた。"system" はキーを消して表す
  theme: { key: "paperlens.theme", def: "system", decode: (r) => r, encode: (v) => (v === "system" ? null : v), normalize: oneOf<ThemePref>(["light", "dark", "system"], "system") },
  accent: { key: "paperlens.accent", def: "indigo", decode: (r) => r, encode: (v) => (v === "indigo" ? null : v), normalize: oneOf(ACCENTS, "indigo") },
  display: {
    key: "paperlens.display",
    def: DEFAULT_DISPLAY,
    decode: json,
    encode: (v) => JSON.stringify(v),
    normalize: (u) => {
      const r = u && typeof u === "object" ? (u as Record<string, unknown>) : {};
      return {
        fontBody: clampFont(r.fontBody),
        fontNote: clampFont(r.fontNote),
        fontSidebar: clampFont(r.fontSidebar),
        leading: oneOf<Leading>(["compact", "normal", "relaxed"], "normal")(r.leading),
      };
    },
  },
  pdfZoom: {
    key: "paperlens.pdfZoom",
    def: 1,
    decode: (r) => Number(r),
    encode: (v) => (v === 1 ? null : String(v)),
    normalize: (u) => (PDF_ZOOMS.includes(u as (typeof PDF_ZOOMS)[number]) ? (u as number) : 1),
  },
  sentenceMarks: { key: "paperlens.sentenceMarks", def: true, decode: (r) => r !== "off", encode: (v) => (v ? "on" : "off"), normalize: (u) => u !== false },
  paperSort: { key: "paperlens.ui.paperSort", def: "created", decode: (r) => r, encode: (v) => v, normalize: oneOf<SortKey>(SORT_KEYS, "created") },
  startup: { key: "paperlens.startup", def: "last", decode: (r) => r, encode: (v) => (v === "last" ? null : v), normalize: oneOf<Startup>(["last", "list"], "last") },
  // 「未読」はテンプレートのままなので空で表す。知らない段階は読まない
  importStatus: {
    key: "paperlens.importStatus",
    def: "",
    decode: (r) => r,
    encode: (v) => v || null,
    normalize: (u) => (typeof u === "string" && u !== STATUSES[0] && (STATUSES as readonly string[]).includes(u) ? u : ""),
  },
  ai: { key: "paperlens.ai", def: { apiKey: "", model: DEFAULT_MODEL }, decode: json, encode: (v) => JSON.stringify(v), normalize: normalizeAi },
};

export const PREF_NAMES = Object.keys(DEFS) as PrefName[];

// --- 保存先 --------------------------------------------------------------

/** localStorage。使えないときは null（テストでは差し替える） */
let store: Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length"> | null = null;
let storeChecked = false;
function storage() {
  if (!storeChecked) {
    storeChecked = true;
    try {
      store = typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      store = null;
    }
  }
  return store;
}

/** テスト用。保存先を差し替え、覚えている値を捨てる */
export function setPrefsStorage(s: typeof store) {
  store = s;
  storeChecked = true;
  cache.clear();
}

const cache = new Map<PrefName, unknown>();
const listeners = new Set<(name: PrefName) => void>();

function read<K extends PrefName>(name: K): Prefs[K] {
  const d = DEFS[name];
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(d.key) ?? null;
  } catch {
    raw = null;
  }
  return raw === null ? d.def : d.normalize(d.decode(raw));
}

export function getPref<K extends PrefName>(name: K): Prefs[K] {
  if (!cache.has(name)) cache.set(name, read(name));
  return cache.get(name) as Prefs[K];
}

export function setPref<K extends PrefName>(name: K, value: Prefs[K]): void {
  const d = DEFS[name];
  const v = d.normalize(value);
  cache.set(name, v);
  try {
    const s = storage();
    const enc = d.encode(v);
    if (enc === null) s?.removeItem(d.key);
    else s?.setItem(d.key, enc);
  } catch {
    // 保存できなくても、この画面を開いている間は効く
  }
  for (const fn of listeners) fn(name);
}

/** 一部だけ書き換える（display と ai のように中身がある設定） */
export function patchPref<K extends "display" | "ai">(name: K, patch: Partial<Prefs[K]>): void {
  setPref(name, { ...getPref(name), ...patch } as Prefs[K]);
}

export function resetPref(name: PrefName): void {
  setPref(name, DEFS[name].def);
}

export function subscribePrefs(fn: (name: PrefName) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** 別のタブで変えたときも合わせる */
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (e) => {
    // key が null のときは、ほかのタブで localStorage をまとめて消した
    const names = e.key === null ? PREF_NAMES : PREF_NAMES.filter((n) => DEFS[n].key === e.key);
    for (const name of names) {
      cache.delete(name);
      for (const fn of listeners) fn(name);
    }
  });
}

// 名前ごとに同じ関数を渡し、描画のたびに購読し直さないようにする
const subscribers = new Map<PrefName, (fn: () => void) => () => void>();
const getters = new Map<PrefName, () => unknown>();
function subscriberFor(name: PrefName) {
  let sub = subscribers.get(name);
  if (!sub) {
    sub = (fn: () => void) => subscribePrefs((n) => n === name && fn());
    subscribers.set(name, sub);
  }
  return sub;
}
function getterFor<K extends PrefName>(name: K): () => Prefs[K] {
  let get = getters.get(name);
  if (!get) {
    get = () => getPref(name);
    getters.set(name, get);
  }
  return get as () => Prefs[K];
}

export function usePref<K extends PrefName>(name: K): Prefs[K] {
  const get = getterFor(name);
  return useSyncExternalStore(subscriberFor(name), get, get);
}

/** 設定の一部だけを購読する。select の結果（真偽値など）が変わったときだけ描き直す */
export function usePrefSelect<K extends PrefName, T extends string | number | boolean>(name: K, select: (v: Prefs[K]) => T): T {
  const get = () => select(getPref(name));
  return useSyncExternalStore(subscriberFor(name), get, get);
}

// --- まとめて扱う ------------------------------------------------------------

/** 表示の設定。リセットでまとめて戻す */
export const DISPLAY_PREFS: PrefName[] = ["theme", "accent", "display", "pdfZoom", "sentenceMarks", "paperSort"];

export interface PrefsFile {
  app: "PaperLens";
  kind: "settings";
  version: 1;
  exportedAt: string;
  prefs: Partial<Prefs>;
}

/** 書き出す内容。API キーは含めない */
export function exportPrefs(now = new Date()): PrefsFile {
  const prefs: Partial<Record<PrefName, unknown>> = {};
  for (const n of PREF_NAMES) prefs[n] = getPref(n);
  const { apiKey: _, ...ai } = getPref("ai");
  prefs.ai = ai;
  return { app: "PaperLens", kind: "settings", version: 1, exportedAt: now.toISOString(), prefs: prefs as Partial<Prefs> };
}

/** 書き出した JSON を読み込む。読み込んだ項目の名前を返す。API キーは今のものを残す */
export function importPrefs(text: string): PrefName[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("JSON として読めませんでした。");
  }
  const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  if (d.app !== "PaperLens" || d.kind !== "settings" || !d.prefs || typeof d.prefs !== "object") {
    throw new Error("PaperLens の設定のファイルではありません。");
  }
  const prefs = d.prefs as Record<string, unknown>;
  const done: PrefName[] = [];
  for (const n of PREF_NAMES) {
    if (!(n in prefs)) continue;
    if (n === "ai") {
      const ai = normalizeAi({ ...(prefs.ai as object), apiKey: getPref("ai").apiKey });
      setPref("ai", ai);
    } else {
      setPref(n, DEFS[n].normalize(prefs[n]) as never);
    }
    done.push(n);
  }
  return done;
}

/** 前回の位置（paperlens.pos.*）を消す。消した数を返す */
export function clearStoredPositions(): number {
  return removeByPrefix("paperlens.pos.");
}

/** 画面の配置（paperlens.workspace.*）を消す。サーバー版の workspace.json は呼ぶ側で戻す */
export function clearStoredLayout(): number {
  return removeByPrefix("paperlens.workspace.");
}

function removeByPrefix(prefix: string): number {
  const s = storage();
  if (!s) return 0;
  const keys: string[] = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(prefix)) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
  } catch {
    return 0;
  }
  return keys.length;
}
