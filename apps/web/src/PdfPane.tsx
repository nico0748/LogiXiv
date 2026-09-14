import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { PaperDocument, Sentence } from './api.ts';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * PDF の描画とマーカーの重ね合わせ。
 *
 * 文の座標は GROBID が返した PDF ユーザー空間の値なので、
 * 「表示幅 / ページ幅」だけを倍率として持てば、拡大しても対応は崩れない。
 *
 * キャンバスは React に描かせず、描画済みのものをスロットへ差し込む。
 * pdf.js の描画は非同期で走るので、React の再描画で canvas 要素が
 * 作り直されると描いた絵が消えてしまうため。
 *
 * ズームは 2 段構えにしてある。押した瞬間は CSS の transform で即座に効かせ、
 * 手が止まってから実解像度で描き直す。1 クリックごとに全ページを再描画すると、
 * 40 ページの論文で 14 秒画面が消え、読んでいた位置も失われる。
 */

interface Props {
  document: PaperDocument;
  selectedId: string | null;
  onSelect: (sentenceId: string, origin: 'pdf' | 'sidebar') => void;
  /** サイドバーで絞り込み中に、対象外のマーカーを押せなくするため。 */
  visibleSentenceIds: ReadonlySet<string> | null;
  zoom: number;
  /** サイドバー起点の選択だけ PDF をスクロールさせる。 */
  scrollTarget: { id: string; token: number } | null;
}

interface PageState {
  pageNumber: number;
  scale: number;
  width: number;
  height: number;
}

const RERENDER_DEBOUNCE_MS = 350;

