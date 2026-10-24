// 元の窓の側から、発表の窓を開いて閉じる。発表の窓が今どのスライドを映しているかを受け取る。
// 開けなかったとき（ポップアップを止められた、BroadcastChannel が無いなど）は start が false を返すので、
// 呼ぶ側はこれまでどおりこの窓の中で全画面にする。

import { useCallback, useEffect, useRef, useState } from "react";
import { PRESENT_WINDOW, type PresentMsg, canPresent, presentChannel, presenterUrl } from "../../lib/presenter.ts";

export interface Presenter {
  /** 発表の窓が開いている */
  open: boolean;
  /** 発表の窓が映しているスライドのページと、ページ数（分かるまで 0） */
  page: number;
  count: number;
  /** 発表の窓で選んでいるグループ */
  active: string | null;
  start(): boolean;
  stop(): void;
  focus(id: string, link?: string): void;
  goto(page: number): void;
}

export function usePresenter(paperId: string | null | undefined, enabled: boolean): Presenter {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [count, setCount] = useState(0);
  const [active, setActive] = useState<string | null>(null);
  const chan = useRef<BroadcastChannel | null>(null);
  const win = useRef<Window | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (!paperId || !canPresent()) return;
    const c = presentChannel(paperId);
    chan.current = c;
    c.onmessage = (e: MessageEvent<PresentMsg>) => {
      const m = e.data;
      if (m.t === "hello" || m.t === "page") {
        if (m.t === "hello") setOpen(true);
        setPage(m.page);
        setCount(m.count);
      } else if (m.t === "active") setActive(m.id);
      else if (m.t === "bye") {
        setOpen(false);
        win.current = null;
      }
    };
    // この窓を読み直したときなど、発表の窓がもう開いていれば名乗り直してもらう
    c.postMessage({ t: "ping" } satisfies PresentMsg);
    return () => {
      // 論文を替えた・スライドの画面を離れたときは、発表も終える
      if (openRef.current) c.postMessage({ t: "close" } satisfies PresentMsg);
      win.current?.close();
      win.current = null;
      c.close();
      chan.current = null;
      setOpen(false);
    };
  }, [paperId]);

  // 発表の窓を閉じるボタンや ⌘W で閉じたときは bye が届かないことがあるので、窓が閉じたかも見る
  useEffect(() => {
    if (!open) return;
    const t = window.setInterval(() => {
      if (win.current?.closed) {
        win.current = null;
        setOpen(false);
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, [open]);

  const send = (m: PresentMsg) => chan.current?.postMessage(m);

  const start = useCallback(() => {
    if (!enabled || !paperId || !chan.current) return false;
    const w = window.open(presenterUrl(location.href, paperId), PRESENT_WINDOW, "popup,width=1280,height=800");
    if (!w) return false;
    win.current = w;
    setOpen(true);
    setPage(1);
    setCount(0);
    setActive(null);
    return true;
  }, [enabled, paperId]);

  const stop = useCallback(() => {
    send({ t: "close" });
    win.current?.close();
    win.current = null;
    setOpen(false);
  }, []);

  const focus = useCallback((id: string, link?: string) => send({ t: "focus", id, ...(link ? { link } : {}) }), []);
  const goto = useCallback((p: number) => send({ t: "goto", page: p }), []);

  return { open, page, count, active, start, stop, focus, goto };
}
