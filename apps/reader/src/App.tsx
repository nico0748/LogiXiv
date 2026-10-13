import { ExternalLink, FileText, PanelLeft, PanelRight, Waypoints } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { GraphView } from "./components/GraphView.tsx";
import { ListModal } from "./components/ListModal";
import { PdfView, type SelectionAction, type SelectionInfo } from "./components/PdfView.tsx";
import { type Busy, RightPanel, type Tab } from "./components/RightPanel.tsx";
import { SettingsDialog, TemplateDialog } from "./components/Dialogs.tsx";
import { Welcome } from "./components/Welcome.tsx";
import { HelpModal } from "./components/shell/HelpModal.tsx";
import { LeftSidebar, type SearchHit } from "./components/shell/LeftSidebar.tsx";
import { ResizeHandle } from "./components/shell/ResizeHandle.tsx";
import { Ribbon, type RibbonItem } from "./components/shell/Ribbon.tsx";
import { SentenceStatus } from "./components/shell/SentenceStatus.tsx";
import { SettingsModal } from "./components/shell/SettingsModal.tsx";
import { StatusBar } from "./components/shell/StatusBar.tsx";
import { ThemeToggle } from "./components/shell/ThemeToggle.tsx";
import { useWorkspace } from "./components/shell/useWorkspace.ts";
import type { LeftTab } from "./components/shell/workspaceState.ts";
import {
  type AiSettings,
  describeError,
  explainTerm,
  loadAiSettings,
  saveAiSettings,
  toTex,
  translate,
} from "./lib/claude.ts";
import { type Backend, type Link, VaultBackend, connectServer } from "./lib/backend.ts";
import { type Annotations, applyOps, diffAnnotations, emptyAnnotations, newId } from "./lib/model.ts";
import { type PaperSummary, searchNotes } from "./lib/papers.ts";
import { openPdf } from "./lib/pdf.ts";
import { getFrontmatter } from "./lib/template.ts";

type SaveState = { kind: "idle" | "saving" | "saved" } | { kind: "error"; msg: string };

export function App() {
  // ローカルサーバーで動いていればその保存先を使う。単体の HTML として開いたときは、保管庫を選んでもらう
  const [backend, setBackend] = useState<Backend | null | undefined>(undefined);
  useEffect(() => {
    void connectServer().then((b) => setBackend(b));
  }, []);
  if (backend === undefined) return <div className="welcome" aria-busy="true" />;
  if (!backend) return <Welcome onOpen={(v) => setBackend(new VaultBackend(v))} />;
  return <Workspace key={backend.name} backend={backend} onClose={backend.kind === "browser" ? () => setBackend(null) : undefined} />;
}

type View = "paper" | "graph";
/** 中央の上に重ねて開く画面 */
type Overlay = "settings" | "help" | "lists" | null;

