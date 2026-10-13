import type { PaperDocument, Sentence } from "@paperlens/core";
import { BookA, Eye, EyeOff, Loader2, RotateCcw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setSentenceFocus, setSentenceMarksVisible, useSentenceFocus, useSentenceMarksVisible } from "../../lib/sentenceFocus.ts";
import { type ParserChoice, putSentences, refreshSentences, sentencesApi } from "../../lib/sentencesApi.ts";
import {
  buildRows,
  filterNonBody,
  filterSentences,
  formatElapsed,
  moveTarget,
  notesByHash,
  qualityCaveats,
  sentenceProgress,
} from "../../lib/sentencesView.ts";
import { GlossaryView } from "./GlossaryView.tsx";
import { type Act, NonBodyCard, SentenceCard } from "./SentenceCard.tsx";
import { useSentences } from "./useSentences.ts";
import "./sentences.css";

const PARSERS: { id: ParserChoice; label: string }[] = [
  { id: "auto", label: "自動（GROBID があれば使う）" },
  { id: "grobid", label: "GROBID" },
  { id: "fallback", label: "簡易解析（PDF の文字から）" },
];

/**
 * 対訳タブ。論文を 1 文ずつのカードに分け、原文の下に訳を並べる。
 * 訳を入れるのは Claude（MCP 経由）か人。ここでは読む・直す・区切りを整えることに集中する。
 */
export function SentencePanel({ paperId }: { paperId: string | null }) {
  const { state, error } = useSentences(paperId);
  const [flash, setFlash] = useState<string | null>(null);

  const act: Act = useCallback(
    async (f) => {
      if (!paperId) return false;
      try {
        putSentences(paperId, await f());
        return true;
      } catch (e) {
        setFlash(e instanceof Error ? e.message : String(e));
        return false;
      }
    },
    [paperId],
  );

  if (!paperId) return <p className="sl-empty">論文を開くと、1 文ずつの対訳がここに並びます。</p>;
  const flashEl = flash && (
    <p className="sl-flash" role="status">
      {flash}
      <button type="button" className="sl-icon" aria-label="閉じる" onClick={() => setFlash(null)}>×</button>
    </p>
  );
  if (!state) {
    if (error)
      return (
        <div className="sl-state">
          <p className="sl-error">対訳を読み込めませんでした。{error}</p>
          <p className="sl-hint">対訳はローカルサーバー（npm start かデスクトップ版）で開いているときに使えます。</p>
          <button type="button" className="sl-btn" onClick={() => void refreshSentences(paperId)}>読み直す</button>
        </div>
      );
    return <p className="sl-empty"><Loader2 size={14} className="sl-spin" /> 読み込み中…</p>;
  }
  if (state.status === "none")
    return (
      <div className="sl-state">
        {flashEl}
        <p>この論文はまだ文に分けていません。分けると、原文と訳が 1 文ずつ並び、Claude に訳を頼めるようになります。</p>
        <ParseForm label="文に分けて解析する" onParse={(parser) => act(() => sentencesApi.parse(paperId, parser))} />
      </div>
    );
  if (state.status === "parsing") return <Parsing startedAt={state.startedAt} />;
  if (state.status === "failed")
    return (
      <div className="sl-state">
        {flashEl}
        <p className="sl-error">解析に失敗しました。{state.error}{state.code ? `（${state.code}）` : ""}</p>
        <p className="sl-hint">GROBID が動いていないときは「簡易解析」を選んでください。</p>
        <ParseForm label="もう一度解析する" onParse={(parser) => act(() => sentencesApi.parse(paperId, parser))} />
      </div>
    );
  return <Ready key={paperId} paperId={paperId} doc={state.document} act={act} flash={flashEl} />;
}

