// ヘルプ。左に章の一覧と検索、右に 1 章ずつ表示する。中身は src/lib/help.ts のデータ。
// 「よくある質問」「キーボード操作」「更新情報」も同じ形のページにする。
// 狭い画面では、章の一覧を上の選択欄に替える。
import { ChevronLeft, ChevronRight, Search, Settings } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  CHANGELOG,
  CHANGES_PAGE,
  FAQ_PAGE,
  HELP_CHAPTERS,
  HELP_FAQ,
  type HelpBlock,
  KEYS_PAGE,
  isHelpPage,
  openSettingsPage,
  parseInline,
  searchHelp,
} from "../../lib/help.ts";
import { type Shortcut, filterShortcuts, shortcutsFor } from "../../lib/shortcuts.ts";
import { KeyCombo } from "../help/KeyCombo.tsx";
import { markChangesSeen, useUnreadChanges } from "../help/useHelpState.ts";
import "../help/help.css";
import { Modal } from "./Modal.tsx";

interface Props {
  onClose: () => void;
  /** 最初に開く章（無ければ「はじめに」） */
  page?: string;
  /** よくある質問の項目など、ページの中の場所 */
  anchor?: string;
  /** 画面の案内（ツアー）を始める */
  onStartTour?: () => void;
  /** サーバー版かデスクトップ版か。ブラウザ版に無い機能のキーボード操作は出さない */
  server?: boolean;
}

const SHORT_TITLE = (t: string) => t.replace(/（.*$/, "");

const EXTRA_PAGES = [
  { id: FAQ_PAGE, title: "よくある質問・困ったとき", group: "困ったとき" },
  { id: KEYS_PAGE, title: "キーボード操作", group: "困ったとき" },
  { id: CHANGES_PAGE, title: "更新情報", group: "お知らせ" },
];

