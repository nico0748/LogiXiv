// 設定の 1 行（Obsidian の setting-item の形）。左に名前と説明、右に操作を置く。
// 説明の id は文脈（useSettingDesc）で操作に渡し、aria-describedby で読み上げに含める。
import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, createContext, useContext, useId } from "react";
import type { SettingsPageInfo } from "../../lib/settingsIndex.ts";
import { HelpButton } from "../help/HelpButton.tsx";

const DescContext = createContext<string | undefined>(undefined);
/** いまの設定の行の説明の id。操作の aria-describedby に使う */
export const useSettingDesc = () => useContext(DescContext);

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
  const auto = useId();
  const descId = desc ? `${id ? `set-${id}` : auto}-desc` : undefined;
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
      {children && (
        <DescContext.Provider value={descId}>
          <div className="setting-item-control">{children}</div>
        </DescContext.Provider>
      )}
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
  const desc = useSettingDesc();
  return (
    <div className="segmented" role="radiogroup" aria-label={label} aria-describedby={desc}>
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
export function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const desc = useSettingDesc();
  return (
    <input
      type="checkbox"
      role="switch"
      className="toggle"
      aria-label={label}
      aria-describedby={desc}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

/** 説明を読み上げに含める select / input / textarea（SettingItem の中で使う） */
export function Select({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`select${className ? ` ${className}` : ""}`} aria-describedby={useSettingDesc()} {...p} />;
}
export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input${className ? ` ${className}` : ""}`} aria-describedby={useSettingDesc()} {...p} />;
}
export function TextArea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`textarea${className ? ` ${className}` : ""}`} aria-describedby={useSettingDesc()} {...p} />;
}
