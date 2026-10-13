import { useEffect, useRef, useState } from "react";

// 画面の下に短い知らせを出す（M3 のスナックバー）。
// 読み上げソフトには role="status" で伝え、フォーカスは移さない。
// マウスが上にあるときと、フォーカスが中にあるときは、時間を止める（消える前に操作できるように）。

export interface Snack {
  message: string;
  action?: { label: string; onClick: () => void };
  /** 表示する時間（ミリ秒） */
  ms?: number;
  /** 同じ文言を続けて出したときも出し直すための番号 */
  n: number;
}

export function Snackbar({ snack, onClose }: { snack: Snack | null; onClose: () => void }) {
  const [hold, setHold] = useState({ hover: false, focus: false });
  const left = useRef(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    left.current = snack?.ms ?? 4000;
    setHold({ hover: false, focus: false });
  }, [snack]);

  const paused = hold.hover || hold.focus;
  useEffect(() => {
    if (!snack || paused) return;
    const start = Date.now();
    const t = window.setTimeout(() => closeRef.current(), left.current);
    return () => {
      window.clearTimeout(t);
      left.current = Math.max(800, left.current - (Date.now() - start));
    };
  }, [snack, paused]);

  // 読み上げを確実にするため、知らせの入れ物は常に置いておく
  return (
    <div role="status" aria-live="polite">
      {snack && (
        <div
          className="snackbar"
          onMouseEnter={() => setHold((h) => ({ ...h, hover: true }))}
          onMouseLeave={() => setHold((h) => ({ ...h, hover: false }))}
          onFocus={() => setHold((h) => ({ ...h, focus: true }))}
          onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setHold((h) => ({ ...h, focus: false }))}
        >
          <span>{snack.message}</span>
          {snack.action && (
            <button
              className="btn text sm"
              onClick={() => {
                snack.action!.onClick();
                onClose();
              }}
            >
              {snack.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
