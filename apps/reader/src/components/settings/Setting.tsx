// 設定の 1 行（Obsidian の setting-item の形）。左に名前と説明、右に操作を置く。
import type { ReactNode } from "react";
import type { SettingsPageInfo } from "../../lib/settingsIndex.ts";
import { HelpButton } from "../help/HelpButton.tsx";

export function PageHeader({ page, children }: { page: SettingsPageInfo; children?: ReactNode }) {
  return (
    <header className="settings-page-header">
      <div className="settings-page-title-row">
        <h2 className="settings-page-title" id={`settings-title-${page.id}`}>{page.label}</h2>
        <HelpButton chapter={page.help} label={`${page.label}のヘルプ`} />
      </div>
      {children && <p className="settings-page-lead">{children}</p>}
    </header>
  );
}

interface ItemProps {
  /** 検索から飛ぶときの目印（set-<id>） */
  id?: string;
  name: ReactNode;
  desc?: ReactNode;
  /** 操作の欄。label 付きの入力にするときは htmlFor に合わせる */
  children?: ReactNode;
  /** 名前を入力欄の label にする */
  htmlFor?: string;
  /** 操作を説明の下に回す（テキストエリアなど幅の要るもの） */
  stacked?: boolean;
}

export function SettingItem({ id, name, desc, children, htmlFor, stacked }: ItemProps) {
  const descId = id ? `set-${id}-desc` : undefined;
  return (
    <div className={`setting-item${stacked ? " is-stacked" : ""}`} id={id ? `set-${id}` : undefined}>
      <div className="setting-item-info">
        {htmlFor ? (
          <label className="setting-item-name" htmlFor={htmlFor}>{name}</label>
        ) : (
          <div className="setting-item-name">{name}</div>
        )}
        {desc && <div className="setting-item-description" id={descId}>{desc}</div>}
      </div>
      {children && <div className="setting-item-control">{children}</div>}
    </div>
  );
}

export function SettingHeading({ children }: { children: ReactNode }) {
  return <h3 className="setting-item-heading">{children}</h3>;
}

/** 少数の選択肢から 1 つ選ぶ（ラジオボタンの見た目を切り替えボタンにしたもの） */
export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={`segmented-item${o.value === value ? " is-active" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** オン・オフの切り替え（Obsidian の checkbox-container の形）。中身は普通のチェックボックス */
export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <input type="checkbox" role="switch" className="toggle" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />;
}
