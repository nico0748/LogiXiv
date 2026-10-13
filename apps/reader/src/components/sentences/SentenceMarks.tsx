import { memo } from "react";
import type { SentenceMark } from "../../lib/sentencesView.ts";
import "./sentences.css";

/**
 * PDF の 1 ページに、文の枠を描く。
 * テキスト層の下に置いて pointer-events を切ってある（文字の選択を邪魔しないため）。
 * ホバーとクリックはページ側が座標から当たりを取る（PdfView の hitTest）。
 */
export const SentenceMarkLayer = memo(function SentenceMarkLayer({
  marks,
  activeId,
  hoverId,
}: {
  marks: readonly SentenceMark[];
  activeId: string | null;
  hoverId: string | null;
}) {
  return (
    <div className="sl-layer" aria-hidden="true">
      {marks.map((m, i) => (
        <div
          key={`${m.id}-${i}`}
          className={`sl-mark${m.translated ? " is-translated" : ""}${m.id === activeId ? " is-active" : ""}${m.id === hoverId ? " is-hover" : ""}`}
          style={{ left: `${m.rect.x * 100}%`, top: `${m.rect.y * 100}%`, width: `${m.rect.w * 100}%`, height: `${m.rect.h * 100}%` }}
        />
      ))}
    </div>
  );
});
