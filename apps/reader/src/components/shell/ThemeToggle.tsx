// 明るい表示と暗い表示の切り替え。選んだものはこのブラウザに覚えておく（設定の「表示 → テーマ」と同じ値）。
// 一度も選んでいないとき（「システム」）は端末の設定（prefers-color-scheme）に合わせる。
import { Moon, Sun } from "lucide-react";
import { setPref } from "../../lib/prefs.ts";
import { startDisplay, useResolvedTheme } from "../settings/display.ts";

/** 最初の描画の前に呼び、ちらつきを防ぐ（表示の設定もまとめて映す） */
export function applyInitialTheme() {
  startDisplay();
}

export function ThemeToggle() {
  const theme = useResolvedTheme();
  const next = theme === "dark" ? "light" : "dark";
  const label = next === "light" ? "明るい表示にする" : "暗い表示にする";
  return (
    <button className="clickable-icon" aria-label={label} title={label} onClick={() => setPref("theme", next)}>
      {theme === "dark" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
    </button>
  );
}
