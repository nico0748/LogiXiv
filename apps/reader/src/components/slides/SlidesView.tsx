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
// - 名前の札は、グループにカーソルかフォーカスがあるときだけ出す（いつも出すとスライドや論文の文字を隠すため）。
//   論文側は札の代わりに小さな色の点を置き、点に乗ると札に広がる。
//   スライド側の札の消すボタンはグループごと（両側とも）消し、論文側の札の消すボタンはそのリンク 1 本だけを外す。
// - 選んでいるグループの四角（スライド側）と、図・数式の囲み（論文側）は、四隅と四辺のつまみで大きさを直せる。
// - 補足情報の対訳で文を選ぶと、論文の面でその文に枠を付けて、そこまで動かす（論文の画面の PdfView と同じ）。
// - 補足情報（info）を渡されたときは、論文の右に三面目（対訳・訳・用語など）を置き、二面ずつ横にめくって見せる
//   （[スライド | 論文] か [論文 | 補足情報]。論文はいつも見える。usePager.ts）。渡されないときはこれまでの二分割のまま。
// - 「発表」（P）は、スライドと論文を別の窓に全画面で映し、この窓には台本（ScriptView）を出す（usePresenter.ts）。
//   別の窓を開けないときは、これまでどおりこの画面を全画面にする。発表の窓では presentation を渡す。

import { Frame, Maximize, Minimize, MousePointer2, Presentation, X, Spline, SquareDashed, Trash2, Upload } from "lucide-react";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { setSentenceFocus, useSentenceFocus } from "../../lib/sentenceFocus.ts";
import { type SentenceMark, hitTest, marksByPage, sentenceAnchor } from "../../lib/sentencesView.ts";
import { Snackbar, type Snack } from "../Snackbar.tsx";
import { SentenceMarkLayer } from "../sentences/SentenceMarks.tsx";
import { useSentences } from "../sentences/useSentences.ts";
import { PdfPages, type PdfPagesHandle } from "./PdfPages.tsx";
import "./slides.css";
import { HelpButton } from "../help/HelpButton.tsx";
import { useFullscreen } from "./useFullscreen.ts";
import { GUTTER, type SlidesSide, usePager } from "./usePager.ts";
import { ScriptView } from "./ScriptView.tsx";
import { usePresenter } from "./usePresenter.ts";
import type { Slides } from "./useSlides.ts";

export type SlideTool = "select" | "box";
export type PaperTool = "text" | "figure" | "equation";
export type { SlidesSide };

/** 右サイドバーなど画面の外から、マークアップ（とそのリンク先）を見せる指示 */
export interface SlideFocus {
  id: string;
  link?: string;
  nonce: number;
}

