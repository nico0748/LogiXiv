import { ExternalLink, FileText, PanelLeft, PanelRight, Presentation, Waypoints } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GraphView } from "./components/GraphView.tsx";
import { ListModal } from "./components/ListModal";
import { type LocateRequest, PdfView, type SelectionAction, type SelectionInfo } from "./components/PdfView.tsx";
import { type Busy, RightPanel, type Tab } from "./components/RightPanel.tsx";
import { UrlImportDialog } from "./components/Dialogs.tsx";
import { Welcome } from "./components/Welcome.tsx";
import { HelpModal } from "./components/shell/HelpModal.tsx";
import { ShortcutSheet } from "./components/help/ShortcutSheet.tsx";
import { Tour } from "./components/help/Tour.tsx";
import { useHelpHotkey, useUnreadChanges } from "./components/help/useHelpState.ts";
import { HELP_EVENT, type HelpRequest } from "./lib/help.ts";
import { LeftSidebar } from "./components/shell/LeftSidebar.tsx";
import { ResizeHandle } from "./components/shell/ResizeHandle.tsx";
import { Ribbon, type RibbonItem } from "./components/shell/Ribbon.tsx";
import { SentenceStatus } from "./components/shell/SentenceStatus.tsx";
import { SettingsModal } from "./components/shell/SettingsModal.tsx";
import { MarkupPanel } from "./components/slides/MarkupPanel.tsx";
import { type SlideFocus, SlidesView } from "./components/slides/SlidesView.tsx";
import { useSlides } from "./components/slides/useSlides.ts";
import { StatusBar } from "./components/shell/StatusBar.tsx";
import { ThemeToggle } from "./components/shell/ThemeToggle.tsx";
import { useWorkspace } from "./components/shell/useWorkspace.ts";
import type { LeftTab } from "./components/shell/workspaceState.ts";
import { describeError, explainTerm, toTex, translate } from "./lib/claude.ts";
import { getPref, usePrefSelect } from "./lib/prefs.ts";
import { OPEN_SETTINGS_EVENT, type SettingsPageId } from "./lib/settingsIndex.ts";
import { ApiError, type Backend, type Link, ServerBackend, VaultBackend, connectServer } from "./lib/backend.ts";
import { type Pos, loadPos, posKey, savePos, throttleTrailing } from "./lib/position.ts";
import { type FmValue, FrontmatterError } from "./lib/frontmatter.ts";
import { type Snack, Snackbar } from "./components/Snackbar.tsx";
import { type Annotations, applyOps, diffAnnotations, emptyAnnotations, newId, type Rect } from "./lib/model.ts";
import type { PaperSummary, SearchHit } from "./lib/papers.ts";
import { openPdf } from "./lib/pdf.ts";
import { useSentenceFocus } from "./lib/sentenceFocus.ts";
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

