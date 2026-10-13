import { STATUSES } from "../lib/defaultTemplate.ts";

// 読解の段階のチップ（M3 のフィルターチップ。1 つだけ選ぶ）。
// 記録タブの段階の切り替えと、論文一覧の絞り込みの両方で使う。
// 矢印キーで前後の段階へ移る（radiogroup の決まりどおり、Tab で入るのは選択中のチップだけ）。

interface Props {
  value: string;
  onChange: (s: string) => void;
  /** 段階ごとの件数。渡すと数字を添え、0 件の段階は出さない（選択中は残す） */
  counts?: Record<string, number>;
  /** 「すべて」のチップの文言。渡すと先頭に足し、その値は "" とする */
  allLabel?: string;
  labelledBy?: string;
  label?: string;
  className?: string;
}

export function StatusChips({ value, onChange, counts, allLabel, labelledBy, label, className }: Props) {
  const all = allLabel !== undefined ? [""] : [];
  const options = [...all, ...STATUSES.filter((s) => !counts || (counts[s] ?? 0) > 0 || s === value)];
  const current = options.includes(value) ? value : options[0];
  const text = (s: string) => (s === "" ? allLabel : s);
  const count = (s: string) => (s === "" ? Object.values(counts ?? {}).reduce((a, b) => a + b, 0) : counts?.[s] ?? 0);
  return (
    <div
      className={`phase-steps${className ? ` ${className}` : ""}`}
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-label={label}
      onKeyDown={(e) => {
        const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const i = Math.max(0, options.indexOf(current));
        const next = options[(i + d + options.length) % options.length];
        onChange(next);
        (e.currentTarget.querySelector(`[data-status="${next}"]`) as HTMLElement | null)?.focus();
      }}
    >
      {options.map((s) => (
        <button
          key={s || "all"}
          type="button"
          role="radio"
          data-status={s}
          aria-checked={value === s}
          tabIndex={s === current ? 0 : -1}
          onClick={() => onChange(s)}
        >
          {text(s)}
          {counts && <span className="chip-count">{count(s)}</span>}
        </button>
      ))}
    </div>
  );
}
