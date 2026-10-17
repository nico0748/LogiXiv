// 発表スライドと論文の対応を見る画面。
//
//   ┌ スライド ──────────┐   ┌ 論文 ──────────────┐
//   │ ┏Markup-03.02━┓──────────────▶ ▒▒ 該当する文 ▒▒   │
//   │ ┗━━━━━━━━━━━━━┛    │ ╲ │ ┌ 図 ┐             │
//   └────────────────────┘   ╲└──────────────────┘
//
// - 左: スライド。「囲む」でドラッグすると四角のマークアップ（グループ）ができる。名前は Markup-ページ.番号。
// - 右: 論文。マークアップを選んでいる間、文章はドラッグで選んで、図・数式は四角で囲んでリンクする。
// - 間: グループの色の線でつなぐ。片方が画面の外にあるときは、端まで点線で引く。

import { Frame, Maximize, Minimize, MousePointer2, Spline, SquareDashed, Upload } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Rect } from "../../lib/model.ts";
import { newId } from "../../lib/model.ts";
import {
  GROUP_COLORS,
  LINK_KIND_LABEL,
  type LinkKind,
  type SlideDeck,
  type SlideLink,
  type SlideMarkup,
  boundsOf,
  markupName,
  mergeLineRects,
  nextColor,
  nextIndex,
  normalizeRect,
  overlapRatio,
} from "../../lib/slides.ts";
import { PdfPages, type PdfPagesHandle } from "./PdfPages.tsx";
import "./slides.css";
import { useFullscreen } from "./useFullscreen.ts";
import type { Slides } from "./useSlides.ts";

export type SlideTool = "select" | "box";
export type PaperTool = "text" | "figure" | "equation";

/** 右サイドバーなど画面の外から、マークアップ（とそのリンク先）を見せる指示 */
export interface SlideFocus {
  id: string;
  link?: string;
  nonce: number;
}

interface Props {
  slides: Slides;
  paperPdf: ArrayBuffer | null;
  active: string | null;
  setActive: (id: string | null) => void;
  hover: string | null;
  setHover: (id: string | null) => void;
  focus: SlideFocus | null;
  notify: (msg: string) => void;
  /** 選んだグループの線だけを出す */
  isolate: boolean;
  setIsolate: (v: boolean) => void;
  /** スライドのページ数が分かったとき（右サイドバーで、無いページのグループを示すため） */
  onSlideCount?: (n: number) => void;
}

const ACCEPT = ".pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation";
const isSlideFile = (f: File) => /\.(pdf|pptx)$/i.test(f.name);

