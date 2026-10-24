// 発表スライドと論文の画面を全画面にする。
// 画面の根の要素に Fullscreen API を使う（中に重ねた知らせや取り込み中の表示も、そのまま見える）。
// 使えないとき・断られたときは、ウィンドウいっぱいに広げる（"fill"）。どちらも Esc で終える。

import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

export type FullscreenMode = "native" | "fill" | null;

/** 入力中、メニューやモーダルの中では、キー操作を使わない（SlidesView のキー操作と同じ条件） */
const busyTarget = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  if (t?.closest("input, textarea, select, [contenteditable], dialog, [role=menu], [role=dialog], .menu-surface:not(.sv-sel)")) return true;
  return !!document.querySelector("dialog[open], [role=dialog][aria-modal=true]");
};

/** onKey: P を押したときに先に呼ぶ。true を返したら全画面にはしない（発表の窓を開けたときなど） */
export function useFullscreen(ref: RefObject<HTMLElement | null>, enabled: boolean, onKey?: () => boolean) {
  const [native, setNative] = useState(false);
  const [fill, setFill] = useState(false);
  const mode: FullscreenMode = native ? "native" : fill ? "fill" : null;

  useEffect(() => {
    const on = () => setNative(!!ref.current && document.fullscreenElement === ref.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, [ref]);

  const enter = useCallback(async () => {
    const el = ref.current;
    if (!el) return;
    if (!document.fullscreenEnabled || !el.requestFullscreen) return setFill(true);
    try {
      await el.requestFullscreen({ navigationUI: "hide" });
    } catch {
      // 断られた（ユーザーの操作から呼んでいない、埋め込みで許されていないなど）
      setFill(true);
    }
  }, [ref]);

  const exit = useCallback(() => {
    setFill(false);
    if (document.fullscreenElement && document.fullscreenElement === ref.current) void document.exitFullscreen().catch(() => undefined);
  }, [ref]);

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const toggle = useCallback(() => {
    if (modeRef.current) exit();
    else void enter();
  }, [enter, exit]);
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;

  // P で切り替える。ウィンドウいっぱいのときの Esc は、ほかの処理（道具を戻す・選択を外す・重ねた画面を閉じる）が使わなかったときだけ終える
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        if (!modeRef.current || modeRef.current === "native") return;
        // ほかの keydown（後から登録したものも含む）が済んでから確かめる
        window.setTimeout(() => {
          if (!e.defaultPrevented && !busyTarget(e)) setFill(false);
        });
        return;
      }
      if (!enabled || e.shiftKey || e.key.toLowerCase() !== "p" || busyTarget(e)) return;
      e.preventDefault();
      if (!modeRef.current && onKeyRef.current?.()) return;
      toggle();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [enabled, toggle]);

  // 画面の外に描くモーダル（リスト・ヘルプなど）は全画面では見えないので、開いたら全画面を終える
  useEffect(() => {
    if (!native) return;
    const mo = new MutationObserver(() => {
      const m = document.querySelector("[role=dialog][aria-modal=true]");
      if (m && !ref.current?.contains(m)) exit();
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [native, exit, ref]);

  // スライドの画面を離れるとき（論文の画面へ戻るなど）は、全画面も終える
  useEffect(() => {
    if (!enabled && modeRef.current) exit();
  }, [enabled, exit]);
  useEffect(() => {
    // 外すときには ref が空になっているので、付けたときの要素を覚えておく
    const el = ref.current;
    return () => {
      if (el && document.fullscreenElement === el) void document.exitFullscreen().catch(() => undefined);
    };
  }, [ref]);

  return { mode, enter, exit, toggle };
}