function ParseForm({ label, onParse, initial = "auto" }: { label: string; onParse: (p: ParserChoice) => Promise<boolean>; initial?: ParserChoice }) {
  const [parser, setParser] = useState<ParserChoice>(initial);
  const [busy, setBusy] = useState(false);
  return (
    <div className="sl-row">
      <label className="visually-hidden" htmlFor="sl-parser">解析の方法</label>
      <select id="sl-parser" className="sl-input" value={parser} onChange={(e) => setParser(e.target.value as ParserChoice)}>
        {PARSERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      <button
        type="button"
        className="sl-btn primary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void onParse(parser).finally(() => setBusy(false));
        }}
      >
        {label}
      </button>
    </div>
  );
}

function Parsing({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const started = Date.parse(startedAt);
  return (
    <div className="sl-state" role="status" aria-live="polite">
      <p><Loader2 size={16} className="sl-spin" /> 文に分けています…{Number.isFinite(started) && `（${formatElapsed(now - started)}）`}</p>
      <p className="sl-hint">長い論文では 1 分ほどかかります。終わると自動で表示されます。</p>
    </div>
  );
}

// --- 解析済み ---------------------------------------------------------------

type View = "sentences" | "glossary";

function Ready({ paperId, doc, act, flash }: { paperId: string; doc: PaperDocument; act: Act; flash: React.ReactNode }) {
  const [view, setView] = useState<View>("sentences");
  const [query, setQuery] = useState("");
  const [onlyUntranslated, setOnlyUntranslated] = useState(false);
  // 枠の端をグリフに合わせる前（rectEdges の印が無い）に解析した文書への案内。閉じたらこの論文では出さない
  const [edgeHintClosed, setEdgeHintClosed] = useState(false);
  const [reparsing, setReparsing] = useState(false);
  const focus = useSentenceFocus();
  const marks = useSentenceMarksVisible();
  const rootRef = useRef<HTMLDivElement>(null);
  const pending = useRef<{ id: string; smooth: boolean } | null>(null);

  const notes = useMemo(() => notesByHash(doc), [doc]);
  const filter = useMemo(() => ({ query, onlyUntranslated }), [query, onlyUntranslated]);
  const visible = useMemo(() => filterSentences(doc, filter, notes), [doc, filter, notes]);
  const visibleNb = useMemo(() => filterNonBody(doc.structure, filter), [doc.structure, filter]);
  const rows = useMemo(() => buildRows(doc, visible, visibleNb), [doc, visible, visibleNb]);
  const prog = useMemo(() => sentenceProgress(doc), [doc]);
  const caveats = useMemo(() => qualityCaveats(doc.structure), [doc.structure]);
  const edits = (doc.annotations.sentenceEdits ?? []).filter((e) => !e.detached);
  const filtering = query.trim().length > 0 || onlyUntranslated;
  const activeId = focus.paperId === paperId ? focus.id : null;

  const select = useCallback((s: Sentence) => setSentenceFocus(paperId, s.id, s.hash, "panel"), [paperId]);

  // PDF やキーで選ばれた文のカードまでスクロールする。絞り込みで隠れていたら絞り込みを外す。
  useEffect(() => {
    if (focus.paperId !== paperId || !focus.id || focus.origin === "panel") return;
    if (!visible.some((s) => s.id === focus.id)) {
      setQuery("");
      setOnlyUntranslated(false);
    }
    setView("sentences");
    pending.current = { id: focus.id, smooth: focus.origin === "pdf" };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.nonce]);
  useEffect(() => {
    const p = pending.current;
    const root = rootRef.current;
    if (!p || !root) return;
    const el = root.querySelector<HTMLElement>(`[data-sl-card="${CSS.escape(p.id)}"]`);
    if (!el) return;
    pending.current = null;
    el.scrollIntoView({ block: p.smooth ? "center" : "nearest", behavior: p.smooth ? "smooth" : "auto" });
    // 画面外のカードは高さが見積もりなので、落ち着いてから測り直す
    const t = setTimeout(() => el.scrollIntoView({ block: "nearest" }), 450);
    return () => clearTimeout(t);
  });

  // j/k で 1 文ずつ、n で次の未訳へ。入力中は横取りしない。
  useEffect(() => {
    if (view !== "sentences") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const step = e.key === "j" ? 1 : e.key === "k" ? -1 : e.key === "n" ? "next-untranslated" : null;
      if (step === null) return;
      const list = visible.length ? visible : doc.structure.sentences;
      const target = moveTarget(doc, list, activeId, step);
      if (!target) return;
      e.preventDefault();
      setSentenceFocus(paperId, target.id, target.hash, "keyboard");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, visible, doc, activeId, paperId]);

  const pct = prog.total ? Math.round((prog.translated / prog.total) * 100) : 0;

  return (
    <div className="sl-panel" ref={rootRef}>
      <div className="sl-head">
        <div className="sl-progress" title={prog.occurrences > prog.total ? `同じ本文が ${prog.occurrences - prog.total} 回くり返されています。訳は本文ごとに 1 つ付きます。` : "訳は同じ本文ごとに 1 つ付きます"}>
          <div className="sl-bar" role="progressbar" aria-valuemin={0} aria-valuemax={prog.total} aria-valuenow={prog.translated} aria-label="訳した文">
            <span style={{ width: `${pct}%` }} />
          </div>
          <span className="sl-progress-text">
            {prog.translated} / {prog.total} 文{prog.skipped > 0 && `（訳さない ${prog.skipped}）`}
          </span>
        </div>
        <div className="sl-badges">
          <span className={`sl-badge ${doc.structure.parser === "grobid" ? "good" : "warn"}`} title={doc.structure.parserNote}>
            {doc.structure.parser === "grobid" ? "GROBID 解析" : "簡易解析"}
          </span>
          {caveats.filter((c) => c.label !== "簡易解析").map((c) => (
            <span key={c.label} className={`sl-badge ${c.level}`} title={c.detail}>{c.label}</span>
          ))}
          <span className="sl-grow" />
          <button type="button" className="sl-icon" aria-pressed={marks} title={marks ? "PDF の文の枠を隠す" : "PDF に文の枠を出す"} aria-label="PDF の文の枠" onClick={() => setSentenceMarksVisible(!marks)}>
            {marks ? <Eye size={16} /> : <EyeOff size={16} />}
          </button>
          <button type="button" className={`sl-icon${view === "glossary" ? " is-on" : ""}`} aria-pressed={view === "glossary"} title="用語集" aria-label="用語集" onClick={() => setView(view === "glossary" ? "sentences" : "glossary")}>
            <BookA size={16} />
            {doc.annotations.glossary.length > 0 && <span className="sl-count">{doc.annotations.glossary.length}</span>}
          </button>
        </div>
        {view === "sentences" && (
          <div className="sl-filter">
            <div className="sl-search">
              <Search size={14} aria-hidden="true" />
              <input type="search" placeholder="原文・訳文・メモを検索" aria-label="文を検索" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <label className="sl-check">
              <input type="checkbox" checked={onlyUntranslated} onChange={(e) => setOnlyUntranslated(e.target.checked)} />
              未訳だけ
            </label>
          </div>
        )}
      </div>

      {flash}

      {!edgeHintClosed && !doc.structure.rectEdges && (
        <p className="sl-flash sl-reparse-hint" role="note">
          <span>この論文は以前の方法で解析されています。再解析すると PDF 上の文の枠が正確になります（訳は残ります）</span>
          <button
            type="button"
            className="sl-btn"
            disabled={reparsing}
            onClick={() => {
              setReparsing(true);
              // 前と同じ方法で。GROBID が今は動いていなくても、簡易解析に落ちて枠は直る
              void act(() => sentencesApi.parse(paperId, doc.structure.parser === "grobid" ? "auto" : "fallback")).finally(() => setReparsing(false));
            }}
          >
            再解析
          </button>
          <button type="button" className="sl-icon" aria-label="閉じる" onClick={() => setEdgeHintClosed(true)}>×</button>
        </p>
      )}

      {caveats.some((c) => c.level === "danger") && (
        <div className="sl-caveat">
          {caveats.filter((c) => c.level === "danger").map((c) => <p key={c.label}><strong>{c.label}</strong>: {c.detail}</p>)}
          <p className="sl-hint">訳す前に PDF の原文と見比べてください。</p>
        </div>
      )}

      {view === "glossary" ? (
        <GlossaryView paperId={paperId} entries={doc.annotations.glossary} act={act} />
      ) : (
        <>
          {filtering && (
            <p className="sl-hint">
              一致: 本文 {visible.length} 件{visibleNb.length > 0 && ` ／ 訳さない行 ${visibleNb.length} 件`}
            </p>
          )}
          {rows.length === 0 ? (
            <p className="sl-empty">
              {filtering
                ? onlyUntranslated && !query.trim()
                  ? "未訳の文はありません。"
                  : "一致する文がありません。"
                : "この PDF からは文を取り出せませんでした。画像だけのスキャン PDF は先に OCR を通してください。"}
            </p>
          ) : (
            rows.map((r) =>
              r.kind === "heading" ? (
                <h3 key={r.key} className="sl-section">{r.title}</h3>
              ) : r.kind === "nonbody" ? (
                <NonBodyCard key={r.key} item={r.item} matched={filtering} />
              ) : (
                <SentenceCard
                  key={r.key}
                  paperId={paperId}
                  sentence={r.sentence}
                  translation={doc.annotations.translations[r.sentence.hash]}
                  skipped={Boolean(doc.annotations.skipped?.[r.sentence.hash])}
                  notes={notes.get(r.sentence.hash) ?? NO_NOTES}
                  active={activeId === r.sentence.id}
                  next={r.next}
                  mergeCount={r.mergeCount}
                  splitCount={r.splitCount}
                  repeat={r.repeat}
                  act={act}
                  onSelect={select}
                />
              ),
            )
          )}
          <p className="sl-hint sl-keys">j・k で文を移動、n で次の未訳へ。訳はダブルクリックで直せます。</p>
        </>
      )}

      {edits.length > 0 && (
        <details className="sl-fold">
          <summary>区切りの直し（{edits.length}）</summary>
          <ul className="sl-edits">
            {[...edits].reverse().map((e) => (
              <li key={e.id}>
                <span className="sl-edit-type">{e.type === "merge" ? "結合" : e.type === "split" ? "分割" : "除外"}</span>
                <span className="sl-edit-text" lang="en">{(e.sourceTexts?.[0] ?? e.hashes[0] ?? "").slice(0, 60)}</span>
                <button type="button" className="sl-btn" onClick={() => void act(() => sentencesApi.undoEdit(paperId, e.id))}>
                  <RotateCcw size={13} /> 取り消す
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <details className="sl-fold">
        <summary>解析し直す</summary>
        <p className="sl-hint">{doc.structure.parserNote}</p>
        <p className="sl-hint">訳・メモ・区切りの直しは、同じ本文の文に引き継がれます。</p>
        <ParseForm label="解析し直す" initial={doc.structure.parser} onParse={(parser) => act(() => sentencesApi.parse(paperId, parser))} />
      </details>

      <details className="sl-fold sl-help" open={prog.translated === 0 && prog.total > 0 ? true : undefined}>
        <summary>Claude に訳させる</summary>
        <p>
          訳は Claude が PaperLens の MCP サーバー経由で入れます。設定画面の手順で Claude Desktop か Claude Code に MCP サーバーをつなぎ、
          「PaperLens で開いている論文『{doc.title}』を訳して」と頼んでください。
        </p>
        <p className="sl-hint">
          Claude は <code>get_sentences</code> で未訳の文を読み、<code>set_translations</code> で訳を書き込みます。訳はこの画面に自動で届きます。
          人が直した訳は上書きされず、用語集の訳語に従います。
        </p>
      </details>
    </div>
  );
}

const NO_NOTES: never[] = [];

