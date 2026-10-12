import { useCallback, useEffect, useRef, useState } from "react";
import { GraphView } from "./components/GraphView.tsx";
import { PdfView, type SelectionAction, type SelectionInfo } from "./components/PdfView.tsx";
import { type Busy, RightPanel, type Tab } from "./components/RightPanel.tsx";
import { SettingsDialog, TemplateDialog } from "./components/Dialogs.tsx";
import { Welcome } from "./components/Welcome.tsx";
import {
  type AiSettings,
  describeError,
  explainTerm,
  loadAiSettings,
  saveAiSettings,
  toTex,
  translate,
} from "./lib/claude.ts";
import { type Annotations, emptyAnnotations, newId } from "./lib/model.ts";
import {
  type PaperSummary,
  collectGraph,
  ensureLayout,
  importPaper,
  listPapers,
  loadAnnotations,
  loadNote,
  loadPdf,
  saveAnnotations,
  writeField,
  writeStatus,
} from "./lib/papers.ts";
import { openPdf } from "./lib/pdf.ts";
import { getFrontmatter } from "./lib/template.ts";
import type { Vault } from "./lib/vault.ts";

type SaveState = { kind: "idle" | "saving" | "saved" } | { kind: "error"; msg: string };

export function App() {
  const [vault, setVault] = useState<Vault | null>(null);
  if (!vault) return <Welcome onOpen={setVault} />;
  return <Workspace vault={vault} onClose={() => setVault(null)} />;
}

