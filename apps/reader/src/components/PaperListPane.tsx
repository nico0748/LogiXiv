import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type Backend, ServerBackend, serverApi } from "../lib/backend.ts";
import { toBibFile } from "../lib/bibtex.ts";
import { readFrontmatter } from "../lib/frontmatter.ts";
import { SORT_KEYS, SORT_LABEL, type SortKey, isSortKey, sortPapers } from "../lib/paperSort.ts";
import type { PaperSummary, SearchHit } from "../lib/papers.ts";
import { parseFields } from "../lib/template.ts";
import { StatusChips } from "./StatusChips.tsx";

// 左サイドバーの論文一覧。検索欄と段階の絞り込み、ノートの中の当たりを出す。
//
// - 検索の語は 300ms 待ってから使う。題名・著者・年で一覧を絞り、2 文字以上ならノートの中も探す
// - 段階の絞り込みは localStorage に覚える。検索の語は覚えない（開き直したときに一覧が理由なく短くならないように）
// - 開いている論文は、絞り込みに当てはまらなくても一覧の先頭に残す
// - 行のタグを押すと、そのタグ（#tag）で絞り込む。検索の語が # で始まるときはタグだけを見る
// - 並び順は localStorage に覚える。「BibTeX を書き出す」は、絞り込んだ一覧をその並び順で 1 つの .bib にする

const FILTER_KEY = "paperlens.ui.statusFilter";
const SORT_KEY = "paperlens.ui.paperSort";
const HIT_LIMIT = 50;

const REGION_LABEL: Record<string, string> = {
  "list:highlights": "マーカーと訳",
  "list:terms": "用語",
  "list:equations": "数式",
  body: "ノート本文（記録欄の外）",
};

const fold = (s: string) => s.normalize("NFKC").toLowerCase();

interface Props {
  backend: Backend;
  papers: PaperSummary[];
  current: string | null;
  /** 論文の表示中か（グラフ・設定の表示中は、選択中の行を強調しない） */
  showing: boolean;
  onOpen: (id: string) => void;
  onHit: (hit: SearchHit) => void;
  /** 「PDF を追加」（論文が無いときに出す） */
  onAdd: () => void;
  /** 書き出しの結果を知らせる */
  notify?: (text: string) => void;
}

