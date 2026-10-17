// 左サイドバー。論文一覧（PDF の取り込み・ドロップ）と、読解ノートの検索を切り替えて表示する。
import { ArrowLeftRight, FilePlus, Files, Search, Settings } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Backend } from "../../lib/backend.ts";
import type { PaperSummary, SearchHit } from "../../lib/papers.ts";
import { PaperListPane } from "../PaperListPane.tsx";
import type { LeftTab } from "./workspaceState.ts";

interface Props {
  backend: Backend;
  tab: LeftTab;
  setTab: (t: LeftTab) => void;
  papers: PaperSummary[];
  current: string | null;
  onOpenPaper: (id: string) => void;
  onImport: (files: File[]) => void;
  /** URL から取り込むダイアログを開く。サーバー版だけ */
  onImportUrl?: () => void;
  /** 検索の当たりを押したとき。当たった場所のタブへ移る */
  onHit: (hit: SearchHit) => void;
  search: (q: string) => Promise<SearchHit[]>;
  vaultName: string;
  onOpenSettings: () => void;
  onSwitchVault?: () => void;
  notify?: (text: string) => void;
}

export function LeftSidebar(p: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const pdfs = (list: FileList | null) => [...(list ?? [])].filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));

  return (
    <div
      className={`sidebar-content${dragOver ? " is-drop-target" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const fs = pdfs(e.dataTransfer.files);
        if (fs.length) p.onImport(fs);
      }}
    >
      <div className="sidebar-tab-header" role="tablist" aria-label="左サイドバーの表示">
        <SideTab id="files" label="論文一覧" active={p.tab} onClick={p.setTab}><Files size={16} aria-hidden="true" /></SideTab>
        <SideTab id="search" label="検索" active={p.tab} onClick={p.setTab}><Search size={16} aria-hidden="true" /></SideTab>
        <span className="spacer" />
        {p.onImportUrl ? (
          <AddMenu onFile={() => fileRef.current?.click()} onUrl={p.onImportUrl} />
        ) : (
          <button className="clickable-icon" aria-label="PDF を追加" title="PDF を追加" onClick={() => fileRef.current?.click()}>
            <FilePlus size={16} aria-hidden="true" />
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          onChange={(e) => {
            const fs = pdfs(e.target.files);
            e.target.value = "";
            if (fs.length) p.onImport(fs);
          }}
        />
      </div>

      {p.tab === "files" ? (
        <PaperListPane backend={p.backend} papers={p.papers} current={p.current} showing={p.current !== null} onOpen={p.onOpenPaper} onHit={p.onHit} onAdd={() => fileRef.current?.click()} notify={p.notify} />
      ) : (
        <SearchView {...p} />
      )}

      <div className="sidebar-vault">
        <span className="sidebar-vault-name" title={p.vaultName}>{p.vaultName}</span>
        {p.onSwitchVault && (
          <button className="clickable-icon" aria-label="別の保管庫を開く" title="別の保管庫を開く" onClick={p.onSwitchVault}>
            <ArrowLeftRight size={16} aria-hidden="true" />
          </button>
        )}
        <button className="clickable-icon" aria-label="設定" title="設定" onClick={p.onOpenSettings}>
          <Settings size={16} aria-hidden="true" />
        </button>
      </div>
      {dragOver && <div className="drop-overlay" aria-hidden="true">PDF をここに置くと取り込みます</div>}
    </div>
  );
}

function SideTab({ id, label, active, onClick, children }: { id: LeftTab; label: string; active: LeftTab; onClick: (t: LeftTab) => void; children: ReactNode }) {
  return (
    <button
      role="tab"
      aria-selected={active === id}
      aria-label={label}
      title={label}
      className={`clickable-icon side-tab${active === id ? " is-active" : ""}`}
      onClick={() => onClick(id)}
    >
      {children}
    </button>
  );
}

function SearchView({ papers, onOpenPaper, onHit, search }: Props) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [err, setErr] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const needle = q.trim();
    if (!needle) {
      setHits(null);
      setErr("");
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      search(needle).then(
        (h) => {
          if (cancelled) return;
          setHits(h);
          setErr("");
        },
        (e: unknown) => !cancelled && setErr(e instanceof Error ? e.message : String(e)),
      );
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q, search]);

  const needle = q.trim().toLowerCase();
  const titleHits = needle ? papers.filter((x) => x.title.toLowerCase().includes(needle)) : [];
  const byPaper = new Map<string, SearchHit[]>();
  for (const h of hits ?? []) byPaper.set(h.paper, [...(byPaper.get(h.paper) ?? []), h]);
  const titleOf = (id: string) => papers.find((x) => x.id === id)?.title ?? id;

  return (
    <div className="sidebar-scroll">
      <div className="search-input-container">
        <Search size={14} aria-hidden="true" />
        <input ref={inputRef} type="search" className="search-input" placeholder="ノートを検索…" aria-label="読解ノートを検索" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {err && <p className="err-msg" role="alert">{err}</p>}
      {titleHits.length > 0 && (
        <div className="search-group">
          <div className="nav-header-title">題名</div>
          {titleHits.map((x) => (
            <button key={x.id} className="search-result-file" onClick={() => onOpenPaper(x.id)}>{x.title}</button>
          ))}
        </div>
      )}
      {hits && (
        <div className="search-group">
          <div className="nav-header-title">ノート <span className="nav-count">{hits.length}</span></div>
          {hits.length === 0 && <p className="empty">一致する行はありません。</p>}
          {[...byPaper].map(([paper, hs]) => (
            <div key={paper} className="search-result">
              <button className="search-result-file" onClick={() => onOpenPaper(paper)}>{titleOf(paper)}</button>
              {hs.map((h) => (
                <button key={h.line} className="search-result-match" onClick={() => onHit(h)}>
                  <Highlight text={h.text} needle={needle} />
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      {!needle && <p className="empty">論文の題名と、読解ノート（note.md）の本文を探します。</p>}
    </div>
  );
}

function Highlight({ text, needle }: { text: string; needle: string }) {
  const i = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + needle.length)}</mark>
      {text.slice(i + needle.length)}
    </>
  );
}

/** 「追加」のボタンとメニュー（PDF ファイル、URL）。URL から取り込めるサーバー版だけで使う */
function AddMenu({ onFile, onUrl }: { onFile: () => void; onUrl: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    (box.current?.querySelector('[role="menuitem"]') as HTMLElement | null)?.focus();
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div className="add-menu" ref={box}>
      <button ref={button} className="clickable-icon" aria-label="論文を追加" title="論文を追加" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <FilePlus size={16} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="menu-surface add-menu-list"
          role="menu"
          aria-label="論文を追加"
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
            const i = items.indexOf(document.activeElement as HTMLElement);
            items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
          }}
        >
          <button role="menuitem" className="menu-item" onClick={pick(onFile)}>PDF ファイルを選ぶ</button>
          <button role="menuitem" className="menu-item" onClick={pick(onUrl)}>URL から追加</button>
        </div>
      )}
    </div>
  );
}