function Workspace({ vault, onClose }: { vault: Vault; onClose: () => void }) {
  const [papers, setPapers] = useState<PaperSummary[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [view, setView] = useState<"paper" | "graph">("paper");
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  const [ann, setAnn] = useState<Annotations>(emptyAnnotations());
  const [note, setNote] = useState("");
  const [noteKey, setNoteKey] = useState("0");
  const [tab, setTab] = useState<Tab>("translate");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>({});
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [ai, setAi] = useState<AiSettings>(loadAiSettings);
  const [dialog, setDialog] = useState<"settings" | "template" | null>(null);
  const [jumpTo, setJumpTo] = useState<{ page: number; y: number; n: number } | null>(null);
  const [links, setLinks] = useState<{ paper: string; term: string }[]>([]);
  const wide = typeof window === "undefined" || window.innerWidth > 900;
  const [leftOpen, setLeftOpen] = useState(wide);
  const [rightOpen, setRightOpen] = useState(wide);
  const fileRef = useRef<HTMLInputElement>(null);
  const annRef = useRef(ann);
  const lastNote = useRef("");
  const timers = useRef(new Map<string, number>());
  const contexts = useRef(new Map<string, string>());

  const aiReady = !!ai.apiKey;

  // 動作確認用。URL に #debug を付けたときだけ保管庫を参照できるようにする
  useEffect(() => {
    if (location.hash === "#debug") (window as unknown as { __vault: Vault }).__vault = vault;
  }, [vault]);
  const title = getFrontmatter(note).title || papers.find((p) => p.id === current)?.title || "";
  const status = getFrontmatter(note).status || "未読";

  const refresh = useCallback(async () => {
    await ensureLayout(vault);
    const list = await listPapers(vault);
    setPapers(list);
    return list;
  }, [vault]);

  useEffect(() => {
    void refresh().then((list) => list[0] && setCurrent((c) => c ?? list[0].id));
  }, [refresh]);

  // 論文を開く
  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    setPdf(null);
    setActiveId(null);
    setBusy({});
    void Promise.all([loadPdf(vault, current), loadAnnotations(vault, current), loadNote(vault, current)]).then(
      ([p, a, n]) => {
        if (cancelled) return;
        setPdf(p);
        setAnn(a);
        annRef.current = a;
        setNote(n);
        lastNote.current = n;
        setNoteKey(`${current}-${Date.now()}`);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [vault, current]);

  // 別のアプリ（Obsidian など）でノートを書き換えたら読み直す
  useEffect(() => {
    if (!current) return;
    const onFocus = async () => {
      try {
        const n = await loadNote(vault, current);
        if (n !== lastNote.current) {
          lastNote.current = n;
          setNote(n);
          setNoteKey(`${current}-${Date.now()}`);
        }
      } catch {
        // 読めないときは何もしない。次に保存するときに再度読み直す
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [vault, current]);

  useEffect(() => {
    if (view === "graph") void collectGraph(vault, papers).then(setLinks);
  }, [view, vault, papers]);

  const debounce = (key: string, fn: () => Promise<void>, ms = 500) => {
    const t = timers.current.get(key);
    if (t) window.clearTimeout(t);
    setSave({ kind: "saving" });
    timers.current.set(
      key,
      window.setTimeout(() => {
        timers.current.delete(key);
        fn().then(
          () => setSave({ kind: "saved" }),
          (e: unknown) => setSave({ kind: "error", msg: e instanceof Error ? e.message : String(e) }),
        );
      }, ms),
    );
  };

  const applyNote = (md: string) => {
    lastNote.current = md;
    setNote(md);
  };

  const update = useCallback(
    (fn: (a: Annotations) => Annotations) => {
      if (!current) return;
      const id = current;
      const next = fn(annRef.current);
      annRef.current = next;
      setAnn(next);
      debounce(`ann-${id}`, async () => applyNote(await saveAnnotations(vault, id, annRef.current)));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current, vault],
  );

  const onField = (field: string, value: string) => {
    if (!current) return;
    const id = current;
    debounce(`f-${id}-${field}`, async () => applyNote(await writeField(vault, id, field, value)));
  };

  const onStatus = async (s: string) => {
    if (!current) return;
    applyNote(await writeStatus(vault, current, s));
    setPapers((ps) => ps.map((p) => (p.id === current ? { ...p, status: s } : p)));
  };

  const setBusyFor = (id: string, v: Busy[string]) => setBusy((b) => ({ ...b, [id]: v }));

  const runTranslate = async (id: string, text: string) => {
    setBusyFor(id, "working");
    try {
      const t = await translate(ai, text, { title, around: contexts.current.get(id) ?? text });
      update((a) => ({ ...a, highlights: a.highlights.map((h) => (h.id === id ? { ...h, translation: t } : h)) }));
      setBusyFor(id, undefined);
    } catch (e) {
      setBusyFor(id, { error: describeError(e) });
    }
  };

  const runTerm = async (id: string, term: string) => {
    setBusyFor(id, "working");
    try {
      const r = await explainTerm(ai, term, { title, around: contexts.current.get(id) ?? term });
      update((a) => ({ ...a, terms: a.terms.map((t) => (t.id === id ? { ...t, ...r, id, page: t.page, createdAt: t.createdAt } : t)) }));
      setBusyFor(id, undefined);
    } catch (e) {
      setBusyFor(id, { error: describeError(e) });
    }
  };

  const crops = useRef(new Map<string, string | null>());
  const runTex = async (id: string, source: string) => {
    setBusyFor(id, "working");
    try {
      const r = await toTex(ai, source, crops.current.get(id) ?? null, { title, around: contexts.current.get(id) ?? source });
      update((a) => ({ ...a, equations: a.equations.map((e) => (e.id === id ? { ...e, tex: r.tex, explanation: r.explanation } : e)) }));
      setBusyFor(id, undefined);
    } catch (e) {
      setBusyFor(id, { error: describeError(e) });
    }
  };

  const onAction = (a: SelectionAction, s: SelectionInfo) => {
    const now = new Date().toISOString();
    if (a.kind === "mark" || a.kind === "translate") {
      const id = newId("h");
      contexts.current.set(id, s.around);
      update((x) => ({
        ...x,
        highlights: [...x.highlights, { id, page: s.page, rects: s.rects, text: s.text, color: a.kind === "mark" ? a.color : "yellow", translation: "", memo: "", createdAt: now }],
      }));
      setTab("translate");
      setActiveId(id);
      setRightOpen(true);
      if (a.kind === "translate" && aiReady) void runTranslate(id, s.text);
    } else if (a.kind === "term") {
      const id = newId("t");
      const term = s.text.slice(0, 80);
      contexts.current.set(id, s.around);
      update((x) => ({ ...x, terms: [{ id, term, reading: "", short: "", detail: "", inPaper: "", related: [], page: s.page, createdAt: now }, ...x.terms] }));
      setTab("terms");
      setRightOpen(true);
      if (aiReady) void runTerm(id, term);
    } else {
      const id = newId("e");
      contexts.current.set(id, s.around);
      crops.current.set(id, s.crop());
      update((x) => ({
        ...x,
        equations: [{ id, label: `式${x.equations.length + 1}`, tex: "", explanation: "", page: s.page, source: s.text, createdAt: now }, ...x.equations],
      }));
      setTab("math");
      setRightOpen(true);
      if (aiReady) void runTex(id, s.text);
    }
  };

  const retry = (kind: "translate" | "term" | "tex", id: string) => {
    const a = annRef.current;
    if (kind === "translate") {
      const h = a.highlights.find((x) => x.id === id);
      if (h) void runTranslate(id, h.text);
    } else if (kind === "term") {
      const t = a.terms.find((x) => x.id === id);
      if (t) void runTerm(id, t.term);
    } else {
      const e = a.equations.find((x) => x.id === id);
      if (e) void runTex(id, e.source);
    }
  };

  const onImport = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    const data = await f.arrayBuffer();
    let t = f.name.replace(/\.pdf$/i, "");
    try {
      const doc = await openPdf(data).promise;
      const meta = await doc.getMetadata();
      const metaTitle = (meta.info as { Title?: string } | undefined)?.Title?.trim();
      if (metaTitle && metaTitle.length > 3) t = metaTitle;
      void doc.destroy();
    } catch {
      // 題名が取れなくてもファイル名で取り込む
    }
    const id = await importPaper(vault, f.name, data, t);
    await refresh();
    setView("paper");
    setCurrent(id);
    setTab("record");
    if (fileRef.current) fileRef.current.value = "";
  };

  const jump = (page: number, y: number) => setJumpTo({ page, y, n: Date.now() });

  const saveLabel =
    save.kind === "saving" ? "保存しています" : save.kind === "saved" ? (vault.persistent ? "フォルダに保存しました" : "保存しました（メモリ）") : save.kind === "error" ? `保存できませんでした: ${save.msg}` : "";

  const cls = ["app", leftOpen ? "show-left" : "left-closed", rightOpen ? "show-right" : "right-closed"].join(" ");

  return (
    <div className={cls}>
      <header className="topbar">
        <button className="icon-btn" aria-label={leftOpen ? "論文一覧を閉じる" : "論文一覧を開く"} aria-expanded={leftOpen} onClick={() => setLeftOpen((v) => !v)}>☰</button>
        <div className="brand"><span className="brand-mark" aria-hidden="true">PL</span>PaperLens</div>
        <span className="crumb">{vault.name}{view === "paper" && title ? ` / ${title}` : view === "graph" ? " / グラフ" : ""}</span>
        <span className="spacer" />
        <span className={`save-state${save.kind === "error" ? " err" : ""}`} role="status">{saveLabel}</span>
        {vault.persistent && current && view === "paper" && (
          <a className="btn text sm" href={`obsidian://open?vault=${encodeURIComponent(vault.name)}&file=${encodeURIComponent(`papers/${current}/note.md`)}`}>Obsidian で開く</a>
        )}
        <ThemeToggle />
        <button className="icon-btn" aria-label={rightOpen ? "補足情報を閉じる" : "補足情報を開く"} aria-expanded={rightOpen} onClick={() => setRightOpen((v) => !v)}>▤</button>
      </header>

      <nav className="left" aria-label="論文一覧">
        <div className="pane-head">
          <span style={{ flex: 1 }}>論文</span>
          <button className="btn sm primary" onClick={() => fileRef.current?.click()}>PDF を追加</button>
          <input ref={fileRef} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => void onImport(e.target.files)} />
        </div>
        {papers.length === 0 ? (
          <p className="empty">論文はまだありません。「PDF を追加」から取り込んでください。取り込むと、テンプレートから読解ノートを作ります。</p>
        ) : (
          <ul className="paper-list">
            {papers.map((p) => (
              <li key={p.id}>
                <button className="paper-item" aria-current={view === "paper" && p.id === current} onClick={() => { setView("paper"); setCurrent(p.id); }}>
                  <span className="paper-title">{p.title}</span>
                  <span className="paper-meta"><span className={`tag st-${p.status}`}>{p.status}</span>{p.year && <span>{p.year}</span>}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="left-foot">
          <button className="btn text sm" aria-pressed={view === "graph"} onClick={() => setView((v) => (v === "graph" ? "paper" : "graph"))}>
            {view === "graph" ? "論文の表示に戻る" : "グラフで見る"}
          </button>
          <button className="btn text sm" onClick={() => setDialog("template")}>テンプレートを編集</button>
          <button className="btn text sm" onClick={() => setDialog("settings")}>Claude の設定</button>
          <button className="btn text sm" onClick={onClose}>別の保管庫を開く</button>
        </div>
      </nav>

      <main className="center" aria-label="論文">
        {view === "graph" ? (
          <GraphView papers={papers} links={links} onOpen={(id) => { setCurrent(id); setView("paper"); }} />
        ) : pdf ? (
          <PdfView data={pdf} highlights={ann.highlights} activeId={activeId} onAction={onAction} onHighlightClick={(id) => { setActiveId(id); setTab("translate"); setRightOpen(true); }} jumpTo={jumpTo} />
        ) : (
          <div className="drop-hint">
            <h2>{current ? "読み込んでいます" : "論文を開いてください"}</h2>
            {!current && <p>左の一覧から論文を選ぶか、「PDF を追加」から取り込んでください。</p>}
          </div>
        )}
      </main>

      <aside className="right" aria-label="補足情報">
        {current ? (
          <RightPanel
            tab={tab}
            setTab={setTab}
            ann={ann}
            update={update}
            activeId={activeId}
            setActive={setActiveId}
            jump={jump}
            busy={busy}
            aiReady={aiReady}
            retry={retry}
            note={note}
            noteKey={noteKey}
            status={status}
            onField={onField}
            onStatus={(s) => void onStatus(s)}
            onOpenSettings={() => setDialog("settings")}
          />
        ) : (
          <p className="empty">論文を開くと、訳・用語・数式・記録が表示されます。</p>
        )}
      </aside>

      {dialog === "settings" && (
        <SettingsDialog
          value={ai}
          onClose={() => setDialog(null)}
          onSave={(s) => { setAi(s); saveAiSettings(s); setDialog(null); }}
        />
      )}
      {dialog === "template" && <TemplateDialog vault={vault} onClose={() => setDialog(null)} />}
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<string>(() => {
    try {
      return localStorage.getItem("paperlens.theme") ?? "auto";
    } catch {
      return "auto";
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("paperlens.theme", theme);
    } catch {
      // 保存できなくても表示は切り替わる
    }
  }, [theme]);
  const next = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
  const label = { auto: "表示: 端末に合わせる", light: "表示: 明るい", dark: "表示: 暗い" }[theme];
  return (
    <button className="btn text sm" onClick={() => setTheme(next)} title="表示の明るさを切り替える">
      {label}
    </button>
  );
}
