// 設定を Obsidian の設定画面の形（モーダル＋左の項目一覧）で見せる。ナビで選んだページだけを右に出す。
// 左の上の検索欄で、項目名と説明から探せる。結果を選ぶと、そのページを開いてその項目まで動く。
// Esc で閉じる処理は App のキーボード操作でまとめて行う（検索欄に語があるときは、先に語を消す）。
import { Search, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Backend } from "../../lib/backend.ts";
import { SETTINGS_PAGES, type SettingsPageId, searchSettings } from "../../lib/settingsIndex.ts";
import { SettingsPage } from "../SettingsPage.tsx";
import "../settings/settings.css";

interface Props {
  backend: Backend;
  onClose: () => void;
  onSwitchVault?: () => void;
  /** 開いたときのページ（ヘルプや「API キーを設定する」から開くとき） */
  initialPage?: SettingsPageId;
  /** 開いたときに動いて目立たせる項目（set-<id>） */
  initialItem?: string;
}

export function SettingsModal({ backend, onClose, onSwitchVault, initialPage, initialItem }: Props) {
  const [page, setPage] = useState<SettingsPageId>(initialPage ?? "general");
  const [query, setQuery] = useState("");
  const [flash, setFlash] = useState<{ id: string; n: number } | null>(initialItem ? { id: initialItem, n: 0 } : null);
  const results = useMemo(() => searchSettings(query), [query]);
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // 開いている間に別のページを指定されたら（ヘルプから再度開いたときなど）移る
  useEffect(() => {
    if (initialPage) setPage(initialPage);
    if (initialItem) setFlash({ id: initialItem, n: Date.now() });
  }, [initialPage, initialItem]);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => prev?.focus?.();
  }, []);

  // ページを替えたら先頭から見せる。項目を指定したときはそこまで動き、少しの間目立たせる
  useLayoutEffect(() => {
    const box = contentRef.current;
    if (!box) return;
    const el = flash ? document.getElementById(`set-${flash.id}`) : null;
    if (!el) {
      box.scrollTop = 0;
      return;
    }
    el.scrollIntoView({ block: "center" });
    el.classList.remove("is-flash");
    void el.offsetWidth;
    el.classList.add("is-flash");
    const t = window.setTimeout(() => el.classList.remove("is-flash"), 1600);
    return () => window.clearTimeout(t);
  }, [page, flash]);

  const go = (p: SettingsPageId, item?: string) => {
    setPage(p);
    setFlash(item ? { id: item, n: Date.now() } : null);
  };

  const groups = [...new Set(SETTINGS_PAGES.map((p) => p.group))];
  const pageLabel = (id: SettingsPageId) => SETTINGS_PAGES.find((p) => p.id === id)?.label ?? "";

  return (
    <div className="modal-container" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="modal mod-settings" role="dialog" aria-modal="true" aria-label="設定" tabIndex={-1}>
        <button className="modal-close-button clickable-icon" aria-label="閉じる" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
        <nav className="vertical-tab-header settings-nav" aria-label="設定の項目">
          <div className="settings-search">
            <Search size={14} aria-hidden="true" className="settings-search-icon" />
            <input
              className="input"
              type="search"
              aria-label="設定を検索"
              placeholder="設定を検索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery("");
                } else if (e.key === "Enter" && results[0]) {
                  e.preventDefault();
                  go(results[0].page, results[0].id);
                }
              }}
            />
          </div>
          {query.trim() ? (
            <div className="settings-results" role="list" aria-label="検索の結果">
              {results.length ? (
                results.map((r) => (
                  <button key={r.id} role="listitem" className={`vertical-tab-nav-item settings-result${page === r.page ? " is-current-page" : ""}`} onClick={() => go(r.page, r.id)}>
                    <span className="settings-result-label">{r.label}</span>
                    <span className="settings-result-page">{pageLabel(r.page)}</span>
                  </button>
                ))
              ) : (
                <p className="settings-empty">当てはまる設定はありません。</p>
              )}
            </div>
          ) : (
            <div className="settings-nav-groups">
              {groups.map((g) => (
                <div key={g} className="vertical-tab-header-group">
                  <div className="vertical-tab-header-group-title">{g}</div>
                  {SETTINGS_PAGES.filter((p) => p.group === g).map((p) => (
                    <button key={p.id} className={`vertical-tab-nav-item${page === p.id ? " is-active" : ""}`} aria-current={page === p.id ? "page" : undefined} onClick={() => go(p.id)}>
                      {p.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </nav>
        <div className="vertical-tab-content settings-content" ref={contentRef}>
          <SettingsPage page={page} backend={backend} onSwitchVault={onSwitchVault} />
        </div>
      </div>
    </div>
  );
}
