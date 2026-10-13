// 空の状態（アイコン・見出し・説明）。項目がまだ無いタブやグラフで使う。
export function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M6 3h9l5 5v13H6z M15 3v5h5" /></svg>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
