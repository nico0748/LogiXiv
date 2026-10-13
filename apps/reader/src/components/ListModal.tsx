// 「リスト」: 保管庫のすべての論文から集めた単語帳と数式帳。Obsidian の設定画面と同じ、左にナビ・右に中身の大きなモーダル。
// 一覧は /api/lists から自分で読み、開いている間は /api/events の通知で読み直す。

import katex from "katex";
import "katex/dist/katex.min.css";
import { BookA, Copy, ExternalLink, RefreshCw, Search, Sigma, X } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type FormulaItem,
  type ListsResponse,
  type SortMode,
  type VocabItem,
  type VocabRow,
  countByPaper,
  filterFormulas,
  filterVocab,
  mergeVocab,
  sectionsByPaper,
  sortFormulas,
  sortVocabRows,
} from "../lib/lists.ts";
import "./list-modal.css";

type Tab = "vocab" | "formulas";

export interface ListModalProps {
  open: boolean;
  onClose: () => void;
  onJump: (paperId: string, page?: number) => void;
  initialTab?: Tab;
}

/** この種類の通知が来たら一覧が古くなっている。 */
const STALE_KINDS = new Set(["annotations", "sentences", "papers", "note"]);

type Group<T> = { key: string; title?: string; rows: T[] };

export function ListModal(props: ListModalProps) {
  if (!props.open) return null;
  return <ListModalBody {...props} />;
}

