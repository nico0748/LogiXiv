import { useCallback, useSyncExternalStore } from "react";
import { type SentencesEntry, getSentences, watchSentences } from "../../lib/sentencesApi.ts";

/** この論文の対訳の状態。読み込みと変更の通知は、同じ論文を見ている部品の間で 1 本にまとめる。 */
export function useSentences(paperId: string | null | undefined): SentencesEntry {
  const id = paperId ?? null;
  const subscribe = useCallback((fn: () => void) => (id ? watchSentences(id, fn) : () => undefined), [id]);
  const snap = useCallback(() => getSentences(id), [id]);
  return useSyncExternalStore(subscribe, snap, snap);
}