export function PdfPane({
  document: paper,
  selectedId,
  onSelect,
  visibleSentenceIds,
  zoom,
  scrollTarget,
}: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvases = useRef(new Map<number, HTMLCanvasElement>());
  const [pages, setPages] = useState<PageState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** 実際に描画した倍率。表示中の zoom との比が CSS スケールになる。 */
  const [renderedZoom, setRenderedZoom] = useState(zoom);
  const [renderKey, setRenderKey] = useState(0);
  const [hostWidth, setHostWidth] = useState(0);

  const sentencesByPage = useMemo(() => {
    const map = new Map<number, Sentence[]>();
    for (const sentence of paper.structure.sentences) {
      const seen = new Set<number>();
      for (const rect of sentence.rects) {
        if (seen.has(rect.page)) continue;
        seen.add(rect.page);
        const list = map.get(rect.page);
        if (list) list.push(sentence);
        else map.set(rect.page, [sentence]);
      }
    }
    return map;
  }, [paper]);

  // 幅の変化に追随する。以前はマウント時の幅で固定していたので、
  // ウィンドウを狭めると PDF がペインからはみ出したまま戻らなかった。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setHostWidth(host.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setHostWidth((previous) => (Math.abs(previous - width) > 8 ? width : previous));
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // ズーム・幅の変化は、手が止まってから実解像度の描き直しに反映する。
  useEffect(() => {
    if (zoom === renderedZoom) return;
    const timer = setTimeout(() => setRenderKey((k) => k + 1), RERENDER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [zoom, renderedZoom]);

  useEffect(() => {
    if (hostWidth === 0) return;
    const timer = setTimeout(() => setRenderKey((k) => k + 1), RERENDER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [hostWidth]);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    const targetZoom = zoom;
    // 再描画の間もスクロール位置を保つ。
    const scrollRatio = host.scrollHeight > 0 ? host.scrollTop / host.scrollHeight : 0;

    setLoading(pages.length === 0);
    setError(null);

    const task = pdfjs.getDocument({ url: `/api/documents/${paper.id}/pdf`, disableFontFace: false });
    const renders: { cancel: () => void }[] = [];

    void (async () => {
      try {
        const pdf = await task.promise;
        if (cancelled) return;
        const cssWidth = Math.max(320, (host.clientWidth - 48) * targetZoom);
        const rendered: PageState[] = [];
        const fresh = new Map<number, HTMLCanvasElement>();

        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          const page = await pdf.getPage(pageNumber);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const scale = cssWidth / base.width;
          const viewport = page.getViewport({ scale });
          const ratio = Math.min(window.devicePixelRatio || 1, 2);

          const canvas = window.document.createElement('canvas');
          canvas.width = Math.floor(viewport.width * ratio);
          canvas.height = Math.floor(viewport.height * ratio);
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('2D コンテキストを取得できませんでした');
          context.scale(ratio, ratio);
          const renderTask = page.render({ canvas, canvasContext: context, viewport, intent: 'display' });
          renders.push(renderTask);
          await renderTask.promise;
          if (cancelled) return;

          fresh.set(pageNumber, canvas);
          rendered.push({ pageNumber, scale, width: viewport.width, height: viewport.height });
          // 1 ページ目が出た時点で読み込み表示を消す（残りは順次差し替わる）。
          if (pageNumber === 1) setLoading(false);
        }

        canvases.current = fresh;
        setPages(rendered);
        setRenderedZoom(targetZoom);
        setLoading(false);

        requestAnimationFrame(() => {
          if (!cancelled && scrollRatio > 0) host.scrollTop = scrollRatio * host.scrollHeight;
        });
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      // 進行中の描画も明示的に止める。破棄されるキャンバスに描き続けさせない。
      for (const render of renders) {
        try {
          render.cancel();
        } catch {
          // 既に完了しているものは cancel が投げる。
        }
      }
      void task.destroy();
    };
    // pages を依存に入れると描画のたびに再実行されるので意図的に外す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper.id, renderKey]);

  // 描画済みキャンバスをスロットへ入れる。
  useLayoutEffect(() => {
    for (const page of pages) {
      const slot = window.document.getElementById(`pdf-page-${page.pageNumber}`);
      const canvas = canvases.current.get(page.pageNumber);
      if (slot && canvas && slot.firstChild !== canvas) {
        slot.replaceChildren(canvas);
      }
    }
  }, [pages]);

  // サイドバー起点の選択のときだけ PDF をスクロールする。
  useEffect(() => {
    if (!scrollTarget) return;
    const marker = window.document.querySelector(`[data-marker-for="${CSS.escape(scrollTarget.id)}"]`);
    marker?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [scrollTarget]);

  const handleSelect = useCallback((id: string) => onSelect(id, 'pdf'), [onSelect]);

  if (error) {
    return <div className="pane-message">PDF を表示できませんでした: {error}</div>;
  }

  // 実描画とのズレを CSS で吸収する。押した瞬間の反応はこれで返す。
  const cssScale = renderedZoom === 0 ? 1 : zoom / renderedZoom;

  return (
    <div className="pdf-pane" ref={hostRef}>
      {loading && <div className="pane-message">PDF を描画しています…</div>}
      {pages.map((page) => (
        <div
          key={page.pageNumber}
          className="pdf-page"
          style={{
            width: page.width * cssScale,
            height: page.height * cssScale,
          }}
        >
          <div
            className="pdf-page-inner"
            style={{
              width: page.width,
              height: page.height,
              transform: cssScale === 1 ? undefined : `scale(${cssScale})`,
            }}
          >
            <div id={`pdf-page-${page.pageNumber}`} className="pdf-canvas-slot" />
            <div className="pdf-overlay">
              {(sentencesByPage.get(page.pageNumber) ?? []).flatMap((sentence) => {
                const dimmed = visibleSentenceIds !== null && !visibleSentenceIds.has(sentence.id);
                return sentence.rects
                  .filter((rect) => rect.page === page.pageNumber)
                  .map((rect, index) => (
                    <button
                      type="button"
                      key={`${sentence.id}-${index}`}
                      data-marker-for={sentence.id}
                      // マーカーは文書全体で数千個になる。タブ順から外し、
                      // キーボード操作はサイドバー側に一本化する。
                      tabIndex={-1}
                      aria-hidden="true"
                      className={[
                        'pdf-marker',
                        paper.annotations.translations[sentence.hash] ? 'is-translated' : '',
                        selectedId === sentence.id ? 'is-active' : '',
                        dimmed ? 'is-filtered-out' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={{
                        left: rect.x * page.scale,
                        top: rect.y * page.scale,
                        width: rect.w * page.scale,
                        height: rect.h * page.scale,
                      }}
                      title={sentence.text}
                      onClick={() => handleSelect(sentence.id)}
                    />
                  ));
              })}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