function ListModalBody({ onClose, onJump, initialTab = "vocab" }: ListModalProps) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState("");
  const [paper, setPaper] = useState<string | null>(null);
  const [sort, setSort] = useState<SortMode>("paper");
  const [data, setData] = useState<ListsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/lists");
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setData((await res.json()) as ListsResponse);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // 開いたら読み込み、通知が来たら読み直す（続けて届いた通知はまとめる）
  useEffect(() => {
    void load();
    if (typeof EventSource === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const es = new EventSource("/api/events");
    es.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data as string) as { kind?: string };
        if (!e.kind || !STALE_KINDS.has(e.kind)) return;
      } catch {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 200);
    };
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [load]);

  // 開いたら検索欄へ、閉じたら元の場所へフォーカスを戻す
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    searchRef.current?.focus();
    return () => prev?.focus?.();
  }, []);

  const vocabHits = useMemo(() => filterVocab(data?.vocab ?? [], query), [data, query]);
  const formulaHits = useMemo(() => filterFormulas(data?.formulas ?? [], query), [data, query]);
  const papers = useMemo(
    () => countByPaper(tab === "vocab" ? vocabHits : formulaHits),
    [tab, vocabHits, formulaHits],
  );
  // 絞り込み中の論文が検索で消えたら、すべての論文に戻す
  const paperId = paper && papers.some((p) => p.paperId === paper) ? paper : null;

  const vocabGroups = useMemo<Group<VocabRow>[]>(() => {
    const items = paperId ? vocabHits.filter((v) => v.paperId === paperId) : vocabHits;
    if (sort === "alpha") return [{ key: "all", rows: sortVocabRows(mergeVocab(items)) }];
    return sectionsByPaper(items, (v) => v.term).map((s) => ({
      key: s.key,
      title: paperId ? undefined : s.title,
      rows: mergeVocab(s.items).map((r) => ({ ...r, key: `${s.paperId}:${r.key}` })),
    }));
  }, [vocabHits, paperId, sort]);

  const formulaGroups = useMemo<Group<FormulaItem>[]>(() => {
    const items = paperId ? formulaHits.filter((f) => f.paperId === paperId) : formulaHits;
    if (sort === "alpha") return [{ key: "all", rows: sortFormulas(items) }];
    return sectionsByPaper(items, (f) => f.label).map((s) => ({ key: s.key, title: paperId ? undefined : s.title, rows: s.items }));
  }, [formulaHits, paperId, sort]);

  // 上下キーで動かす選択は、表示順に並べた行の位置で持つ
  const flat = useMemo(
    () =>
      tab === "vocab"
        ? vocabGroups.flatMap((g) => g.rows.map((r) => ({ key: r.key, target: r.entries[0] })))
        : formulaGroups.flatMap((g) => g.rows.map((r) => ({ key: r.key, target: r }))),
    [tab, vocabGroups, formulaGroups],
  );
  const selIndex = Math.min(sel, Math.max(0, flat.length - 1));
  const selKey = flat[selIndex]?.key;

  useEffect(() => setSel(0), [tab, query, paperId, sort]);
  useEffect(() => {
    if (!selKey) return;
    listRef.current?.querySelector(`[data-key="${CSS.escape(selKey)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selKey]);

  const jump = useCallback(
    (paperId: string, page?: number) => {
      onJump(paperId, page);
      onClose();
    },
    [onJump, onClose],
  );

  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!flat.length) return;
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      setSel((selIndex + d + flat.length) % flat.length);
    } else if (e.key === "Enter" && !mod) {
      // ボタンや詳細の開閉は、それ自身の Enter に任せる
      const t = e.target as HTMLElement;
      if (t.closest("button, summary, a")) return;
      const target = flat[selIndex]?.target;
      if (!target) return;
      e.preventDefault();
      jump(target.paperId, target.page);
    } else if (e.key === "Tab") {
      trapFocus(e, modalRef.current);
    }
  };

  const total = tab === "vocab" ? vocabHits.length : formulaHits.length;
  const shown = flat.length;
  const paperTitle = papers.find((p) => p.paperId === paperId)?.title;

  return (
    <div className="lm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={modalRef}
        className="lm-modal"
        role="dialog"
        aria-modal="true"
        aria-label="リスト"
        onKeyDown={onKeyDown}
      >
        <button type="button" className="lm-close lm-icon-btn" onClick={onClose} aria-label="閉じる" title="閉じる（Esc）">
          <X size={16} />
        </button>

        <nav className="lm-nav" aria-label="リストの種類">
          <div className="lm-search">
            <Search size={14} aria-hidden />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="用語・数式を検索…"
              aria-label="リストを検索"
              spellCheck={false}
            />
          </div>
          <div className="lm-nav-scroll">
            <div className="lm-nav-group">
              <div className="lm-nav-title">リスト</div>
              <NavItem active={tab === "vocab"} onClick={() => setTab("vocab")} icon={<BookA size={16} />} label="単語帳" count={vocabHits.length} />
              <NavItem active={tab === "formulas"} onClick={() => setTab("formulas")} icon={<Sigma size={16} />} label="数式帳" count={formulaHits.length} />
            </div>
            {papers.length > 0 && (
              <div className="lm-nav-group">
                <div className="lm-nav-title">論文</div>
                <NavItem active={!paperId} onClick={() => setPaper(null)} label="すべての論文" count={total} />
                {papers.map((p) => (
                  <NavItem key={p.paperId} active={paperId === p.paperId} onClick={() => setPaper(p.paperId)} label={p.title} count={p.count} />
                ))}
              </div>
            )}
          </div>
        </nav>

        <section className="lm-content" aria-label={tab === "vocab" ? "単語帳" : "数式帳"}>
          <header className="lm-header">
            <div className="lm-heading">
              <h2>{tab === "vocab" ? "単語帳" : "数式帳"}</h2>
              <div className="lm-sub">
                {paperTitle ? `${paperTitle} · ` : "すべての論文 · "}
                {tab === "vocab" ? `${shown} 語` : `${shown} 式`}
                {query.trim() && `（「${query.trim()}」で絞り込み）`}
              </div>
            </div>
            <div className="lm-header-actions">
              <div className="lm-segment" role="group" aria-label="並べ方">
                <button type="button" aria-pressed={sort === "paper"} onClick={() => setSort("paper")}>論文ごと</button>
                <button type="button" aria-pressed={sort === "alpha"} onClick={() => setSort("alpha")}>
                  {tab === "vocab" ? "五十音・ABC順" : "名前順"}
                </button>
              </div>
              <button type="button" className="lm-icon-btn" onClick={() => void load()} aria-label="読み直す" title="読み直す">
                <RefreshCw size={16} />
              </button>
            </div>
          </header>

          <div className="lm-items" ref={listRef} role="listbox" aria-label="項目" aria-activedescendant={selKey ? domId(selKey) : undefined}>
            {error && !data ? (
              <Empty title="一覧を読み込めませんでした">
                {error}
                <br />
                ローカルサーバーで開いているときだけ使えます。
                <div><button type="button" className="lm-btn" onClick={() => void load()}>もう一度読み込む</button></div>
              </Empty>
            ) : !data ? (
              <Empty title="読み込み中…" />
            ) : shown === 0 ? (
              query.trim() || paperId ? (
                <Empty title="一致する項目はありません">
                  {query.trim() ? `「${query.trim()}」を含む${tab === "vocab" ? "用語" : "数式"}は見つかりませんでした。` : ""}
                </Empty>
              ) : tab === "vocab" ? (
                <Empty title="まだ用語がありません">
                  PDF の上で語句を選び、出てきたメニューの「用語を調べる」を押すと、ここに集まります。
                  <br />
                  対訳の用語集に登録した語も、論文をまたいでここに並びます。
                </Empty>
              ) : (
                <Empty title="まだ数式がありません">
                  PDF の上で数式の部分を選び、出てきたメニューの「数式にする」を押すと、ここに集まります。
                </Empty>
              )
            ) : tab === "vocab" ? (
              vocabGroups.map((g) => (
                <div key={g.key} className="lm-group">
                  {g.title && <div className="lm-group-title">{g.title}</div>}
                  {g.rows.map((r) => (
                    <VocabRowView key={r.key} row={r} selected={r.key === selKey} onSelect={() => setSel(flat.findIndex((x) => x.key === r.key))} onJump={jump} showPaper={sort === "alpha" && !paperId} />
                  ))}
                </div>
              ))
            ) : (
              formulaGroups.map((g) => (
                <div key={g.key} className="lm-group">
                  {g.title && <div className="lm-group-title">{g.title}</div>}
                  {g.rows.map((f) => (
                    <FormulaRowView key={f.key} item={f} showPaper={sort === "alpha" && !paperId} selected={f.key === selKey} onSelect={() => setSel(flat.findIndex((x) => x.key === f.key))} onJump={jump} />
                  ))}
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

const domId = (key: string) => `lm-row-${key.replace(/[^\w-]/g, "_")}`;

function NavItem({ active, onClick, icon, label, count }: { active: boolean; onClick: () => void; icon?: ReactNode; label: string; count: number }) {
  return (
    <button type="button" className={`lm-nav-item${active ? " is-active" : ""}`} aria-current={active ? "page" : undefined} onClick={onClick} title={label}>
      {icon && <span className="lm-nav-icon">{icon}</span>}
      <span className="lm-nav-label">{label}</span>
      <span className="lm-nav-count">{count}</span>
    </button>
  );
}

function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="lm-empty">
      <div className="lm-empty-title">{title}</div>
      {children && <div className="lm-empty-body">{children}</div>}
    </div>
  );
}

function PaperChip({ item, onJump, showTitle = true }: { item: { paperId: string; paperTitle: string; page?: number }; onJump: (id: string, page?: number) => void; showTitle?: boolean }) {
  const label = [showTitle ? item.paperTitle : "", item.page ? `p.${item.page}` : ""].filter(Boolean).join(" · ") || "論文を開く";
  return (
    <button
      type="button"
      className="lm-chip"
      onClick={(e) => {
        e.stopPropagation();
        onJump(item.paperId, item.page);
      }}
      title={`${item.paperTitle}${item.page ? ` の p.${item.page}` : ""} を開く`}
    >
      <ExternalLink size={12} aria-hidden />
      <span>{label}</span>
    </button>
  );
}

function VocabRowView({ row, selected, onSelect, onJump, showPaper }: { row: VocabRow; selected: boolean; onSelect: () => void; onJump: (id: string, page?: number) => void; showPaper: boolean }) {
  // 論文ごとの表示では見出しに論文名があるので、チップはページだけにする
  return (
    <div id={domId(row.key)} data-key={row.key} role="option" aria-selected={selected} className={`lm-item${selected ? " is-selected" : ""}`} onMouseDown={onSelect}>
      <div className="lm-term-head">
        <span className="lm-term">{row.term}</span>
        {row.reading && <span className="lm-reading">{row.reading}</span>}
        {row.entries.length > 1 && <span className="lm-badge">{new Set(row.entries.map((e) => e.paperId)).size} 本の論文</span>}
      </div>
      {row.entries.map((e) => (
        <VocabEntry key={e.key} entry={e} onJump={onJump} showPaper={showPaper} />
      ))}
    </div>
  );
}

function VocabEntry({ entry, onJump, showPaper }: { entry: VocabItem; onJump: (id: string, page?: number) => void; showPaper: boolean }) {
  return (
    <div className="lm-entry">
      <div className="lm-meaning">
        {entry.meaning || <span className="lm-faint">（意味はまだありません）</span>}
        {entry.source === "glossary" && <span className="lm-badge">対訳の用語集</span>}
      </div>
      {entry.detail && (
        <details className="lm-detail">
          <summary>詳しく</summary>
          <div className="lm-detail-body">{entry.detail}</div>
        </details>
      )}
      <div className="lm-meta">
        <PaperChip item={entry} onJump={onJump} showTitle={showPaper} />
      </div>
    </div>
  );
}

function FormulaRowView({ item, selected, onSelect, onJump, showPaper }: { item: FormulaItem; showPaper: boolean; selected: boolean; onSelect: () => void; onJump: (id: string, page?: number) => void }) {
  const [copied, setCopied] = useState(false);
  const html = useMemo(() => {
    try {
      return katex.renderToString(item.tex || "\\;", { displayMode: true, throwOnError: true, strict: "ignore" });
    } catch {
      return null;
    }
  }, [item.tex]);
  const copy = async (e: MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(item.tex);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // クリップボードが使えない環境では何もしない
    }
  };
  return (
    <div id={domId(item.key)} data-key={item.key} role="option" aria-selected={selected} className={`lm-item${selected ? " is-selected" : ""}`} onMouseDown={onSelect}>
      <div className="lm-term-head">
        <span className="lm-label">{item.label || "数式"}</span>
        <span className="lm-spacer" />
        <button type="button" className="lm-icon-btn" onClick={copy} aria-label="TeX をコピー" title={copied ? "コピーしました" : "TeX をコピー"}>
          <Copy size={16} />
          {copied && <span className="lm-copied">コピーしました</span>}
        </button>
      </div>
      {html ? (
        <div className="lm-katex" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="lm-tex">{item.tex}</pre>
      )}
      {item.explanation && <div className="lm-explanation">{item.explanation}</div>}
      <div className="lm-meta">
        <PaperChip item={item} onJump={onJump} showTitle={showPaper} />
      </div>
    </div>
  );
}

/** Tab でモーダルの外へ出ないように、端で反対側へ回す。 */
function trapFocus(e: KeyboardEvent, root: HTMLElement | null) {
  if (!root) return;
  const items = [...root.querySelectorAll<HTMLElement>("button, input, summary, [href], [tabindex]:not([tabindex='-1'])")].filter(
    (el) => !el.hasAttribute("disabled") && el.offsetParent !== null,
  );
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
