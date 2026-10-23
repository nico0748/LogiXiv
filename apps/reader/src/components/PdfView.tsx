import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { attachGlyphs, type FontLike, layoutGlyphs } from "../lib/glyphs.ts";
import type { Highlight, MarkerColor, Rect } from "../lib/model.ts";
import { fromDisplay, type LaidItem, layoutItems, mergeLineRects, segmentRects, type Segment, type TextItemLike, textRotation, toDisplay } from "../lib/pageText.ts";
import { findText } from "../lib/findText.ts";
import { openPdf } from "../lib/pdf.ts";
import { type Pt, segmentText, snapSegments } from "../lib/selection.ts";
import { attachEndOfContent } from "../lib/textSelection.ts";
import type { Pos } from "../lib/position.ts";
import { getPref } from "../lib/prefs.ts";
import { setSentenceFocus, setSentenceMarksVisible, useSentenceFocus, useSentenceMarksVisible } from "../lib/sentenceFocus.ts";
import { type SentenceMark, hitTest, marksByPage, sentenceAnchor, successorSentence } from "../lib/sentencesView.ts";
import { SentenceMarkLayer } from "./sentences/SentenceMarks.tsx";
import { useSentences } from "./sentences/useSentences.ts";

/** ページの大きさ（拡大率 1 のとき） */
type Size = { w: number; h: number };


export interface SelectionInfo {
  page: number;
  rects: Rect[];
  text: string;
  around: string;
  /** 選択範囲を切り出した PNG（base64）。数式の書き起こしに使う。 */
  crop: () => string | null;
}

export type SelectionAction =
  | { kind: "mark"; color: MarkerColor }
  | { kind: "translate" }
  | { kind: "term" }
  | { kind: "tex" };

interface Props {
  data: ArrayBuffer;
  highlights: Highlight[];
  activeId: string | null;
  onAction: (a: SelectionAction, s: SelectionInfo) => void;
  onHighlightClick: (id: string) => void;
  onLoaded?: (doc: PDFDocumentProxy) => void;
  /** 移動の指示。instant のときは、離れていなくてもすぐに移る（「先頭に戻る」など） */
  jumpTo?: { page: number; y: number; n: number; instant?: boolean } | null;
  /** 前回の位置。全ページの寸法がそろった直後に 1 回だけ使う。先に jumpTo が来ていれば使わない */
  initialPos?: Pos | null;
  /** 前回の位置へ移動したときに呼ぶ */
  onRestored?: (page: number) => void;
  /** スクロールのたびに、今の位置を知らせる（requestAnimationFrame で間引く） */
  onPosition?: (pos: Pos) => void;
  /** 開いている論文の id。あれば対訳の文の枠を描き、対訳タブと選択を同期する。 */
  paperId?: string | null;
  /** そのページの先頭までスクロールする。nonce が変わるたびに動く。 */
  scrollToPage?: { page: number; nonce: number };
  /**
   * 論文中の場所を示す（用語・数式のカードから）。n が変わるたびに動く。
   * rects があればそこを、無ければ needles の語を page（無ければ先頭）から順に本文で探して光らせる。
   */
  locate?: LocateRequest | null;
  /** 探しても本文に見つからなかったとき */
  onLocateMiss?: (req: LocateRequest) => void;
  /** 枠で囲むモード（数式の場所を指定する）。囲み終えると onBox、Esc で onBoxCancel */
  boxing?: boolean;
  onBox?: (page: number, rect: Rect) => void;
  onBoxCancel?: () => void;
}

export interface LocateRequest {
  page?: number;
  rects?: Rect[];
  needles?: string[];
  n: number;
}

/** 場所を光らせておく時間（ms） */
const FLASH_MS = 2600;

/** 文の枠が無いページに渡す配列。毎回 [] を作ると memo が外れる。 */
const NO_MARKS: SentenceMark[] = [];

const COLORS: MarkerColor[] = ["yellow", "cyan", "magenta", "green"];

