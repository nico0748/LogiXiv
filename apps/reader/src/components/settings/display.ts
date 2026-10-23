// 表示の設定（明暗・アクセント色・文字の大きさ・行間）を <html> に映す。
// 明暗は data-theme、ほかは CSS 変数（--pl-*）で渡し、settings.css の規則が各画面に効かせる。

import { useSyncExternalStore } from "react";
import { type Accent, type Leading, FONT_DEFAULT, getPref, subscribePrefs } from "../../lib/prefs.ts";
import "./settings.css";

export type Theme = "light" | "dark";

/** アクセント色。M3 の primary / on-primary / primary-container / on-primary-container を明暗の組で持つ。indigo は styles.css のまま */
export const ACCENT_COLORS: Record<Exclude<Accent, "indigo">, [string, string, string, string]> = {
  blue: ["light-dark(#2f5f97, #a5c8ff)", "light-dark(#ffffff, #00315f)", "light-dark(#d4e3ff, #144876)", "light-dark(#144876, #d4e3ff)"],
  green: ["light-dark(#2f6a3b, #96d5a0)", "light-dark(#ffffff, #003916)", "light-dark(#b2f1bb, #145226)", "light-dark(#145226, #b2f1bb)"],
  orange: ["light-dark(#8a5100, #ffb870)", "light-dark(#ffffff, #4a2800)", "light-dark(#ffdcbe, #693c00)", "light-dark(#693c00, #ffdcbe)"],
  rose: ["light-dark(#8e4957, #ffb1c0)", "light-dark(#ffffff, #561d2a)", "light-dark(#ffd9df, #72333f)", "light-dark(#72333f, #ffd9df)"],
};

/** 見本の丸に使う色（明るい表示での primary） */
export const ACCENT_SWATCH: Record<Accent, string> = {
  indigo: "#545a92",
  blue: "#2f5f97",
  green: "#2f6a3b",
  orange: "#8a5100",
  rose: "#8e4957",
};

export const ACCENT_LABEL: Record<Accent, string> = { indigo: "藍（初期）", blue: "青", green: "緑", orange: "橙", rose: "紅" };
export const LEADING_SCALE: Record<Leading, number> = { compact: 0.88, normal: 1, relaxed: 1.15 };

const mq = () => (typeof matchMedia === "undefined" ? null : matchMedia("(prefers-color-scheme: light)"));
export const systemTheme = (): Theme => (mq()?.matches ?? false ? "light" : "dark");
export const resolvedTheme = (): Theme => {
  const t = getPref("theme");
  return t === "system" ? systemTheme() : t;
};

const themeListeners = new Set<() => void>();
const notifyTheme = () => {
  for (const fn of themeListeners) fn();
};

/** 実際に出している明暗（「システム」のときは端末の設定） */
export function useResolvedTheme(): Theme {
  return useSyncExternalStore(
    (fn) => {
      themeListeners.add(fn);
      return () => void themeListeners.delete(fn);
    },
    resolvedTheme,
    resolvedTheme,
  );
}

export function applyDisplay() {
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme();
  const accent = getPref("accent");
  const props = ["--md-sys-color-primary", "--md-sys-color-on-primary", "--md-sys-color-primary-container", "--md-sys-color-on-primary-container"];
  props.forEach((p, i) => (accent === "indigo" ? root.style.removeProperty(p) : root.style.setProperty(p, ACCENT_COLORS[accent][i])));
  root.dataset.accent = accent;
  const d = getPref("display");
  root.style.setProperty("--pl-fs-body", String(d.fontBody / FONT_DEFAULT));
  root.style.setProperty("--pl-fs-note", String(d.fontNote / FONT_DEFAULT));
  root.style.setProperty("--pl-fs-sidebar", String(d.fontSidebar / FONT_DEFAULT));
  root.style.setProperty("--pl-leading", String(LEADING_SCALE[d.leading]));
  notifyTheme();
}

let started = false;
/** 最初の描画の前に一度呼ぶ。以後は設定と端末の明暗の変化に合わせて映し直す */
export function startDisplay() {
  applyDisplay();
  if (started) return;
  started = true;
  subscribePrefs((n) => {
    if (n === "theme" || n === "accent" || n === "display") applyDisplay();
  });
  mq()?.addEventListener("change", () => getPref("theme") === "system" && applyDisplay());
}
