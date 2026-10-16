// 右サイドバー: スライドのグループ（マークアップ）の一覧。選ぶと、スライドと論文の該当箇所へ移る。
// メモ、色、リンクの種類を直したり、リンクやグループを消したりできる。

import { Trash2, X } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { GROUP_COLORS, LINK_KIND_LABEL, type LinkKind, type SlideMarkup, markupName, sortMarkups } from "../../lib/slides.ts";
import type { SlideFocus } from "./SlidesView.tsx";
import type { Slides } from "./useSlides.ts";

interface Props {
  slides: Slides;
  active: string | null;
  setActive: (id: string | null) => void;
  setHover: (id: string | null) => void;
  reveal: (f: Omit<SlideFocus, "nonce">) => void;
  /** スライドのページ数（分かっていれば）。これより後ろのページのグループには印を付ける */
  slideCount?: number;
}

const COLOR_NAMES = ["青", "橙", "青緑", "黄", "桃", "緑", "紫", "赤"];

export function MarkupPanel({ slides, active, setActive, setHover, reveal, slideCount }: Props) {
  const s = slides.state;
  // 消すボタンは 2 回押しで消す（リンクごと消えて、元に戻せないため）
  const [confirm, setConfirm] = useState<string | null>(null);
  useEffect(() => {
    if (!confirm) return;
    const t = window.setTimeout(() => setConfirm(null), 4000);
    return () => window.clearTimeout(t);
  }, [confirm]);
  if (s.kind !== "ready") {
    return <p className="empty">{s.kind === "loading" ? "読み込んでいます" : "スライドを追加すると、囲んだ部分（グループ）がここに並びます。"}</p>;
  }
  const list = sortMarkups(s.deck.markups);
  const patch = (id: string, p: Partial<SlideMarkup>) => slides.update((d) => ({ ...d, markups: d.markups.map((m) => (m.id === id ? { ...m, ...p } : m)) }));

  return (
    <div className="sidebar-content mp">
      <div className="sidebar-tab-header mp-head">
        <span className="nav-header-title">
          グループ<span className="nav-count">{list.length}</span>
        </span>
        <span className="mp-sub">リンク {list.reduce((n, m) => n + m.links.length, 0)} 件</span>
      </div>
      <div className="sidebar-scroll">
        {!list.length && (
          <div className="empty">
            <p>スライドの上で「囲む」（R）を選び、ドラッグして四角で囲んでください。</p>
            <p>囲んだ部分は Markup-03.02（3 ページ目の 2 個目）のような名前のグループになります。グループを選んでいる間に、論文の文章を選ぶか、図・数式を囲むとリンクできます。</p>
          </div>
        )}
        <ul className="mp-list">
          {list.map((m) => {
            const on = m.id === active;
            const style = { "--g": GROUP_COLORS[m.color % GROUP_COLORS.length] } as CSSProperties;
            return (
              <li key={m.id} className={`mp-item${on ? " is-active" : ""}`} style={style} onMouseEnter={() => setHover(m.id)} onMouseLeave={() => setHover(null)}>
                <button
                  className="mp-title"
                  aria-expanded={on}
                  onClick={() => {
                    setActive(on ? null : m.id);
                    if (!on) reveal({ id: m.id });
                  }}
                >
                  <span className="mu-dot" aria-hidden="true" />
                  <span className="mp-name">{markupName(m)}</span>
                  {slideCount && m.page > slideCount ? (
                    <span className="mp-orphan" title={`今のスライドは ${slideCount} ページです`}>スライドに無いページ</span>
                  ) : null}
                  <span className="mp-meta">スライド p.{m.page}・リンク {m.links.length}</span>
                </button>
                {!on && m.memo.trim() && <p className="mp-memo-preview">{m.memo.trim()}</p>}
                {on && (
                  <div className="mp-body">
                    <label className="field-label" htmlFor={`memo-${m.id}`}>メモ</label>
                    <textarea
                      id={`memo-${m.id}`}
                      className="textarea"
                      rows={2}
                      placeholder="このスライドで言うこと、論文との対応の要点"
                      value={m.memo}
                      onChange={(e) => patch(m.id, { memo: e.target.value })}
                    />
                    <div className="mp-colors" role="group" aria-label="グループの色">
                      {GROUP_COLORS.map((c, i) => (
                        <button
                          key={c}
                          aria-pressed={m.color === i}
                          aria-label={COLOR_NAMES[i]}
                          title={COLOR_NAMES[i]}
                          className={`mp-color${m.color === i ? " is-on" : ""}`}
                          style={{ background: c }}
                          onClick={() => patch(m.id, { color: i })}
                        />
                      ))}
                    </div>
                    <div className="pane-sub">論文の該当箇所</div>
                    {!m.links.length && <p className="mp-none">まだありません。論文の文章を選ぶか、図・数式を囲んでください。</p>}
                    <ul className="mp-links">
                      {[...m.links]
                        .sort((a, b) => a.page - b.page || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0))
                        .map((l) => (
                          <li key={l.id} className="mp-link">
                            <select
                              className="select mp-kind"
                              aria-label="リンクの種類"
                              value={l.kind}
                              onChange={(e) => patch(m.id, { links: m.links.map((x) => (x.id === l.id ? { ...x, kind: e.target.value as LinkKind } : x)) })}
                            >
                              {(Object.keys(LINK_KIND_LABEL) as LinkKind[]).map((k) => (
                                <option key={k} value={k}>{LINK_KIND_LABEL[k]}</option>
                              ))}
                            </select>
                            <button className="mp-link-body" onClick={() => reveal({ id: m.id, link: l.id })} title="論文のこの箇所へ移る">
                              <span className="mp-page">p.{l.page}</span>
                              <span className="mp-text">{l.text || `（${LINK_KIND_LABEL[l.kind]}の範囲）`}</span>
                            </button>
                            <button
                              className="icon-btn"
                              aria-label={`p.${l.page} のリンクを外す`}
                              title="リンクを外す"
                              onClick={() => patch(m.id, { links: m.links.filter((x) => x.id !== l.id) })}
                            >
                              <X size={14} aria-hidden="true" />
                            </button>
                          </li>
                        ))}
                    </ul>
                    <div className="mp-actions">
                      <button
                        className={`btn text sm mp-delete${confirm === m.id ? " is-confirm" : ""}`}
                        onClick={() => {
                          if (confirm !== m.id) return setConfirm(m.id);
                          setConfirm(null);
                          slides.update((d) => ({ ...d, markups: d.markups.filter((x) => x.id !== m.id) }));
                          setActive(null);
                          // 消した行の上では mouseleave が来ないので、ここで外す
                          setHover(null);
                        }}
                      >
                        <Trash2 size={14} aria-hidden="true" />{" "}
                        {confirm === m.id ? `もう一度押すと消します（リンク ${m.links.length} 件も消えます）` : `${markupName(m)} を消す`}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