type View = "paper" | "graph" | "slides";
/** 中央の上に重ねて開く画面 */
type Overlay = "settings" | "help" | "lists" | "keys" | null;

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
  // 論文の上で文を選んだら、補足情報を対訳のタブにする（開いた対訳タブがそのカードまで動く）
  const sentenceFocus = useSentenceFocus();
  useEffect(() => {
    if (sentenceFocus.origin === "pdf" && sentenceFocus.id && sentenceFocus.paperId === current) setTab("sentences");
    // 選び直したとき（nonce）だけ。論文を切り替えただけでは変えない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sentenceFocus.nonce]);
  const [busy, setBusy] = useState<Busy>({});
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  // API キーがあるかだけを購読する（設定の画面で入力するたびに全体を描き直さないように）。
  // キー・モデル・文体などは、頼むときに設定（prefs.ts）から読む
  const aiReady = usePrefSelect("ai", (a) => !!a.apiKey);
  const [dialog, setDialog] = useState<"url" | null>(null);
  /** 設定を開くページと項目（「API キーを設定する」やヘルプから）。n を変えると開き直す */
  const [settingsAt, setSettingsAt] = useState<{ page?: SettingsPageId; item?: string; query?: string; n: number }>({ n: 0 });
  /** 開いている設定のページと検索の語。設定の「?」からヘルプへ行って戻ったときに、同じ所を開く */
  const settingsLast = useRef<{ page: SettingsPageId; query: string } | null>(null);
  const openSettingsAt = (page?: SettingsPageId, item?: string) => {
    setSettingsAt({ page, item, n: Date.now() });
    setOverlay("settings");
  };
  const [jumpTo, setJumpTo] = useState<{ page: number; y: number; n: number; instant?: boolean } | null>(null);
  /** 用語・数式の場所を PDF で示す指示 */
  const [locateReq, setLocateReq] = useState<LocateRequest | null>(null);
  /** PDF で場所を囲んでいる数式の id */
  const [boxFor, setBoxFor] = useState<string | null>(null);
  /** スライドの画面で、補足情報から論文の面を動かす指示（y はページ内の縦位置 0..1） */
  const [paperJump, setPaperJump] = useState<{ page: number; y: number; n: number } | null>(null);
  // 論文を替えたら、前の論文の場所の指示と囲むモードを捨てる
  useEffect(() => {
    setLocateReq(null);
    setBoxFor(null);
  }, [current]);
  /** リストから論文のページへ飛ぶとき。nonce を変えると同じページでももう一度飛ぶ */
  const [scrollToPage, setScrollToPage] = useState<{ page: number; nonce: number } | undefined>(undefined);
  const [overlay, setOverlay] = useState<Overlay>(null);
  /** ヘルプを開く章（画面の各所の「?」から）。n を変えると同じ章でも開き直す */
  const [helpAt, setHelpAt] = useState<(HelpRequest & { n: number }) | null>(null);
  /** 値を変えると、画面の案内（ツアー）を最初から始める */
  const [tourRun, setTourRun] = useState(0);
  const unreadChanges = useUnreadChanges();
  const [resizing, setResizing] = useState(false);
  const { ws, patch, ready } = useWorkspace(backend);
  const setRightOpen = (v: boolean) => patch({ rightOpen: v });
  /** 開いた論文の前回の位置（2 ページ目以降のときだけ） */
  const [initialPos, setInitialPos] = useState<Pos | null>(null);
  /** 取り込んだ直後の論文。前回の位置へは移らない */
  const skipRestore = useRef<string | null>(null);
  const [links, setLinks] = useState<Link[]>([]);
  const [metaError, setMetaError] = useState<Record<string, string>>({});
  const [snack, setSnack] = useState<Snack | null>(null);
  /** 検索の当たりから開いた記録欄。記録タブを開いたあとにフォーカスを移す */
  const [focusField, setFocusField] = useState<{ id: string; paper: string; n: number } | null>(null);
  /** 検索の当たり（マーカーと訳）。論文を読み終えてから、当たった行のマーカーを選ぶ */
  const [pendingHit, setPendingHit] = useState<SearchHit | null>(null);
  /** 読み込みを終えた論文の ID */
  const [loaded, setLoaded] = useState<string | null>(null);
  const notify = useCallback((message: string, extra: Partial<Snack> = {}) => setSnack({ message, n: Date.now(), ...extra }), []);
  const annRef = useRef(ann);
  /** 保存先にある（と分かっている）注釈。画面での変更は、これとの差分として保存する */
  const baseRef = useRef(ann);
  const currentRef = useRef(current);
  currentRef.current = current;
  const lastNote = useRef("");
  const timers = useRef(new Map<string, number>());
  const contexts = useRef(new Map<string, string>());


  // 発表スライドとの対応（中央の「スライド」画面と、右サイドバーのグループ一覧で共有する）
  const slides = useSlides(backend, current, {
    active: view === "slides",
    onNote: (md) => applyNote(md),
    onSave: (st) => setSave(st === "saving" ? { kind: "saving" } : st === "saved" ? { kind: "saved" } : { kind: "error", msg: st.error }),
  });
  const [markupActive, setMarkupActive] = useState<string | null>(null);
  const [markupHover, setMarkupHover] = useState<string | null>(null);
  const [slideFocus, setSlideFocus] = useState<SlideFocus | null>(null);
  const [isolateLines, setIsolateLines] = useState(false);
  const [slideCount, setSlideCount] = useState<number | undefined>(undefined);
  useEffect(() => {
    setMarkupActive(null);
    setMarkupHover(null);
    setSlideCount(undefined);
  }, [current]);

  // 動作確認用。URL に #debug を付けたときだけ保管庫を参照できるようにする
  useEffect(() => {
    if (location.hash === "#debug" && backend instanceof VaultBackend) (window as unknown as { __vault: unknown }).__vault = backend.vault;
  }, [backend]);
  const title = getFrontmatter(note).title || papers.find((p) => p.id === current)?.title || "";
  const status = getFrontmatter(note).status || "未読";

  // 前回の位置のキー。サーバー版は保存先のフルパスを使い、名前が同じ別の保管庫と混ざらないようにする
  const keyFor = useCallback(
    (id: string) => posKey(backend instanceof ServerBackend ? backend.meta.dataRoot : backend.name, id),
    [backend],
  );
  // 保存は 1 秒に 1 回まで。論文を切り替えるときは、待っている値をすぐに保存する
  const posSaver = useMemo(() => throttleTrailing((key: string, pos: Pos) => savePos(key, pos), 1000), []);
  useEffect(() => () => posSaver.flush(), [current, posSaver]);

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
      // 起動時の動作が「論文一覧を開く」のときは、論文を開かずに一覧を出す
      if (getPref("startup") === "list") patch({ leftOpen: true, leftTab: "files" });
      else if (last) setCurrent((c) => c ?? last);
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
    // 前の論文への移動の指示は捨てる（新しい論文では、前回の位置か先頭から表示する）
    setJumpTo(null);
    setActiveId(null);
    setBusy({});
    setMetaError({});
    void Promise.all([backend.loadPdf(current), backend.loadAnnotations(current), backend.loadNote(current)]).then(
      ([p, a, n]) => {
        if (cancelled) return;
        const pos = skipRestore.current === current ? null : loadPos(keyFor(current));
        skipRestore.current = null;
        setInitialPos(pos && pos.page >= 2 ? pos : null);
        setPdf(p);
        setAnn(a);
        annRef.current = a;
        baseRef.current = a;
        setNote(n);
        lastNote.current = n;
        setNoteKey(`${current}-${Date.now()}`);
        setLoaded(current);
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

  /** 書誌情報の欄。800ms 待ってから項目ごとに保存し、題名・年・著者は一覧も直す */
  const onMeta = (key: string, value: FmValue) => {
    if (!current) return;
    const id = current;
    debounce(
      `m-${id}-${key}`,
      async () => {
        try {
          applyNote(await backend.writeMeta(id, key, value));
          setMetaError(({ [key]: _, ...rest }) => rest);
        } catch (e) {
          // 複数行の値の項目は書き換えない。その欄を読み取り専用にして理由を出す
          if (e instanceof FrontmatterError || (e instanceof ApiError && e.status === 409)) setMetaError((m) => ({ ...m, [key]: e.message }));
          throw e;
        }
        if (key === "title" || key === "year" || key === "authors") {
          setPapers((ps) =>
            ps.map((p) =>
              p.id !== id ? p : key === "authors" ? { ...p, authors: Array.isArray(value) ? value : [value] } : { ...p, [key]: Array.isArray(value) ? value.join(", ") : value || (key === "title" ? id : "") },
            ),
          );
        }
      },
      800,
    );
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
      const t = await translate(getPref("ai"), text, { title, around: contexts.current.get(id) ?? text });
      update((a) => ({ ...a, highlights: a.highlights.map((h) => (h.id === id ? { ...h, translation: t } : h)) }));
      setBusyFor(id, undefined);
    } catch (e) {
      setBusyFor(id, { error: describeError(e) });
    }
  };

  const runTerm = async (id: string, term: string) => {
    setBusyFor(id, "working");
    try {
      const r = await explainTerm(getPref("ai"), term, { title, around: contexts.current.get(id) ?? term });
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
      const r = await toTex(getPref("ai"), source, crops.current.get(id) ?? null, { title, around: contexts.current.get(id) ?? source });
      update((a) => ({
        ...a,
        // 記号の欄は、手で書いたものがあれば上書きしない
        equations: a.equations.map((e) => (e.id === id ? { ...e, tex: r.tex, explanation: r.explanation, symbols: e.symbols?.length ? e.symbols : r.symbols } : e)),
      }));
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
      update((x) => ({ ...x, terms: [{ id, term, reading: "", short: "", detail: "", inPaper: "", related: [], page: s.page, rects: s.rects, createdAt: now }, ...x.terms] }));
      setTab("terms");
      setRightOpen(true);
      if (aiReady) void runTerm(id, term);
    } else {
      const id = newId("e");
      contexts.current.set(id, s.around);
      crops.current.set(id, s.crop());
      update((x) => ({
        ...x,
        equations: [{ id, label: `式${x.equations.length + 1}`, tex: "", explanation: "", page: s.page, rects: s.rects, source: s.text, createdAt: now }, ...x.equations],
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

  /** 設定の「取り込み時の段階」が未読以外なら、取り込んだ論文の段階をそれにする */
  const applyImportStatus = async (id: string) => {
    const s = getPref("importStatus");
    if (s) await backend.writeMeta(id, "status", s).catch(() => undefined);
  };

  /** 選んだ・ドロップした PDF を順に取り込み、最後のものを開く */
  const onImport = async (files: File[]) => {
    let last: string | null = null;
    for (const f of files) {
      try {
        last = await importOne(f);
        await applyImportStatus(last);
      } catch (e) {
        setSave({ kind: "error", msg: `${f.name} を取り込めませんでした: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    await refresh();
    if (!last) return;
    skipRestore.current = last;
    setView("paper");
    setCurrent(last);
    setTab("record");
  };

  /** URL か arXiv の番号から取り込む。新しい論文なら記録タブと書誌情報の欄を開く */
  const onImportUrl = async (url: string) => {
    if (!backend.importUrl) return;
    const r = await backend.importUrl(url);
    await refresh();
    setDialog(null);
    setView("paper");
    if (r.existing) {
      notify("この論文は既に取り込んでいます。開きました。");
    } else {
      skipRestore.current = r.id;
      await applyImportStatus(r.id);
      setTab("record");
      setRightOpen(true);
      try {
        localStorage.setItem("paperlens.ui.biblioOpen", "1");
      } catch {
        // 覚えられなくても、書誌情報の欄は開閉できる
      }
    }
    setCurrent(r.id);
  };

  // スライドの画面では PdfView が無いので、論文の面（SlidesView）へ移る指示に替える
  const jump = (page: number, y: number) => {
    if (view === "slides") setPaperJump({ page, y, n: Date.now() });
    else setJumpTo({ page, y, n: Date.now() });
  };
  const locate = (req: Omit<LocateRequest, "n">) => {
    if (view !== "slides") return setLocateReq({ ...req, n: Date.now() });
    if (!req.page) return notify("ページが分からないため、論文の画面で探してください");
    setPaperJump({ page: req.page, y: req.rects?.[0]?.y ?? 0, n: Date.now() });
  };
  /** 数式を囲むには PdfView が要る。スライドの画面では囲むモードに入らない */
  const askBox = (id: string | null) => {
    if (id !== null && view === "slides") return notify("数式を囲むのは論文の画面で行ってください");
    setBoxFor(id);
  };
  const onBox = (page: number, rect: Rect) => {
    const id = boxFor;
    setBoxFor(null);
    if (!id) return;
    update((a) => ({ ...a, equations: a.equations.map((e) => (e.id === id ? { ...e, page, rects: [rect] } : e)) }));
    setLocateReq({ page, rects: [rect], n: Date.now() });
    notify(`数式の場所を p.${page} に設定しました`);
  };

  const openPaper = (id: string) => {
    // スライドの画面では、その論文のスライドに切り替える（続けて対応づけられるように）
    setView((v) => (v === "slides" ? "slides" : "paper"));
    setCurrent(id);
    // リストから来たページへの移動は、別の開き方では使わない
    setScrollToPage(undefined);
    // 狭い画面では、選んだら一覧を閉じて論文を見せる
    if (window.innerWidth <= 900) patch({ leftOpen: false });
  };

  /** 検索の当たりを押したとき。論文を開き、当たった場所のタブへ移る */
  const onHit = (h: SearchHit) => {
    openPaper(h.paper);
    setRightOpen(true);
    if (h.region === "field" && h.field) {
      setTab("record");
      setFocusField({ id: h.field, paper: h.paper, n: Date.now() });
    } else if (h.region === "list:highlights") {
      setTab("translate");
      setPendingHit(h);
    } else if (h.region === "list:terms") setTab("terms");
    else if (h.region === "list:equations") setTab("math");
    else setTab("record");
  };

  // 当たった行の文を含むマーカーを探して選ぶ。見つからなければタブを開くだけ
  useEffect(() => {
    if (!pendingHit || loaded !== pendingHit.paper) return;
    const needle = pendingHit.text.replace(/^>\s*/, "").replace(/^(訳|メモ):\s*/, "").trim().toLowerCase();
    const h = needle && ann.highlights.find((x) => [x.text, x.translation, x.memo].some((s) => s && (s.toLowerCase().includes(needle) || needle.includes(s.toLowerCase()))));
    if (h) setActiveId(h.id);
    setPendingHit(null);
  }, [pendingHit, loaded, ann]);

  /** リストの項目から、その論文の該当ページへ飛ぶ */
  const onListJump = (paperId: string, page?: number) => {
    setOverlay(null);
    setView("paper");
    setCurrent(paperId);
    if (page) setScrollToPage({ page, nonce: Date.now() });
  };

  /** 読解ノートの検索。サーバー版はサーバーで、それ以外は保管庫を直接探す */
  const search = useCallback((q: string) => backend.search(q), [backend]);

  const toggleLeft = (tab?: LeftTab) =>
    patch((w) => (tab && (!w.leftOpen || w.leftTab !== tab) ? { leftOpen: true, leftTab: tab } : { leftOpen: !w.leftOpen }));

  const onRibbon = (id: RibbonItem) => {
    if (id === "files" || id === "search") toggleLeft(id);
    else if (id === "graph") setView((v) => (v === "graph" ? "paper" : "graph"));
    else if (id === "slides") setView((v) => (v === "slides" ? "paper" : "slides"));
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
      // 閉じた Esc を、ほかの画面（スライドの道具など）に渡さない
      e.preventDefault();
      // 設定の「?」から開いたヘルプは、閉じると設定に戻る
      setOverlay(overlay === "help" && helpReturn.current ? "settings" : null);
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  // ヘルプなど App の外から、設定を指定のページで開く（settingsIndex.ts の openSettings）
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ page?: SettingsPageId; item?: string }>).detail ?? {};
      setSettingsAt({ page: d.page, item: d.item, n: Date.now() });
      setOverlay("settings");
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, on);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, on);
  }, []);
  // 閉じたら（Esc・リボンを含む）指定のページを忘れ、次にリボンから開くときは「全般」から
  // 設定の「?」から開いたヘルプの間は覚えておく（閉じると同じページに戻る）
  useEffect(() => {
    if (overlay === "settings" || (overlay === "help" && helpReturn.current)) return;
    settingsLast.current = null;
    setSettingsAt((x) => (x.page || x.item || x.query ? { n: x.n } : x));
  }, [overlay]);

  // ? でキーボード操作の早見表。画面の各所の「?」からは、その章でヘルプを開く
  // ほかの画面（設定・ヘルプ・リスト）を開いているときは何もしない（入力途中の内容を捨てないように）
  useHelpHotkey(() => setOverlay((o) => (o === null ? "keys" : o === "keys" ? null : o)));
  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;
  /** 設定から開いたヘルプか。閉じたら設定（同じページ）に戻る */
  const helpReturn = useRef(false);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<HelpRequest>).detail;
      helpReturn.current = overlayRef.current === "settings";
      // 戻ったときに同じページと検索の語で開き直す（設定のモーダルはヘルプの間は閉じる）
      const last = settingsLast.current;
      if (helpReturn.current && last) setSettingsAt((x) => ({ n: x.n, page: last.page, query: last.query }));
      setHelpAt({ ...d, n: Date.now() });
      setOverlay("help");
    };
    window.addEventListener(HELP_EVENT, on);
    return () => window.removeEventListener(HELP_EVENT, on);
  }, []);
  // ヘルプを閉じたら章の指定を捨てる（リボンから開くときは「はじめに」から）
  useEffect(() => {
    if (overlay === "help") return;
    setHelpAt(null);
    helpReturn.current = false;
  }, [overlay]);

  const saveLabel =
    save.kind === "saving" ? "保存しています" : save.kind === "saved" ? (backend.persistent ? "フォルダに保存しました" : "保存しました（メモリ）") : save.kind === "error" ? `保存できませんでした: ${save.msg}` : "";

  const leftOpen = ws.leftOpen;
  const rightOpen = ws.rightOpen;
  const cls = ["app", leftOpen ? "show-left" : "left-closed", rightOpen ? "show-right" : "right-closed", resizing ? "is-resizing" : ""].join(" ");
  const style = { "--left-w": `${ws.leftWidth}px`, "--right-w": `${ws.rightWidth}px` } as CSSProperties;
  // スライドの画面に移ったら、論文の画面で始めた囲むモードは捨てる
  useEffect(() => {
    if (view === "slides") setBoxFor(null);
  }, [view]);

  // 右サイドバー（論文の画面）とスライドの画面の補足情報の面で同じものを使う。同時には 1 つしか出さない
  const rightPanel = current ? (
    <RightPanel
      paperId={current}
      tab={tab}
      setTab={setTab}
      ann={ann}
      update={update}
      activeId={activeId}
      setActive={setActiveId}
      jump={jump}
      locate={locate}
      boxFor={boxFor}
      setBoxFor={askBox}
      busy={busy}
      aiReady={aiReady}
      retry={retry}
      note={note}
      noteKey={noteKey}
      status={status}
      onField={onField}
      onStatus={(s) => void onStatus(s)}
      onOpenSettings={() => openSettingsAt("ai", "api-key")}
      onMeta={onMeta}
      metaError={metaError}
      notify={notify}
      focusField={focusField && focusField.paper === loaded ? focusField : null}
      onFocused={() => setFocusField(null)}
      sentences={backend.kind === "server"}
    />
  ) : null;

  const tabTitle = view === "graph" ? "グラフ" : view === "slides" ? `スライドと論文: ${title || current || ""}` : title || (current ? "読み込んでいます" : "新しいタブ");
  const highlightCount = ann.highlights.length;

  return (
    <div className={cls} style={style}>
      <Ribbon
        active={{ files: leftOpen && ws.leftTab === "files", search: leftOpen && ws.leftTab === "search", graph: view === "graph", slides: view === "slides", lists: overlay === "lists", settings: overlay === "settings", help: overlay === "help" }}
        onItem={onRibbon}
        badges={unreadChanges ? { help: "新しい更新情報があります" } : undefined}
      />

      <aside className="sidebar left" aria-label="左サイドバー" aria-hidden={!leftOpen} inert={!leftOpen}>
        <div className="sidebar-inner">
          <LeftSidebar
            backend={backend}
            tab={ws.leftTab}
            setTab={(t) => patch({ leftTab: t })}
            papers={papers}
            current={view === "paper" ? current : null}
            onOpenPaper={openPaper}
            onImport={(fs) => void onImport(fs)}
            onImportUrl={backend.importUrl ? () => setDialog("url") : undefined}
            onHit={onHit}
            search={search}
            vaultName={backend.name}
            onOpenSettings={() => setOverlay("settings")}
            onSwitchVault={onClose}
            notify={notify}
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
            {view === "graph" ? <Waypoints size={14} aria-hidden="true" /> : view === "slides" ? <Presentation size={14} aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}
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
          ) : view === "slides" && current ? (
            <SlidesView
              slides={slides}
              paperId={current}
              paperPdf={pdf}
              active={markupActive}
              setActive={setMarkupActive}
              hover={markupHover}
              setHover={setMarkupHover}
              focus={slideFocus}
              notify={notify}
              isolate={isolateLines}
              setIsolate={setIsolateLines}
              info={rightPanel}
              paperJump={paperJump}
              canPresent={backend.kind === "server"}
              onSlideCount={(n) => {
                setSlideCount(n);
                const lost = slides.state.kind === "ready" ? slides.state.deck.markups.filter((m) => m.page > n) : [];
                if (lost.length) notify(`スライドは ${n} ページです。それより後ろのページのグループが ${lost.length} 個あります（右の一覧に印を付けました）`);
              }}
            />
          ) : pdf ? (
            <PdfView
              data={pdf}
              highlights={ann.highlights}
              activeId={activeId}
              onAction={onAction}
              onHighlightClick={(id) => { setActiveId(id); setTab("translate"); setRightOpen(true); }}
              jumpTo={jumpTo}
              // 対訳（文の枠）はサーバー版だけ。1 ファイル版で渡すと /api/events への接続を試みてしまう
              paperId={backend.kind === "server" ? current : null}
              scrollToPage={scrollToPage}
              initialPos={initialPos}
              onRestored={(page) =>
                notify(`前回の位置（p.${page}）から表示しています`, {
                  ms: 6000,
                  action: { label: "先頭に戻る", onClick: () => setJumpTo({ page: 1, y: 0, n: Date.now(), instant: true }) },
                })
              }
              onPosition={(pos) => current && posSaver.call(keyFor(current), pos)}
              locate={locateReq}
              onLocateMiss={(r) => notify(r.page ? `p.${r.page} の本文に見つかりませんでした。ページだけ表示しています` : "本文に見つかりませんでした")}
              boxing={boxFor !== null}
              onBox={onBox}
              onBoxCancel={() => setBoxFor(null)}
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
          {current && view === "slides" ? (
            <MarkupPanel
              slides={slides}
              active={markupActive}
              setActive={setMarkupActive}
              setHover={setMarkupHover}
              reveal={(f) => setSlideFocus({ ...f, nonce: Date.now() })}
              slideCount={slideCount}
            />
          ) : current ? (
            rightPanel
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
          {
            key: "markups",
            node:
              view === "slides" && slides.state.kind === "ready"
                ? `グループ ${slides.state.deck.markups.length}・リンク ${slides.state.deck.markups.reduce((n, m) => n + m.links.length, 0)}`
                : null,
          },
          { key: "papers", node: `論文 ${papers.length}`, title: "保管庫にある論文の数" },
          { key: "vault", node: backend.name, title: backend.persistent ? "保存先" : "メモリ上の保管庫（閉じると消えます）" },
        ]}
      />

      <ListModal open={overlay === "lists"} onClose={() => setOverlay(null)} onJump={onListJump} />
      {overlay === "settings" && (
        <SettingsModal
          backend={backend}
          key={settingsAt.n}
          initialPage={settingsAt.page}
          initialItem={settingsAt.item}
          initialQuery={settingsAt.query}
          onState={(st) => { settingsLast.current = st; }}
          onClose={() => setOverlay(null)}
          onSwitchVault={onClose}
        />
      )}
      {overlay === "help" && (
        <HelpModal
          key={helpAt?.n}
          page={helpAt?.page}
          anchor={helpAt?.anchor}
          onClose={() => setOverlay(helpReturn.current ? "settings" : null)}
          onStartTour={() => { setOverlay(null); setTourRun((n) => n + 1); }}
          server={backend.kind === "server"}
        />
      )}
      {overlay === "keys" && <ShortcutSheet server={backend.kind === "server"} onClose={() => setOverlay(null)} onOpenHelp={() => { setHelpAt({ page: "keys", n: Date.now() }); setOverlay("help"); }} />}
      <Tour
        mode={backend instanceof ServerBackend ? (backend.meta.desktop ? "desktop" : "server") : "browser"}
        ready={ready && overlay === null && dialog === null}
        restart={tourRun}
        hasPapers={papers.length > 0}
        onImport={onImport}
        layout={{ left: ws.leftOpen, right: ws.rightOpen }}
        setLayout={(l) => patch({ ...(l.left !== undefined && { leftOpen: l.left }), ...(l.left && !ws.leftOpen && { leftTab: "files" as const }), ...(l.right !== undefined && { rightOpen: l.right }) })}
      />

      {dialog === "url" && <UrlImportDialog onClose={() => setDialog(null)} onImport={onImportUrl} />}
      <Snackbar snack={snack} onClose={() => setSnack(null)} />
    </div>
  );
}
