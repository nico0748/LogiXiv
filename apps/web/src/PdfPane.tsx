import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
 */

interface Props {
  document: PaperDocument;
  selectedId: string | null;
  onSelect: (sentenceId: string) => void;
  zoom: number;
}

interface PageState {
  pageNumber: number;
  scale: number;
  width: number;
  height: number;
}

export function PdfPane({ document: paper, selectedId, onSelect, zoom }: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvases = useRef(new Map<number, HTMLCanvasElement>());
  const [pages, setPages] = useState<PageState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    setLoading(true);
    setError(null);
    setPages([]);
    canvases.current.clear();

    const task = pdfjs.getDocument({ url: `/api/documents/${paper.id}/pdf`, disableFontFace: false });

    void (async () => {
      try {
        const pdf = await task.promise;
        if (cancelled) return;
        const cssWidth = Math.max(320, (host.clientWidth - 48) * zoom);
        const rendered: PageState[] = [];

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
          await page.render({ canvas, canvasContext: context, viewport, intent: 'display' }).promise;
          if (cancelled) return;

          canvases.current.set(pageNumber, canvas);
          rendered.push({ pageNumber, scale, width: viewport.width, height: viewport.height });
          setPages([...rendered]);
          setLoading(false);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [paper.id, zoom]);

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

  useEffect(() => {
    if (!selectedId) return;
    const marker = window.document.querySelector(`[data-marker-for="${selectedId}"]`);
    marker?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [selectedId]);

  if (error) {
    return <div className="pane-message">PDF を表示できませんでした: {error}</div>;
  }

  return (
    <div className="pdf-pane" ref={hostRef}>
      {loading && <div className="pane-message">PDF を描画しています…</div>}
      {pages.map((page) => (
        <div key={page.pageNumber} className="pdf-page" style={{ width: page.width, height: page.height }}>
          <div id={`pdf-page-${page.pageNumber}`} className="pdf-canvas-slot" />
          <div className="pdf-overlay">
            {(sentencesByPage.get(page.pageNumber) ?? []).flatMap((sentence) =>
              sentence.rects
                .filter((rect) => rect.page === page.pageNumber)
                .map((rect, index) => (
                  <button
                    type="button"
                    key={`${sentence.id}-${index}`}
                    data-marker-for={sentence.id}
                    className={[
                      'pdf-marker',
                      paper.annotations.translations[sentence.hash] ? 'is-translated' : '',
                      selectedId === sentence.id ? 'is-active' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    style={{
                      left: rect.x * page.scale,
                      top: rect.y * page.scale,
                      width: rect.w * page.scale,
                      height: rect.h * page.scale,
                    }}
                    title={sentence.text.slice(0, 120)}
                    onClick={() => onSelect(sentence.id)}
                  />
                )),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