export function PdfView({ data, highlights, activeId, onAction, onHighlightClick, onLoaded, jumpTo, initialPos, onRestored, onPosition, paperId, scrollToPage, locate, onLocateMiss, boxing, onBox, onBoxCancel }: Props) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  /** 全ページの寸法。そろうまではページを描かない（仮の高さで並べると、移動先がずれるため） */
  const [sizes, setSizes] = useState<Size[] | null>(null);
  const [curPage, setCurPage] = useState(1);
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  /** 寸法がそろう前に来た移動の指示 */
  const pendingJump = useRef<Props["jumpTo"]>(null);
  const initialRef = useRef(initialPos);
  const posRef = useRef({ onPosition, onRestored });
  posRef.current = { onPosition, onRestored };
  const curPageRef = useRef(curPage);
  curPageRef.current = curPage;
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;
  const [error, setError] = useState<string | null>(null);
  // 開いたときの倍率は設定（表示 → PDF）で決める
  const [zoom, setZoom] = useState(() => getPref("pdfZoom"));
  const [width, setWidth] = useState(800);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; sel: SelectionInfo } | null>(null);
  const texts = useRef(new Map<number, string>());

  // 対訳の文の枠。解析済みのときだけ描く。
  const sentences = useSentences(paperId);
  const sdoc = sentences.state?.status === "ready" ? sentences.state.document : null;
  const marksVisible = useSentenceMarksVisible();
  const markMap = useMemo(() => (sdoc ? marksByPage(sdoc) : null), [sdoc]);
  const focus = useSentenceFocus();
  const activeSentence = paperId && focus.paperId === paperId ? focus.id : null;
  const pickSentence = useCallback((m: SentenceMark) => paperId && setSentenceFocus(paperId, m.id, m.hash, "pdf"), [paperId]);

  // 選んでいた文が結合・分割で消えたら、後を継いだ文を選び直す。
  // そのままだと PDF の枠も対訳のカードも選択が外れ、結合・分割の結果が PDF に出ていないように見える。
  const prevDoc = useRef(sdoc);
  useEffect(() => {
    const prev = prevDoc.current;
    prevDoc.current = sdoc;
    if (!sdoc || !prev || !paperId || focus.paperId !== paperId || !focus.id) return;
    const now = sdoc.structure.sentences;
    if (now.some((x) => x.id === focus.id)) return;
    const gone = prev.structure.sentences.find((x) => x.id === focus.id);
    const next = gone && successorSentence(gone, now);
    // PDF は既にその位置を見せているので動かさず、対訳タブだけ後継のカードへ寄せる
    if (next) setSentenceFocus(paperId, next.id, next.hash, "auto");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdoc]);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setSizes(null);
    setError(null);
    texts.current.clear();
    const task = openPdf(data);
    task.promise.then(
      async (d) => {
        if (cancelled) return;
        setDoc(d);
        onLoaded?.(d);
        // getPage は描画を伴わないので、全ページでも短い時間で終わる
        // 読み終わる前に文書を閉じた（論文を替えた）ときの失敗は捨てる。ここで拾わないと、捕まえていない失敗になる
        const all = await Promise.all(
          Array.from({ length: d.numPages }, (_, i) =>
            d.getPage(i + 1).then((p) => {
              const v = p.getViewport({ scale: 1 });
              return { w: v.width, h: v.height };
            }),
          ),
        ).catch(() => null);
        if (!cancelled && all) setSizes(all);
      },
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
      void task.destroy();
    };
    // onLoaded は取り込み時だけ使うため依存に含めない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(320, el.clientWidth - 32)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** ページの中の位置へ移る。y はページの高さに対する割合、margin は上に空ける幅（px） */
  const goTo = useCallback((page: number, y: number, smooth: boolean, margin = 0) => {
    const box = scrollRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-page="${page}"]`);
    if (!box || !el) return;
    box.scrollTo({ top: Math.max(0, el.offsetTop + el.offsetHeight * y - margin), behavior: smooth ? "smooth" : "auto" });
    setCurPage(page);
  }, []);

  const jump = useCallback(
    (j: NonNullable<Props["jumpTo"]>) => {
      if (j.instant) return goTo(j.page, j.y, false);
      // 遠くへ smooth で移ると途中のページをすべて描くので、3 ページ以上離れていればすぐに移る
      goTo(j.page, j.y, Math.abs(j.page - curPageRef.current) < 3, 120);
    },
    [goTo],
  );

  useEffect(() => {
    if (!jumpTo) return;
    if (!sizesRef.current) pendingJump.current = jumpTo;
    else jump(jumpTo);
    // jumpTo が変わったときだけ動かす
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo]);

  // 寸法がそろい、ページを並べた直後: 先に来た移動の指示か、前回の位置へ移る
  useEffect(() => {
    if (!sizes) return;
    const j = pendingJump.current;
    const init = initialRef.current;
    pendingJump.current = null;
    initialRef.current = null;
    if (j) jump(j);
    else if (init && init.page <= sizes.length) {
      goTo(init.page, init.y, false);
      posRef.current.onRestored?.(init.page);
    }
  }, [sizes, jump, goTo]);

  // 今のページ（表示している範囲の上から 1/3 の位置にあるページ）と、上端の位置を知らせる
  const frame = useRef(0);
  const onScroll = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const box = scrollRef.current;
      if (!box) return;
      const els = box.querySelectorAll<HTMLElement>(".pdf-page");
      if (!els.length) return;
      const probe = box.scrollTop + box.clientHeight / 3;
      // ページは上から順に並ぶので、二分探索で探す
      let lo = 0;
      let hi = els.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (els[mid].offsetTop <= probe) lo = mid;
        else hi = mid - 1;
      }
      const el = els[lo];
      const page = lo + 1;
      setCurPage(page);
      posRef.current.onPosition?.({ page, y: (box.scrollTop - el.offsetTop) / el.offsetHeight });
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const commitPage = () => {
    if (pageDraft === null || !doc) return;
    const n = Number.parseInt(pageDraft, 10);
    setPageDraft(null);
    if (!Number.isFinite(n)) return;
    // 範囲外の数値は、1 か最後のページに丸める
    goTo(Math.min(doc.numPages, Math.max(1, n)), 0, false, 8);
  };

  // 対訳タブ（やキー操作）で選んだ文まで動かす。PDF 上で選んだときは動かさない。
  useEffect(() => {
    if (!sdoc || !paperId || focus.paperId !== paperId || !focus.id || focus.origin === "pdf" || focus.origin === "auto") return;
    const at = sentenceAnchor(sdoc, focus.id);
    if (at) goTo(at.page, at.y, focus.origin === "panel", 120);
    // 選び直したとき（nonce）だけ動かす。訳が届いて文書が変わっただけでは動かさない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.nonce]);

  // リストから来たページへの移動。寸法がそろう前なら、そろってから移る
  useEffect(() => {
    if (!scrollToPage) return;
    const j = { page: scrollToPage.page, y: 0, n: scrollToPage.nonce, instant: true };
    if (!sizesRef.current) pendingJump.current = j;
    else jump(j);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToPage?.nonce]);

  // 用語・数式の場所を光らせる
  const [flash, setFlash] = useState<{ page: number; rects: Rect[]; n: number } | null>(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(t);
  }, [flash]);
  const missRef = useRef(onLocateMiss);
  missRef.current = onLocateMiss;
  useEffect(() => {
    if (!locate || !doc || !sizes) return;
    let cancelled = false;
    void (async () => {
      let hit = locate.page && locate.rects?.length ? { page: locate.page, rects: locate.rects } : null;
      if (!hit && locate.needles?.length) {
        // 指定のページを先に、続けて先頭から探す
        const order = Array.from({ length: doc.numPages }, (_, i) => i + 1);
        if (locate.page && locate.page <= doc.numPages) order.unshift(...order.splice(locate.page - 1, 1));
        search: for (const n of order) {
          const m = await pageModel(doc, n);
          if (cancelled) return;
          if (!m) continue;
          const pt = { page: n, width: 0, height: 0, rotation: m.rotation, text: "", items: m.items };
          for (const needle of locate.needles) {
            const found = findText([pt], needle);
            if (found?.rects.length) {
              hit = { page: n, rects: found.rects };
              break search;
            }
          }
        }
      }
      if (cancelled) return;
      if (!hit) {
        if (locate.page) goTo(locate.page, 0, Math.abs(locate.page - curPageRef.current) < 3, 0);
        missRef.current?.(locate);
        return;
      }
      goTo(hit.page, hit.rects[0].y, Math.abs(hit.page - curPageRef.current) < 3, 160);
      setFlash({ ...hit, n: locate.n });
    })();
    return () => {
      cancelled = true;
    };
    // 指示（n）が来たときだけ動かす。文書や寸法が後からそろったら、そのときに動かす
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locate?.n, doc, sizes]);

  // 囲むモードは Esc でやめる
  const cancelRef = useRef(onBoxCancel);
  cancelRef.current = onBoxCancel;
  useEffect(() => {
    if (!boxing) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancelRef.current?.();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [boxing]);

  const pageText = useCallback(
    async (n: number) => {
      if (!doc) return "";
      const hit = texts.current.get(n);
      if (hit !== undefined) return hit;
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      const t = tc.items
        .map((i) => ("str" in i ? i.str + (i.hasEOL ? "\n" : "") : ""))
        .join("")
        .replace(/-\n/g, "")
        .replace(/\s*\n\s*/g, " ");
      texts.current.set(n, t);
      return t;
    },
    [doc],
  );

  // 押した位置・今の位置（client 座標）。選択の端をグリフで決め直すのに使う（src/lib/selection.ts）
  const pointer = useRef<{ down: { x: number; y: number } | null; cur: { x: number; y: number }; dragging: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    // 押したのがページの文字の上でなければ（選択メニューのボタンなど）、選択の端とは関係ない
    if (e.button !== 0 || !(e.target as HTMLElement).closest?.(".textLayer")) {
      pointer.current = null;
      return;
    }
    // Shift+クリック（選択の延長）は、押した位置が選択の端ではない
    const down = e.shiftKey ? null : { x: e.clientX, y: e.clientY };
    pointer.current = { down, cur: { x: e.clientX, y: e.clientY }, dragging: true };
  };
  // 位置は PointerEvent から取る（MouseEvent の clientX は整数 px に丸められ、細い字では半文字ずれる）
  const onPointerMove = (e: React.PointerEvent) => {
    const p = pointer.current;
    if (p?.dragging && e.buttons & 1) p.cur = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const p = pointer.current;
    if (!p?.dragging) return;
    p.cur = { x: e.clientX, y: e.clientY };
    p.dragging = false;
  };

  /**
   * 今の選択を、グリフに合わせた矩形にする。最初と最後の文字は、押した位置・離した位置から決め直す。
   * そのページの文字の位置がまだ求まっていなければ null（ブラウザの選択の表示に任せる）。
   */
  const snappedSelection = useCallback(
    (model: PageModel | null, startEl: HTMLElement, range: Range, forward: boolean) => {
      const tl = startEl.querySelector<HTMLElement>(".textLayer");
      const layer = tl ? textLayers.get(tl) : undefined;
      if (!layer || !model || !tl) return null;
      const native = selectionSegments(range, layer, model);
      if (!native.length) return null;
      const pr = startEl.getBoundingClientRect();
      const toFrame = (p: { x: number; y: number } | null): Pt | null => {
        if (!p || pr.width <= 0 || pr.height <= 0) return null;
        const [x, y] = fromDisplay((p.x - pr.left) / pr.width, (p.y - pr.top) / pr.height, model.rotation);
        return { x, y };
      };
      const p = pointer.current;
      let segs = native;
      // 押したまま動かしていない（ダブルクリック・トリプルクリックで語や行を選んだ）なら、ブラウザの選択のまま
      const dragged = !p?.down || Math.hypot(p.cur.x - p.down.x, p.cur.y - p.down.y) >= 4;
      if (p && dragged) {
        const anchor = toFrame(p.down);
        const focus = toFrame(p.cur);
        // 終わりが別のページ（のテキスト層の外）なら、そちらの端は決め直さない
        const endHere = tl.contains(range.endContainer);
        const start = forward ? anchor : focus;
        const end = forward ? focus : anchor;
        segs = snapSegments(model.items, native, start, endHere ? end : null);
      }
      const rects = segmentRects(model.items, segs).map((r) => toDisplay(r, model.rotation));
      return { segs, native, rects, layer, forward };
    },
    [],
  );

  // 選んでいる間の表示: ブラウザの選択の色はテキスト層（グリフからずれている）に付くので消し、
  // グリフに合わせた矩形を描く（ページの .sel-preview に直接描く。ドラッグ中に React を描き直さない）
  const previewFrame = useRef(0);
  const updatePreview = useCallback(() => {
    previewFrame.current = 0;
    const box = scrollRef.current;
    if (!box) return;
    const clear = () => {
      box.classList.remove("sel-snapped");
      box.querySelectorAll(".sel-preview").forEach((el) => el.childElementCount && el.replaceChildren());
    };
    const cur = currentSelection(pointer.current);
    if (!cur || !doc) return clear();
    const { range, forward } = cur;
    const startEl = range.startContainer.parentElement?.closest<HTMLElement>(".pdf-page");
    if (!startEl || !box.contains(startEl)) return clear();
    const pageNo = Number(startEl.dataset.page);
    const s = snappedSelection(readyModel(doc, pageNo), startEl, range, forward);
    if (!s) return clear();
    box.querySelectorAll<HTMLElement>(".sel-preview").forEach((el) => {
      if (el.parentElement !== startEl) {
        if (el.childElementCount) el.replaceChildren();
        return;
      }
      el.replaceChildren(
        ...s.rects.map((r) => {
          const d = document.createElement("div");
          d.style.cssText = `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%`;
          return d;
        }),
      );
    });
    box.classList.add("sel-snapped");
  }, [doc, snappedSelection]);
  useEffect(() => {
    const onChange = () => {
      if (!previewFrame.current) previewFrame.current = requestAnimationFrame(updatePreview);
    };
    // キーで選択を変えたら、押した位置はもう選択の端ではない
    const onKey = (e: KeyboardEvent) => e.shiftKey && pointer.current && (pointer.current = null);
    document.addEventListener("selectionchange", onChange);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("selectionchange", onChange);
      document.removeEventListener("keydown", onKey);
      cancelAnimationFrame(previewFrame.current);
      previewFrame.current = 0;
    };
  }, [updatePreview]);

  const onMouseUp = useCallback(
    async () => {
      const sel = window.getSelection();
      const cur = currentSelection(pointer.current);
      if (!sel || !cur || !scrollRef.current) return setMenu(null);
      const { range, forward } = cur;
      const startEl = (range.startContainer.parentElement ?? null)?.closest<HTMLElement>(".pdf-page");
      if (!startEl) return setMenu(null);
      const pageNo = Number(startEl.dataset.page);
      // 横位置は描画命令から求めたグリフの位置、縦は行の帯（テキスト層の代わりのフォントでは文頭・文末も高さもずれる）
      const model = doc ? await pageModel(doc, pageNo) : null;
      const pr = startEl.getBoundingClientRect();
      const snapped = snappedSelection(model, startEl, range, forward);
      let text = sel.isCollapsed ? range.toString() : sel.toString();
      if (snapped && model) {
        const { segs, native, layer } = snapped;
        const changed = segs.length !== native.length || segs.some((s, i) => s.k !== native[i].k || s.a !== native[i].a || s.b !== native[i].b);
        if (changed || sel.isCollapsed) {
          // ブラウザの選択も合わせる（コピーした文字列と、テキスト層の選択の端がマーカーと一致する）
          const first = layer.textDivs[segs[0].k]?.firstChild;
          const last = layer.textDivs[segs[segs.length - 1].k]?.firstChild;
          const end = segs[segs.length - 1].b;
          // 向きは保つ（後ろから選んだときは、押した側が後ろの端のまま）
          if (first && last) {
            if (forward) sel.setBaseAndExtent(first, segs[0].a, last, end);
            else sel.setBaseAndExtent(last, end, first, segs[0].a);
          }
          text = segmentText(model.items, segs);
        }
      }
      // ドラッグが選択にならなかったとき（currentSelection）は、作った範囲をブラウザの選択にする
      if (sel.isCollapsed) sel.setBaseAndExtent(range.startContainer, range.startOffset, range.endContainer, range.endOffset);
      text = text.replace(/-\n/g, "").replace(/\s+/g, " ").trim();
      if (!text) return setMenu(null);
      const rects = snapped
        ? snapped.rects
        : mergeLineRects(
            [...range.getClientRects()]
              .filter((r) => r.width > 1 && r.height > 1)
              .filter((r) => r.top >= pr.top - 2 && r.bottom <= pr.bottom + 2)
              .map((r) => toFraction(r, pr))
              .sort((a, b) => a.y - b.y || a.x - b.x),
          );
      if (!rects.length) return setMenu(null);
      const full = await pageText(pageNo);
      const around = surrounding(full, text);
      const canvas = startEl.querySelector("canvas");
      const crop = () => (canvas ? cropCanvas(canvas, rects) : null);
      const sr = scrollRef.current.getBoundingClientRect();
      // メニューは選択の最後の行の下に出す
      const lastRect = rects[rects.length - 1];
      const right = pr.left + (lastRect.x + lastRect.w) * pr.width;
      const bottom = pr.top + (lastRect.y + lastRect.h) * pr.height;
      setMenu({
        x: Math.min(right - sr.left, sr.width - 360),
        y: bottom - sr.top + scrollRef.current.scrollTop + 6,
        sel: { page: pageNo, rects, text, around, crop },
      });
    },
    [pageText, doc, snappedSelection],
  );

  const run = (a: SelectionAction) => {
    if (!menu) return;
    onAction(a, menu.sel);
    setMenu(null);
    window.getSelection()?.removeAllRanges();
  };

  const pages = useMemo(() => (sizes ? sizes.map((_, i) => i + 1) : []), [sizes]);

  return (
    <>
      <div className="pdf-toolbar" role="toolbar" aria-label="表示の操作">
        {doc ? (
          <>
            <input
              className="input page-input"
              type="number"
              inputMode="numeric"
              aria-label="ページ番号"
              min={1}
              max={doc.numPages}
              value={pageDraft ?? String(curPage)}
              onChange={(e) => setPageDraft(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitPage();
                if (e.key === "Escape") setPageDraft(null);
              }}
              onBlur={commitPage}
            />
            <span>/ {doc.numPages} ページ</span>
          </>
        ) : (
          <span>読み込み中</span>
        )}
        <span className="spacer" />
        {boxing && (
          <span className="box-hint" role="status">
            数式をドラッグで囲んでください
            <button className="btn text sm" onClick={() => onBoxCancel?.()}>やめる（Esc）</button>
          </span>
        )}
        {sdoc && (
          <button
            className={`btn text sm sl-marks-toggle${marksVisible ? " is-on" : ""}`}
            aria-pressed={marksVisible}
            title={marksVisible ? "PDF の文の枠を隠す" : "PDF に文の枠を出す（押すと対訳のカードへ）"}
            onClick={() => setSentenceMarksVisible(!marksVisible)}
          >
            文の枠
          </button>
        )}
        <button className="icon-btn" aria-label="縮小" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))}>−</button>
        <span style={{ minWidth: 44, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
        <button className="icon-btn" aria-label="拡大" onClick={() => setZoom((z) => Math.min(3, +(z + 0.1).toFixed(2)))}>＋</button>
        <button className="btn text sm" onClick={() => setZoom(1)}>幅に合わせる</button>
      </div>
      <div
        className="pdf-scroll"
        ref={scrollRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onMouseUp={onMouseUp}
        onScroll={onScroll}
        style={{ position: "relative" }}
      >
        {error && <p className="err-msg">PDF を開けませんでした。{error}</p>}
        {doc &&
          sizes &&
          pages.map((n) => (
            <PageView
              key={n}
              doc={doc}
              n={n}
              size={sizes[n - 1]}
              width={width * zoom}
              highlights={highlights.filter((h) => h.page === n)}
              activeId={activeId}
              onHighlightClick={onHighlightClick}
              marks={markMap?.get(n) ?? NO_MARKS}
              showMarks={marksVisible}
              activeSentence={activeSentence}
              onPickSentence={pickSentence}
              flash={flash?.page === n ? flash : null}
              onBox={boxing ? onBox : undefined}
            />
          ))}
        {menu && (
          <div
            className="sel-menu menu-surface"
            style={{ left: Math.max(8, menu.x - 180), top: menu.y }}
            onMouseUp={(e) => e.stopPropagation()}
            role="menu"
            aria-label="選択した文への操作"
          >
            {COLORS.map((c) => (
              <button
                key={c}
                className={`swatch ${c}`}
                aria-label={`${COLOR_NAME[c]}のマーカーを引く`}
                title={`${COLOR_NAME[c]}のマーカー`}
                onClick={() => run({ kind: "mark", color: c })}
              />
            ))}
            <span className="sep" />
            <button className="btn" onClick={() => run({ kind: "translate" })}>訳す</button>
            <button className="btn" onClick={() => run({ kind: "term" })}>用語を調べる</button>
            <button className="btn" onClick={() => run({ kind: "tex" })}>数式にする</button>
          </div>
        )}
      </div>
    </>
  );
}

const COLOR_NAME: Record<MarkerColor, string> = { yellow: "黄色", cyan: "水色", magenta: "桃色", green: "緑色" };

function PageView({
  doc,
  n,
  size,
  width,
  highlights,
  activeId,
  onHighlightClick,
  marks,
  showMarks,
  activeSentence,
  onPickSentence,
  flash,
  onBox,
}: {
  doc: PDFDocumentProxy;
  n: number;
  size: Size;
  width: number;
  highlights: Highlight[];
  activeId: string | null;
  onHighlightClick: (id: string) => void;
  /** このページの文の枠。枠を隠していてもクリックの当たりには使う（論文の文から対訳のカードへ移れるように） */
  marks: SentenceMark[];
  /** 文の枠をすべて描くか。false でも選んだ文の枠だけは描く */
  showMarks: boolean;
  activeSentence: string | null;
  onPickSentence: (m: SentenceMark) => void;
  /** このページで光らせる場所 */
  flash: { rects: Rect[]; n: number } | null;
  /** あれば囲むモード。ドラッグで囲んだ枠（ページに対する割合）を渡す */
  onBox?: (page: number, rect: Rect) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [visible, setVisible] = useState(n <= 2);
  const [hover, setHover] = useState<string | null>(null);
  // 選択中の文がこのページに無ければ null を渡し、他のページの枠を描き直さない
  const pageActive = activeSentence && marks.some((m) => m.id === activeSentence) ? activeSentence : null;
  // 枠を隠しているときは、選んだ文の枠だけを描く
  const drawn = useMemo(() => (showMarks ? marks : pageActive ? marks.filter((m) => m.id === pageActive) : NO_MARKS), [showMarks, marks, pageActive]);

  // 文の枠はテキスト層の下にあるので、当たりは座標で取る（文字の選択を邪魔しないため）
  const markAt = (e: React.MouseEvent): SentenceMark | null => {
    if (!marks.length || !boxRef.current) return null;
    const r = boxRef.current.getBoundingClientRect();
    return hitTest(marks, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };
  const onMove = (e: React.MouseEvent) => {
    if (!showMarks || !marks.length || e.buttons) return;
    const id = markAt(e)?.id ?? null;
    if (id !== hover) setHover(id);
  };
  // 押した時点で文字が選ばれていたら、そのクリックは選択を外すためのもの。文は選ばない
  const hadSelection = useRef(false);
  const onMouseDown = () => {
    const sel = window.getSelection();
    hadSelection.current = !!sel && !sel.isCollapsed;
  };
  const onClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, .sel-menu")) return;
    if (hadSelection.current || e.detail > 1) return; // 選択を外すクリックと、語を選ぶダブルクリック
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // 文字を選んだだけのときは文を選ばない
    const m = markAt(e);
    if (m) onPickSentence(m);
  };

  useEffect(() => {
    // 描き終わる前に文書を閉じたときの失敗は捨てる
    doc.getPage(n).then(setPage, () => undefined);
  }, [doc, n]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setVisible(true), {
      rootMargin: "800px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // 大きさは先に集めた寸法から決める。ページを読み込む前から正しい高さで並ぶ
  const scale = width / size.w;
  const vp = page?.getViewport({ scale });

  useEffect(() => {
    if (!page || !vp || !visible || !canvasRef.current || !textRef.current) return;
    const canvas = canvasRef.current;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = `${vp.width}px`;
    canvas.style.height = `${vp.height}px`;
    const task = page.render({
      canvas,
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    const tl = textRef.current;
    tl.replaceChildren();
    const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp });
    textLayers.set(tl, layer);
    // pdf.js はテキスト層を回転前の向き・大きさで組み、styles.css の [data-main-rotation] で層ごと回す。
    // 大きさの式（round(down, …, var(--scale-round-x))）はビューアの変数が無いと効かないので、ここで決める
    const turned = vp.rotation % 180 !== 0;
    tl.style.width = `${turned ? vp.height : vp.width}px`;
    tl.style.height = `${turned ? vp.width : vp.height}px`;
    let detach: (() => void) | null = null;
    let cancelled = false;
    void layer.render().then(
      () => {
        if (cancelled) return;
        // 文字の無いところへ指が出ても選択が飛ばないように（src/lib/textSelection.ts）
        detach = attachEndOfContent(tl);
        // 選んだときに待たないよう、グリフの位置を先に求めておく
        void pageModel(doc, n);
      },
      () => undefined,
    );
    task.promise.catch(() => undefined);
    return () => {
      cancelled = true;
      detach?.();
      task.cancel();
      layer.cancel();
    };
    // vp はスケールから決まるため scale を依存にする
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, scale, visible]);

  const w = width;
  const h = size.h * scale;
  return (
    <div
      className="pdf-page"
      data-page={n}
      ref={boxRef}
      style={{ width: w, height: h, ["--total-scale-factor" as string]: scale }}
      onMouseMove={onMove}
      onMouseLeave={() => hover && setHover(null)}
      onMouseDown={onMouseDown}
      onClick={onClick}
      data-sl-hover={hover ? "" : undefined}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      <div className="mk-layer">
        {highlights.flatMap((hl) =>
          hl.rects.map((r, i) => (
            <div
              key={`${hl.id}-${i}`}
              className={`mk ${hl.color}${hl.id === activeId ? " active" : ""}`}
              style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
            />
          )),
        )}
      </div>
      {drawn.length > 0 && <SentenceMarkLayer marks={drawn} activeId={pageActive} hoverId={showMarks ? hover : null} />}
      {/* 選んでいる範囲（グリフに合わせた矩形）。中身は PdfView の updatePreview が直接描く */}
      <div className="sel-preview" aria-hidden="true" />
      <div className="textLayer" ref={textRef} />
      {highlights.length > 0 && (
        <div style={{ position: "absolute", inset: 0, zIndex: 3, pointerEvents: "none" }}>
          {highlights.map((hl) => {
            const r = hl.rects[0];
            // 位置が分からないマーカー（AI エージェントが本文から見つけられなかったもの）は、訳タブにだけ出す
            if (!r) return null;
            // 印は本文に重ねない: マーカーの最初の行の高さで、近い側のページの余白に置く
            // （以前は行末の 2px 右に置いていて、文の途中で終わるマーカーでは次の語を隠していた）
            const nearLeft = r.x + r.w / 2 < 0.5;
            return (
              <button
                key={hl.id}
                aria-label={`p.${n} のマーカーを開く`}
                title="マーカーを開く"
                onClick={() => onHighlightClick(hl.id)}
                style={{
                  position: "absolute", ...(nearLeft ? { left: 4 } : { right: 4 }), top: `calc(${(r.y + r.h / 2) * 100}% - 5px)`,
                  width: 10, height: 10, borderRadius: 5, padding: 0, border: "1px solid rgba(0,0,0,.35)",
                  background: `var(--mk-${hl.color})`, pointerEvents: "auto", cursor: "pointer",
                }}
              />
            );
          })}
        </div>
      )}
      {flash && (
        <div className="locate-layer" aria-hidden="true" key={flash.n}>
          {flash.rects.map((r, i) => (
            <div key={i} className="locate-flash" style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }} />
          ))}
        </div>
      )}
      {onBox && <BoxCapture onBox={(r) => onBox(n, r)} />}
      <span className="page-no">{n}</span>
    </div>
  );
}

/** 囲むモードでページに重ねる面。ドラッグした矩形をページに対する割合で返す。 */
function BoxCapture({ onBox }: { onBox: (r: Rect) => void }) {
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const at = (e: React.PointerEvent) => {
    const b = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), y: Math.min(1, Math.max(0, (e.clientY - b.top) / b.height)) };
  };
  const rect = drag && { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) };
  return (
    <div
      className="box-capture"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = at(e);
        setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const p = at(e);
        setDrag({ ...drag, x1: p.x, y1: p.y });
      }}
      onPointerUp={(e) => {
        e.stopPropagation();
        setDrag(null);
        // 小さすぎる枠（クリックしただけ）は無視する
        if (rect && rect.w > 0.01 && rect.h > 0.005) onBox(rect);
      }}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {rect && <div className="box-draft" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} />}
    </div>
  );
}

/** テキスト層の要素から、その TextLayer（textDivs と元の文字列を持つ）を引く。 */
const textLayers = new WeakMap<HTMLElement, pdfjs.TextLayer>();

/**
 * ページの文字の並び（src/lib/pageText.ts）。項目の矩形（縦は行の帯）と各文字の横位置（src/lib/glyphs.ts）を持つ。
 * 値はフレーム（文字が横に流れる向き）での割合で、rotation はフレームから表示の向きまでの角度。
 * AI エージェントのマーカー（server/pdftext.ts の readPages）と同じ関数で作るので、同じ文なら同じ矩形になる。
 */
interface PageModel {
  items: LaidItem[];
  rotation: number;
}

/** 文書ごと・ページごとの PageModel。 */
const modelCache = new WeakMap<PDFDocumentProxy, Map<number, Promise<PageModel | null>>>();
/** 求め終えた PageModel（選択中の表示は待たずに描きたいので、同期で引けるようにする）。 */
const modelReady = new WeakMap<PDFDocumentProxy, Map<number, PageModel | null>>();

function readyModel(doc: PDFDocumentProxy, n: number): PageModel | null {
  return modelReady.get(doc)?.get(n) ?? null;
}

function pageModel(doc: PDFDocumentProxy, n: number): Promise<PageModel | null> {
  let byPage = modelCache.get(doc);
  if (!byPage) modelCache.set(doc, (byPage = new Map()));
  let hit = byPage.get(n);
  if (!hit) {
    hit = (async () => {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const raws = tc.items.filter((i): i is typeof i & TextItemLike => "str" in i);
      const frameRotation = textRotation(raws, vp.rotation, (rotation) => page.getViewport({ scale: 1, rotation }));
      const fvp = frameRotation === vp.rotation ? vp : page.getViewport({ scale: 1, rotation: frameRotation });
      const items = layoutItems(raws, tc.styles, fvp);
      try {
        const ops = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE });
        const getFont = (name: string) => {
          try {
            return page.commonObjs.has(name) ? (page.commonObjs.get(name) as FontLike) : null;
          } catch {
            return null;
          }
        };
        const xs = attachGlyphs(items.map((it) => it.str), layoutGlyphs(pdfjs.OPS, ops.fnArray, ops.argsArray, getFont, fvp.transform), fvp.width);
        if (xs) items.forEach((it, i) => (it.xs = xs[i]));
      } catch {
        // 描画命令が読めなくても、文字数での按分にはできる
      }
      return { items, rotation: (vp.rotation - frameRotation + 360) % 360 };
    })().catch(() => null);
    void hit.then((m) => {
      let ready = modelReady.get(doc);
      if (!ready) modelReady.set(doc, (ready = new Map()));
      ready.set(n, m);
    });
    byPage.set(n, hit);
  }
  return hit;
}

/** 画面上の点にある文字の位置（テキスト層の文字の中だけ）。 */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let hit: { node: Node; offset: number } | null = null;
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    if (p) hit = { node: p.offsetNode, offset: p.offset };
  } else if (d.caretRangeFromPoint) {
    const r = d.caretRangeFromPoint(x, y);
    if (r) hit = { node: r.startContainer, offset: r.startOffset };
  }
  return hit && hit.node.nodeType === Node.TEXT_NODE && hit.node.parentElement?.closest(".textLayer") ? hit : null;
}

/**
 * 今の選択の範囲と向き。
 * Chromium は、文字の境目ちょうど（±0.25px）で押したドラッグを選択にせず、カーソルを動かすだけになる
 * （素の pdf.js でも起きる。実測でドラッグの 8%）。そのときは押した位置と今の位置から範囲を作る。
 */
function currentSelection(p: { down: { x: number; y: number } | null; cur: { x: number; y: number } } | null): { range: Range; forward: boolean } | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  if (!sel.isCollapsed) {
    const range = sel.getRangeAt(0);
    // 選択の向き: anchor（押した側）が範囲の先頭なら前向き
    return { range, forward: sel.anchorNode === range.startContainer && sel.anchorOffset === range.startOffset };
  }
  if (!p?.down || Math.hypot(p.cur.x - p.down.x, p.cur.y - p.down.y) < 4) return null;
  const a = caretAt(p.down.x, p.down.y);
  const b = caretAt(p.cur.x, p.cur.y);
  if (!a || !b) return null;
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  const forward = range.comparePoint(b.node, b.offset) >= 0;
  if (forward) range.setEnd(b.node, b.offset);
  else {
    range.setStart(b.node, b.offset);
    range.setEnd(a.node, a.offset);
  }
  return range.collapsed ? null : { range, forward };
}

function toFraction(r: DOMRect, pr: DOMRect): Rect {
  return { x: (r.left - pr.left) / pr.width, y: (r.top - pr.top) / pr.height, w: r.width / pr.width, h: r.height / pr.height };
}

/**
 * 選択範囲を、テキスト層の各項目の「実際に選ばれた文字」の範囲にする（b は含まない）。
 * 行末の余白まで引きずった選択や、要素の境目で終わる選択でも、選ばれていない文字は含めない。
 * テキスト層の文字列が PageModel と食い違う項目（読み込みの途中など）は飛ばす。
 */
function selectionSegments(range: Range, layer: pdfjs.TextLayer, model: PageModel): Segment[] {
  const out: Segment[] = [];
  layer.textDivs.forEach((div, k) => {
    const t = div.firstChild;
    if (!t || t.nodeType !== Node.TEXT_NODE || !range.intersectsNode(t)) return;
    const str = t.textContent ?? "";
    if (model.items[k]?.str !== str) return;
    let a = t === range.startContainer ? range.startOffset : 0;
    let b = t === range.endContainer ? range.endOffset : str.length;
    while (a < b && /\s/.test(str[a])) a++;
    while (b > a && /\s/.test(str[b - 1])) b--;
    if (a < b) out.push({ k, a, b });
  });
  return out;
}

// 前後の本文は多めに取っておき、送る量（設定の「送る範囲」）は claude.ts で切り詰める
function surrounding(full: string, text: string) {
  const key = text.slice(0, 40);
  const i = full.indexOf(key);
  if (i < 0) return full.slice(0, 3000);
  return full.slice(Math.max(0, i - 1500), i + text.length + 1500);
}

function cropCanvas(canvas: HTMLCanvasElement, rects: Rect[]): string | null {
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  const pad = 0.01;
  const sx = Math.max(0, (x1 - pad) * canvas.width);
  const sy = Math.max(0, (y1 - pad) * canvas.height);
  const sw = Math.min(canvas.width - sx, (x2 - x1 + pad * 2) * canvas.width);
  const sh = Math.min(canvas.height - sy, (y2 - y1 + pad * 2) * canvas.height);
  if (sw < 4 || sh < 4) return null;
  const out = document.createElement("canvas");
  out.width = Math.round(sw);
  out.height = Math.round(sh);
  out.getContext("2d")!.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
  try {
    return out.toDataURL("image/png").split(",")[1] ?? null;
  } catch {
    return null;
  }
}
