// サイドバーの端をつまんで幅を変える。左右の矢印キーでも変えられる。
import { useRef } from "react";
import { SIDEBAR_MAX, SIDEBAR_MIN } from "./workspaceState.ts";

interface Props {
  side: "left" | "right";
  width: number;
  onResize: (w: number) => void;
  onDragging?: (v: boolean) => void;
  label: string;
}

export function ResizeHandle({ side, width, onResize, onDragging, label }: Props) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const clamp = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));
  return (
    <div
      className={`resize-handle ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: width };
        onDragging?.(true);
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        const dx = e.clientX - s.x;
        onResize(clamp(side === "left" ? s.w + dx : s.w - dx));
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        start.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        onDragging?.(false);
      }}
      onPointerCancel={() => {
        start.current = null;
        onDragging?.(false);
      }}
      onDoubleClick={() => onResize(side === "left" ? 280 : 400)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
        const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
        if (e.key === grow) onResize(clamp(width + step));
        else if (e.key === shrink) onResize(clamp(width - step));
        else return;
        e.preventDefault();
      }}
    />
  );
}
