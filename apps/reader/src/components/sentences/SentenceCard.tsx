import type { NonBodySentence, Note, Sentence, Translation } from "@paperlens/core";
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { type SentencesState, sentencesApi } from "../../lib/sentencesApi.ts";
import { NONBODY_LABEL, seamLabel, wordBoundaries } from "../../lib/sentencesView.ts";

/** 書き込みを 1 つ走らせる。成功したら true（失敗の知らせはパネルが出す）。 */
export type Act = (f: () => Promise<SentencesState>) => Promise<boolean>;

export interface CardProps {
  paperId: string;
  sentence: Sentence;
  translation: Translation | undefined;
  skipped: boolean;
  notes: Note[];
  active: boolean;
  next: Sentence | null;
  mergeCount: number;
  splitCount: number;
  repeat: boolean;
  act: Act;
  onSelect: (s: Sentence) => void;
}

const preview = (t: string, n = 28) => (t.length <= n ? t : `${t.slice(0, n)}…`);
const tail = (t: string, n = 20) => (t.length <= n ? t : `…${t.slice(-n)}`);

/**
 * 1 文 = 1 枚のカード。
 * 訳はダブルクリックか「訳を編集」で直せる。Enter で保存、Shift+Enter で改行、Esc で取り消し。
 * 人が保存した訳には印が付き、Claude の訳で上書きされない。
 */