interface Props {
  slides: Slides;
  /** 開いている論文の ID（補足情報の対訳で選んだ文を、論文の面に出すため） */
  paperId?: string | null;
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
  /** 右の補足情報の面に出す中身（App が RightPanel を渡す）。無いときは三面目を作らず、これまでの二分割のまま */
  info?: ReactNode;
  /** 補足情報から「論文のこの場所を見せる」指示。n が変わるたびに論文の面を page / y（0..1 のページ内の縦位置）へ動かす */
  paperJump?: { page: number; y: number; n: number } | null;
  /** 「発表」で別の窓を開けるか（ローカルサーバーで動いているときだけ。発表の窓が同じ保存先を読むため） */
  canPresent?: boolean;
  /** この画面が発表の窓のとき。いつも全画面の見た目にし、「発表を終える」で窓を閉じる */
  presentation?: boolean;
  /** スライドの見えているページが変わったとき（発表の窓から、台本へ知らせるため） */
  onSlidePage?: (page: number, count: number) => void;
  /** スライドをこのページへ動かす指示。n が変わるたびに動かす */
  slideGoto?: { page: number; n: number } | null;
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
  const { presentation } = props;
  // 発表の窓の中では使わない（同じ窓の PresenterApp が送る知らせを、自分あての知らせと取り違えないように）
  const presenter = usePresenter(presentation ? null : props.paperId, ready && !!props.canPresent);
  // 「発表」: 別の窓を開けたらそちらに映し、開けなければこの画面を全画面にする。発表中なら終える
  const present = () => {
    if (presenter.open) {
      presenter.stop();
      return true;
    }
    return presenter.start();
  };
  const fs = useFullscreen(rootRef, ready && !presentation, present);
  const fsLook = presentation || !!fs.mode;
  // 全画面では道具の帯を隠し、上の端にマウスを近づけたときだけ出す（止まって 2 秒で隠す）
  const [bar, setBar] = useState(false);
  const [fsHint, setFsHint] = useState(false);
  const barTimer = useRef(0);
  useEffect(() => {
    setBar(false);
    setFsHint(fsLook);
    if (!fsLook) return;
    const t = window.setTimeout(() => setFsHint(false), 2500);
    return () => window.clearTimeout(t);
  }, [fsLook]);
  useEffect(() => () => window.clearTimeout(barTimer.current), []);
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!fsLook) return;
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
      className={`slides-view${dropping ? " is-drop-target" : ""}${fsLook ? " is-fullscreen" : ""}${presentation || fs.mode === "fill" ? " is-fill" : ""}${presentation ? " is-presentation" : ""}${bar ? " fs-bar" : ""}`}
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
      {fsHint && (
        <div className="sv-fs-hint" role="status">
          {presentation ? "台本は元の窓に出ています。上の端にマウスを動かすと道具が出ます" : "Esc で全画面を終えます。上の端にマウスを動かすと道具が出ます"}
        </div>
      )}
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
          <p className="sv-none-help">
            <HelpButton chapter="slides" /> 囲み方とリンクのしかた
          </p>
        </div>
      ) : !props.paperPdf ? (
        <div className="drop-hint" aria-busy="true"><h2>論文を読み込んでいます</h2></div>
      ) : presenter.open ? (
        <ScriptView deck={s.deck} presenter={presenter} />
      ) : (
        <Split
          {...props}
          deck={s.deck}
          slidePdf={s.pdf}
          paperPdf={props.paperPdf}
          onReplace={() => fileRef.current?.click()}
          fullscreen={!!fs.mode}
          onFullscreen={presentation ? () => window.close() : () => present() || fs.toggle()}
          canOpenPresenter={!!props.canPresent && !presentation}
        />
      )}
    </div>
  );
}

type Line = { key: string; markup: string; color: string; d: string; dashed: boolean; a?: [number, number]; b?: [number, number] };