export function HelpModal({ onClose, page: initial, anchor: initialAnchor, onStartTour, server = true }: Props) {
  const shortcuts = useMemo(() => shortcutsFor(server), [server]);
  const [page, setPage] = useState(initial && isHelpPage(initial) ? initial : "start");
  const [anchor, setAnchor] = useState<string | undefined>(initialAnchor);
  const [query, setQuery] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const unread = useUnreadChanges();

  const go = (id: string, a?: string) => {
    setPage(id);
    setAnchor(a);
    setQuery("");
  };

  // ページを替えたら先頭へ。場所の指定があればそこまで動かす
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (!anchor) {
      body.scrollTop = 0;
      return;
    }
    const el = document.getElementById(anchor);
    if (el instanceof HTMLDetailsElement) el.open = true;
    el?.scrollIntoView({ block: "start" });
    el?.querySelector("summary")?.focus({ preventScroll: true });
  }, [page, anchor]);

  // 更新情報を開いたら、読んだと記録する
  useEffect(() => {
    if (page === CHANGES_PAGE) markChangesSeen();
  }, [page]);

  const hits = useMemo(() => searchHelp(query), [query]);
  const keyHits = useMemo(() => (query.trim() ? filterShortcuts(shortcuts, query) : []), [query, shortcuts]);
  const searching = query.trim().length > 0;

  const chapterIndex = HELP_CHAPTERS.findIndex((c) => c.id === page);
  const pageTitle = chapterIndex >= 0 ? HELP_CHAPTERS[chapterIndex].title : EXTRA_PAGES.find((x) => x.id === page)?.title ?? "";

  const navItem = (id: string, label: string, dot = false) => (
    <button
      key={id}
      type="button"
      className={`vertical-tab-nav-item help-nav-item${!searching && page === id ? " is-active" : ""}`}
      aria-current={!searching && page === id ? "page" : undefined}
      onClick={() => go(id)}
    >
      {label}
      {dot && <span className="help-dot" aria-label="新しい更新があります" />}
    </button>
  );

  return (
    <Modal title="ヘルプ" onClose={onClose} className="mod-help help-modal">
      <div className="help">
        <nav className="help-nav" aria-label="ヘルプの章">
          <div className="help-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              className="help-search-input"
              placeholder="ヘルプを検索"
              aria-label="ヘルプを検索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // 検索語があるときの Esc は、語を消すだけにする（ヘルプは閉じない）
                if (e.key === "Escape" && query) {
                  e.stopPropagation();
                  e.nativeEvent.stopImmediatePropagation();
                  setQuery("");
                }
                if (e.key === "Enter" && hits[0]) go(hits[0].page, hits[0].anchor);
              }}
            />
          </div>
          <label className="help-select-wrap">
            <span className="visually-hidden">章を選ぶ</span>
            <select className="select help-select" value={page} onChange={(e) => go(e.target.value)}>
              {HELP_CHAPTERS.map((c) => <option key={c.id} value={c.id}>{SHORT_TITLE(c.title)}</option>)}
              {EXTRA_PAGES.map((x) => <option key={x.id} value={x.id}>{x.title}{x.id === CHANGES_PAGE && unread ? "（新着）" : ""}</option>)}
            </select>
          </label>
          <div className="help-nav-list">
            <div className="vertical-tab-header-group">
              <div className="vertical-tab-header-group-title">使い方</div>
              {HELP_CHAPTERS.map((c) => navItem(c.id, SHORT_TITLE(c.title)))}
            </div>
            {["困ったとき", "お知らせ"].map((g) => (
              <div key={g} className="vertical-tab-header-group">
                <div className="vertical-tab-header-group-title">{g}</div>
                {EXTRA_PAGES.filter((x) => x.group === g).map((x) => navItem(x.id, x.title, x.id === CHANGES_PAGE && unread))}
              </div>
            ))}
          </div>
        </nav>

        <div className="help-body" ref={bodyRef}>
          <div className="help-page">
            {searching ? (
              <SearchResults query={query} hits={hits} keyHits={keyHits} go={go} />
            ) : (
              <article aria-labelledby="help-page-title">
                <h1 id="help-page-title" className="help-title">{pageTitle}</h1>
                {chapterIndex >= 0 && <ChapterPage index={chapterIndex} go={go} onStartTour={onStartTour} />}
                {page === FAQ_PAGE && <FaqPage go={go} />}
                {page === KEYS_PAGE && <KeysPage list={shortcuts} />}
                {page === CHANGES_PAGE && <ChangesPage />}
              </article>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

type Go = (page: string, anchor?: string) => void;

/** `code`・{{キー}}・[[章|文字]] を含む 1 文 */
function Text({ s, go }: { s: string; go?: Go }) {
  return (
    <>
      {parseInline(s).map((x, i) =>
        x.t === "code" ? (
          <code key={i}>{x.v}</code>
        ) : x.t === "kbd" ? (
          <KeyCombo key={i} keys={x.v} />
        ) : x.t === "link" ? (
          <button key={i} type="button" className="help-link" onClick={() => go?.(x.to)}>{x.v}</button>
        ) : (
          <Fragment key={i}>{x.v}</Fragment>
        ),
      )}
    </>
  );
}

function Block({ b, go, onStartTour }: { b: HelpBlock; go: Go; onStartTour?: () => void }) {
  switch (b.kind) {
    case "p":
      return <p><Text s={b.text} go={go} /></p>;
    case "h":
      return <h2>{b.text}</h2>;
    case "list":
      return <ul>{b.items.map((t) => <li key={t}><Text s={t} go={go} /></li>)}</ul>;
    case "steps":
      return <ol className="help-steps">{b.items.map((t) => <li key={t}><Text s={t} go={go} /></li>)}</ol>;
    case "tip":
      return <p className="help-tip"><Text s={b.text} go={go} /></p>;
    case "settings":
      return (
        <p className="help-actions">
          <button type="button" className="btn tonal sm" onClick={() => openSettingsPage(b.page)}>
            <Settings size={14} aria-hidden="true" /> {b.label}
          </button>
        </p>
      );
    case "tour":
      return onStartTour ? (
        <p className="help-actions">
          <button type="button" className="btn primary sm" onClick={onStartTour}>{b.label}</button>
        </p>
      ) : null;
  }
}

function ChapterPage({ index, go, onStartTour }: { index: number; go: Go; onStartTour?: () => void }) {
  const c = HELP_CHAPTERS[index];
  const prev = HELP_CHAPTERS[index - 1];
  const next = HELP_CHAPTERS[index + 1];
  const faq = HELP_FAQ.filter((f) => f.chapter === c.id);
  return (
    <>
      <p className="help-lead">{c.summary}</p>
      <div className="help-prose">
        {c.blocks.map((b, i) => <Block key={i} b={b} go={go} onStartTour={onStartTour} />)}
      </div>
      {faq.length > 0 && (
        <section className="help-related" aria-labelledby="help-related-title">
          <h2 id="help-related-title">この章のよくある質問</h2>
          <ul>
            {faq.map((f) => (
              <li key={f.id}>
                <button type="button" className="help-link" onClick={() => go(FAQ_PAGE, f.id)}>{f.q}</button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="help-pager">
        {prev ? (
          <button type="button" className="help-pager-btn" onClick={() => go(prev.id)}>
            <ChevronLeft size={16} aria-hidden="true" />
            <span><small>前の章</small>{SHORT_TITLE(prev.title)}</span>
          </button>
        ) : <span />}
        {next && (
          <button type="button" className="help-pager-btn is-next" onClick={() => go(next.id)}>
            <span><small>次の章</small>{SHORT_TITLE(next.title)}</span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        )}
      </div>
    </>
  );
}

function FaqPage({ go }: { go: Go }) {
  return (
    <>
      <p className="help-lead">よく聞かれることと、うまく動かないときの直し方です。</p>
      <div className="help-faq">
        {HELP_FAQ.map((f) => (
          <details key={f.id} id={f.id} className="help-faq-item">
            <summary>{f.q}</summary>
            <div className="help-prose">
              {f.a.map((t) => <p key={t}><Text s={t} go={go} /></p>)}
              {f.chapter && (
                <p className="help-more">
                  詳しくは <button type="button" className="help-link" onClick={() => go(f.chapter!)}>{SHORT_TITLE(HELP_CHAPTERS.find((c) => c.id === f.chapter)?.title ?? "")}</button>
                </p>
              )}
            </div>
          </details>
        ))}
      </div>
    </>
  );
}

/** 画面ごとにまとめたキーボード操作の表。早見表と同じもの */
export function ShortcutTable({ list }: { list: Shortcut[] }) {
  const scopes = [...new Set(list.map((s) => s.scope))];
  return (
    <div className="help-keys">
      {scopes.map((scope) => (
        <section key={scope} className="help-keys-group" aria-label={scope}>
          <h2>{scope}</h2>
          <dl>
            {list.filter((s) => s.scope === scope).map((s) => (
              <div key={s.keys + s.action} className="help-keys-row">
                <dt><KeyCombo keys={s.keys} /></dt>
                <dd>{s.action}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

function KeysPage({ list }: { list: Shortcut[] }) {
  return (
    <>
      <p className="help-lead">
        どの画面でも <KeyCombo keys="?" /> で、この一覧の早見表を開けます（文字の入力中は除きます）。
      </p>
      <ShortcutTable list={list} />
    </>
  );
}

function ChangesPage() {
  return (
    <>
      <p className="help-lead">主な機能の追加です。新しいものから並べています。</p>
      <ol className="help-changes">
        {CHANGELOG.map((c) => (
          <li key={c.id}>
            <div className="help-change-head">
              <time>{c.date}</time>
              <h2>{c.title}</h2>
            </div>
            <ul>{c.items.map((t) => <li key={t}><Text s={t} /></li>)}</ul>
          </li>
        ))}
      </ol>
    </>
  );
}

function SearchResults({ query, hits, keyHits, go }: { query: string; hits: ReturnType<typeof searchHelp>; keyHits: Shortcut[]; go: Go }): ReactNode {
  const total = hits.length + keyHits.length;
  return (
    <section aria-labelledby="help-search-title">
      <h1 id="help-search-title" className="help-title">『{query.trim()}』の検索結果</h1>
      <p className="help-lead" role="status">{total ? `${total} 件見つかりました。` : "見つかりませんでした。語を短くするか、別の言い方で探してください。"}</p>
      {hits.length > 0 && (
        <ul className="help-hits">
          {hits.map((h) => (
            <li key={`${h.page}-${h.anchor ?? ""}`}>
              <button type="button" className="help-hit" onClick={() => go(h.page, h.anchor)}>
                <span className="help-hit-title">{h.title}</span>
                <span className="help-hit-snippet"><Marked text={h.snippet} query={query} /></span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {keyHits.length > 0 && (
        <>
          <h2 className="help-hits-sub">キーボード操作</h2>
          <ShortcutTable list={keyHits} />
        </>
      )}
      {!total && (
        <p>
          <button type="button" className="help-link" onClick={() => go(FAQ_PAGE)}>よくある質問</button> も見てください。
        </p>
      )}
    </section>
  );
}

/** 抜粋の中の検索語に印を付ける（大文字と小文字は区別しない） */
function Marked({ text, query }: { text: string; query: string }) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const low = text.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    let at = -1;
    let len = 0;
    for (const w of words) {
      const j = low.indexOf(w, i);
      if (j >= 0 && (at < 0 || j < at)) [at, len] = [j, w.length];
    }
    if (at < 0) break;
    if (at > i) parts.push(text.slice(i, at));
    parts.push(<mark key={at}>{text.slice(at, at + len)}</mark>);
    i = at + len;
  }
  parts.push(text.slice(i));
  return <>{parts}</>;
}