function SentenceCardView(p: CardProps) {
  const { sentence: s, translation: tr, notes } = p;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tr?.text ?? "");
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [splitting, setSplitting] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const bounds = useMemo(() => wordBoundaries(s.text), [s.text]);

  // 編集中は、通知で届いた更新で下書きを潰さない
  useEffect(() => {
    if (!editing) setDraft(tr?.text ?? "");
  }, [tr?.text, editing]);
  useEffect(() => setSplitting(false), [s.hash]);
  useEffect(() => {
    if (splitting) splitRef.current?.querySelector("button")?.focus();
  }, [splitting]);

  const run = async (f: () => Promise<SentencesState>) => {
    setBusy(true);
    try {
      return await p.act(f);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    const text = draft.trim();
    if (text === (tr?.text ?? "")) return setEditing(false);
    const ok = await run(() => (text ? sentencesApi.setTranslation(p.paperId, s.hash, text) : sentencesApi.clearTranslation(p.paperId, s.hash)));
    if (ok) setEditing(false);
  };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <article
      className={`sl-card${p.active ? " is-active" : ""}${p.skipped ? " is-skipped" : ""}`}
      data-sl-card={s.id}
      role="button"
      tabIndex={0}
      aria-pressed={p.active}
      onClick={() => p.onSelect(s)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          p.onSelect(s);
        }
      }}
    >
      {splitting ? (
        <div className="sl-split" ref={splitRef} onClick={stop} onKeyDown={(e) => { stop(e); if (e.key === "Escape") setSplitting(false); }}>
          <p className="sl-orig" lang="en">
            {bounds.map((o, i) => (
              <Fragment key={o}>
                <span>{s.text.slice(i === 0 ? 0 : bounds[i - 1], o)}</span>
                <button
                  type="button"
                  className="sl-split-point"
                  disabled={busy}
                  title={`ここで分割: 「${tail(s.text.slice(0, o).trim())}」／「${preview(s.text.slice(o).trim())}」`}
                  aria-label={`ここで分割。前半の終わりは ${tail(s.text.slice(0, o).trim())}`}
                  onClick={() =>
                    void run(() => sentencesApi.editBoundary(p.paperId, { type: "split", hashes: [s.hash], offsets: [o] })).then(
                      (ok) => ok && setSplitting(false),
                    )
                  }
                />
              </Fragment>
            ))}
            <span>{s.text.slice(bounds[bounds.length - 1] ?? 0)}</span>
          </p>
          <div className="sl-row">
            <span className="sl-hint">切りたい位置の縦線を押してください{p.splitCount > 1 && `（同じ本文の ${p.splitCount} か所すべてに効きます）`}</span>
            <button type="button" className="sl-btn" onClick={() => setSplitting(false)}>やめる</button>
          </div>
        </div>
      ) : (
        <p className="sl-orig" lang="en">{s.text}</p>
      )}

      {editing ? (
        <div className="sl-editor" onClick={stop}>
          <textarea
            className="sl-textarea"
            value={draft}
            autoFocus
            rows={3}
            aria-label="訳文"
            placeholder="訳を入力（空にして保存すると未訳に戻ります）"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              stop(e);
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void save();
              }
              if (e.key === "Escape") {
                setDraft(tr?.text ?? "");
                setEditing(false);
              }
            }}
          />
          <div className="sl-row">
            <button type="button" className="sl-btn primary" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</button>
            <button type="button" className="sl-btn" onClick={() => setEditing(false)}>取消</button>
            <span className="sl-hint">Enter で保存・Shift+Enter で改行・Esc で取消</span>
          </div>
        </div>
      ) : (
        <p
          className={`sl-trans${tr ? "" : " is-empty"}${tr?.revisedByHuman ? " is-human" : ""}`}
          onDoubleClick={(e) => {
            stop(e);
            setEditing(true);
          }}
          title={tr ? (tr.revisedByHuman ? "人が直した訳（Claude は上書きしません）" : "Claude の訳") : undefined}
        >
          {tr?.text ?? (p.skipped ? "（訳さない）" : "（未訳）")}
        </p>
      )}

      {s.seam && (
        <div className="sl-seam">
          この文には、本文として取り出せなかった{seamLabel(s.seam.kinds)}が挟まっています。記号や語が抜けているおそれがあるので、PDF を確かめてください。
          {s.seam.texts && s.seam.texts.length > 0 && <span className="sl-seam-text" lang="en">抜けたのはここ: {s.seam.texts.join(" / ")}</span>}
        </div>
      )}
      {p.repeat && <p className="sl-sub">同じ本文が前にも出ています（訳は共通）</p>}

      {notes.map((n) => (
        <p key={n.id} className="sl-note">
          <span className="sl-note-body">{n.body}</span>
          {n.author && <span className="sl-note-author">{n.author}</span>}
          <button type="button" className="sl-icon" aria-label="メモを削除" title="メモを削除" onClick={(e) => { stop(e); void run(() => sentencesApi.removeNote(p.paperId, n.id)); }}>×</button>
        </p>
      ))}

      {noteOpen && (
        <div className="sl-editor" onClick={stop}>
          <textarea
            className="sl-textarea"
            value={noteDraft}
            rows={2}
            autoFocus
            aria-label="メモ"
            placeholder="訳語の判断、原文の曖昧さなど"
            onChange={(e) => setNoteDraft(e.target.value)}
            onKeyDown={(e) => {
              stop(e);
              if (e.key === "Escape") setNoteOpen(false);
            }}
          />
          <div className="sl-row">
            <button
              type="button"
              className="sl-btn primary"
              disabled={busy || !noteDraft.trim()}
              onClick={() =>
                void run(() => sentencesApi.addNote(p.paperId, s.hash, noteDraft.trim())).then((ok) => {
                  if (!ok) return;
                  setNoteDraft("");
                  setNoteOpen(false);
                })
              }
            >
              メモを追加
            </button>
            <button type="button" className="sl-btn" onClick={() => setNoteOpen(false)}>取消</button>
          </div>
        </div>
      )}

      {confirm && (
        <div className="sl-confirm" onClick={stop}>
          <span>この訳を消して未訳に戻します。元に戻せません。{p.splitCount > 1 && `（同じ本文の ${p.splitCount} か所すべて）`}</span>
          <button type="button" className="sl-btn danger" disabled={busy} onClick={() => void run(() => sentencesApi.clearTranslation(p.paperId, s.hash)).then(() => setConfirm(false))}>消す</button>
          <button type="button" className="sl-btn" onClick={() => setConfirm(false)}>やめる</button>
        </div>
      )}

      <div className="sl-tools" onClick={stop}>
        <button type="button" onClick={() => setEditing(true)}>訳を編集</button>
        <button type="button" onClick={() => setNoteOpen(true)}>メモ</button>
        {tr ? (
          <button type="button" onClick={() => setConfirm((v) => !v)}>訳を消す</button>
        ) : (
          <button
            type="button"
            disabled={busy}
            title={p.skipped ? "訳す対象に戻す" : "訳す対象から外す（参考文献・数式など）"}
            onClick={() => void run(() => (p.skipped ? sentencesApi.unskip(p.paperId, [s.hash]) : sentencesApi.skip(p.paperId, [s.hash], null)))}
          >
            {p.skipped ? "訳す対象に戻す" : "訳さない"}
          </button>
        )}
        <button
          type="button"
          aria-disabled={!p.next}
          title={p.next ? `次の文と 1 つにします: 「${preview(p.next.text, 40)}」${p.mergeCount > 1 ? `（同じ並びの ${p.mergeCount} か所すべて）` : ""}` : "最後の文なので結合する相手がいません"}
          onClick={() => {
            if (!p.next || busy) return;
            void run(() => sentencesApi.editBoundary(p.paperId, { type: "merge", hashes: [s.hash, p.next!.hash] }));
          }}
        >
          次と結合
        </button>
        <button
          type="button"
          aria-disabled={bounds.length === 0}
          aria-expanded={splitting}
          title={bounds.length ? "原文の切れ目を選んで 2 文に分けます" : "語がひとつしかないので分割できません"}
          onClick={() => bounds.length && setSplitting((v) => !v)}
        >
          分割…
        </button>
        <span className="sl-page">p.{s.page}</span>
      </div>
    </article>
  );
}

