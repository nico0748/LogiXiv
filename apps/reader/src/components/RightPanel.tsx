import katex from "katex";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Annotations, Equation, Highlight, Term } from "../lib/model.ts";
import { MARKER_LABEL, sortEquationsByPage } from "../lib/model.ts";
import { toBibtex } from "../lib/bibtex.ts";
import { type FmValue, fmText, parseFrontmatter, readFrontmatter } from "../lib/frontmatter.ts";
import { type FieldDef, parseFields } from "../lib/template.ts";
import { EmptyState } from "./EmptyState.tsx";
import { StatusChips } from "./StatusChips.tsx";
import { SentencePanel } from "./sentences/SentencePanel.tsx";

export type Tab = "sentences" | "translate" | "terms" | "math" | "record";

export interface Busy {
  [id: string]: "working" | { error: string } | undefined;
}

interface Props {
  tab: Tab;
  setTab: (t: Tab) => void;
  ann: Annotations;
  update: (fn: (a: Annotations) => Annotations) => void;
  activeId: string | null;
  setActive: (id: string | null) => void;
  jump: (page: number, y: number) => void;
  busy: Busy;
  aiReady: boolean;
  retry: (kind: "translate" | "term" | "tex", id: string) => void;
  note: string;
  /** ノートを外から読み直したときに変わる。記録フォームの入力途中の値を捨てるために使う。 */
  noteKey: string;
  status: string;
  onField: (id: string, value: string) => void;
  onStatus: (s: string) => void;
  onOpenSettings: () => void;
  /** 開いている論文の id。対訳タブも使う。 */
  paperId: string;
  /** frontmatter の1項目を書く（書誌情報の欄） */
  onMeta: (key: string, value: FmValue) => void;
  /** 書き込めなかった項目と、その理由 */
  metaError: Record<string, string>;
  /** 画面の下に短い知らせを出す */
  notify: (message: string) => void;
  /** 記録タブを開いたあとにフォーカスを移す記録欄（検索の当たりから開いたとき） */
  focusField?: { id: string; n: number } | null;
  onFocused?: () => void;
  /** 対訳タブを出すか。対訳は保存先のサーバーがあるときだけ使える */
  sentences?: boolean;
}

export function RightPanel(p: Props) {
  const tabs: { id: Tab; label: string; count?: number }[] = [
    ...(p.sentences === false ? [] : [{ id: "sentences" as const, label: "対訳" }]),
    { id: "translate", label: "訳", count: p.ann.highlights.length },
    { id: "terms", label: "用語", count: p.ann.terms.length },
    { id: "math", label: "数式", count: p.ann.equations.length },
    { id: "record", label: "記録" },
  ];
  return (
    <>
      <div className="tabs" role="tablist" aria-label="補足情報">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={p.tab === t.id}
            aria-controls={`panel-${t.id}`}
            className="tab"
            onClick={() => p.setTab(t.id)}
          >
            {t.label}
            {t.count ? <span className="count">{t.count}</span> : null}
          </button>
        ))}
      </div>
      <div className="panel" role="tabpanel" id={`panel-${p.tab}`} aria-labelledby={`tab-${p.tab}`}>
        {!p.aiReady && p.tab !== "record" && p.tab !== "sentences" && (
          <div className="notice" style={{ marginTop: 0, marginBottom: 12 }}>
            <p style={{ margin: "0 0 8px" }}>訳や用語の説明を自動で入れるには、Claude の API キーが必要です。キーが無くても手で入力できます。</p>
            <button className="btn tonal sm" onClick={p.onOpenSettings}>API キーを設定する</button>
          </div>
        )}
        {p.tab === "sentences" && <SentencePanel paperId={p.paperId ?? null} />}
        {p.tab === "translate" && <TranslateList {...p} />}
        {p.tab === "terms" && <TermList {...p} />}
        {p.tab === "math" && <MathList {...p} />}
        {p.tab === "record" && (
          <>
            <BiblioSection key={`b-${p.noteKey}`} note={p.note} paperId={p.paperId} onMeta={p.onMeta} metaError={p.metaError} notify={p.notify} />
            <RecordForm key={p.noteKey} note={p.note} status={p.status} onField={p.onField} onStatus={p.onStatus} focusField={p.focusField} onFocused={p.onFocused} />
          </>
        )}
      </div>
    </>
  );
}