function Split({
  slides,
  paperId,
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
  info,
  paperJump,
  onReplace,
  fullscreen,
  onFullscreen,
  canOpenPresenter,
  presentation,
  onSlidePage,
  slideGoto,
}: Props & {
  deck: SlideDeck;
  slidePdf: ArrayBuffer;
  paperPdf: ArrayBuffer;
  onReplace: () => void;
  fullscreen: boolean;
  onFullscreen: () => void;
  canOpenPresenter: boolean;
}) {
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
  /** つまみで大きさを直している途中の四角（離すまで保存しない）。link が無ければスライド側の四角 */
  const [resizing, setResizing] = useState<{ markup: string; link?: string; rect: Rect } | null>(null);
  const rectOfMarkup = (m: SlideMarkup) => (resizing && resizing.markup === m.id && !resizing.link ? resizing.rect : m.rect);
  const rectsOfLink = (l: SlideLink) => (resizing?.link === l.id ? [resizing.rect] : l.rects);

  // --- 対訳で選んだ文 ---------------------------------------------------------
  // 論文の画面では PdfView が文の枠を描くが、ここには PdfView が無いので、選んだ文の枠だけを論文の面に描く
  const sentences = useSentences(paperId);
  const sdoc = sentences.state?.status === "ready" ? sentences.state.document : null;
  const sFocus = useSentenceFocus();
  const activeSentence = paperId && sFocus.paperId === paperId ? sFocus.id : null;
  const sentenceMarks = useMemo(() => {
    const by = new Map<number, SentenceMark[]>();
    if (!sdoc || !activeSentence) return by;
    for (const [page, ms] of marksByPage(sdoc)) {
      const mine = ms.filter((m) => m.id === activeSentence);
      if (mine.length) by.set(page, mine);
    }
    return by;
  }, [sdoc, activeSentence]);
  // 論文の面で文をクリックしたら、その文を選ぶ（補足情報の対訳がそのカードまで動く）。
  // 枠は選んだ文の分しか描かないので、当たりはすべての文の枠から座標で取る
  const allMarks = useMemo(() => (sdoc ? marksByPage(sdoc) : null), [sdoc]);
  const onPaperClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!allMarks || !paperId) return;
    if (selMenu) return; // 選択のメニューを閉じるためのクリック
    if (active && paperTool !== "text") return; // 囲んでいる途中
    const t = e.target as HTMLElement;
    if (t.closest("button, a, .sel-menu, .ln-pin")) return;
    if (e.detail > 1) return; // 語を選ぶダブルクリック
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // 文字を選んだだけ（リンクする途中）のときは文を選ばない
    const pageEl = t.closest<HTMLElement>(".pp-page");
    const page = Number(pageEl?.dataset.page);
    const marks = page ? allMarks.get(page) : undefined;
    if (!pageEl || !marks) return;
    const r = pageEl.getBoundingClientRect();
    const m = hitTest(marks, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    if (m) setSentenceFocus(paperId, m.id, m.hash, "pdf");
  };

  // --- 線 -------------------------------------------------------------------
  const frame = useRef(0);
  /** 横めくりが最後に測った枠の幅 */
  const pagerWidth = useRef(0);
  const measure = useCallback(() => {
    const split = splitRef.current;
    const L = slideRef.current?.el;
    const R = paperRef.current?.el;
    if (!split || !L || !R) return;
    // 三面のとき、枠の幅が変わったばかりで測り直す前（全画面に入る・出る直後など）は、位置がまだ戻っていないので引かない
    if (info !== undefined && Math.abs(split.clientWidth - pagerWidth.current) > 0.5) {
      setLines((v) => (v.length ? [] : v));
      return;
    }
    const S = split.getBoundingClientRect();
    const lr = L.getBoundingClientRect();
    const rr = R.getBoundingClientRect();
    // スクロールバーの内側を、それぞれの枠の端にする。横にめくっている途中は、見えている幅（分割の枠）の内側に切り詰める
    const lLeft = Math.max(lr.left, S.left);
    const lRight = Math.min(lr.left + L.clientWidth, S.right);
    const rLeft = Math.max(rr.left, S.left);
    const rRight = Math.min(rr.left + R.clientWidth, S.right);
    // スライドの面がすっかり見えない（補足情報の側にいる）ときは、線を引かない
    if (lRight - lLeft < 1 || rRight - rLeft < 1) {
      setLines((v) => (v.length ? [] : v));
      return;
    }
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
  }, [deck, isolate, active, info]);
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
  const hasInfo = info !== undefined;
  const pager = usePager(splitRef, hasInfo, ratio, schedule);
  pagerWidth.current = pager.width;
  const toSlides = () => pager.side !== "slides" && pager.go("slides");
  useLayoutEffect(() => {
    schedule();
  }, [schedule, measure, slideZoom, paperZoom, ratio, slideCount, paperCount, pager.slidesOff, pager.width, resizing]);
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
  // 発表の窓: 見えているスライドのページを台本へ知らせ、台本からの指示でページを動かす
  useEffect(() => {
    onSlidePage?.(slidePage, slideCount);
  }, [onSlidePage, slidePage, slideCount]);
  useEffect(() => {
    if (!slideGoto) return;
    toSlides();
    slideRef.current?.goTo(slideGoto.page, 0, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideGoto?.n]);
  useEffect(() => {
    if (!focus) return;
    const m = deck.markups.find((x) => x.id === focus.id);
    if (!m) return;
    toSlides();
    showMarkup(m);
    const l = m.links.find((x) => x.id === focus.link) ?? m.links[0];
    if (l) showLink(l);
    // 指示が来たとき（nonce）だけ動かす
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);
  // 補足情報の対訳で文を選んだら、論文の面をその文まで動かす（PdfView と同じく、PDF の上で選んだときは動かさない）
  useEffect(() => {
    if (!sdoc || !paperId || sFocus.paperId !== paperId || !sFocus.id || sFocus.origin === "pdf" || sFocus.origin === "auto") return;
    const at = sentenceAnchor(sdoc, sFocus.id);
    if (at) paperRef.current?.goTo(at.page, at.y, sFocus.origin === "panel");
    // 選び直したとき（nonce）だけ動かす。訳が届いて文書が変わっただけでは動かさない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sFocus.nonce]);
  // 補足情報から論文の場所を見せる指示（論文はどちらの面でも見えているので、面は変えない）
  useEffect(() => {
    if (paperJump) paperRef.current?.goTo(paperJump.page, paperJump.y);
    // 指示が来たとき（n）だけ動かす
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperJump?.n]);

  // --- 編集 -----------------------------------------------------------------
  const addMarkup = (page: number, rect: Rect) => {
    const id = newId("m");
    slides.update((d) => {
      const m: SlideMarkup = { id, page, index: nextIndex(d.markups, page), rect, color: nextColor(d.markups), memo: "", links: [], createdAt: new Date().toISOString() };
      notify(`${markupName(m)} を作りました。論文の該当箇所を選んでリンクしてください`);
      return { ...d, markups: [...d.markups, m] };
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

  /** スライド側の四角の大きさを直したとき */
  const resizeMarkup = (id: string, rect: Rect) => {
    setResizing(null);
    slides.update((d) => ({ ...d, markups: d.markups.map((m) => (m.id === id ? { ...m, rect } : m)) }));
  };
  /** 論文側の図・数式の囲みの大きさを直したとき。囲んだ範囲の文字も取り直す */
  const resizeLink = (id: string, link: string, page: number, rect: Rect) => {
    setResizing(null);
    const text = textIn(page, rect);
    slides.update((d) => ({
      ...d,
      markups: d.markups.map((m) => (m.id === id ? { ...m, links: m.links.map((l) => (l.id === link ? { ...l, rects: [rect], text } : l)) } : m)),
    }));
  };

  /** 論文のページの、四角の中にある文字 */
  const textIn = (page: number, rect: Rect) => {
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
    return text;
  };

  /** 論文のページで四角く囲んだとき（図・数式）。囲んだ範囲の文字も添える */
  const onPaperBox = (page: number, rect: Rect) => {
    if (paperTool === "text") return;
    addLink(paperTool, page, [rect], textIn(page, rect));
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

  // --- 消す・元に戻す ---------------------------------------------------------
  // スライド側から消すとグループごと（論文側のリンクも）消え、論文側から消すとそのリンク 1 本だけが外れる。
  // その場で確かめずに消すので、下の知らせ（と ⌘Z / Ctrl+Z）で元に戻せるようにする
  const removeGroup = (m: SlideMarkup) => {
    slides.remove(m.id);
    if (active === m.id) setActive(null);
    // 消した要素の上では mouseleave が来ないので、ここで外す
    setHover(null);
  };
  const removeLink = (m: SlideMarkup, l: SlideLink) => {
    slides.removeLink(m.id, l.id);
    setHover(null);
  };
  const undoRemove = () => {
    const m = slides.restore();
    if (m) setActive(m.id);
  };
  const undoRef = useRef(undoRemove);
  undoRef.current = undoRemove;
  const removed = slides.lastRemoved;
  const removedSnack = useMemo<Snack | null>(
    () =>
      removed && {
        message: removed.link
          ? `${markupName(removed.markup)} から p.${removed.link.page} の${LINK_KIND_LABEL[removed.link.kind]}のリンクを外しました`
          : `${markupName(removed.markup)} を消しました${removed.markup.links.length ? `（リンク ${removed.markup.links.length} 件も）` : ""}`,
        action: { label: "元に戻す", onClick: () => undoRef.current() },
        ms: 8000,
        n: removed.n,
      },
    [removed],
  );

  // キー操作: R で囲む、V で選ぶ、F/E/T で論文側の道具、Esc で道具を戻す、Delete で選んだグループを消す、⌘Z で消したのを戻す、
  // [ / ] でスライドの面・補足情報の面へめくる
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (e.defaultPrevented || e.isComposing) return;
    // 入力中、メニューやモーダルの中、ほかの画面を重ねているときは使わない（入力欄の ⌘Z はその欄の取り消しに回す）
    if (t?.closest("input, textarea, select, [contenteditable], dialog, [role=menu], [role=dialog], .menu-surface:not(.sv-sel)")) return;
    if (document.querySelector("dialog[open], [role=dialog][aria-modal=true]")) return;
    const k = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && k === "z" && removed) {
      e.preventDefault();
      undoRemove();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.key === "Delete" || e.key === "Backspace") && activeMarkup) removeGroup(activeMarkup);
    else if (k === "r") {
      setSlideTool("box");
      toSlides();
    } else if (e.key === "[" && hasInfo) pager.go("slides");
    else if (e.key === "]" && hasInfo) pager.go("info");
    else if (k === "v") setSlideTool("select");
    else if (k === "t" && active) setPaperTool("text");
    else if (k === "f" && active) setPaperTool("figure");
    else if (k === "e" && active) setPaperTool("equation");
    // 発表の窓では、← / → / PageUp / PageDown（プレゼン用のリモコンが送るキー）でスライドを 1 ページずつ送る
    else if (presentation && (e.key === "ArrowRight" || e.key === "PageDown")) slideRef.current?.goTo(Math.min(slideCount || slidePage, slidePage + 1), 0, true);
    else if (presentation && (e.key === "ArrowLeft" || e.key === "PageUp")) slideRef.current?.goTo(Math.max(1, slidePage - 1), 0, true);
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
  /** スライド側の札の中の消すボタン。グループごと（論文側のリンクも）消す */
  const delBtn = (m: SlideMarkup) => (
    <button
      type="button"
      className="mu-del"
      aria-label={`${markupName(m)} を消す（論文のリンク ${m.links.length} 件も消えます）`}
      title={`${markupName(m)} を消す（論文のリンク ${m.links.length} 件も消えます。消したあと元に戻せます）`}
      onClick={(e) => {
        e.stopPropagation();
        removeGroup(m);
      }}
    >
      <Trash2 size={12} aria-hidden="true" />
    </button>
  );
  /** 論文側の札の中の消すボタン。このリンクだけを外し、スライド側の四角とほかのリンクは残す */
  const delLinkBtn = (m: SlideMarkup, l: SlideLink) => (
    <button
      type="button"
      className="mu-del"
      aria-label={`${markupName(m)} から、この${LINK_KIND_LABEL[l.kind]}のリンクを外す（スライドの四角は残ります）`}
      title={`この${LINK_KIND_LABEL[l.kind]}のリンクだけを外す（スライドの四角とほかのリンクは残ります。外したあと元に戻せます）`}
      onClick={(e) => {
        e.stopPropagation();
        removeLink(m, l);
      }}
    >
      <Trash2 size={12} aria-hidden="true" />
    </button>
  );

  const slideOverlay = (n: number) => (
    <>
      <div className="mu-layer">
        {(byPage.slidesBy.get(n) ?? []).map((m) => (
          // 四角（選ぶボタン）と札（消すボタン入り）を並べて包む。ボタンの中にボタンは置けないため。
          // カーソルは包みで見るので、四角から札へ動かしても札は消えない
          <div
            key={m.id}
            className={`mu${hov === m.id ? " is-hover" : ""}${dim(m.id) ? " is-dim" : ""}${rectOfMarkup(m).y < 0.05 ? " tag-inside" : ""}`}
            style={{ ...color(m), ...pos(rectOfMarkup(m)) }}
            onMouseEnter={() => setHover(m.id)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(m.id)}
            onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setHover(null)}
          >
            <button
              type="button"
              data-mk={m.id}
              className={`mu-box${m.id === active ? " is-active" : ""}`}
              aria-label={`${markupName(m)}（リンク ${m.links.length} 件）`}
              aria-pressed={m.id === active}
              onClick={() => {
                setActive(m.id === active ? null : m.id);
                if (m.id !== active && m.links[0]) showLink(m.links[0]);
              }}
            />
            <span className="mu-tag">
              <span className="mu-dot" aria-hidden="true" />
              {markupName(m)}
              {delBtn(m)}
            </span>
          </div>
        ))}
      </div>
      {slideTool === "select" && activeMarkup?.page === n && (
        <ResizeFrame
          key={activeMarkup.id}
          rect={rectOfMarkup(activeMarkup)}
          label={`${markupName(activeMarkup)} の四角`}
          style={color(activeMarkup)}
          onDraft={(rect) => setResizing(rect && { markup: activeMarkup.id, rect })}
          onCommit={(rect) => resizeMarkup(activeMarkup.id, rect)}
        />
      )}
      {slideTool === "box" && <DrawLayer label={`スライド ${n} ページ目を囲む`} onBox={(r) => addMarkup(n, r)} />}
    </>
  );

  const paperOverlay = (n: number) => (
    <>
      {sentenceMarks.has(n) && <SentenceMarkLayer marks={sentenceMarks.get(n)!} activeId={activeSentence} hoverId={null} />}
      {/* 塗りは紙に multiply で重ねる（文字が霞まない）。札と枠は別の層にして、普通に重ねる */}
      <div className="ln-fills" aria-hidden="true">
        {(byPage.paperBy.get(n) ?? []).map(({ m, l }) =>
          l.kind === "text" ? (
            <div key={l.id} className={`ln${m.id === active ? " is-active" : ""}${dim(m.id) ? " is-dim" : ""}`} style={color(m)}>
              {rectsOfLink(l).map((r, i) => <div key={i} className="ln-fill" style={pos(r)} />)}
            </div>
          ) : null,
        )}
      </div>
      <div className="ln-layer">
        {(byPage.paperBy.get(n) ?? []).map(({ m, l }) => {
          const b = boundsOf(rectsOfLink(l));
          if (!b) return null;
          const cls = `ln-${l.kind}${m.id === active ? " is-active" : ""}${dim(m.id) ? " is-dim" : ""}`;
          return (
            <div key={l.id} className={`ln ${cls}`} style={color(m)}>
              {l.kind !== "text" && <div className="ln-frame" style={pos(b)} />}
              <div className="ln-anchor" data-ln={l.id} style={pos(b)} />
              {/* 文字の選択を邪魔しないよう、カーソルを受けるのは左上の点（乗ると札に広がる）だけにする */}
              <div
                className={`ln-pin${hov === m.id ? " is-hover" : ""}${b.y < 0.05 ? " tag-inside" : ""}`}
                style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%` }}
                onMouseEnter={() => setHover(m.id)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(m.id)}
                onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setHover(null)}
              >
                <button
                  type="button"
                  className="ln-go"
                  aria-label={`${markupName(m)} の${LINK_KIND_LABEL[l.kind]}。押すとスライドへ移ります`}
                  title={`${markupName(m)} の${LINK_KIND_LABEL[l.kind]}。押すとスライドへ移ります`}
                  onClick={() => {
                    setActive(m.id);
                    toSlides();
                    showMarkup(m);
                  }}
                >
                  <span className="mu-dot" aria-hidden="true" />
                  <span className="ln-name">{markupName(m)}</span>
                </button>
                {delLinkBtn(m, l)}
              </div>
            </div>
          );
        })}
      </div>
      {activeMarkup &&
        paperTool === "text" &&
        activeMarkup.links
          .filter((l) => l.page === n && l.kind !== "text" && l.rects.length === 1)
          .map((l) => (
            <ResizeFrame
              key={l.id}
              rect={rectsOfLink(l)[0]}
              label={`${markupName(activeMarkup)} の${LINK_KIND_LABEL[l.kind]}の囲み`}
              style={color(activeMarkup)}
              onDraft={(rect) => setResizing(rect && { markup: activeMarkup.id, link: l.id, rect })}
              onCommit={(rect) => resizeLink(activeMarkup.id, l.id, n, rect)}
            />
          ))}
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
    // つまみの真ん中がカーソルの下に来るようにする（三面のときも、見えている幅の中で決める）
    const move = (ev: PointerEvent) => setRatio(clampRatio((ev.clientX - r.left - GUTTER / 2) / (el.clientWidth - GUTTER)));
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
          ? `${markupName(activeMarkup)} にリンクする文を、論文の上でドラッグして選んでください。図・数式は右上の道具で囲みます。四角の大きさは角と辺のつまみで直せます`
          : `論文の${LINK_KIND_LABEL[paperTool]}をドラッグして囲んでください（Esc でやめる）`
        : deck.markups.length
          ? "四角を押すとグループを選べます。選んでいる間、論文の該当箇所をリンクできます"
          : "「囲む」（R）でスライドの一部を四角で囲むと、グループ（Markup-ページ.番号）ができます";

  // 横にめくるタブ。矢印キーでも隣のタブへ移る
  const sides: { id: SlidesSide; label: string; key: string }[] = [
    { id: "slides", label: "スライド", key: "[" },
    { id: "info", label: "補足情報", key: "]" },
  ];
  const tabs = hasInfo && (
    <div className="sv-group sv-tabs" role="tablist" aria-label="論文の横に出す面">
      {sides.map((t) => (
        <button
          key={t.id}
          id={`sv-tab-${t.id}`}
          role="tab"
          type="button"
          className={`btn text sm${pager.side === t.id ? " is-on" : ""}`}
          aria-selected={pager.side === t.id}
          aria-controls={`sv-pane-${t.id}`}
          tabIndex={pager.side === t.id ? 0 : -1}
          title={`${t.label}を論文の${t.id === "slides" ? "左" : "右"}に出す（${t.key}）`}
          onClick={() => pager.go(t.id)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            const next: SlidesSide = e.key === "ArrowLeft" ? "slides" : "info";
            pager.go(next);
            document.getElementById(`sv-tab-${next}`)?.focus();
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
  const W = pager.width;
  const columns =
    hasInfo && W
      ? `${pager.slidesW}px ${GUTTER}px ${(1 - ratio) * (W - GUTTER)}px ${pager.slidesW + GUTTER}px`
      : `minmax(0, ${ratio}fr) ${GUTTER}px minmax(0, ${1 - ratio}fr)${hasInfo ? " 0px" : ""}`;
  const trackW = hasInfo && W ? W + pager.slidesW + GUTTER : undefined;

  return (
    <div className="sv">
      <div className="pdf-toolbar sv-toolbar" role="toolbar" aria-label="スライドと論文の操作">
        <div className="sv-group" role="group" aria-label="スライドの道具">
          <button className={`btn text sm${slideTool === "select" ? " is-on" : ""}`} aria-pressed={slideTool === "select"} title="選ぶ（V）" onClick={() => setSlideTool("select")}>
            <MousePointer2 size={14} aria-hidden="true" /> 選ぶ
          </button>
          <button className={`btn text sm${slideTool === "box" ? " is-on" : ""}`} aria-pressed={slideTool === "box"} title="スライドの一部を四角で囲む（R）" onClick={() => {
            setSlideTool((t) => (t === "box" ? "select" : "box"));
            if (slideTool !== "box") toSlides();
          }}>
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
        {presentation ? (
          <button className="btn text sm sv-fs-btn" title="発表の窓を閉じる（台本の窓は元の画面に戻ります）" onClick={onFullscreen}>
            <X size={14} aria-hidden="true" /> 発表を終える
          </button>
        ) : canOpenPresenter && !fullscreen ? (
          <button className="btn text sm sv-fs-btn" title="スライドと論文を別の窓に全画面で映し、この窓に台本（グループのメモとリンク）を出す（P）" onClick={onFullscreen}>
            <Presentation size={14} aria-hidden="true" /> 発表
          </button>
        ) : (
          <button className="btn text sm sv-fs-btn" title={fullscreen ? "全画面を終える（P / Esc）" : "スライドと論文を全画面で表示する（P）"} onClick={onFullscreen}>
            {fullscreen ? <Minimize size={14} aria-hidden="true" /> : <Maximize size={14} aria-hidden="true" />} {fullscreen ? "全画面を終える" : "全画面"}
          </button>
        )}
        {tabs}
        <HelpButton chapter="slides" />
      </div>
      {/* 線と知らせは、横に動く中身ではなく見えている枠（.sv-stage）に重ねる */}
      <div className="sv-stage">
        <div ref={splitRef} className={`sv-split${hasInfo ? " is-pager" : ""}`}>
          <div className="sv-track" style={{ gridTemplateColumns: columns, width: trackW }}>
            <section
              id="sv-pane-slides"
              className={`sv-pane sv-slides${slideTool === "box" ? " is-drawing" : ""}`}
              aria-label="発表スライド"
              inert={pager.slidesOff || undefined}
              aria-hidden={pager.slidesOff || undefined}
            >
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
                onClick={onPaperClick}
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
            {hasInfo && (
              <section id="sv-pane-info" className="sv-pane sv-info" aria-label="補足情報" inert={pager.infoOff || undefined} aria-hidden={pager.infoOff || undefined}>
                <div className="sv-pane-head">
                  <span className="sv-pane-title">補足情報</span>
                </div>
                <div className="sv-info-body">{info}</div>
              </section>
            )}
          </div>
        </div>
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
        {/* 元に戻す知らせは分割の中に出す（この画面だけを全画面にしても見えるように） */}
        <Snackbar snack={removedSnack} onClose={slides.dismissRemoved} className="sv-snack" inline />
      </div>
    </div>
  );
}

const pos = (r: Rect): CSSProperties => ({ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });

type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const EDGES: Edge[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const EDGE_LABEL: Record<Edge, string> = { n: "上の辺", s: "下の辺", e: "右の辺", w: "左の辺", ne: "右上の角", nw: "左上の角", se: "右下の角", sw: "左下の角" };
/** これより小さくはしない（ページに対する割合） */
const MIN_SIZE = 0.01;

/** rect の edge の側を (dx, dy) だけ動かす。反対側は動かさず、MIN_SIZE より小さくしない */
function moveEdge(r: Rect, edge: Edge, dx: number, dy: number): Rect {
  let x1 = r.x;
  let y1 = r.y;
  let x2 = r.x + r.w;
  let y2 = r.y + r.h;
  if (edge.includes("w")) x1 = Math.min(x2 - MIN_SIZE, x1 + dx);
  if (edge.includes("e")) x2 = Math.max(x1 + MIN_SIZE, x2 + dx);
  if (edge.includes("n")) y1 = Math.min(y2 - MIN_SIZE, y1 + dy);
  if (edge.includes("s")) y2 = Math.max(y1 + MIN_SIZE, y2 + dy);
  return normalizeRect({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
}

/** 選んでいる四角の大きさを直すつまみ。ドラッグの途中は onDraft で見せ、離したときに onCommit で保存する。
 *  つまみにフォーカスして矢印キーでも動かせる（Shift で大きく） */
function ResizeFrame({ rect, label, style, onDraft, onCommit }: { rect: Rect; label: string; style: CSSProperties; onDraft: (r: Rect | null) => void; onCommit: (r: Rect) => void }) {
  const drag = useRef<{ edge: Edge; w: number; h: number; x: number; y: number; start: Rect; last: Rect } | null>(null);
  const at = (e: React.PointerEvent) => {
    const d = drag.current!;
    return moveEdge(d.start, d.edge, (e.clientX - d.x) / d.w, (e.clientY - d.y) / d.h);
  };
  const end = (commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (d && commit && JSON.stringify(d.last) !== JSON.stringify(d.start)) onCommit(d.last);
    else onDraft(null);
  };
  return (
    <div className="rz-layer">
      <div className="rz" style={{ ...style, ...pos(rect) }} role="group" aria-label={`${label}の大きさ`}>
        {EDGES.map((edge) => (
          <div
            key={edge}
            className={`rz-h rz-${edge}`}
            role="button"
            tabIndex={0}
            aria-label={`${label}の${EDGE_LABEL[edge]}（矢印キーで動かす）`}
            title="ドラッグして大きさを直す"
            onPointerDown={(e) => {
              const page = e.currentTarget.closest<HTMLElement>(".pp-page")?.getBoundingClientRect();
              if (e.button !== 0 || !page) return;
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { edge, w: page.width, h: page.height, x: e.clientX, y: e.clientY, start: rect, last: rect };
            }}
            onPointerMove={(e) => {
              if (!drag.current) return;
              drag.current.last = at(e);
              onDraft(drag.current.last);
            }}
            onPointerUp={(e) => {
              if (drag.current) drag.current.last = at(e);
              end(true);
            }}
            onPointerCancel={() => end(false)}
            onLostPointerCapture={() => drag.current && end(true)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 0.02 : 0.005;
              const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
              if (!d) return;
              e.preventDefault();
              e.stopPropagation();
              // 辺のつまみは、その辺の向きにだけ動かす
              const [dx, dy] = d;
              const next = moveEdge(rect, edge, /[ew]/.test(edge) ? dx : 0, /[ns]/.test(edge) ? dy : 0);
              if (JSON.stringify(next) !== JSON.stringify(rect)) onCommit(next);
            }}
          />
        ))}
      </div>
    </div>
  );
}

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
