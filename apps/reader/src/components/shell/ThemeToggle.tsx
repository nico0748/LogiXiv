// 明るい表示と暗い表示の切り替え。選んだものはこのブラウザに覚えておく。
// 一度も選んでいないときは端末の設定（prefers-color-scheme）に合わせる。
import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

type Theme = "light" | "dark";
const KEY = "paperlens.theme";

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

const systemTheme = (): Theme =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";

/** 最初の描画の前に呼び、ちらつきを防ぐ */
export function applyInitialTheme() {
  document.documentElement.dataset.theme = stored() ?? systemTheme();
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => stored() ?? systemTheme());
  const [chosen, setChosen] = useState(() => stored() !== null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // 選んでいない間は、端末の設定の変化に合わせる
  useEffect(() => {
    if (chosen || typeof matchMedia === "undefined") return;
    const mq = matchMedia("(prefers-color-scheme: light)");
    const on = () => setTheme(mq.matches ? "light" : "dark");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [chosen]);

  const next: Theme = theme === "dark" ? "light" : "dark";
  const label = next === "light" ? "明るい表示にする" : "暗い表示にする";
  return (
    <button
      className="clickable-icon"
      aria-label={label}
      title={label}
      onClick={() => {
        setTheme(next);
        setChosen(true);
        try {
          localStorage.setItem(KEY, next);
        } catch {
          // 保存できなくても表示は切り替わる
        }
      }}
    >
      {theme === "dark" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
    </button>
  );
}
