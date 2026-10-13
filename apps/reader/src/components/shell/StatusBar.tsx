// 右下に重ねて表示する状態表示（Obsidian のステータスバー）。
import type { ReactNode } from "react";

export function StatusBar({ items }: { items: { key: string; node: ReactNode; title?: string }[] }) {
  const shown = items.filter((i) => i.node !== null && i.node !== undefined && i.node !== false && i.node !== "");
  if (!shown.length) return null;
  return (
    <footer className="status-bar" role="status" aria-live="polite">
      {shown.map((i) => (
        <span key={i.key} className="status-bar-item" title={i.title}>
          {i.node}
        </span>
      ))}
    </footer>
  );
}