// --- 訳 -------------------------------------------------------------------

function TranslateList(p: Props) {
  const list = [...p.ann.highlights].sort((a, b) => a.page - b.page || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0));
  const refs = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (p.activeId) refs.current.get(p.activeId)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [p.activeId]);
  if (!list.length)
    return (
      <EmptyState title="訳はまだありません">PDF の文を選択して「訳す」かマーカーの色を押すと、ここに並びます。</EmptyState>
    );
  const set = (id: string, patch: Partial<Highlight>) =>
    p.update((a) => ({ ...a, highlights: a.highlights.map((h) => (h.id === id ? { ...h, ...patch } : h)) }));
  return (
    <>
      {list.map((h) => {
        const b = p.busy[h.id];
        return (
          <div
            key={h.id}
            ref={(el) => void (el ? refs.current.set(h.id, el) : refs.current.delete(h.id))}
            className={`card${p.activeId === h.id ? " active" : ""}`}
            onFocus={() => p.setActive(h.id)}
          >
            <div className="card-head">
              <span className={`dot ${h.color}`} aria-hidden="true" />
              <button className="btn text sm" style={{ padding: 0, minHeight: 0 }} onClick={() => { p.setActive(h.id); p.jump(h.page, h.rects[0]?.y ?? 0); }}>
                p.{h.page}
              </button>
              <span>{MARKER_LABEL[h.color]}</span>
              <span className="grow" />
              <button
                className="icon-btn"
                aria-label="このマーカーを削除"
                title="削除"
                onClick={() => p.update((a) => ({ ...a, highlights: a.highlights.filter((x) => x.id !== h.id) }))}
              >
                ×
              </button>
            </div>
            <div className="orig" lang="en">{h.text}</div>
            {b === "working" ? (
              <p className="ai-label">訳しています…</p>
            ) : (
              <>
                <label className="visually-hidden" htmlFor={`tr-${h.id}`}>訳</label>
                <textarea
                  id={`tr-${h.id}`}
                  className="textarea trans"
                  placeholder="訳を入力"
                  value={h.translation}
                  onChange={(e) => set(h.id, { translation: e.target.value })}
                  rows={Math.min(8, Math.max(2, Math.ceil(h.translation.length / 26)))}
                />
              </>
            )}
            {b && b !== "working" && <p className="err-msg">{b.error}</p>}
            <label className="visually-hidden" htmlFor={`memo-${h.id}`}>メモ</label>
            <textarea
              id={`memo-${h.id}`}
              className="textarea"
              placeholder="メモ（疑問点や気づいたこと）"
              value={h.memo}
              onChange={(e) => set(h.id, { memo: e.target.value })}
              rows={2}
            />
            {p.aiReady && b !== "working" && (
              <div className="card-actions">
                <button className="btn sm text" onClick={() => p.retry("translate", h.id)}>
                  {h.translation ? "もう一度訳す" : "Claude で訳す"}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

// --- 用語 -----------------------------------------------------------------

function TermList(p: Props) {
  const [draft, setDraft] = useState("");
  const set = (id: string, patch: Partial<Term>) =>
    p.update((a) => ({ ...a, terms: a.terms.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  const add = () => {
    const term = draft.trim();
    if (!term) return;
    p.update((a) => ({
      ...a,
      terms: [
        { id: `t-${Date.now().toString(36)}`, term, reading: "", short: "", detail: "", inPaper: "", related: [], createdAt: new Date().toISOString() },
        ...a.terms,
      ],
    }));
    setDraft("");
  };
  return (
    <>
      {p.ann.terms.length ? (
        <p className="panel-note">PDF で語を選択して「用語を調べる」を押すか、下の欄に入力してください。用語は読解ノートに [[リンク]] として書き込まれ、グラフで他の論文とつながります。</p>
      ) : (
        <EmptyState title="用語はまだありません">PDF で語を選択して「用語を調べる」を押すか、下の欄に入力してください。</EmptyState>
      )}
      <div className="row" style={{ marginBottom: 12 }}>
        <label className="visually-hidden" htmlFor="term-new">用語を追加</label>
        <input id="term-new" className="input grow" placeholder="用語を入力" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && add()} />
        <button className="btn" onClick={add}>追加</button>
      </div>
      {p.ann.terms.map((t) => (
        <TermCard key={t.id} t={t} {...p} set={(patch) => set(t.id, patch)} />
      ))}
    </>
  );
}

function TermCard({ t, set, busy, update, aiReady, retry, jump }: Props & { t: Term; set: (p: Partial<Term>) => void }) {
  const [editing, setEditing] = useState(false);
  const b = busy[t.id];
  return (
    <div className="card">
      <div className="card-head">
        {t.page ? <button className="btn text sm" style={{ padding: 0, minHeight: 0 }} onClick={() => jump(t.page!, 0)}>p.{t.page}</button> : <span>手入力</span>}
        <span className="grow" />
        <button className="btn text sm" onClick={() => setEditing((v) => !v)}>{editing ? "閉じる" : "編集"}</button>
        <button className="icon-btn" aria-label="この用語を削除" title="削除" onClick={() => update((a) => ({ ...a, terms: a.terms.filter((x) => x.id !== t.id) }))}>×</button>
      </div>
      <h3 className="term-title">{t.term}</h3>
      {t.reading && <div className="term-reading">{t.reading}</div>}
      {b === "working" && <p className="ai-label">調べています…</p>}
      {b && b !== "working" && <p className="err-msg">{b.error}</p>}
      {editing ? (
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          <Labeled label="見出し語"><input className="input" value={t.term} onChange={(e) => set({ term: e.target.value })} /></Labeled>
          <Labeled label="読み"><input className="input" value={t.reading} onChange={(e) => set({ reading: e.target.value })} /></Labeled>
          <Labeled label="定義（1文）"><textarea className="textarea" rows={2} value={t.short} onChange={(e) => set({ short: e.target.value })} /></Labeled>
          <Labeled label="説明"><textarea className="textarea" rows={4} value={t.detail} onChange={(e) => set({ detail: e.target.value })} /></Labeled>
          <Labeled label="この論文での使われ方"><textarea className="textarea" rows={2} value={t.inPaper} onChange={(e) => set({ inPaper: e.target.value })} /></Labeled>
          <Labeled label="関連する用語（読点で区切る）">
            <input className="input" value={t.related.join("、")} onChange={(e) => set({ related: e.target.value.split(/[、,]\s*/).filter(Boolean) })} />
          </Labeled>
        </div>
      ) : (
        <>
          {t.short && <p className="term-short">{t.short}</p>}
          {t.detail && <p className="term-body">{t.detail}</p>}
          {t.inPaper && (<><div className="term-sec">この論文での使われ方</div><p className="term-body">{t.inPaper}</p></>)}
          {t.related.length > 0 && (<><div className="term-sec">関連する用語</div><div className="chips">{t.related.map((r) => <span key={r} className="tag">{r}</span>)}</div></>)}
          {!t.short && !t.detail && b !== "working" && <p className="ai-label">説明はまだありません。「編集」から入力できます。</p>}
        </>
      )}
      {aiReady && b !== "working" && (
        <div className="card-actions">
          <span className="ai-label" style={{ marginRight: "auto" }}>{t.short ? "Claude の説明です。原典でも確認してください。" : ""}</span>
          <button className="btn sm text" onClick={() => retry("term", t.id)}>{t.short ? "調べ直す" : "Claude で調べる"}</button>
        </div>
      )}
    </div>
  );
}

// --- 数式 -----------------------------------------------------------------

function Tex({ tex }: { tex: string }) {
  const html = useMemo(() => {
    try {
      return { ok: true, html: katex.renderToString(tex || "\\;", { displayMode: true, throwOnError: true, strict: "ignore" }) };
    } catch (e) {
      return { ok: false, html: e instanceof Error ? e.message : String(e) };
    }
  }, [tex]);
  if (!html.ok) return <div className="katex-box"><span className="err-msg">TeX を表示できません: {html.html.replace(/^KaTeX parse error: /, "")}</span></div>;
  return <div className="katex-box" dangerouslySetInnerHTML={{ __html: html.html }} />;
}

function MathList(p: Props) {
  const set = (id: string, patch: Partial<Equation>) =>
    p.update((a) => ({ ...a, equations: a.equations.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
  const add = () =>
    p.update((a) => ({
      ...a,
      equations: [
        { id: `e-${Date.now().toString(36)}`, label: `式${a.equations.length + 1}`, tex: "", explanation: "", source: "", createdAt: new Date().toISOString() },
        ...a.equations,
      ],
    }));
  return (
    <>
      {p.ann.equations.length ? (
        <p className="panel-note">PDF で数式を選択して「数式にする」を押すと、選択範囲の画像から TeX を書き起こします。TeX は手で直せます。</p>
      ) : (
        <EmptyState title="数式はまだありません">PDF で数式を選択して「数式にする」を押してください。</EmptyState>
      )}
      <div style={{ marginBottom: 12 }}><button className="btn sm" onClick={add}>数式を手で追加</button></div>
      {sortEquationsByPage(p.ann.equations).map((e) => {
        const b = p.busy[e.id];
        return (
          <div key={e.id} className="card">
            <div className="card-head">
              {e.page ? <button className="btn text sm" style={{ padding: 0, minHeight: 0 }} onClick={() => p.jump(e.page!, 0)}>p.{e.page}</button> : <span>手入力</span>}
              <span className="grow" />
              <button className="icon-btn" aria-label="この数式を削除" title="削除" onClick={() => p.update((a) => ({ ...a, equations: a.equations.filter((x) => x.id !== e.id) }))}>×</button>
            </div>
            <label className="visually-hidden" htmlFor={`lb-${e.id}`}>見出し</label>
            <input id={`lb-${e.id}`} className="input" value={e.label} onChange={(ev) => set(e.id, { label: ev.target.value })} placeholder="式(1) など" />
            {b === "working" ? <p className="ai-label">書き起こしています…</p> : <Tex tex={e.tex} />}
            {b && b !== "working" && <p className="err-msg">{b.error}</p>}
            <label className="visually-hidden" htmlFor={`tex-${e.id}`}>TeX</label>
            <textarea id={`tex-${e.id}`} className="textarea tex-input" rows={3} placeholder="\frac{a}{b}" value={e.tex} onChange={(ev) => set(e.id, { tex: ev.target.value })} spellCheck={false} />
            <label className="visually-hidden" htmlFor={`ex-${e.id}`}>説明</label>
            <textarea id={`ex-${e.id}`} className="textarea" rows={2} placeholder="記号の意味や式の役割" value={e.explanation} onChange={(ev) => set(e.id, { explanation: ev.target.value })} />
            {p.aiReady && e.source && b !== "working" && (
              <div className="card-actions"><button className="btn sm text" onClick={() => p.retry("tex", e.id)}>もう一度書き起こす</button></div>
            )}
          </div>
        );
      })}
    </>
  );
}

// --- 書誌情報 ---------------------------------------------------------------

const BIB_FIELDS: { key: string; label: string; hint?: string; multi?: boolean; numeric?: boolean }[] = [
  { key: "title", label: "題名", hint: "題名を変えても、ノート本文の見出し（# の行）は変わりません。" },
  { key: "authors", label: "著者", hint: "1 行に 1 人ずつ書きます。", multi: true },
  { key: "year", label: "年", numeric: true },
  { key: "venue", label: "掲載先", hint: "会議名・論文誌名。arXiv だけの場合は arXiv" },
  { key: "doi", label: "DOI", hint: "10. から始まる番号。URL でも構いません" },
];
const OPEN_KEY = "paperlens.ui.biblioOpen";

/** 欄の文字列を、frontmatter に書く値に直す。著者は 1 行 1 人の配列、DOI は URL の前置きを外す */
function toMeta(key: string, text: string): FmValue {
  if (key === "authors") return text.split("\n").map((x) => x.trim()).filter(Boolean);
  if (key === "doi") return text.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  return text;
}

function BiblioSection({ note, paperId, onMeta, metaError, notify }: Pick<Props, "note" | "paperId" | "onMeta" | "metaError" | "notify">) {
  const meta = useMemo(() => readFrontmatter(note), [note]);
  // 複数行の値など、PaperLens から書き換えない項目
  const opaque = useMemo(() => new Set((parseFrontmatter(note)?.entries ?? []).filter((e) => e.kind === "opaque").map((e) => e.key)), [note]);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [fallback, setFallback] = useState<string | null>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const text = (k: string) => local[k] ?? (Array.isArray(meta[k]) ? (meta[k] as string[]).join("\n") : fmText(meta[k]));
  const empty = ["authors", "year", "venue", "doi"].every((k) => !fmText(meta[k]).trim());
  const [open, setOpen] = useState(() => {
    if (empty) return true;
    try {
      return localStorage.getItem(OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (fallback !== null) fallbackRef.current?.select();
  }, [fallback]);

  const current = { ...meta, ...Object.fromEntries(Object.entries(local).map(([k, v]) => [k, toMeta(k, v)])) };
  const canCopy = !!(fmText(current.title).trim() || fmText(current.authors).trim());
  const copy = async () => {
    const bib = toBibtex(current, paperId);
    try {
      await navigator.clipboard.writeText(bib);
      setFallback(null);
      notify("BibTeX をコピーしました");
    } catch {
      // 権限が無いときや file:// で開いたときは、選択した状態で見せて手でコピーしてもらう
      setFallback(bib);
    }
  };
  const errorOf = (k: string) =>
    metaError[k] ?? (opaque.has(k) ? `frontmatter の「${k}」は複数行の値のため、PaperLens からは書き換えません。Obsidian で直してください。` : undefined);

  return (
    <details
      className="card biblio"
      open={open}
      onToggle={(e) => {
        const v = (e.currentTarget as HTMLDetailsElement).open;
        setOpen(v);
        try {
          localStorage.setItem(OPEN_KEY, v ? "1" : "0");
        } catch {
          // 覚えられなくても開閉はできる
        }
      }}
    >
      <summary>書誌情報</summary>
      <div className="biblio-body">
        {BIB_FIELDS.map((f) => {
          const err = errorOf(f.key);
          const common = {
            id: `bib-${f.key}`,
            value: text(f.key),
            readOnly: !!err,
            "aria-describedby": [f.hint ? `bibh-${f.key}` : "", err ? `bibe-${f.key}` : ""].filter(Boolean).join(" ") || undefined,
            onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
              setLocal((l) => ({ ...l, [f.key]: e.target.value }));
              onMeta(f.key, toMeta(f.key, e.target.value));
            },
          };
          return (
            <div key={f.key}>
              <label className="field-label" htmlFor={`bib-${f.key}`}>{f.label}</label>
              {f.hint && <span className="field-hint" id={`bibh-${f.key}`}>{f.hint}</span>}
              {f.multi ? (
                <textarea className="textarea" rows={Math.max(2, text(f.key).split("\n").length)} {...common} />
              ) : (
                <input className="input" inputMode={f.numeric ? "numeric" : undefined} {...common} />
              )}
              {err && <p className="err-msg" id={`bibe-${f.key}`}>{err}</p>}
            </div>
          );
        })}
        {fmText(meta.arxiv) && (
          <div className="biblio-arxiv"><span className="field-label">arXiv</span>{fmText(meta.arxiv)}</div>
        )}
        <div className="card-actions">
          {!canCopy && <span className="field-hint" style={{ margin: "0 auto 0 0" }}>題名を入れると BibTeX を作れます。</span>}
          <button className="btn text sm" disabled={!canCopy} onClick={() => void copy()}>BibTeX をコピー</button>
        </div>
        {fallback !== null && (
          <div>
            <p className="field-hint" id="bib-fallback-hint">コピーできませんでした。選択した文字を Ctrl+C（mac は ⌘C）でコピーしてください。</p>
            <textarea ref={fallbackRef} className="textarea tex-input" readOnly rows={8} value={fallback} aria-label="BibTeX" aria-describedby="bib-fallback-hint" />
          </div>
        )}
      </div>
    </details>
  );
}

// --- 記録 -----------------------------------------------------------------

function RecordForm({ note, status, onField, onStatus, focusField, onFocused }: Pick<Props, "note" | "status" | "onField" | "onStatus" | "focusField" | "onFocused">) {
  const fields = useMemo(() => parseFields(note), [note]);
  // 検索の当たりから開いたときは、その欄までスクロールしてフォーカスを移す
  const ready = fields.length > 0;
  useEffect(() => {
    if (!focusField || !ready) return;
    const el = document.getElementById(`f-${focusField.id}`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.focus({ preventScroll: true });
    onFocused?.();
  }, [focusField, ready, onFocused]);
  // 入力中の値は手元で持ち、ノートの再読み込みで入力が巻き戻らないようにする
  const [local, setLocal] = useState<Record<string, string>>({});
  const value = (f: FieldDef) => local[f.id] ?? f.value;
  const groups = useMemo(() => {
    const g: { section: string; fields: FieldDef[] }[] = [];
    for (const f of fields) {
      const last = g[g.length - 1];
      if (last && last.section === f.section) last.fields.push(f);
      else g.push({ section: f.section, fields: [f] });
    }
    return g;
  }, [fields]);
  if (!fields.length)
    return <p className="empty">この読解ノートには入力欄がありません。テンプレートに &lt;!-- field: ID | 見出し | 説明 --&gt; の形で入力欄を書いてください。</p>;
  return (
    <>
      <p className="panel-note">ここに入力した内容は、読解ノート（note.md）の対応する箇所に自動で保存されます。</p>
      <div className="field-label" id="phase-label">読解の段階</div>
      <StatusChips value={status} onChange={onStatus} labelledBy="phase-label" />
      {groups.map((g) => (
        <section key={g.section}>
          {g.section && <h3 className="record-section">{g.section}</h3>}
          {g.fields.map((f) => (
            <div className="record-field" key={f.id}>
              <label className="field-label" htmlFor={`f-${f.id}`}>{f.label}</label>
              {f.hint && <span className="field-hint" id={`fh-${f.id}`}>{f.hint}</span>}
              <textarea
                id={`f-${f.id}`}
                aria-describedby={f.hint ? `fh-${f.id}` : undefined}
                className="textarea"
                rows={Math.min(10, Math.max(2, value(f).split("\n").length + 1))}
                value={value(f)}
                onChange={(e) => {
                  setLocal((l) => ({ ...l, [f.id]: e.target.value }));
                  onField(f.id, e.target.value);
                }}
              />
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block" }}>
      <span className="field-label" style={{ fontSize: 13 }}>{label}</span>
      {children}
    </label>
  );
}
