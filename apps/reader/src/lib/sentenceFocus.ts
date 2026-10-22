// いま選んでいる文（対訳タブと PDF の枠で共有する）。
//
// App.tsx を介さずに PDF と対訳タブをつなぐための小さな置き場。
// origin は「どこで選ばれたか」。選ばれた側は自分をスクロールしない（目の前で選んだものが動くと読みにくい）。

import { useSyncExternalStore } from "react";

/** auto は利用者が選んだのではなく、結合・分割で消えた文の後継へ選び直したとき。 */
export type FocusOrigin = "pdf" | "panel" | "keyboard" | "auto";

export interface SentenceFocus {
  paperId: string | null;
  /** 文の id（同じ本文が何度も出るので、hash ではなく出現を指す）。 */
  id: string | null;
  hash: string | null;
  origin: FocusOrigin;
  /** 同じ文をもう一度選んだときもスクロールし直すための番号。 */
  nonce: number;
}

let focus: SentenceFocus = { paperId: null, id: null, hash: null, origin: "panel", nonce: 0 };
const listeners = new Set<() => void>();

export function getSentenceFocus(): SentenceFocus {
  return focus;
}

export function setSentenceFocus(paperId: string, id: string | null, hash: string | null, origin: FocusOrigin): void {
  focus = { paperId, id, hash, origin, nonce: focus.nonce + 1 };
  for (const fn of listeners) fn();
}

export function subscribeSentenceFocus(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function useSentenceFocus(): SentenceFocus {
  return useSyncExternalStore(subscribeSentenceFocus, getSentenceFocus, getSentenceFocus);
}

// --- PDF に文の枠を出すか -------------------------------------------------------

const MARKS_KEY = "paperlens.sentenceMarks";
let marks = readMarks();
const markListeners = new Set<() => void>();

function readMarks(): boolean {
  try {
    return globalThis.localStorage?.getItem(MARKS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSentenceMarksVisible(v: boolean): void {
  marks = v;
  try {
    globalThis.localStorage?.setItem(MARKS_KEY, v ? "on" : "off");
  } catch {
    // 保存できなくても、この画面の中では切り替わる
  }
  for (const fn of markListeners) fn();
}

export function useSentenceMarksVisible(): boolean {
  return useSyncExternalStore(
    (fn) => {
      markListeners.add(fn);
      return () => void markListeners.delete(fn);
    },
    () => marks,
    () => marks,
  );
}
