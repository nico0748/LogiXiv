import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Highlight, MarkerColor, Rect } from "../lib/model.ts";
import { openPdf } from "../lib/pdf.ts";
import { setSentenceFocus, setSentenceMarksVisible, useSentenceFocus, useSentenceMarksVisible } from "../lib/sentenceFocus.ts";
import { type SentenceMark, hitTest, marksByPage, sentenceAnchor } from "../lib/sentencesView.ts";
import { SentenceMarkLayer } from "./sentences/SentenceMarks.tsx";
import { useSentences } from "./sentences/useSentences.ts";


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
  jumpTo?: { page: number; y: number; n: number } | null;
  /** 開いている論文の id。あれば対訳の文の枠を描き、対訳タブと選択を同期する。 */
  paperId?: string | null;
  /** そのページの先頭までスクロールする。nonce が変わるたびに動く。 */
  scrollToPage?: { page: number; nonce: number };
}

/** 文の枠が無いページに渡す配列。毎回 [] を作ると memo が外れる。 */
const NO_MARKS: SentenceMark[] = [];

const COLORS: MarkerColor[] = ["yellow", "cyan", "magenta", "green"];

export function PdfView({ data, highlights, activeId, onAction, onHighlightClick, onLoaded, jumpTo, paperId, scrollToPage }: Props) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
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

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setError(null);
    texts.current.clear();
    const task = openPdf(data);
    task.promise.then(
      (d) => {
        if (cancelled) return;
        setDoc(d);
        onLoaded?.(d);
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

  useEffect(() => {
    if (!jumpTo || !scrollRef.current) return;
    const page = scrollRef.current.querySelector<HTMLElement>(`[data-page="${jumpTo.page}"]`);
    if (!page) return;
    scrollRef.current.scrollTo({
      top: page.offsetTop + page.offsetHeight * jumpTo.y - 120,
      behavior: "smooth",
    });
  }, [jumpTo]);

  const scrollToFraction = useCallback((pageNo: number, y: number, smooth: boolean) => {
    const el = scrollRef.current;
    const page = el?.querySelector<HTMLElement>(`[data-page="${pageNo}"]`);
    if (!el || !page) return;
    el.scrollTo({ top: Math.max(0, page.offsetTop + page.offsetHeight * y - 120), behavior: smooth ? "smooth" : "auto" });
  }, []);

  // 対訳タブ（やキー操作）で選んだ文まで動かす。PDF 上で選んだときは動かさない。
  useEffect(() => {
    if (!sdoc || !paperId || focus.paperId !== paperId || !focus.id || focus.origin === "pdf") return;
    const at = sentenceAnchor(sdoc, focus.id);
    if (at) scrollToFraction(at.page, at.y, focus.origin === "panel");
    // 選び直したとき（nonce）だけ動かす。訳が届いて文書が変わっただけでは動かさない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.nonce]);

  useEffect(() => {
    if (scrollToPage && doc) scrollToFraction(scrollToPage.page, 0, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToPage?.nonce, doc]);

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

  const onMouseUp = useCallback(async () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !scrollRef.current) return setMenu(null);
    const text = sel.toString().replace(/-\n/g, "").replace(/\s+/g, " ").trim();
    if (!text) return setMenu(null);
    const range = sel.getRangeAt(0);
    const startEl = (range.startContainer.parentElement ?? null)?.closest<HTMLElement>(".pdf-page");
    if (!startEl) return setMenu(null);
    const pageNo = Number(startEl.dataset.page);
    const pr = startEl.getBoundingClientRect();
    const rects = mergeRects(
      [...range.getClientRects()]
        .filter((r) => r.width > 1 && r.height > 1)
        .filter((r) => r.top >= pr.top - 2 && r.bottom <= pr.bottom + 2)
        .map((r) => ({
          x: (r.left - pr.left) / pr.width,
          y: (r.top - pr.top) / pr.height,
          w: r.width / pr.width,
          h: r.height / pr.height,
        })),
    );
    if (!rects.length) return setMenu(null);
    const full = await pageText(pageNo);
    const around = surrounding(full, text);
    const canvas = startEl.querySelector("canvas");
    const crop = () => (canvas ? cropCanvas(canvas, rects) : null);
    const last = range.getClientRects()[range.getClientRects().length - 1] ?? range.getBoundingClientRect();
    const sr = scrollRef.current.getBoundingClientRect();
    setMenu({
      x: Math.min(last.right - sr.left, sr.width - 360),
      y: last.bottom - sr.top + scrollRef.current.scrollTop + 6,
      sel: { page: pageNo, rects, text, around, crop },
    });
  }, [pageText]);

  const run = (a: SelectionAction) => {
    if (!menu) return;
    onAction(a, menu.sel);
    setMenu(null);
    window.getSelection()?.removeAllRanges();
  };

  const pages = useMemo(() => (doc ? Array.from({ length: doc.numPages }, (_, i) => i + 1) : []), [doc]);

  return (
    <>
      <div className="pdf-toolbar" role="toolbar" aria-label="表示の操作">
        <span>{doc ? `${doc.numPages} ページ` : "読み込み中"}</span>
        <span className="spacer" />
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
        onMouseUp={onMouseUp}
        style={{ position: "relative" }}
      >
        {error && <p className="err-msg">PDF を開けませんでした。{error}</p>}
        {doc &&
          pages.map((n) => (
            <PageView
              key={n}
              doc={doc}
              n={n}
              width={width * zoom}
              highlights={highlights.filter((h) => h.page === n)}
              activeId={activeId}
              onHighlightClick={onHighlightClick}
              marks={marksVisible ? (markMap?.get(n) ?? NO_MARKS) : NO_MARKS}
              activeSentence={activeSentence}
              onPickSentence={pickSentence}
            />
          ))}
        {menu && (
          <div
            className="sel-menu"
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
  width,
  highlights,
  activeId,
  onHighlightClick,
  marks,
  activeSentence,
  onPickSentence,
}: {
  doc: PDFDocumentProxy;
  n: number;
  width: number;
  highlights: Highlight[];
  activeId: string | null;
  onHighlightClick: (id: string) => void;
  marks: SentenceMark[];
  activeSentence: string | null;
  onPickSentence: (m: SentenceMark) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [visible, setVisible] = useState(n <= 2);
  const [hover, setHover] = useState<string | null>(null);
  // 選択中の文がこのページに無ければ null を渡し、他のページの枠を描き直さない
  const pageActive = activeSentence && marks.some((m) => m.id === activeSentence) ? activeSentence : null;

  // 文の枠はテキスト層の下にあるので、当たりは座標で取る（文字の選択を邪魔しないため）
  const markAt = (e: React.MouseEvent): SentenceMark | null => {
    if (!marks.length || !boxRef.current) return null;
    const r = boxRef.current.getBoundingClientRect();
    return hitTest(marks, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };
  const onMove = (e: React.MouseEvent) => {
    if (!marks.length || e.buttons) return;
    const id = markAt(e)?.id ?? null;
    if (id !== hover) setHover(id);
  };
  const onClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, .sel-menu")) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // 文字を選んだだけのときは文を選ばない
    const m = markAt(e);
    if (m) onPickSentence(m);
  };

  useEffect(() => {
    void doc.getPage(n).then(setPage);
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

  const base = page?.getViewport({ scale: 1 });
  const scale = base ? width / base.width : 1;
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
    void layer.render().catch(() => undefined);
    task.promise.catch(() => undefined);
    return () => {
      task.cancel();
      layer.cancel();
    };
    // vp はスケールから決まるため scale を依存にする
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, scale, visible]);

  const w = vp?.width ?? width;
  const h = vp?.height ?? width * 1.294;
  return (
    <div
      className="pdf-page"
      data-page={n}
      ref={boxRef}
      style={{ width: w, height: h, ["--total-scale-factor" as string]: scale }}
      onMouseMove={onMove}
      onMouseLeave={() => hover && setHover(null)}
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
      {marks.length > 0 && <SentenceMarkLayer marks={marks} activeId={pageActive} hoverId={hover} />}
      <div className="textLayer" ref={textRef} />
      {highlights.length > 0 && (
        <div style={{ position: "absolute", inset: 0, zIndex: 3, pointerEvents: "none" }}>
          {highlights.map((hl) => {
            const r = hl.rects[0];
            // 位置が分からないマーカー（AI エージェントが本文から見つけられなかったもの）は、訳タブにだけ出す
            if (!r) return null;
            return (
              <button
                key={hl.id}
                aria-label={`p.${n} のマーカーを開く`}
                title="マーカーを開く"
                onClick={() => onHighlightClick(hl.id)}
                style={{
                  position: "absolute", left: `calc(${(r.x + r.w) * 100}% + 2px)`, top: `${r.y * 100}%`,
                  width: 10, height: 10, borderRadius: 5, padding: 0, border: "1px solid rgba(0,0,0,.35)",
                  background: `var(--mk-${hl.color})`, pointerEvents: "auto", cursor: "pointer",
                }}
              />
            );
          })}
        </div>
      )}
      <span className="page-no">{n}</span>
    </div>
  );
}

/** 同じ行に並ぶ矩形をまとめる。テキスト層は単語ごとに分かれているため。 */
function mergeRects(rs: Rect[]): Rect[] {
  const sorted = [...rs].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: Rect[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - r.y) < r.h * 0.5 && r.x <= last.x + last.w + 0.02) {
      const x2 = Math.max(last.x + last.w, r.x + r.w);
      const y2 = Math.max(last.y + last.h, r.y + r.h);
      last.x = Math.min(last.x, r.x);
      last.y = Math.min(last.y, r.y);
      last.w = x2 - last.x;
      last.h = y2 - last.y;
    } else out.push({ ...r });
  }
  return out;
}

function surrounding(full: string, text: string) {
  const key = text.slice(0, 40);
  const i = full.indexOf(key);
  if (i < 0) return full.slice(0, 1200);
  return full.slice(Math.max(0, i - 600), i + text.length + 600);
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
