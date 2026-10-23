// 画面の各所に置く小さな「?」。押すとヘルプをその場所の章で開く（App が HELP_EVENT を受ける）。
import { CircleHelp } from "lucide-react";
import { HELP_CHAPTERS, openHelp } from "../../lib/help.ts";
import "./help.css";

interface Props {
  /** 開く章の id（"faq" / "keys" も可） */
  chapter: string;
  /** よくある質問の項目など、章の中の場所 */
  anchor?: string;
  /** 読み上げとツールチップ。省くと「ヘルプ: 章の題名」 */
  label?: string;
  className?: string;
}

export function HelpButton({ chapter, anchor, label, className }: Props) {
  const title = HELP_CHAPTERS.find((c) => c.id === chapter)?.title.replace(/（.*$/, "");
  const text = label ?? `ヘルプ: ${title ?? "よくある質問"}`;
  return (
    <button
      type="button"
      className={`clickable-icon help-button${className ? ` ${className}` : ""}`}
      aria-label={text}
      title={text}
      data-help-chapter={chapter}
      onClick={(e) => {
        // カードの選択など、親の押下の処理に渡さない
        e.stopPropagation();
        openHelp(chapter, anchor);
      }}
    >
      <CircleHelp size={14} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