function Workspace({ backend, onClose }: { backend: Backend; onClose?: () => void }) {
  const [papers, setPapers] = useState<PaperSummary[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [view, setView] = useState<View>("paper");
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  const [ann, setAnn] = useState<Annotations>(emptyAnnotations());
  const [note, setNote] = useState("");
  const [noteKey, setNoteKey] = useState("0");
  const [tab, setTab] = useState<Tab>(backend.kind === "server" ? "sentences" : "translate");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>({});
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [ai, setAi] = useState<AiSettings>(loadAiSettings);
  const [dialog, setDialog] = useState<"settings" | "template" | null>(null);
  const [jumpTo, setJumpTo] = useState<{ page: number; y: number; n: number } | null>(null);
  /** リストから論文のページへ飛ぶとき。nonce を変えると同じページでももう一度飛ぶ */
  const [scrollToPage, setScrollToPage] = useState<{ page: number; nonce: number } | undefined>(undefined);
  const [links, setLinks] = useState<Link[]>([]);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [resizing, setResizing] = useState(false);
  const { ws, patch, ready } = useWorkspace(backend);
  const setRightOpen = (v: boolean) => patch({ rightOpen: v });
  const annRef = useRef(ann);
  /** 保存先にある（と分かっている）注釈。画面での変更は、これとの差分として保存する */
  const baseRef = useRef(ann);
  const currentRef = useRef(current);
  currentRef.current = current;
  const lastNote = useRef("");
  const timers = useRef(new Map<string, number>());
  const contexts = useRef(new Map<string, string>());

  const aiReady = !!ai.apiKey;

  // 動作確認用。URL に #debug を付けたときだけ保管庫を参照できるようにする
  useEffect(() => {
    if (location.hash === "#debug" && backend instanceof VaultBackend) (window as unknown as { __vault: unknown }).__vault = backend.vault;
  }, [backend]);
  const title = getFrontmatter(note).title || papers.find((p) => p.id === current)?.title || "";
  const status = getFrontmatter(note).status || "未読";

  const refresh = useCallback(async () => {
    const list = await backend.listPapers();
    setPapers(list);
    return list;
  }, [backend]);

  // 前回開いていた論文があればそれを、無ければ一覧の先頭を開く
  const restored = useRef(false);
  useEffect(() => {
    if (!ready) return;
    void refresh().then((list) => {
      if (restored.current) return;
      restored.current = true;
      const last = ws.openPaper && list.find((p) => p.id === ws.openPaper) ? ws.openPaper : list[0]?.id;
      if (last) setCurrent((c) => c ?? last);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, ready]);

  // 開いている論文を覚えておく
  useEffect(() => {
    if (current && restored.current && current !== ws.openPaper) patch({ openPaper: current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  // 論文を開く
  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    setPdf(null);
    setActiveId(null);
    setBusy({});
    void Promise.all([backend.loadPdf(current), backend.loadAnnotations(current), backend.loadNote(current)]).then(
      ([p, a, n]) => {
        if (cancelled) return;
        setPdf(p);
        setAnn(a);
        annRef.current = a;
        baseRef.current = a;
        setNote(n);
        lastNote.current = n;
        setNoteKey(`${current}-${Date.now()}`);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [backend, current]);

  // 別のアプリ（Obsidian など）でノートを書き換えたら読み直す
  const reloadNote = useCallback(async () => {
    const id = currentRef.current;
    if (!id) return;
    try {
      const n = await backend.loadNote(id);
      if (n !== lastNote.current && id === currentRef.current) {
        lastNote.current = n;
        setNote(n);
        setNoteKey(`${id}-${Date.now()}`);
      }
    } catch {
      // 読めないときは何もしない。次に保存するときに再度読み直す
    }
  }, [backend]);

  /** 保存先の注釈を読み直し、まだ保存していない画面の変更を上に重ねる。 */
  const reloadAnnotations = useCallback(async () => {
    const id = currentRef.current;
    if (!id) return;
    const fresh = await backend.loadAnnotations(id);
    if (id !== currentRef.current) return;
    const mine = diffAnnotations(baseRef.current, annRef.current);
    baseRef.current = fresh;
    const next = applyOps(fresh, mine);
    annRef.current = next;
    setAnn(next);
  }, [backend]);

  useEffect(() => {
    window.addEventListener("focus", reloadNote);
    return () => window.removeEventListener("focus", reloadNote);
  }, [reloadNote]);

  // MCP サーバー（AI エージェント）や Obsidian による変更を、その場で画面に映す
  useEffect(
    () =>
      backend.subscribe((e) => {
        if (e.kind === "config") return location.reload();
        if (e.kind === "papers" || e.kind === "note") void refresh();
        if (e.paper && e.paper === currentRef.current) {
          if (e.kind === "note") void reloadNote();
          if (e.kind === "annotations") void reloadAnnotations().catch(() => undefined);
        }
        if (view === "graph" && (e.kind === "annotations" || e.kind === "papers")) void backend.graph().then(setLinks);
      }),
    [backend, refresh, reloadNote, reloadAnnotations, view],
  );

  useEffect(() => {
    if (view === "graph") void backend.graph().then(setLinks);
  }, [view, backend, papers]);

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
      debounce(`ann-${id}`, async () => {
        // 保存先と画面の差分だけを送る。AI エージェントが同時に足した項目は消えない
        const sent = annRef.current;
        const ops = diffAnnotations(baseRef.current, sent);
        if (!ops.length) return;
        const r = await backend.changeAnnotations(id, ops);
        if (id !== currentRef.current) return;
        baseRef.current = r.annotations;
        const merged = applyOps(r.annotations, diffAnnotations(sent, annRef.current));
        annRef.current = merged;
        setAnn(merged);
        applyNote(r.note);
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current, backend],
  );

  const onField = (field: string, value: string) => {
    if (!current) return;
    const id = current;
    debounce(`f-${id}-${field}`, async () => applyNote(await backend.writeField(id, field, value)));
  };

  const onStatus = async (s: string) => {
    if (!current) return;
    applyNote(await backend.writeMeta(current, "status", s));
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

  const importOne = async (f: File) => {
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
    return backend.importPaper(f.name, data, t);
  };

  /** 選んだ・ドロップした PDF を順に取り込み、最後のものを開く */
  const onImport = async (files: File[]) => {
    let last: string | null = null;
    for (const f of files) {
      try {
        last = await importOne(f);
      } catch (e) {
        setSave({ kind: "error", msg: `${f.name} を取り込めませんでした: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    await refresh();
    if (!last) return;
    setView("paper");
    setCurrent(last);
    setTab("record");
  };


  const jump = (page: number, y: number) => setJumpTo({ page, y, n: Date.now() });

  const openPaper = (id: string) => {
    setView("paper");
    setCurrent(id);
    // 狭い画面では、選んだら一覧を閉じて論文を見せる
    if (window.innerWidth <= 900) patch({ leftOpen: false });
  };

  /** リストの項目から、その論文の該当ページへ飛ぶ */
  const onListJump = (paperId: string, page?: number) => {
    setOverlay(null);
    setView("paper");
    setCurrent(paperId);
    if (page) setScrollToPage({ page, nonce: Date.now() });
  };

  /** サーバーがあればその検索を、無ければ保管庫を直接探す */
  const search = useCallback(
    async (q: string): Promise<SearchHit[]> => {
      if (backend instanceof VaultBackend) return searchNotes(backend.vault, q);
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error(`検索できませんでした（${res.status}）`);
      return (await res.json()) as SearchHit[];
    },
    [backend],
  );

  const toggleLeft = (tab?: LeftTab) =>
    patch((w) => (tab && (!w.leftOpen || w.leftTab !== tab) ? { leftOpen: true, leftTab: tab } : { leftOpen: !w.leftOpen }));

  const onRibbon = (id: RibbonItem) => {
    if (id === "files" || id === "search") toggleLeft(id);
    else if (id === "graph") setView((v) => (v === "graph" ? "paper" : "graph"));
    else setOverlay((o) => (o === id ? null : id));
  };

  // キーボード操作。Cmd/Ctrl+\ で左サイドバー、Cmd/Ctrl+Shift+L でリスト、Esc で重ねた画面を閉じる
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && !e.altKey && (e.key === "\\" || e.code === "Backslash")) {
      e.preventDefault();
      toggleLeft();
    } else if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      setOverlay("lists");
    } else if (e.key === "Escape" && overlay && !document.querySelector("dialog[open]")) {
      setOverlay(null);
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const saveLabel =
    save.kind === "saving" ? "保存しています" : save.kind === "saved" ? (backend.persistent ? "フォルダに保存しました" : "保存しました（メモリ）") : save.kind === "error" ? `保存できませんでした: ${save.msg}` : "";

  const leftOpen = ws.leftOpen;
  const rightOpen = ws.rightOpen;
  const cls = ["app", leftOpen ? "show-left" : "left-closed", rightOpen ? "show-right" : "right-closed", resizing ? "is-resizing" : ""].join(" ");
  const style = { "--left-w": `${ws.leftWidth}px`, "--right-w": `${ws.rightWidth}px` } as CSSProperties;
  const tabTitle = view === "graph" ? "グラフ" : title || (current ? "読み込んでいます" : "新しいタブ");
  const highlightCount = ann.highlights.length;

  return (
    <div className={cls} style={style}>
      <Ribbon
        active={{ files: leftOpen && ws.leftTab === "files", search: leftOpen && ws.leftTab === "search", graph: view === "graph", lists: overlay === "lists", settings: overlay === "settings", help: overlay === "help" }}
        onItem={onRibbon}
      />

      <aside className="sidebar left" aria-label="左サイドバー" aria-hidden={!leftOpen} inert={!leftOpen}>
        <div className="sidebar-inner">
          <LeftSidebar
            tab={ws.leftTab}
            setTab={(t) => patch({ leftTab: t })}
            papers={papers}
            current={view === "paper" ? current : null}
            onOpenPaper={openPaper}
            onImport={(fs) => void onImport(fs)}
            search={search}
            vaultName={backend.name}
            onOpenSettings={() => setOverlay("settings")}
            onSwitchVault={onClose}
          />
        </div>
        {leftOpen && <ResizeHandle side="left" width={ws.leftWidth} onResize={(w) => patch({ leftWidth: w })} onDragging={setResizing} label="左サイドバーの幅" />}
      </aside>

      <main className="workspace" aria-label="論文">
        <div className="view-header">
          <button className={`clickable-icon${leftOpen ? " is-active" : ""}`} aria-label={leftOpen ? "左サイドバーを閉じる" : "左サイドバーを開く"} title="左サイドバー（⌘\\）" aria-expanded={leftOpen} onClick={() => toggleLeft()}>
            <PanelLeft size={16} aria-hidden="true" />
          </button>
          <div className="workspace-tab is-active" title={tabTitle}>
            {view === "graph" ? <Waypoints size={14} aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}
            <span className="workspace-tab-title">{tabTitle}</span>
          </div>
          <span className="spacer" />
          {backend.persistent && current && view === "paper" && (
            <a
              className="clickable-icon"
              aria-label="Obsidian で開く"
              title="読解ノートを Obsidian で開く"
              href={`obsidian://open?vault=${encodeURIComponent(backend.name)}&file=${encodeURIComponent(`papers/${current}/note.md`)}`}
            >
              <ExternalLink size={16} aria-hidden="true" />
            </a>
          )}
          <ThemeToggle />
          <button className={`clickable-icon${rightOpen ? " is-active" : ""}`} aria-label={rightOpen ? "右サイドバーを閉じる" : "右サイドバーを開く"} title="右サイドバー" aria-expanded={rightOpen} onClick={() => patch((w) => ({ rightOpen: !w.rightOpen }))}>
            <PanelRight size={16} aria-hidden="true" />
          </button>
        </div>
        <div
          className="view-content"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            const fs = [...e.dataTransfer.files].filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
            if (!fs.length) return;
            e.preventDefault();
            void onImport(fs);
          }}
        >
          {view === "graph" ? (
            <GraphView papers={papers} links={links} onOpen={openPaper} />
          ) : pdf ? (
            <PdfView
              data={pdf}
              highlights={ann.highlights}
              activeId={activeId}
              onAction={onAction}
              onHighlightClick={(id) => { setActiveId(id); setTab("translate"); setRightOpen(true); }}
              jumpTo={jumpTo}
              paperId={current}
              scrollToPage={scrollToPage}
            />
          ) : (
            <div className="drop-hint">
              <h2>{current ? "読み込んでいます" : "論文を開いてください"}</h2>
              {!current && (
                <>
                  <p>PDF をここにドロップするか、左の「論文一覧」から取り込んでください。</p>
                  <button className="btn primary" onClick={() => patch({ leftOpen: true, leftTab: "files" })}>論文一覧を開く</button>
                </>
              )}
            </div>
          )}
        </div>
      </main>

      <aside className="sidebar right" aria-label="右サイドバー（補足情報）" aria-hidden={!rightOpen} inert={!rightOpen}>
        {rightOpen && <ResizeHandle side="right" width={ws.rightWidth} onResize={(w) => patch({ rightWidth: w })} onDragging={setResizing} label="右サイドバーの幅" />}
        <div className="sidebar-inner">
          {current ? (
            <RightPanel
              paperId={current}
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
        </div>
      </aside>

      <StatusBar
        items={[
          { key: "save", node: saveLabel ? <span className={save.kind === "error" ? "status-err" : undefined}>{saveLabel}</span> : null },
          // 対訳は保存先のサーバーがあるときだけ使える
          { key: "sentences", node: backend.kind === "server" && view === "paper" && current ? <SentenceStatus key={current} paperId={current} /> : null },
          { key: "marks", node: view === "paper" && current ? `マーカー ${highlightCount}` : null },
          { key: "papers", node: `論文 ${papers.length}`, title: "保管庫にある論文の数" },
          { key: "vault", node: backend.name, title: backend.persistent ? "保存先" : "メモリ上の保管庫（閉じると消えます）" },
        ]}
      />

      <ListModal open={overlay === "lists"} onClose={() => setOverlay(null)} onJump={onListJump} />
      {overlay === "settings" && (
        <SettingsModal
          backend={backend}
          aiReady={aiReady}
          onOpenClaude={() => setDialog("settings")}
          onOpenTemplate={() => setDialog("template")}
          onClose={() => setOverlay(null)}
          onSwitchVault={onClose}
        />
      )}
      {overlay === "help" && <HelpModal onClose={() => setOverlay(null)} />}

      {dialog === "settings" && (
        <SettingsDialog
          value={ai}
          onClose={() => setDialog(null)}
          onSave={(s) => { setAi(s); saveAiSettings(s); setDialog(null); }}
        />
      )}
      {dialog === "template" && <TemplateDialog backend={backend} onClose={() => setDialog(null)} />}
    </div>
  );
}
