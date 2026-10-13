// 状態表示に出す、開いている論文の対訳の解析器と進み具合。
import { useMemo } from "react";
import { sentenceProgress } from "../../lib/sentencesView.ts";
import { useSentences } from "../sentences/useSentences.ts";

export function SentenceStatus({ paperId }: { paperId: string }) {
  const { state } = useSentences(paperId);
  const doc = state?.status === "ready" ? state.document : null;
  const prog = useMemo(() => (doc ? sentenceProgress(doc) : null), [doc]);
  if (!state || state.status === "none") return null;
  if (state.status === "parsing") return <span>対訳: 解析しています</span>;
  if (state.status === "failed") return <span className="status-err" title={state.error}>対訳: 解析できませんでした</span>;
  if (!doc || !prog) return null;
  const parser = doc.structure.parser === "grobid" ? "GROBID" : "簡易解析";
  return (
    <span title={doc.structure.parserNote}>
      {parser} · 訳 {prog.translated}/{prog.total}
    </span>
  );
}
