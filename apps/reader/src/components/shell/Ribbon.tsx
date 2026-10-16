// 左端の細いメニュー（Obsidian のリボン）。押すと左サイドバーの表示や中央の画面が切り替わる。
import { CircleHelp, Files, ListChecks, type LucideIcon, Presentation, Search, Settings, Waypoints } from "lucide-react";

export type RibbonItem = "files" | "search" | "lists" | "graph" | "slides" | "settings" | "help";

const TOP: { id: RibbonItem; label: string; icon: LucideIcon }[] = [
  { id: "files", label: "論文一覧", icon: Files },
  { id: "search", label: "検索", icon: Search },
  { id: "lists", label: "リスト（用語・数式）", icon: ListChecks },
  { id: "graph", label: "グラフ", icon: Waypoints },
  { id: "slides", label: "発表スライドと論文の対応", icon: Presentation },
];
const BOTTOM: { id: RibbonItem; label: string; icon: LucideIcon }[] = [
  { id: "settings", label: "設定", icon: Settings },
  { id: "help", label: "ヘルプ", icon: CircleHelp },
];

export function Ribbon({ active, onItem }: { active: Partial<Record<RibbonItem, boolean>>; onItem: (id: RibbonItem) => void }) {
  const btn = ({ id, label, icon: Icon }: (typeof TOP)[number]) => (
    <button
      key={id}
      className={`ribbon-item clickable-icon${active[id] ? " is-active" : ""}`}
      aria-label={label}
      title={label}
      aria-pressed={active[id] ?? false}
      onClick={() => onItem(id)}
    >
      <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
  return (
    <nav className="ribbon" aria-label="主要メニュー">
      <div className="ribbon-group">{TOP.map(btn)}</div>
      <div className="ribbon-group ribbon-bottom">{BOTTOM.map(btn)}</div>
    </nav>
  );
}