export function SlidesView(props: Props) {
  const { slides } = props;
  const s = slides.state;
  const fileRef = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const ready = s.kind === "ready" && !!props.paperPdf;
  const fs = useFullscreen(rootRef, ready);
  // 全画面では道具の帯を隠し、上の端にマウスを近づけたときだけ出す（止まって 2 秒で隠す）
  const [bar, setBar] = useState(false);
  const [fsHint, setFsHint] = useState(false);
  const barTimer = useRef(0);
  useEffect(() => {
    setBar(false);
    setFsHint(!!fs.mode);
    if (!fs.mode) return;
    const t = window.setTimeout(() => setFsHint(false), 2500);
    return () => window.clearTimeout(t);
  }, [fs.mode]);
  useEffect(() => () => window.clearTimeout(barTimer.current), []);
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!fs.mode) return;
    const inBar = (e.target as Element).closest?.(".sv-toolbar");
    if (!inBar && e.clientY - e.currentTarget.getBoundingClientRect().top > 56) return;
    setBar(true);
    window.clearTimeout(barTimer.current);
    barTimer.current = window.setTimeout(() => setBar(false), 2000);
  };

  const pick = async (f: File | undefined) => {
    if (!f || slides.importing) return;
    if (!isSlideFile(f)) return props.notify("スライドは PDF か PPTX で指定してください。");
    try {
      await slides.importFile(f);
      props.notify(`${f.name} を取り込みました`);
    } catch (e) {
      props.notify(e instanceof Error ? e.message : String(e));
    }
  };

  const input = (
    <input
      ref={fileRef}
      type="file"
      accept={ACCEPT}
      hidden
      onChange={(e) => {
        void pick(e.target.files?.[0]);
        e.target.value = "";
      }}
    />
  );

  return (
    <div
      ref={rootRef}
      className={`slides-view${dropping ? " is-drop-target" : ""}${fs.mode ? " is-fullscreen" : ""}${fs.mode === "fill" ? " is-fill" : ""}${bar ? " fs-bar" : ""}`}
      onPointerMove={onPointerMove}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        // 論文の取り込み（中央の画面へのドロップ）には回さない
        e.preventDefault();
        e.stopPropagation();
        setDropping(false);
        void pick([...e.dataTransfer.files].find(isSlideFile) ?? e.dataTransfer.files[0]);
      }}
    >
      {input}
      {fsHint && <div className="sv-fs-hint" role="status">Esc で全画面を終えます。上の端にマウスを動かすと道具が出ます</div>}
      {slides.importing && (
        // 今の画面（拡大率や分割の幅）を残したまま、上に重ねて知らせる
        <div className="sv-importing" role="status" aria-busy="true">
          <h2>スライドを取り込んでいます</h2>
          <p>{slides.importing}{/\.pptx$/i.test(slides.importing) ? "（PDF に変換しています。1 分ほどかかることがあります）" : ""}</p>
        </div>
      )}
      {s.kind === "loading" ? (
        <div className="drop-hint" aria-busy="true"><h2>読み込んでいます</h2></div>
      ) : s.kind === "error" ? (
        <div className="drop-hint"><h2>スライドを読み込めませんでした</h2><p>{s.message}</p></div>
      ) : s.kind === "none" ? (
        <div className="drop-hint">
          <h2>発表スライドを追加してください</h2>
          <p>論文発表会で使う PDF か PPTX をここにドロップするか、下のボタンから選んでください。PPTX は PDF に変換して表示します。</p>
          <button className="btn primary" onClick={() => fileRef.current?.click()}>
            <Upload size={16} aria-hidden="true" /> スライドを追加
          </button>
        </div>
      ) : !props.paperPdf ? (
        <div className="drop-hint" aria-busy="true"><h2>論文を読み込んでいます</h2></div>
      ) : (
        <Split {...props} deck={s.deck} slidePdf={s.pdf} paperPdf={props.paperPdf} onReplace={() => fileRef.current?.click()} fullscreen={!!fs.mode} onFullscreen={fs.toggle} />
      )}
    </div>
  );
}

type Line = { key: string; markup: string; color: string; d: string; dashed: boolean; a?: [number, number]; b?: [number, number] };

