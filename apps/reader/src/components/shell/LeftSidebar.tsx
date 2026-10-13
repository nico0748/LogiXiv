// 左サイドバー。論文一覧（PDF の取り込み・ドロップ）と、読解ノートの検索を切り替えて表示する。
import { ArrowLeftRight, FilePlus, Files, Search, Settings } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { PaperSummary } from "../../lib/papers.ts";
import type { LeftTab } from "./workspaceState.ts";

export interface SearchHit {
  paper: string;
  line: number;
  text: string;
}

interface Props {
  tab: LeftTab;
  setTab: (t: LeftTab) => void;
  papers: PaperSummary[];
  current: string | null;
  onOpenPaper: (id: string) => void;
  onImport: (files: File[]) => void;
  search: (q: string) => Promise<SearchHit[]>;
  vaultName: string;
  onOpenSettings: () => void;
  onSwitchVault?: () => void;
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
        <button className="clickable-icon" aria-label="PDF を追加" title="PDF を追加" onClick={() => fileRef.current?.click()}>
          <FilePlus size={16} aria-hidden="true" />
        </button>
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

      {p.tab === "files" ? <FileList {...p} onAdd={() => fileRef.current?.click()} /> : <SearchView {...p} />}

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

function FileList({ papers, current, onOpenPaper, onAdd }: Props & { onAdd: () => void }) {
  return (
    <div className="sidebar-scroll">
      <div className="nav-header-title">論文 <span className="nav-count">{papers.length}</span></div>
      {papers.length === 0 ? (
        <div className="empty">
          <p>論文はまだありません。PDF をここにドロップするか、取り込んでください。取り込むと、テンプレートから読解ノートを作ります。</p>
          <button className="btn sm primary" onClick={onAdd}>PDF を追加</button>
        </div>
      ) : (
        <ul className="nav-files">
          {papers.map((x) => (
            <li key={x.id}>
              <button className={`nav-file-title${x.id === current ? " is-active" : ""}`} aria-current={x.id === current} onClick={() => onOpenPaper(x.id)}>
                <span className="nav-file-title-content">{x.title}</span>
                <span className="nav-file-meta">
                  <span className={`tag st-${x.status}`}>{x.status}</span>
                  {x.year && <span>{x.year}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SearchView({ papers, onOpenPaper, search }: Props) {
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
                <button key={h.line} className="search-result-match" onClick={() => onOpenPaper(paper)}>
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
