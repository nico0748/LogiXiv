// 「このアプリについて」に出す動作モードと、不具合報告用の文面。

export type AppMode = "browser" | "server" | "desktop";

export const MODE_LABEL: Record<AppMode, string> = {
  browser: "ブラウザ（サーバーなし）",
  server: "ローカルサーバー",
  desktop: "デスクトップ版",
};

export function appMode(kind: "server" | "browser", desktop: boolean): AppMode {
  if (kind === "browser") return "browser";
  return desktop ? "desktop" : "server";
}

export interface ReportInput {
  version: string;
  mode: AppMode;
  where: string;
  userAgent: string;
  language: string;
  screen: string;
}

/** 不具合報告に貼る文面。API キーや論文の内容は入れない */
export function buildReport(r: ReportInput): string {
  return [
    `PaperLens ${r.version}`,
    `動作モード: ${MODE_LABEL[r.mode]}`,
    `保存先: ${r.where}`,
    `ブラウザ: ${r.userAgent}`,
    `言語: ${r.language}`,
    `画面: ${r.screen}`,
  ].join("\n");
}
