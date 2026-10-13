// 対訳（1 文ずつの訳）をローカルサーバーと読み書きする。
//
// 中身は papers/<id>/sentences.json（@paperlens/core の PaperDocument）。型は core から読むが、
// 値は読まない（core は node:crypto を読むので、ブラウザに持ち込むと動かない）。
// 書き込みはどれも、書いたあとの状態（SentencesState）をそのまま返す。

import type { PaperDocument } from "@paperlens/core";

export type ParserChoice = "auto" | "grobid" | "fallback";

export type SentencesState =
  | { status: "none" }
  | { status: "parsing"; startedAt: string }
  | { status: "failed"; error: string; code?: string }
  | { status: "ready"; document: PaperDocument };

export type BoundaryEdit = { type: "merge" | "split" | "drop"; hashes: string[]; offsets?: number[] };

/**
 * この画面を見分ける ID。backend.ts と同じ見出しで送る。
 * 自分の書き込みで届いた通知を見分けるのに使う（返り値で既に最新になっているため）。
 */
export const SENTENCES_CLIENT_ID = Math.random().toString(36).slice(2);

async function call(url: string, init: RequestInit = {}): Promise<SentencesState> {
  const headers: Record<string, string> = { "x-paperlens-client": SENTENCES_CLIENT_ID };
  if (typeof init.body === "string") headers["content-type"] = "application/json";
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  if (!res.ok) {
    let msg = `通信に失敗しました（${res.status}）`;
    try {
      msg = (JSON.parse(text) as { error?: string }).error || msg;
    } catch {
      // 本文が JSON でないときは状態コードだけを伝える
    }
    throw new Error(msg);
  }
  return JSON.parse(text) as SentencesState;
}

const enc = encodeURIComponent;
const base = (id: string) => `/api/papers/${enc(id)}/sentences`;
const body = (method: string, v: unknown): RequestInit => ({ method, body: JSON.stringify(v) });

export const sentencesApi = {
  get: (id: string) => call(base(id)),
  parse: (id: string, parser: ParserChoice = "auto") => call(`${base(id)}/parse`, body("POST", { parser })),
  setTranslation: (id: string, hash: string, text: string) => call(`${base(id)}/translations/${enc(hash)}`, body("PUT", { text })),
  clearTranslation: (id: string, hash: string) => call(`${base(id)}/translations/${enc(hash)}`, { method: "DELETE" }),
  addNote: (id: string, hash: string, noteBody: string) => call(`${base(id)}/notes`, body("POST", { hash, body: noteBody })),
  removeNote: (id: string, noteId: string) => call(`${base(id)}/notes/${enc(noteId)}`, { method: "DELETE" }),
  skip: (id: string, hashes: string[], reason?: string | null) => call(`${base(id)}/skip`, body("POST", { hashes, reason: reason ?? null })),
  unskip: (id: string, hashes: string[]) => call(`${base(id)}/skip`, body("DELETE", { hashes })),
  editBoundary: (id: string, edit: BoundaryEdit) => call(`${base(id)}/edits`, body("POST", edit)),
  undoEdit: (id: string, editId: string) => call(`${base(id)}/edits/${enc(editId)}`, { method: "DELETE" }),
  upsertGlossary: (id: string, entry: { term: string; translation: string; note?: string | null }) =>
    call(`${base(id)}/glossary`, body("PUT", entry)),
  removeGlossary: (id: string, term: string) => call(`${base(id)}/glossary/${enc(term)}`, { method: "DELETE" }),
};

/**
 * この論文の対訳が変わったら知らせる（/api/events の kind "sentences"）。
 * own は「この画面の書き込みで起きた変更か」。戻り値を呼ぶと止まる。
 */
export function subscribeSentences(paperId: string, cb: (e: { own: boolean }) => void): () => void {
  if (typeof EventSource === "undefined") return () => undefined;
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data as string) as { kind?: string; paper?: string; origin?: string };
      if (e.kind === "sentences" && e.paper === paperId) cb({ own: e.origin === SENTENCES_CLIENT_ID });
    } catch {
      // 壊れた通知は捨てる
    }
  };
  return () => es.close();
}

// --- 論文ごとの置き場 ---------------------------------------------------------
//
// PDF の枠と対訳タブが同じ文書を見るので、1 論文につき 1 回だけ読み、通知も 1 本だけ張る。

export interface SentencesEntry {
  state: SentencesState | null;
  error: string | null;
}

type Slot = SentencesEntry & { listeners: Set<() => void>; stop: (() => void) | null; timer: ReturnType<typeof setInterval> | null; seq: number };

const slots = new Map<string, Slot>();
const EMPTY: SentencesEntry = { state: null, error: null };

function slot(id: string): Slot {
  let s = slots.get(id);
  if (!s) {
    s = { state: null, error: null, listeners: new Set(), stop: null, timer: null, seq: 0 };
    slots.set(id, s);
  }
  return s;
}

function emit(id: string, patch: Partial<SentencesEntry>) {
  const s = slot(id);
  // useSyncExternalStore が変化を見分けられるよう、置き場ごと作り直す
  const next: Slot = { ...s, ...patch };
  slots.set(id, next);
  syncPolling(id);
  for (const fn of next.listeners) fn();
}

/** 解析中は通知の取りこぼしに備えて、数秒ごとに読み直す。 */
function syncPolling(id: string) {
  const s = slot(id);
  const want = s.listeners.size > 0 && s.state?.status === "parsing";
  if (want && !s.timer) s.timer = setInterval(() => void refreshSentences(id), 4000);
  if (!want && s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
}

export function getSentences(id: string | null): SentencesEntry {
  return id ? (slots.get(id) ?? EMPTY) : EMPTY;
}

export async function refreshSentences(id: string): Promise<void> {
  const seq = ++slot(id).seq;
  try {
    const state = await sentencesApi.get(id);
    if (seq === slot(id).seq) emit(id, { state, error: null });
  } catch (e) {
    if (seq === slot(id).seq) emit(id, { error: e instanceof Error ? e.message : String(e) });
  }
}

/** 書き込みの返り値（書いたあとの状態）をそのまま置く。読み直しより新しいので、途中の読み直しは捨てる。 */
export function putSentences(id: string, state: SentencesState) {
  slot(id).seq++;
  emit(id, { state, error: null });
}

export function watchSentences(id: string, fn: () => void): () => void {
  const s = slot(id);
  s.listeners.add(fn);
  if (!s.stop) {
    s.stop = subscribeSentences(id, ({ own }) => {
      // 自分の書き込みは返り値で反映済み。ただし解析は裏で終わるので、解析中だけは自分のものも拾う。
      if (own && slot(id).state?.status !== "parsing") return;
      void refreshSentences(id);
    });
    void refreshSentences(id);
  }
  syncPolling(id);
  return () => {
    const cur = slot(id);
    cur.listeners.delete(fn);
    if (cur.listeners.size === 0) {
      cur.stop?.();
      cur.stop = null;
      syncPolling(id);
    }
  };
}
