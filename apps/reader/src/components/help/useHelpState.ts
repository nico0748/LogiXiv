// ヘルプの小さな状態: 更新情報の未読と、? キーで早見表を開く操作。
import { useCallback, useEffect, useRef, useState } from "react";
import { CHANGELOG, CHANGES_SEEN_EVENT, SEEN_CHANGE_KEY, hasUnreadChanges } from "../../lib/help.ts";

const readSeen = (): string | null => {
  try {
    return localStorage.getItem(SEEN_CHANGE_KEY);
  } catch {
    return null;
  }
};

/** 最新の更新情報を読んだと記録する。リボンの印も消える。 */
export function markChangesSeen(): void {
  try {
    localStorage.setItem(SEEN_CHANGE_KEY, CHANGELOG[0]?.id ?? "");
  } catch {
    // 覚えられなくても、ヘルプは使える
  }
  window.dispatchEvent(new Event(CHANGES_SEEN_EVENT));
}

/** 読んでいない更新情報があるか。ほかの画面で読んだらすぐ変わる。 */
export function useUnreadChanges(): boolean {
  const [unread, setUnread] = useState(() => hasUnreadChanges(readSeen()));
  useEffect(() => {
    const on = () => setUnread(hasUnreadChanges(readSeen()));
    window.addEventListener(CHANGES_SEEN_EVENT, on);
    window.addEventListener("storage", on);
    return () => {
      window.removeEventListener(CHANGES_SEEN_EVENT, on);
      window.removeEventListener("storage", on);
    };
  }, []);
  return unread;
}

/** 文字を入力している場所か（入力欄・テキストエリア・選択・contenteditable） */
export function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/** ? キー（Shift + /）で呼ぶ。入力中と、修飾キー（⌘・Ctrl・Alt）付きのときは呼ばない。 */
export function useHelpHotkey(onPress: () => void): void {
  const ref = useRef(onPress);
  ref.current = onPress;
  const on = useCallback((e: KeyboardEvent) => {
    if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (isTyping(e.target) || isTyping(document.activeElement)) return;
    // 開いているダイアログ（<dialog>）と画面の案内（ツアー）の上では使わない
    if (document.querySelector("dialog[open], .tour")) return;
    e.preventDefault();
    ref.current();
  }, []);
  useEffect(() => {
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [on]);
}
