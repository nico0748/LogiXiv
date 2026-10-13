// Obsidian の設定画面と同じ形のモーダル。左に項目の一覧、右に中身を置く。
// Esc で閉じる処理は App のキーボード操作でまとめて行う。
import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

export interface ModalNavItem {
  id: string;
  label: string;
  group?: string;
}

interface Props {
  title: string;
  onClose: () => void;
  nav?: ModalNavItem[];
  activeNav?: string;
  onNav?: (id: string) => void;
  children: ReactNode;
  className?: string;
}

export function Modal({ title, onClose, nav, activeNav, onNav, children, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => prev?.focus?.();
  }, []);
  const groups = nav ? [...new Set(nav.map((n) => n.group ?? ""))] : [];
  return (
    <div className="modal-container" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`modal${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <button className="modal-close-button clickable-icon" aria-label="閉じる" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
        {nav && (
          <nav className="vertical-tab-header" aria-label={`${title}の項目`}>
            {groups.map((g) => (
              <div key={g} className="vertical-tab-header-group">
                {g && <div className="vertical-tab-header-group-title">{g}</div>}
                {nav
                  .filter((n) => (n.group ?? "") === g)
                  .map((n) => (
                    <button key={n.id} className={`vertical-tab-nav-item${activeNav === n.id ? " is-active" : ""}`} aria-current={activeNav === n.id} onClick={() => onNav?.(n.id)}>
                      {n.label}
                    </button>
                  ))}
              </div>
            ))}
          </nav>
        )}
        <div className="vertical-tab-content">{children}</div>
      </div>
    </div>
  );
}
