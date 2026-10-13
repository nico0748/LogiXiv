import type { GlossaryEntry } from "@paperlens/core";
import { Pencil, X } from "lucide-react";
import { useState } from "react";
import { sentencesApi } from "../../lib/sentencesApi.ts";
import type { Act } from "./SentenceCard.tsx";

/**
 * 対訳の用語集（この論文の訳語の方針）。
 * Claude は訳すときにこれに従う。追加した後の訳から効き、既にある訳は書き換えない。
 */
export function GlossaryView({ paperId, entries, act }: { paperId: string; entries: GlossaryEntry[]; act: Act }) {
  const [term, setTerm] = useState("");
  const [translation, setTranslation] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");

  const add = async () => {
    if (!term.trim() || !translation.trim()) return;
    setBusy(true);
    const ok = await act(() => sentencesApi.upsertGlossary(paperId, { term: term.trim(), translation: translation.trim(), note: note.trim() || null }));
    setBusy(false);
    if (ok) {
      setTerm("");
      setTranslation("");
      setNote("");
    }
  };
  const needle = q.trim().toLowerCase();
  const list = [...entries]
    .filter((e) => !needle || `${e.term} ${e.translation} ${e.note ?? ""}`.toLowerCase().includes(needle))
    .sort((a, b) => a.term.localeCompare(b.term));
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) void add();
  };

  return (
    <div className="sl-glossary">
      <p className="sl-hint">訳語をそろえたい語を登録します。Claude はこの一覧に従って訳します（登録より前の訳は書き換えません）。同じ語をもう一度登録すると上書きします。</p>
      <div className="sl-gl-form">
        <input className="sl-input" placeholder="原語（例: attention）" aria-label="原語" value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={onEnter} />
        <input className="sl-input" placeholder="訳語（例: 注意機構）" aria-label="訳語" value={translation} onChange={(e) => setTranslation(e.target.value)} onKeyDown={onEnter} />
        <input className="sl-input" placeholder="メモ（任意）" aria-label="メモ" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={onEnter} />
        <button type="button" className="sl-btn primary" disabled={busy || !term.trim() || !translation.trim()} onClick={() => void add()}>登録</button>
      </div>
      {entries.length > 5 && (
        <input className="sl-input sl-gl-search" type="search" placeholder="用語集を検索" aria-label="用語集を検索" value={q} onChange={(e) => setQ(e.target.value)} />
      )}
      {list.length === 0 ? (
        <p className="sl-empty">{entries.length ? "一致する語がありません。" : "まだ登録された語はありません。"}</p>
      ) : (
        <ul className="sl-gl-list">
          {list.map((e) => (
            <li key={e.term} className="sl-gl-item">
              <div className="sl-gl-main">
                <span className="sl-gl-term" lang="en">{e.term}</span>
                <span className="sl-gl-arrow" aria-hidden="true">→</span>
                <span className="sl-gl-tr">{e.translation}</span>
              </div>
              {e.note && <div className="sl-gl-note">{e.note}</div>}
              <div className="sl-gl-actions">
                <button type="button" className="sl-icon" title="編集" aria-label={`${e.term} を編集`} onClick={() => { setTerm(e.term); setTranslation(e.translation); setNote(e.note ?? ""); }}><Pencil size={14} /></button>
                <button type="button" className="sl-icon" title="削除" aria-label={`${e.term} を削除`} onClick={() => void act(() => sentencesApi.removeGlossary(paperId, e.term))}><X size={14} /></button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
