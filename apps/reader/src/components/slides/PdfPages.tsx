// PDF のページを縦に並べて描く部品。スライドと論文の対応の画面で、左右の両方に使う。
// 全ページの寸法を先に集め、正しい高さで並べてから、見えているページだけを描く（PdfView と同じ考え方）。
// ページの上に重ねるもの（四角、リンク先）は overlay で受け取る。座標はページに対する割合で置く。

import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { type ReactNode, type Ref, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { openPdf } from "../../lib/pdf.ts";

type Size = { w: number; h: number };

export interface PdfPagesHandle {
  /** ページの中の位置へ移る。y はページの高さに対する割合 */
  goTo(page: number, y?: number, smooth?: boolean): void;
  el: HTMLDivElement | null;
}

interface Props {
  data: ArrayBuffer;
  /** 1 のとき枠の幅に合わせる */
  zoom: number;
  /** 文字を選べるようにする（論文の側） */
  textLayer?: boolean;
  overlay?: (page: number) => ReactNode;
  onScroll?: () => void;
  /** ページの幅や並びが変わったとき（重ねた線を測り直すため） */
  onLayout?: () => void;
  onPage?: (page: number) => void;
  onLoaded?: (numPages: number) => void;
  onMouseUp?: (e: React.MouseEvent<HTMLDivElement>) => void;
  className?: string;
  label: string;
  handle?: Ref<PdfPagesHandle>;
  /** ページの後ろに置くもの（選択のメニューなど）。スクロールの中で絶対配置する */
  children?: ReactNode;
}

export function PdfPages({ data, zoom, textLayer, overlay, onScroll, onLayout, onPage, onLoaded, onMouseUp, className, label, handle, children }: Props) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<Size[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(600);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(onLoaded);
  loadedRef.current = onLoaded;

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setSizes(null);
    setError(null);
    const task = openPdf(data);
    task.promise.then(
      async (d) => {
        if (cancelled) return;
        const all = await Promise.all(
          Array.from({ length: d.numPages }, (_, i) =>
            d.getPage(i + 1).then((p) => {
              const v = p.getViewport({ scale: 1 });
              return { w: v.width, h: v.height };
            }),
          ),
        );
        if (cancelled) return;
        setDoc(d);
        setSizes(all);
        loadedRef.current?.(d.numPages);
      },
    ).catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [data]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, el.clientWidth - 32)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const goTo = useCallback((page: number, y = 0, smooth = true) => {
    const box = scrollRef.current;
    const el = box?.querySelector<HTMLElement>(`:scope > .pp-page[data-page="${page}"]`);
    if (!box || !el) return;
    const top = el.offsetTop + el.offsetHeight * y - box.clientHeight * (y > 0 ? 0.3 : 0) - 8;
    box.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
  }, []);
  useImperativeHandle(handle, () => ({ goTo, el: scrollRef.current }), [goTo]);

  // 今のページ（表示している範囲の上から 1/3 の位置にあるページ）
  const frame = useRef(0);
  const scrolled = () => {
    onScroll?.();
    if (frame.current || !onPage) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const box = scrollRef.current;
      if (!box) return;
      const els = box.querySelectorAll<HTMLElement>(":scope > .pp-page");
      const probe = box.scrollTop + box.clientHeight / 3;
      let page = 1;
      els.forEach((el, i) => {
        if (el.offsetTop <= probe) page = i + 1;
      });
      // 最後までスクロールしたら、最後のページを示す（最後のページが短く、上から 1/3 の位置に届かないため）
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) page = els.length;
      onPage(page);
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // ページを並べ直したあと（幅・拡大率・文書が変わったとき）に知らせる
  const layoutRef = useRef(onLayout);
  layoutRef.current = onLayout;
  useEffect(() => {
    layoutRef.current?.();
  }, [width, zoom, sizes]);

  const pages = useMemo(() => (sizes ? sizes.map((_, i) => i + 1) : []), [sizes]);
  return (
    <div className={`pp-scroll ${className ?? ""}`} ref={scrollRef} onScroll={scrolled} onMouseUp={onMouseUp} aria-label={label}>
      {error && <p className="err-msg">PDF を開けませんでした。{error}</p>}
      {doc && sizes && pages.map((n) => <Page key={n} doc={doc} n={n} size={sizes[n - 1]} width={width * zoom} textLayer={!!textLayer} overlay={overlay?.(n)} root={scrollRef} />)}
      {children}
    </div>
  );
}

function Page({
  doc,
  n,
  size,
  width,
  textLayer,
  overlay,
  root,
}: {
  doc: PDFDocumentProxy;
  n: number;
  size: Size;
  width: number;
  textLayer: boolean;
  overlay: ReactNode;
  root: React.RefObject<HTMLDivElement | null>;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [visible, setVisible] = useState(n <= 2);
  const scale = width / size.w;

  useEffect(() => {
    let alive = true;
    // 描き終わる前に文書を閉じた（部品が外れた）ときの失敗は捨てる
    doc.getPage(n).then((p) => alive && setPage(p), () => undefined);
    return () => {
      alive = false;
    };
  }, [doc, n]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    // スクロールの枠を基準にして、上下 800px 先のページから描き始める
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setVisible(true), { root: root.current, rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!page || !visible || !canvasRef.current) return;
    const vp = page.getViewport({ scale });
    const canvas = canvasRef.current;
    // 拡大したときに canvas が大きくなりすぎない（ブラウザの上限を超えると白紙になる）よう、画素数を 1600 万までにする
    const dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / (vp.width * vp.height)));
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = `${vp.width}px`;
    canvas.style.height = `${vp.height}px`;
    const task = page.render({ canvas, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
    task.promise.catch(() => undefined);
    let layer: pdfjs.TextLayer | null = null;
    if (textLayer && textRef.current) {
      textRef.current.replaceChildren();
      layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textRef.current, viewport: vp });
      void layer.render().catch(() => undefined);
    }
    return () => {
      task.cancel();
      layer?.cancel();
    };
  }, [page, scale, visible, textLayer]);

  return (
    <div className="pdf-page pp-page" data-page={n} ref={boxRef} style={{ width, height: size.h * scale, ["--total-scale-factor" as string]: scale }}>
      <canvas ref={canvasRef} aria-hidden="true" />
      {textLayer && <div className="textLayer" ref={textRef} />}
      {overlay}
      <span className="page-no">{n}</span>
    </div>
  );
}