export function PaperListPane({ backend, papers, current, showing, onOpen, onHit, onAdd, notify }: Props) {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(() => {
    try {
      return localStorage.getItem(FILTER_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [sort, setSort] = useState<SortKey>(() => {
    try {
      const v = localStorage.getItem(SORT_KEY);
      return isSortKey(v) ? v : "created";
    } catch {
      return "created";
    }
  });
  const [exporting, setExporting] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  /** 記録欄の外（body）の当たりを押したときの知らせ */
  const [bodyHit, setBodyHit] = useState<SearchHit | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setQuery(draft.trim()), 300);
    return () => window.clearTimeout(t);
  }, [draft]);

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_KEY, status);
    } catch {
      // 覚えられなくても絞り込みは効く
    }
  }, [status]);

  useEffect(() => {
    try {
      localStorage.setItem(SORT_KEY, sort);
    } catch {
      // 覚えられなくても並べ替えは効く
    }
  }, [sort]);

  // 記録欄の見出しは、テンプレートから引く
  useEffect(() => {
    void backend.readTemplate().then(
      (t) => setLabels(Object.fromEntries(parseFields(t).map((f) => [f.id, f.label]))),
      () => undefined,
    );
  }, [backend]);

  useEffect(() => {
    setBodyHit(null);
    if (query.length < 2 || query.startsWith("#")) return setHits(null);
    let cancelled = false;
    void backend.search(query).then(
      (h) => !cancelled && setHits(h),
      () => !cancelled && setHits([]),
    );
    return () => {
      cancelled = true;
    };
  }, [backend, query, papers]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of papers) c[p.status] = (c[p.status] ?? 0) + 1;
    return c;
  }, [papers]);
  // 件数が 0 になった段階で絞り込んでいたら、絞り込みを外す
  const activeStatus = status && counts[status] ? status : "";

  const matches = (p: PaperSummary) => {
    if (activeStatus && p.status !== activeStatus) return false;
    if (!query) return true;
    const q = fold(query);
    // #ml のように # で始まる語は、タグだけで絞り込む
    if (q.startsWith("#")) return p.tags.some((t) => fold(t) === q.slice(1));
    return [p.title, p.authors.join(" "), p.year, ...p.tags].some((s) => fold(s).includes(q));
  };
  const filtered = useMemo(() => sortPapers(papers, sort), [papers, sort]).filter(matches);
  const outside = current && !filtered.some((p) => p.id === current) ? papers.find((p) => p.id === current) : undefined;
  const shown = outside ? [outside, ...filtered] : filtered;
  const noteHits = (hits ?? []).filter((h) => h.region !== "frontmatter");
  const titleOf = (id: string) => papers.find((p) => p.id === id)?.title ?? id;
  const filtering = !!activeStatus || !!query;

  const band = [query ? `『${query}』で絞り込み中` : "", activeStatus ? `${activeStatus}のみ表示` : ""].filter(Boolean).join("・");
  const exportBib = async () => {
    setExporting(true);
    try {
      const notes = await Promise.all(filtered.map(async (p) => ({ id: p.id, fm: readFrontmatter(await backend.loadNote(p.id)) })));
      const url = URL.createObjectURL(new Blob([toBibFile(notes)], { type: "application/x-bibtex" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = filtering ? "paperlens-selected.bib" : "paperlens.bib";
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify?.(`${notes.length} 件の BibTeX を書き出しました`);
    } catch (e) {
      notify?.(`BibTeX を書き出せませんでした: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
    }
  };

  const clear = () => {
    setDraft("");
    setQuery("");
    setStatus("");
  };

  return (
    <>
      <div className="list-tools">
        <div className="search-box">
          <label className="visually-hidden" htmlFor="paper-search">論文とノートを検索</label>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z M15.5 15.5L20 20" /></svg>
          <input id="paper-search" className="input" type="search" placeholder="題名・著者・ノートを検索" value={draft} onChange={(e) => setDraft(e.target.value)} />
          {draft && (
            <button className="icon-btn" aria-label="検索を消す" onClick={() => { setDraft(""); setQuery(""); }}>×</button>
          )}
        </div>
        {papers.length > 0 && (
          <WrapLimit>
            <StatusChips value={activeStatus} onChange={setStatus} counts={counts} allLabel="すべて" label="段階で絞り込む" className="status-filter" />
          </WrapLimit>
        )}
      </div>
      {filtering && (
        <div className="filter-band">
          <span>{band}（{filtered.length} / {papers.length} 件）</span>
          <button className="btn text sm" onClick={clear}>すべて表示</button>
        </div>
      )}
      {bodyHit && (
        <div className="notice body-hit">
          <p>この箇所は記録欄の外にあります。note.md を直接開いて確かめてください。</p>
          {backend instanceof ServerBackend && backend.meta.desktop && (
            <button className="btn text sm" onClick={() => void serverApi.reveal(`papers/${bodyHit.paper}/note.md`).catch(() => undefined)}>フォルダで表示</button>
          )}
        </div>
      )}
      <div className="sidebar-scroll">
        <div className="nav-header-title list-head">
          <span>論文 <span className="nav-count">{papers.length}</span></span>
          {papers.length > 1 && (
            <>
              <label className="visually-hidden" htmlFor="paper-sort">並び順</label>
              <select id="paper-sort" className="sort-select" value={sort} onChange={(e) => isSortKey(e.target.value) && setSort(e.target.value)}>
                {SORT_KEYS.map((k) => <option key={k} value={k}>{SORT_LABEL[k]}</option>)}
              </select>
            </>
          )}
        </div>
        {papers.length === 0 ? (
          <div className="empty">
            <p>論文はまだありません。PDF をここにドロップするか、取り込んでください。取り込むと、テンプレートから読解ノートを作ります。</p>
            <button className="btn sm primary" onClick={onAdd}>PDF を追加</button>
          </div>
        ) : (
          <ul className="nav-files">
            {shown.map((p) => (
              <li key={p.id}>
                <button className={`nav-file-title${showing && p.id === current ? " is-active" : ""}`} aria-current={showing && p.id === current} onClick={() => onOpen(p.id)}>
                  <span className="nav-file-title-content">{p.title}</span>
                  <span className="nav-file-meta">
                    <span className={`tag st-${p.status}`}>{p.status}</span>
                    {p.year && <span>{p.year}</span>}
                    {p === outside && <span className="tag out-of-filter">絞り込み外</span>}
                  </span>
                </button>
                {p.tags.length > 0 && (
                  <span className="nav-file-tags">
                    {p.tags.map((t) => (
                      <button
                        key={t}
                        type="button"
                        className={`paper-tag${fold(query) === `#${fold(t)}` ? " is-active" : ""}`}
                        aria-label={`タグ ${t} で絞り込む`}
                        onClick={() => { setDraft(`#${t}`); setQuery(`#${t}`); }}
                      >#{t}</button>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {filtered.length > 0 && (
          <button className="btn text sm bib-export" disabled={exporting} onClick={() => void exportBib()}>
            {exporting ? "書き出しています…" : filtering ? `表示中の ${filtered.length} 件の BibTeX を書き出す` : "すべての BibTeX を書き出す"}
          </button>
        )}
        {hits && noteHits.length > 0 && (
          <section className="hit-list" aria-labelledby="hit-head">
            <h2 id="hit-head" className="pane-sub">ノートの中で見つかった箇所（{noteHits.length} 件）</h2>
            <ul>
              {noteHits.map((h) => (
                <li key={`${h.paper}-${h.line}`}>
                  <button
                    className="hit-item"
                    onClick={() => {
                      onHit(h);
                      setBodyHit(h.region === "body" ? h : null);
                    }}
                  >
                    <span className="hit-title">{titleOf(h.paper)}</span>
                    <span className="hit-region">{h.region === "field" ? labels[h.field ?? ""] ?? "記録" : REGION_LABEL[h.region]}</span>
                    <span className="hit-text">{h.text.replace(/^>\s*/, "")}</span>
                  </button>
                </li>
              ))}
            </ul>
            {hits.length >= HIT_LIMIT && <p className="empty">{HIT_LIMIT} 件まで表示しています。語を増やして絞り込んでください。</p>}
          </section>
        )}
        {query && papers.length > 0 && filtered.length === 0 && (query.length < 2 || (hits && noteHits.length === 0)) && (
          <p className="empty">『{query}』に当たる論文とノートはありません。</p>
        )}
      </div>
    </>
  );
}

/** チップを最大 2 行で折り返す。2 行に入らないときは 1 行にして横にスクロールさせる。 */
function WrapLimit({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      const group = el.firstElementChild as HTMLElement | null;
      const chip = group?.firstElementChild as HTMLElement | null;
      if (!group || !chip) return;
      // 折り返したときの行数で判断する
      el.classList.remove("scrolling");
      const rows = Math.round(group.scrollHeight / (chip.offsetHeight + 6));
      el.classList.toggle("scrolling", rows > 2);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  });
  return <div ref={ref} className="wrap-limit">{children}</div>;
}
