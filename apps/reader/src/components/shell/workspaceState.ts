// 画面の配置（サイドバーの開閉・幅・開いている論文）。
// 保管庫の .paperlens/workspace.json に保存する。サーバーと画面の両方で使うので Node の機能は使わない。

export type LeftTab = "files" | "search";

export interface WorkspaceState {
  leftOpen: boolean;
  leftWidth: number;
  rightOpen: boolean;
  rightWidth: number;
  leftTab: LeftTab;
  openPaper: string | null;
}

export const WORKSPACE_PATH = ".paperlens/workspace.json";

export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 640;

/** 初めて開いたときの配置。左は閉じておき、右（補足情報）は開いておく */
export const DEFAULT_WORKSPACE: WorkspaceState = {
  leftOpen: false,
  leftWidth: 280,
  rightOpen: true,
  rightWidth: 400,
  leftTab: "files",
  openPaper: null,
};

const clampWidth = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, v))) : fallback;

/** 壊れた値や知らない項目は捨て、足りない項目は既定値で埋める。 */
export function normalizeWorkspace(raw: unknown, base: WorkspaceState = DEFAULT_WORKSPACE): WorkspaceState {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    leftOpen: typeof r.leftOpen === "boolean" ? r.leftOpen : base.leftOpen,
    leftWidth: clampWidth(r.leftWidth, base.leftWidth),
    rightOpen: typeof r.rightOpen === "boolean" ? r.rightOpen : base.rightOpen,
    rightWidth: clampWidth(r.rightWidth, base.rightWidth),
    leftTab: r.leftTab === "files" || r.leftTab === "search" ? r.leftTab : base.leftTab,
    openPaper:
      r.openPaper === null ? null : typeof r.openPaper === "string" && r.openPaper && !/[\\/]/.test(r.openPaper) ? r.openPaper : base.openPaper,
  };
}