/**
 * 画面に出る値だけで比べる。読み直すたびに JSON から作り直されるので、
 * 参照で比べると中身が同じでも必ず描き直しになる（j/k で 1 文動くたびに全カードが作り直される）。
 */
function sameCard(a: CardProps, b: CardProps): boolean {
  if (a.active !== b.active || a.skipped !== b.skipped || a.repeat !== b.repeat) return false;
  if (a.mergeCount !== b.mergeCount || a.splitCount !== b.splitCount || a.paperId !== b.paperId) return false;
  if (a.sentence.id !== b.sentence.id || a.sentence.hash !== b.sentence.hash || a.sentence.text !== b.sentence.text) return false;
  if (a.sentence.page !== b.sentence.page || Boolean(a.sentence.seam) !== Boolean(b.sentence.seam)) return false;
  if (a.next?.hash !== b.next?.hash || a.next?.text !== b.next?.text) return false;
  if (a.translation?.text !== b.translation?.text || a.translation?.revisedByHuman !== b.translation?.revisedByHuman) return false;
  if (a.notes.length !== b.notes.length) return false;
  for (let i = 0; i < a.notes.length; i++) {
    const x = a.notes[i]!;
    const y = b.notes[i]!;
    if (x.id !== y.id || x.body !== y.body || x.author !== y.author) return false;
  }
  return a.act === b.act && a.onSelect === b.onSelect;
}

export const SentenceCard = memo(SentenceCardView, sameCard);

/** 本文として扱わなかった行。訳の対象ではないので、在ることと理由だけを示す。 */
export const NonBodyCard = memo(function NonBodyCard({ item, matched }: { item: NonBodySentence; matched: boolean }) {
  return (
    <article className={`sl-card is-nonbody${matched ? " is-match" : ""}`} data-sl-card={item.id}>
      <p className="sl-kind">
        {NONBODY_LABEL[item.kind]}（訳しません）{matched && <span className="sl-badge">検索に一致</span>}
      </p>
      <p className="sl-orig" lang="en">{item.text}</p>
    </article>
  );
});
