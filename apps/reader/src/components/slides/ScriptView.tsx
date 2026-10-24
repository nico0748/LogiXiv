// 発表中に元の窓に出す台本。グループのメモと、リンクした論文の箇所を、スライドの順に並べる。
// 発表の窓が映しているスライドのページに印を付け、そこまで送る。
// - ページの見出しを押すと、発表の窓のスライドをそのページへ動かす（← / → / PageUp / PageDown でも前後へ）
// - グループやリンクを押すと、発表の窓でそのグループを選び、論文の該当箇所を見せる
// 読むだけの画面にする（メモを直すのは右サイドバーの一覧で行う）。

import { ChevronLeft, ChevronRight, Presentation, X } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef } from "react";
import { GROUP_COLORS, LINK_KIND_LABEL, type SlideDeck, markupName, sortMarkups } from "../../lib/slides.ts";
import type { Presenter } from "./usePresenter.ts";

export function ScriptView({ deck, presenter }: { deck: SlideDeck; presenter: Presenter }) {
  const { page, count } = presenter;
  const byPage = useMemo(() => {
    const m = new Map<number, SlideDeck["markups"]>();
    for (const g of sortMarkups(deck.markups)) m.set(g.page, [...(m.get(g.page) ?? []), g]);
    return m;
  }, [deck.markups]);
  const last = Math.max(count, ...deck.markups.map((m) => m.page), 1);
  const pages = Array.from({ length: last }, (_, i) => i + 1);

  // 映しているページを上に送る
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-page="${page}"]`);
    el?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [page]);

  const go = (p: number) => presenter.goto(Math.min(last, Math.max(1, p)));
  const goRef = useRef(go);
  goRef.current = go;
  const pageRef = useRef(page);
  pageRef.current = page;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable], dialog, [role=dialog]")) return;
      if (document.querySelector("dialog[open], [role=dialog][aria-modal=true]")) return;
      const d = e.key === "ArrowRight" || e.key === "PageDown" ? 1 : e.key === "ArrowLeft" || e.key === "PageUp" ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      goRef.current(pageRef.current + d);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  return (
    <div className="sc">
      <div className="pdf-toolbar sc-bar" role="toolbar" aria-label="発表の操作">
        <span className="sc-live">
          <Presentation size={16} aria-hidden="true" /> 発表中
        </span>
        <button className="icon-btn" aria-label="前のスライド" title="前のスライド（← / PageUp）" disabled={page <= 1} onClick={() => go(page - 1)}>
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <span className="sc-pos" role="status">
          スライド {page} / {count || "-"}
        </span>
        <button className="icon-btn" aria-label="次のスライド" title="次のスライド（→ / PageDown）" disabled={page >= last} onClick={() => go(page + 1)}>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
        <span className="spacer" />
        <span className="sc-sub">グループ {deck.markups.length}・リンク {deck.markups.reduce((n, m) => n + m.links.length, 0)}</span>
        <button className="btn text sm" title="発表の窓を閉じて、スライドと論文の画面に戻る（P）" onClick={presenter.stop}>
          <X size={14} aria-hidden="true" /> 発表を終える
        </button>
      </div>
      <div className="sc-scroll" ref={scrollRef}>
        {pages.map((p) => {
          const groups = byPage.get(p) ?? [];
          const here = p === page;
          return (
            <section key={p} data-page={p} className={`sc-page${here ? " is-current" : ""}`} aria-current={here ? "step" : undefined} aria-label={`スライド ${p}`}>
              <button className="sc-page-head" onClick={() => go(p)} title="発表の窓をこのスライドへ動かす">
                <span className="sc-page-no">スライド {p}</span>
                {here && <span className="sc-now">表示中</span>}
                {count > 0 && p > count && <span className="mp-orphan">スライドに無いページ</span>}
              </button>
              {!groups.length ? (
                <p className="sc-none">このページのグループはありません</p>
              ) : (
                <ol className="sc-groups">
                  {groups.map((m) => (
                    <li
                      key={m.id}
                      className={`sc-group${m.id === presenter.active ? " is-active" : ""}`}
                      style={{ "--g": GROUP_COLORS[m.color % GROUP_COLORS.length] } as CSSProperties}
                    >
                      <button className="sc-group-head" onClick={() => presenter.focus(m.id)} title="発表の窓でこのグループを選び、論文の該当箇所を見せる">
                        <span className="mu-dot" aria-hidden="true" />
                        <span className="sc-name">{markupName(m)}</span>
                        <span className="sc-meta">リンク {m.links.length}</span>
                      </button>
                      {m.memo.trim() ? <p className="sc-memo">{m.memo.trim()}</p> : <p className="sc-none">メモはありません</p>}
                      {m.links.length > 0 && (
                        <ul className="sc-links">
                          {[...m.links]
                            .sort((a, b) => a.page - b.page || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0))
                            .map((l) => (
                              <li key={l.id}>
                                <button className="sc-link" onClick={() => presenter.focus(m.id, l.id)} title="発表の窓で論文のこの箇所を見せる">
                                  <span className="sc-kind">{LINK_KIND_LABEL[l.kind]}</span>
                                  <span className="mp-page">p.{l.page}</span>
                                  <span className="sc-text">{l.text || `（${LINK_KIND_LABEL[l.kind]}の範囲）`}</span>
                                </button>
                              </li>
                            ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