function Split({
  slides,
  deck,
  slidePdf,
  paperPdf,
  active,
  setActive,
  hover,
  setHover,
  focus,
  notify,
  isolate,
  setIsolate,
  onSlideCount,
  onReplace,
  fullscreen,
  onFullscreen,
}: Props & { deck: SlideDeck; slidePdf: ArrayBuffer; paperPdf: ArrayBuffer; onReplace: () => void; fullscreen: boolean; onFullscreen: () => void }) {
  const [slideTool, setSlideTool] = useState<SlideTool>("select");
  const [paperTool, setPaperTool] = useState<PaperTool>("text");
  const [slideZoom, setSlideZoom] = useState(1);
  const [paperZoom, setPaperZoom] = useState(1);
  const [slidePage, setSlidePage] = useState(1);
  const [paperPage, setPaperPage] = useState(1);
  const [slideCount, setSlideCount] = useState(0);
  const [paperCount, setPaperCount] = useState(0);
  const [ratio, setRatio] = useState(0.5);
  const [lines, setLines] = useState<Line[]>([]);
  const [selMenu, setSelMenu] = useState<{ x: number; y: number; page: number; rects: Rect[]; text: string } | null>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const slideRef = useRef<PdfPagesHandle>(null);
  const paperRef = useRef<PdfPagesHandle>(null);
  const activeMarkup = deck.markups.find((m) => m.id === active) ?? null;

  // --- 線 -------------------------------------------------------------------
  const frame = useRef(0);
  const measure = useCallback(() => {
    const split = splitRef.current;
    const L = slideRef.current?.el;
    const R = paperRef.current?.el;
    if (!split || !L || !R) return;
    const S = split.getBoundingClientRect();
    const lr = L.getBoundingClientRect();
    const rr = R.getBoundingClientRect();
    // スクロールバーの内側を、それぞれの枠の端にする
    const lLeft = lr.left;
    const lRight = lr.left + L.clientWidth;
    const rLeft = rr.left;
    const rRight = rr.left + R.clientWidth;
    const top1 = lr.top + 6;
    const bot1 = lr.top + L.clientHeight - 6;
    const top2 = rr.top + 6;
    const bot2 = rr.top + R.clientHeight - 6;
    const out: Line[] = [];
    for (const m of deck.markups) {
      if (isolate && m.id !== active) continue;
      const box = L.querySelector<HTMLElement>(`[data-mk="${m.id}"]`)?.getBoundingClientRect();
      if (!box) continue;
      const y1raw = box.top + box.height / 2;
      // 縦か横に枠の外へ出ていれば、枠の端から点線で引く
      const off1 = y1raw < top1 || y1raw > bot1 || box.right < lLeft || box.left > lRight;
      const y1 = Math.min(bot1, Math.max(top1, y1raw));
      const x1 = off1 ? lRight : Math.min(box.right, lRight);
      for (const l of m.links) {
        const t = R.querySelector<HTMLElement>(`[data-ln="${l.id}"]`)?.getBoundingClientRect();
        if (!t) continue;
        const y2raw = t.top + t.height / 2;
        const off2 = y2raw < top2 || y2raw > bot2 || t.right < rLeft || t.left > rRight;
        if (off1 && off2) continue;
        const y2 = Math.min(bot2, Math.max(top2, y2raw));
        const x2 = off2 ? rLeft : Math.max(t.left, rLeft);
        const p = (x: number, y: number): [number, number] => [x - S.left, y - S.top];
        const [ax, ay] = p(x1, y1);
        const [bx] = p(lRight, 0);
        const [cx] = p(rLeft, 0);
        const [dx, dy] = p(x2, y2);
        const g = Math.max(24, (cx - bx) * 0.6);
        out.push({
          key: l.id,
          markup: m.id,
          color: GROUP_COLORS[m.color % GROUP_COLORS.length],
          d: `M${ax},${ay} L${bx},${ay} C${bx + g},${ay} ${cx - g},${dy} ${cx},${dy} L${dx},${dy}`,
          dashed: off1 || off2,
          a: off1 ? undefined : [ax, ay],
          b: off2 ? undefined : [dx, dy],
        });
      }
    }
    setLines(out);
  }, [deck, isolate, active]);
  // 待っている間に条件（deck・選択）が変わっても、測るときの最新の measure を使う
  const measureRef = useRef(measure);
  measureRef.current = measure;
  const schedule = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      measureRef.current();
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useLayoutEffect(() => {
    schedule();
  }, [schedule, measure, slideZoom, paperZoom, ratio, slideCount, paperCount]);
  useEffect(() => {
    const el = splitRef.current;
    if (!el) return;
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    return () => ro.disconnect();
  }, [schedule]);

  // --- 移動 -----------------------------------------------------------------
  const showLink = useCallback((l: SlideLink) => paperRef.current?.goTo(l.page, boundsOf(l.rects)?.y ?? 0), []);
  const showMarkup = useCallback((m: SlideMarkup) => slideRef.current?.goTo(m.page, m.rect.y), []);
  useEffect(() => {
    if (!focus) return;
    const m = deck.markups.find((x) => x.id === focus.id);
    if (!m) return;
    showMarkup(m);
    const l = m.links.find((x) => x.id === focus.link) ?? m.links[0];
    if (l) showLink(l);
    // 指示が来たとき（nonce）だけ動かす
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  // --- 編集 -----------------------------------------------------------------
  const addMarkup = (page: number, rect: Rect) => {
    const id = newId("m");
    slides.update((d) => {
      const m: SlideMarkup = { id, page, index: nextIndex(d.markups, page, d.used), rect, color: nextColor(d.markups), memo: "", links: [], createdAt: new Date().toISOString() };
      notify(`${markupName(m)} を作りました。論文の該当箇所を選んでリンクしてください`);
      return { ...d, used: { ...d.used, [page]: m.index }, markups: [...d.markups, m] };
    });
    setActive(id);
    setSlideTool("select");
    setPaperTool("text");
  };

  const addLink = (kind: LinkKind, page: number, rects: Rect[], text: string) => {
    if (!active) return;
    const link: SlideLink = { id: newId("l"), kind, page, rects, text, createdAt: new Date().toISOString() };
    slides.update((d) => ({ ...d, markups: d.markups.map((m) => (m.id === active ? { ...m, links: [...m.links, link] } : m)) }));
  };

  /** 論文のページで四角く囲んだとき（図・数式）。囲んだ範囲の文字も添える */
  const onPaperBox = (page: number, rect: Rect) => {
    if (paperTool === "text") return;
    const el = paperRef.current?.el?.querySelector<HTMLElement>(`:scope > .pp-page[data-page="${page}"]`);
    let text = "";
    if (el) {
      const pr = el.getBoundingClientRect();
      text = [...el.querySelectorAll<HTMLElement>(".textLayer span")]
        .filter((sp) => {
          const r = sp.getBoundingClientRect();
          return r.width > 0 && overlapRatio({ x: (r.left - pr.left) / pr.width, y: (r.top - pr.top) / pr.height, w: r.width / pr.width, h: r.height / pr.height }, rect) >= 0.5;
        })
        .map((sp) => sp.textContent ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    }
    addLink(paperTool, page, [rect], text);
  };

  /** 論文の文字を選んだとき。リンクの種類を選ぶメニューを出す */
  const onPaperMouseUp = () => {
    const box = paperRef.current?.el;
    const sel = window.getSelection();
    if (!box || !active || paperTool !== "text" || !sel || sel.isCollapsed) return setSelMenu(null);
    const full = sel.getRangeAt(0);
    const startEl = full.startContainer instanceof Element ? full.startContainer : full.startContainer.parentElement;
    const pageEl = startEl?.closest<HTMLElement>(".pp-page");
    const tl = pageEl?.querySelector<HTMLElement>(".textLayer");
    if (!pageEl || !tl || !box.contains(pageEl) || !tl.contains(full.startContainer)) return setSelMenu(null);
    // 始めのページの文字だけにする（次のページまで選ぶと、ページ番号や重ねた札まで入ってしまうため）
    const range = full.cloneRange();
    if (!tl.contains(range.endContainer)) range.setEnd(tl, tl.childNodes.length);
    const text = range.toString().replace(/-\n/g, "").replace(/\s+/g, " ").trim();
    if (!text) return setSelMenu(null);
    const pr = pageEl.getBoundingClientRect();
    // 文字の行の矩形だけを使う（範囲が丸ごと含む要素の枠は、行の高さよりずっと大きい）
    const all = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1 && r.height < pr.height * 0.2);
    const rects = mergeLineRects(
      all
        .filter((r) => r.top >= pr.top - 2 && r.bottom <= pr.bottom + 2)
        .map((r) => ({ x: (r.left - pr.left) / pr.width, y: (r.top - pr.top) / pr.height, w: r.width / pr.width, h: r.height / pr.height })),
    );
    if (!rects.length) return setSelMenu(null);
    const last = all[all.length - 1];
    const br = box.getBoundingClientRect();
    const menuW = 380;
    setSelMenu({
      x: Math.max(box.scrollLeft + 8, Math.min(last.right - br.left + box.scrollLeft - 120, box.scrollLeft + box.clientWidth - menuW - 8)),
      y: last.bottom - br.top + box.scrollTop + 6,
      page: Number(pageEl.dataset.page),
      rects,
      text,
    });
  };
  const linkSelection = (kind: LinkKind) => {
    if (!selMenu) return;
    addLink(kind, selMenu.page, selMenu.rects, selMenu.text);
    setSelMenu(null);
    window.getSelection()?.removeAllRanges();
  };

  // キー操作: R で囲む、V で選ぶ、F/E/T で論文側の道具、Esc で道具を戻す
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    // 入力中、メニューやモーダルの中、ほかの画面を重ねているときは使わない
    if (t?.closest("input, textarea, select, [contenteditable], dialog, [role=menu], [role=dialog], .menu-surface:not(.sv-sel)")) return;
    if (document.querySelector("dialog[open], [role=dialog][aria-modal=true]")) return;
    const k = e.key.toLowerCase();
    if (k === "r") setSlideTool("box");
    else if (k === "v") setSlideTool("select");
    else if (k === "t" && active) setPaperTool("text");
    else if (k === "f" && active) setPaperTool("figure");
    else if (k === "e" && active) setPaperTool("equation");
    else if (e.key === "Escape") {
      if (slideTool !== "select" || paperTool !== "text") {
        setSlideTool("select");
        setPaperTool("text");
      } else if (selMenu) {
        setSelMenu(null);
        window.getSelection()?.removeAllRanges();
      }
      else if (active) setActive(null);
      else return; // 何もしないときは、ほかの処理に Esc を渡す
    } else return;
    e.preventDefault();
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  // 道具が使えなくなったら（グループの選択を外したら）戻す
  useEffect(() => {
    if (!active) {
      setPaperTool("text");
      setSelMenu(null);
    }
  }, [active]);

  // --- ページの上に重ねるもの ------------------------------------------------
  const byPage = useMemo(() => {
    const slidesBy = new Map<number, SlideMarkup[]>();
    const paperBy = new Map<number, { m: SlideMarkup; l: SlideLink }[]>();
    // 大きい四角から描き、小さい四角が上に来るようにする（大きい四角に覆われて押せなくならないように）
    for (const m of [...deck.markups].sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)) {
      slidesBy.set(m.page, [...(slidesBy.get(m.page) ?? []), m]);
      for (const l of m.links) paperBy.set(l.page, [...(paperBy.get(l.page) ?? []), { m, l }]);
    }
    return { slidesBy, paperBy };
  }, [deck]);

  // 消したグループの上で離れた（mouseleave が来ない）ときは、hover を無かったことにする
  const hov = hover && deck.markups.some((m) => m.id === hover) ? hover : null;
  const dim = (id: string) => (hov ? hov !== id : active ? active !== id : false);
  const color = (m: SlideMarkup) => ({ "--g": GROUP_COLORS[m.color % GROUP_COLORS.length] }) as CSSProperties;

  const slideOverlay = (n: number) => (
    <>
      <div className="mu-layer">
        {(byPage.slidesBy.get(n) ?? []).map((m) => (
          <button
            key={m.id}
            type="button"
            data-mk={m.id}
            className={`mu-box${m.id === active ? " is-active" : ""}${dim(m.id) ? " is-dim" : ""}${m.rect.y < 0.05 ? " tag-inside" : ""}`}
            style={{ ...color(m), left: `${m.rect.x * 100}%`, top: `${m.rect.y * 100}%`, width: `${m.rect.w * 100}%`, height: `${m.rect.h * 100}%` }}
            aria-label={`${markupName(m)}（リンク ${m.links.length} 件）`}
            aria-pressed={m.id === active}
            onMouseEnter={() => setHover(m.id)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(m.id)}
            onBlur={() => setHover(null)}
            onClick={() => {
              setActive(m.id === active ? null : m.id);
              if (m.id !== active && m.links[0]) showLink(m.links[0]);
            }}
          >
            <span className="mu-tag">
              <span className="mu-dot" aria-hidden="true" />
              {markupName(m)}
            </span>
          </button>
        ))}
      </div>
      {slideTool === "box" && <DrawLayer label={`スライド ${n} ページ目を囲む`} onBox={(r) => addMarkup(n, r)} />}
    </>
  );

  const paperOverlay = (n: number) => (
    <>
      {/* 塗りは紙に multiply で重ねる（文字が霞まない）。札と枠は別の層にして、普通に重ねる */}
      <div className="ln-fills" aria-hidden="true">
        {(byPage.paperBy.get(n) ?? []).map(({ m, l }) =>
          l.kind === "text" ? (
            <div key={l.id} className={`ln${m.id === active ? " is-active" : ""}${dim(m.id) ? " is-dim" : ""}`} style={color(m)}>
              {l.rects.map((r, i) => <div key={i} className="ln-fill" style={pos(r)} />)}
            </div>
          ) : null,
        )}
      </div>
      <div className="ln-layer">
        {(byPage.paperBy.get(n) ?? []).map(({ m, l }) => {
          const b = boundsOf(l.rects);
          if (!b) return null;
          const cls = `ln-${l.kind}${m.id === active ? " is-active" : ""}${dim(m.id) ? " is-dim" : ""}`;
          return (
            <div key={l.id} className={`ln ${cls}`} style={color(m)}>
              {l.kind !== "text" && <div className="ln-frame" style={pos(b)} />}
              <div className="ln-anchor" data-ln={l.id} style={pos(b)} />
              <button
                type="button"
                className={`mu-tag ln-tag${b.y < 0.05 ? " tag-inside" : ""}`}
                style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%` }}
                title={`${markupName(m)} の${LINK_KIND_LABEL[l.kind]}。押すとスライドへ移ります`}
                onMouseEnter={() => setHover(m.id)}
                onMouseLeave={() => setHover(null)}
                onClick={() => {
                  setActive(m.id);
                  showMarkup(m);
                }}
              >
                <span className="mu-dot" aria-hidden="true" />
                {markupName(m)}
              </button>
            </div>
          );
        })}
      </div>
      {active && paperTool !== "text" && (
        <DrawLayer label={`論文 ${n} ページ目の${LINK_KIND_LABEL[paperTool]}を囲む`} onBox={(r) => onPaperBox(n, r)} />
      )}
    </>
  );

  // --- 分割の幅 -------------------------------------------------------------
  const clampRatio = (v: number) => Math.min(0.75, Math.max(0.25, v));
  const onGutterDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = splitRef.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    const g = e.currentTarget;
    g.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => setRatio(clampRatio((ev.clientX - r.left) / r.width));
    const up = () => {
      g.removeEventListener("pointermove", move);
      g.removeEventListener("pointerup", up);
      g.removeEventListener("lostpointercapture", up);
    };
    g.addEventListener("pointermove", move);
    g.addEventListener("pointerup", up);
    g.addEventListener("lostpointercapture", up);
  };

  const zoomBtns = (z: number, set: (f: (z: number) => number) => void, who: string) => (
    <>
      <button className="icon-btn" aria-label={`${who}を縮小`} onClick={() => set((v) => Math.max(0.5, +(v - 0.1).toFixed(2)))}>−</button>
      <span className="sv-zoom">{Math.round(z * 100)}%</span>
      <button className="icon-btn" aria-label={`${who}を拡大`} onClick={() => set((v) => Math.min(3, +(v + 0.1).toFixed(2)))}>＋</button>
    </>
  );

  const hint =
    slideTool === "box"
      ? "スライドの上をドラッグして、四角で囲んでください（Esc でやめる）"
      : activeMarkup
        ? paperTool === "text"
          ? `${markupName(activeMarkup)} にリンクする文を、論文の上でドラッグして選んでください。図・数式は右上の道具で囲みます`
          : `論文の${LINK_KIND_LABEL[paperTool]}をドラッグして囲んでください（Esc でやめる）`
        : deck.markups.length
          ? "四角を押すとグループを選べます。選んでいる間、論文の該当箇所をリンクできます"
          : "「囲む」（R）でスライドの一部を四角で囲むと、グループ（Markup-ページ.番号）ができます";

  return (
    <div className="sv">
      <div className="pdf-toolbar sv-toolbar" role="toolbar" aria-label="スライドと論文の操作">
        <div className="sv-group" role="group" aria-label="スライドの道具">
          <button className={`btn text sm${slideTool === "select" ? " is-on" : ""}`} aria-pressed={slideTool === "select"} title="選ぶ（V）" onClick={() => setSlideTool("select")}>
            <MousePointer2 size={14} aria-hidden="true" /> 選ぶ
          </button>
          <button className={`btn text sm${slideTool === "box" ? " is-on" : ""}`} aria-pressed={slideTool === "box"} title="スライドの一部を四角で囲む（R）" onClick={() => setSlideTool((t) => (t === "box" ? "select" : "box"))}>
            <SquareDashed size={14} aria-hidden="true" /> 囲む
          </button>
        </div>
        <span className="sv-hint" role="status">{hint}</span>
        <span className="spacer" />
        <div className="sv-group" role="group" aria-label="論文にリンクする道具">
          {(["text", "figure", "equation"] as PaperTool[]).map((t) => (
            <button
              key={t}
              className={`btn text sm${paperTool === t && active ? " is-on" : ""}`}
              aria-pressed={paperTool === t && !!active}
              disabled={!active}
              title={active ? `${LINK_KIND_LABEL[t]}をリンクする（${t === "text" ? "T" : t === "figure" ? "F" : "E"}）` : "先にスライドの四角（グループ）を選んでください"}
              onClick={() => setPaperTool(t)}
            >
              {t === "text" ? "文章" : t === "figure" ? <><Frame size={14} aria-hidden="true" /> 図</> : "数式"}
            </button>
          ))}
        </div>
        <button className={`btn text sm${isolate ? " is-on" : ""}`} aria-pressed={isolate} title="選んだグループの線だけを出す" onClick={() => setIsolate(!isolate)}>
          <Spline size={14} aria-hidden="true" /> 選んだ線だけ
        </button>
        <button className="btn text sm sv-fs-btn" title={fullscreen ? "全画面を終える（P / Esc）" : "スライドと論文を全画面で表示する（P）"} onClick={onFullscreen}>
          {fullscreen ? <Minimize size={14} aria-hidden="true" /> : <Maximize size={14} aria-hidden="true" />} {fullscreen ? "全画面を終える" : "全画面"}
        </button>
      </div>
      <div ref={splitRef} className="sv-split" style={{ gridTemplateColumns: `minmax(0, ${ratio}fr) 56px minmax(0, ${1 - ratio}fr)` }}>
        <section className={`sv-pane sv-slides${slideTool === "box" ? " is-drawing" : ""}`} aria-label="発表スライド">
          <div className="sv-pane-head">
            <span className="sv-pane-title" title={deck.source}>スライド</span>
            <span>{slidePage} / {slideCount || "-"}</span>
            <span className="spacer" />
            {zoomBtns(slideZoom, setSlideZoom, "スライド")}
            <button className="btn text sm" onClick={onReplace} title={`今のスライド: ${deck.source}。差し替えても四角は残ります`}>差し替える</button>
          </div>
          <PdfPages
            handle={slideRef}
            data={slidePdf}
            zoom={slideZoom}
            overlay={slideOverlay}
            onScroll={schedule}
            onLayout={schedule}
            onPage={setSlidePage}
            onLoaded={(n) => {
              setSlideCount(n);
              onSlideCount?.(n);
            }}
            label="スライドのページ"
          />
        </section>
        <div
          className="sv-gutter"
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="スライドと論文の幅"
          aria-valuemin={25}
          aria-valuemax={75}
          aria-valuenow={Math.round(ratio * 100)}
          onPointerDown={onGutterDown}
          onDoubleClick={() => setRatio(0.5)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              setRatio((v) => clampRatio(v + (e.key === "ArrowLeft" ? -0.05 : 0.05)));
            }
          }}
        />
        <section className={`sv-pane sv-paper${active && paperTool !== "text" ? " is-drawing" : ""}`} aria-label="論文">
          <div className="sv-pane-head">
            <span className="sv-pane-title">論文</span>
            <span>{paperPage} / {paperCount || "-"}</span>
            <span className="spacer" />
            {zoomBtns(paperZoom, setPaperZoom, "論文")}
          </div>
          <PdfPages
            handle={paperRef}
            data={paperPdf}
            zoom={paperZoom}
            textLayer
            overlay={paperOverlay}
            onScroll={() => {
              schedule();
              if (selMenu) setSelMenu(null);
            }}
            onLayout={schedule}
            onPage={setPaperPage}
            onLoaded={setPaperCount}
            onMouseUp={onPaperMouseUp}
            label="論文のページ"
          >
            {selMenu && activeMarkup && (
              <div className="sel-menu menu-surface sv-sel" style={{ left: selMenu.x, top: selMenu.y }} onMouseUp={(e) => e.stopPropagation()} role="toolbar" aria-label="選んだ文をリンクする">
                <span className="sv-sel-label"><span className="mu-dot" style={color(activeMarkup)} aria-hidden="true" />{markupName(activeMarkup)} に</span>
                {(["text", "equation", "figure"] as LinkKind[]).map((k) => (
                  <button key={k} className="btn" onClick={() => linkSelection(k)}>
                    {LINK_KIND_LABEL[k]}としてリンク
                  </button>
                ))}
              </div>
            )}
          </PdfPages>
        </section>
        <svg className="sv-lines" aria-hidden="true">
          {lines.map((ln) => {
            const on = hov ? hov === ln.markup : active ? active === ln.markup : true;
            return (
              <g key={ln.key} className={on ? "is-on" : "is-dim"} style={{ color: ln.color }}>
                <path className="sv-line-halo" d={ln.d} />
                <path className="sv-line" d={ln.d} strokeDasharray={ln.dashed ? "5 5" : undefined} />
                {ln.a && <circle cx={ln.a[0]} cy={ln.a[1]} r={4} />}
                {ln.b && <circle cx={ln.b[0]} cy={ln.b[1]} r={4} />}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

const pos = (r: Rect): CSSProperties => ({ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });

/** ページの上をドラッグして四角を描く層 */
function DrawLayer({ onBox, label }: { onBox: (r: Rect) => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<Rect | null>(null);
  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  return (
    <div
      ref={ref}
      className="draw-layer"
      aria-label={label}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = at(e);
        setDraft({ ...start.current, w: 0, h: 0 });
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        const p = at(e);
        setDraft(normalizeRect({ x: s.x, y: s.y, w: p.x - s.x, h: p.y - s.y }));
      }}
      onPointerUp={(e) => {
        const s = start.current;
        // 最後の移動がまだ描かれていないことがあるので、離した位置から計算し直す
        const d = s ? normalizeRect({ x: s.x, y: s.y, w: at(e).x - s.x, h: at(e).y - s.y }) : null;
        start.current = null;
        setDraft(null);
        // 押しただけ（小さすぎる四角）は作らない
        if (d && d.w > 0.01 && d.h > 0.01) onBox(d);
      }}
      onLostPointerCapture={() => {
        start.current = null;
        setDraft(null);
      }}
      onPointerCancel={() => {
        start.current = null;
        setDraft(null);
      }}
    >
      {draft && <div className="draw-draft" style={pos(draft)} />}
    </div>
  );
}
