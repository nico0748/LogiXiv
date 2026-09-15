import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
 * **枠だけ先に並べ、見える範囲になってから描く。**
 * 寸法は描かなくても分かるので、マーカーは最初から正しい位置に置ける。
 * 全ページを描いて持ち続けると、60 ページの論文を 250% で開くだけで
 * キャンバスが 1.4GB になり、200 ページなら 776MB を常時占有していた。
 * しかも最初の 1 枚が画面に出るまで 200 ページで 7 秒間まっ白だった。
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
/** 実体を持ったまま残すページ数。見える範囲の前後を賄えれば十分。 */
const MAX_DRAWN_PAGES = 12;

export function PdfPane({
  document: paper,
  selectedId,
  onSelect,
  visibleSentenceIds,
  zoom,
  scrollTarget,
}: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<PageState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** 実際に描画した倍率。表示中の zoom との比が CSS スケールになる。 */
  const [renderedZoom, setRenderedZoom] = useState(zoom);
  const [renderKey, setRenderKey] = useState(0);
  const [hostWidth, setHostWidth] = useState(0);

  /** いま描画に使っている PDF と、そのときの幅。遅延描画から参照する。 */
  const pdfRef = useRef<Awaited<ReturnType<typeof pdfjs.getDocument>['promise']> | null>(null);
  const cssWidthRef = useRef(0);
  const drawnRef = useRef(new Map<number, HTMLCanvasElement>());
  const generationRef = useRef(0);
  // 描き直しの引き金は renderKey だけにする。zoom を依存に入れると、
  // 押した瞬間に PDF を開き直してしまい、2 段構えのズームが意味を失う。
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

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
    // 初期値は ResizeObserver の最初の通知に任せる。clientWidth で先に入れると、
    // padding のぶんだけ違う値が続けて入り、開いた直後に「幅が変わった」と
    // 誤判定して PDF を丸ごと取り直していた。
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

  const previousWidth = useRef(0);
  useEffect(() => {
    if (hostWidth === 0) return;
    const first = previousWidth.current === 0;
    previousWidth.current = hostWidth;
    // 初回は 0 → 実幅という「変化」が必ず起きる。これを描き直しとして扱うと、
    // 文書を開くたびに PDF を 2 回取得して 2 回解析することになる。
    if (first) return;
    const timer = setTimeout(() => setRenderKey((k) => k + 1), RERENDER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [hostWidth]);

  /** 描いたキャンバスを手放す。width=0 にしないとピクセルは解放されない。 */
  const release = useCallback((pageNumber: number) => {
    const canvas = drawnRef.current.get(pageNumber);
    drawnRef.current.delete(pageNumber);
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
    canvas.remove();
  }, []);

  const draw = useCallback(
    async (pageNumber: number) => {
      const pdf = pdfRef.current;
      const generation = generationRef.current;
      if (!pdf || drawnRef.current.has(pageNumber)) return;
      const slot = window.document.getElementById(`pdf-page-${pageNumber}`);
      if (!slot) return;
      const placeholder = window.document.createElement('canvas');
      drawnRef.current.set(pageNumber, placeholder);
      try {
        const page = await pdf.getPage(pageNumber);
        if (generation !== generationRef.current) return;
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: cssWidthRef.current / base.width });
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
        if (generation !== generationRef.current) {
          canvas.width = 0;
          return;
        }
        drawnRef.current.set(pageNumber, canvas);
        slot.replaceChildren(canvas);

        // 直近のぶんだけ残す。交差の監視は「離れたとき」を安定して教えてくれないので、
        // 距離ではなく枚数で抑える方が確実。
        while (drawnRef.current.size > MAX_DRAWN_PAGES) {
          const oldest = [...drawnRef.current.keys()].find((n) => n !== pageNumber);
          if (oldest === undefined) break;
          release(oldest);
        }
      } catch {
        drawnRef.current.delete(pageNumber);
      }
    },
    [release],
  );

  // --- PDF を開いて、寸法だけ先に決める ------------------------------------
  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    const generation = ++generationRef.current;
    const targetZoom = zoomRef.current;
    // 再描画の間もスクロール位置を保つ。
    const scrollRatio = host.scrollHeight > 0 ? host.scrollTop / host.scrollHeight : 0;

    for (const pageNumber of [...drawnRef.current.keys()]) release(pageNumber);
    setLoading(true);
    setError(null);

    const task = pdfjs.getDocument({ url: `/api/documents/${paper.id}/pdf`, disableFontFace: false });

    void (async () => {
      try {
        const pdf = await task.promise;
        if (cancelled || generation !== generationRef.current) return;
        pdfRef.current = pdf;
        cssWidthRef.current = Math.max(320, (host.clientWidth - 48) * targetZoom);

        const geometry: PageState[] = [];
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          const page = await pdf.getPage(pageNumber);
          if (cancelled || generation !== generationRef.current) return;
          const base = page.getViewport({ scale: 1 });
          const scale = cssWidthRef.current / base.width;
          geometry.push({ pageNumber, scale, width: base.width * scale, height: base.height * scale });
        }

        setPages(geometry);
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
      void task.destroy();
    };
  }, [paper.id, renderKey, release]);

  // --- 見える範囲になったページだけ描く ------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host || pages.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const pageNumber = Number((entry.target as HTMLElement).dataset['page']);
          if (Number.isFinite(pageNumber)) void draw(pageNumber);
        }
      },
      // root は実際にスクロールする要素。null にすると rootMargin が効かない。
      { root: host, rootMargin: '900px 0px' },
    );
    for (const page of pages) {
      const slot = window.document.getElementById(`pdf-page-${page.pageNumber}`);
      if (slot) observer.observe(slot);
    }
    return () => observer.disconnect();
  }, [pages, draw]);

  // サイドバー起点の選択のときだけ PDF をスクロールする。
  useEffect(() => {
    if (!scrollTarget) return;
    const marker = window.document.querySelector(`[data-marker-for="${CSS.escape(scrollTarget.id)}"]`);
    if (!marker) return;
    // 飛び先のページは観測を待たずに描く。待つと着いた先が白いままになる。
    const slot = marker.closest('.pdf-page-inner')?.querySelector('.pdf-canvas-slot');
    if (slot instanceof HTMLElement) void draw(Number(slot.dataset['page']));
    marker.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [scrollTarget, draw]);

  const handleSelect = useCallback((id: string) => onSelect(id, 'pdf'), [onSelect]);

  if (error) {
    return <div className="pane-message">PDF を表示できませんでした: {error}</div>;
  }

  // 実描画とのズレを CSS で吸収する。押した瞬間の反応はこれで返す。
  const cssScale = renderedZoom === 0 ? 1 : zoom / renderedZoom;

  return (
    <div className="pdf-pane" ref={hostRef}>
      {loading && <div className="pane-message">PDF を読み込んでいます…</div>}
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
            <div
              id={`pdf-page-${page.pageNumber}`}
              className="pdf-canvas-slot"
              data-page={page.pageNumber}
            />
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
