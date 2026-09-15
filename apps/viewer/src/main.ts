import './style.css';
import type { ExportPayload, Note, Section, Sentence } from './types.ts';
import {
  base64ToBytes,
  isWorkerAvailable,
  loadPdf,
  needsMissingResources,
  pageGeometry,
  renderPageCanvas,
  type LoadedPdf,
} from './pdf.ts';

/**
 * 書き出し HTML の中で動くビューア。
 *
 * ここは「他人が受け取ったファイル」を開く場所なので、次の 2 つを守る。
 *  - ネットワークに一切出ない（fetch も外部フォントも無い）
 *  - 埋め込みデータは JSON.parse で読むだけ。innerHTML への流し込みもしない
 */

const DATA_ELEMENT_ID = 'logixiv-data';
const RESIZE_DEBOUNCE_MS = 300;

/**
 * 埋め込みデータを読む。
 *
 * 同じ id の script が複数あるときは読まない。取り込み側（core/import.ts）は
 * その状態を「どれが本物か判断できない」として断るので、ビューアだけが
 * 先頭の 1 つを採用すると、同じファイルなのに人によって中身が違うことになる。
 *
 * 形も最低限だけ見る。ここを素通しにすると、少し壊れた payload で
 * 静的フォールバックごと消えた真っ白なページになる。
 */
function readPayload(): ExportPayload | null {
  const elements = document.querySelectorAll(`#${DATA_ELEMENT_ID}`);
  if (elements.length !== 1) return null;
  try {
    const payload = JSON.parse(elements[0]!.textContent ?? '') as ExportPayload;
    const paper = payload?.document;
    if (!paper || typeof paper !== 'object') return null;
    if (!Array.isArray(paper.structure?.sentences)) return null;
    if (!Array.isArray(paper.structure?.sections)) return null;
    const annotations = paper.annotations;
    if (!annotations || typeof annotations !== 'object') return null;
    if (!Array.isArray(annotations.notes) || typeof annotations.translations !== 'object') return null;
    return payload;
  } catch {
    return null;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function boot(): void {
  const payload = readPayload();
  if (!payload) return; // データが読めないときは静的フォールバックをそのまま見せる。

  const staticFallback = document.getElementById('lx-static');
  const root = document.getElementById('lx-root');
  if (!root) return;
  // 静的フォールバックは、画面を組み立て切ってから外す。
  // 先に外すと、途中で例外が出たときに何も無いページだけが残る。
  if (staticFallback) staticFallback.hidden = true;

  const { document: paper, pdfBase64 } = payload;
  const sentences = paper.structure.sentences;
  const sectionTitles = new Map(paper.structure.sections.map((s: Section) => [s.id, s.title]));
  const notesByHash = new Map<string, Note[]>();
  for (const note of paper.annotations.notes) {
    const list = notesByHash.get(note.sentenceHash);
    if (list) list.push(note);
    else notesByHash.set(note.sentenceHash, [note]);
  }

  document.title = `${paper.title} — LogiXiv`;

  const layout = el('div', 'lxv-layout');
  const header = el('header', 'lxv-header');
  const title = el('h1', 'lxv-title', paper.title);
  const search = el('input', 'lxv-search');
  search.type = 'search';
  search.placeholder = '原文・訳文・メモを検索';
  search.setAttribute('aria-label', '文書内検索');
  const meta = el(
    'span',
    'lxv-meta',
    `${sentences.length} 文 · ${paper.structure.parser === 'grobid' ? 'GROBID 解析' : '簡易解析'}`,
  );
  header.append(title, search, meta);

  const pdfColumn = el('main', 'lxv-pdf');
  const sidebar = el('aside', 'lxv-sidebar');
  const emptyMessage = el('p', 'lxv-empty', '一致する文がありません。');
  emptyMessage.hidden = true;
  layout.append(header, pdfColumn, sidebar);
  root.append(layout);

  // --- サイドバー（1 文 = 1 カード）---------------------------------------
  const cards = new Map<string, HTMLElement>();
  /** 見出しと、その見出しに属するカード。0 件になったら見出しごと隠す。 */
  const groups: { heading: HTMLElement | null; cards: HTMLElement[] }[] = [];
  let currentGroup: { heading: HTMLElement | null; cards: HTMLElement[] } = { heading: null, cards: [] };
  groups.push(currentGroup);

  let lastSection: string | null | undefined;
  sidebar.append(emptyMessage);
  for (const sentence of sentences) {
    if (sentence.sectionId !== lastSection) {
      lastSection = sentence.sectionId;
      const heading = lastSection ? sectionTitles.get(lastSection) : null;
      if (heading) {
        const element = el('h2', 'lxv-section', heading);
        sidebar.append(element);
        currentGroup = { heading: element, cards: [] };
        groups.push(currentGroup);
      }
    }
    const card = buildCard(sentence);
    currentGroup.cards.push(card);
    sidebar.append(card);
  }

  function buildCard(sentence: Sentence): HTMLElement {
    const card = el('article', 'lxv-card');
    card.dataset['id'] = sentence.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');

    const translation = paper.annotations.translations[sentence.hash];
    if (translation) {
      const target = el('p', 'lxv-target', translation.text);
      if (translation.revisedByHuman) target.classList.add('is-human');
      card.append(target);
    } else {
      card.append(el('p', 'lxv-untranslated', '（未訳）'));
    }
    card.append(el('p', 'lxv-source', sentence.text));

    for (const note of notesByHash.get(sentence.hash) ?? []) {
      const noteElement = el('p', 'lxv-note', note.body);
      if (note.author) noteElement.title = note.author;
      card.append(noteElement);
    }

    card.addEventListener('click', () => select(sentence.id, 'sidebar'));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select(sentence.id, 'sidebar');
      }
    });
    cards.set(sentence.id, card);
    return card;
  }

  // --- PDF とマーカー -----------------------------------------------------
  const markers = new Map<string, HTMLElement[]>();
  let selectedId: string | null = null;
  /** 検索で絞り込んだ結果。null なら絞り込みなし。 */
  let visibleIds: Set<string> | null = null;

  function select(id: string, origin: 'pdf' | 'sidebar'): void {
    if (selectedId) {
      cards.get(selectedId)?.classList.remove('is-active');
      for (const marker of markers.get(selectedId) ?? []) marker.classList.remove('is-active');
    }
    selectedId = id;
    const card = cards.get(id);
    card?.classList.add('is-active');
    for (const marker of markers.get(id) ?? []) marker.classList.add('is-active');

    if (origin === 'pdf') card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    else markers.get(id)?.[0]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  let renderToken = 0;
  let pageObserver: IntersectionObserver | null = null;

  /**
   * ページは「枠だけ先に並べ、見える範囲に入ったら描く」。
   *
   * 全ページを一度に描いて持ち続けると、500 ページの論文でブラウザが 3GB 以上使い、
   * 幅を変えるたびに全ページを描き直して 20 秒固まる。枠の寸法は描かなくても分かるので、
   * マーカーの位置は最初から正しく置ける。
   */
  async function renderPdf(): Promise<void> {
    const token = ++renderToken;
    pageObserver?.disconnect();
    pageObserver = null;
    pdfColumn.textContent = '';
    markers.clear();
    const status = el('p', 'lxv-status', 'PDF を読み込んでいます…');
    pdfColumn.append(status);

    let pdf: LoadedPdf;
    try {
      pdf = await loadPdf(base64ToBytes(pdfBase64));
    } catch (error) {
      status.textContent = `PDF を開けませんでした: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    if (token !== renderToken) return;
    status.remove();

    if (!isWorkerAvailable()) {
      pdfColumn.append(
        el(
          'p',
          'lxv-status',
          'このブラウザではワーカーを使えないため、PDF の描画が単一スレッドで動きます。ページ数が多いと遅くなります。',
        ),
      );
    }

    const cssWidth = Math.max(320, Math.min(pdfColumn.clientWidth - 32, 1400));
    const byPage = new Map<number, Set<Sentence>>();
    for (const sentence of sentences) {
      for (const rect of sentence.rects) {
        const list = byPage.get(rect.page);
        if (list) list.add(sentence);
        else byPage.set(rect.page, new Set([sentence]));
      }
    }

    const drawn = new Set<number>();
    const draw = async (container: HTMLElement, pageNumber: number): Promise<void> => {
      if (drawn.has(pageNumber) || token !== renderToken) return;
      drawn.add(pageNumber);
      try {
        const canvas = await renderPageCanvas(pdf, pageNumber, cssWidth);
        if (token !== renderToken) return;
        container.prepend(canvas);
        if (needsMissingResources()) showResourceWarning();
      } catch {
        drawn.delete(pageNumber);
      }
    };
    const release = (container: HTMLElement, pageNumber: number): void => {
      const canvas = container.querySelector('canvas');
      if (!canvas) return;
      // 実体を手放す。width=0 にしないと、要素を外してもピクセルは解放されない。
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
      drawn.delete(pageNumber);
    };

    pageObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const container = entry.target as HTMLElement;
          const pageNumber = Number(container.dataset['page']);
          if (entry.isIntersecting) void draw(container, pageNumber);
          else if (Math.abs(entry.boundingClientRect.top) > window.innerHeight * 6) release(container, pageNumber);
        }
      },
      { root: null, rootMargin: '800px 0px' },
    );

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const geometry = await pageGeometry(pdf, pageNumber, cssWidth);
      if (token !== renderToken) return;
      const container = el('div', 'lxv-page');
      container.style.width = `${geometry.width}px`;
      container.style.height = `${geometry.height}px`;
      container.dataset['page'] = String(pageNumber);

      const overlay = el('div', 'lxv-overlay');
      for (const sentence of byPage.get(pageNumber) ?? []) {
        for (const rect of sentence.rects) {
          if (rect.page !== pageNumber) continue;
          const marker = el('button', 'lxv-marker');
          marker.type = 'button';
          // 文書全体で数千個になるのでタブ順から外す。操作はサイドバーに一本化する。
          marker.tabIndex = -1;
          marker.setAttribute('aria-hidden', 'true');
          marker.style.left = `${rect.x * geometry.scale}px`;
          marker.style.top = `${rect.y * geometry.scale}px`;
          marker.style.width = `${rect.w * geometry.scale}px`;
          marker.style.height = `${rect.h * geometry.scale}px`;
          marker.title = sentence.text;
          if (paper.annotations.translations[sentence.hash]) marker.classList.add('is-translated');
          // 描画前に選ばれていた文・絞り込み済みの文の状態をここで反映する。
          if (sentence.id === selectedId) marker.classList.add('is-active');
          if (visibleIds !== null && !visibleIds.has(sentence.id)) marker.classList.add('is-filtered-out');
          marker.addEventListener('click', () => select(sentence.id, 'pdf'));
          overlay.append(marker);
          const list = markers.get(sentence.id);
          if (list) list.push(marker);
          else markers.set(sentence.id, [marker]);
        }
      }
      container.append(overlay);
      pdfColumn.append(container);
      pageObserver.observe(container);
    }
  }

  let resourceWarningShown = false;
  function showResourceWarning(): void {
    if (resourceWarningShown) return;
    resourceWarningShown = true;
    // 外部 URL をゼロにしている代償。黙って白いページを見せるより、理由を出す。
    pdfColumn.prepend(
      el(
        'p',
        'lxv-status',
        'この PDF は、このファイルに同梱していない文字コード表（CMap）や標準フォントを必要とします。' +
          'ページが白く見えることがありますが、原文と訳は右側でそのまま読めます。',
      ),
    );
  }

  // --- 検索 ---------------------------------------------------------------
  function applyFilter(): void {
    const needle = search.value.trim().toLowerCase();
    if (needle.length === 0) {
      visibleIds = null;
      for (const card of cards.values()) card.hidden = false;
      for (const group of groups) if (group.heading) group.heading.hidden = false;
      for (const list of markers.values()) {
        for (const marker of list) marker.classList.remove('is-filtered-out', 'is-match');
      }
      emptyMessage.hidden = true;
      return;
    }

    visibleIds = new Set<string>();
    for (const sentence of sentences) {
      const card = cards.get(sentence.id);
      if (!card) continue;
      const haystack = [
        sentence.text,
        paper.annotations.translations[sentence.hash]?.text ?? '',
        ...(notesByHash.get(sentence.hash) ?? []).map((note) => note.body),
      ]
        .join(' ')
        .toLowerCase();
      const matched = haystack.includes(needle);
      card.hidden = !matched;
      if (matched) visibleIds.add(sentence.id);
    }

    // 配下が全部消えた見出しは一緒に隠す（見出しだけが宙に浮くのを防ぐ）。
    for (const group of groups) {
      if (!group.heading) continue;
      group.heading.hidden = group.cards.every((card) => card.hidden);
    }

    for (const [id, list] of markers) {
      for (const marker of list) {
        const matched = visibleIds.has(id);
        marker.classList.toggle('is-filtered-out', !matched);
        // 未訳のマーカーは背景が無いので、消すだけでは「当たり」が見えない。
        marker.classList.toggle('is-match', matched);
      }
    }
    emptyMessage.hidden = visibleIds.size > 0;
  }

  search.addEventListener('input', applyFilter);

  // 幅が変わったら描き直す（描画幅を起動時に固定するとページがはみ出したままになる）。
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let lastWidth = 0;
  window.addEventListener('resize', () => {
    const width = pdfColumn.clientWidth;
    if (Math.abs(width - lastWidth) < 24) return;
    lastWidth = width;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      void renderPdf().then(applyFilter);
    }, RESIZE_DEBOUNCE_MS);
  });

  lastWidth = pdfColumn.clientWidth;
  // ここまで来たら画面は組み上がっている。静的フォールバックを外してよい。
  if (staticFallback) staticFallback.remove();
  void renderPdf();
}

/**
 * 何があっても静的フォールバックだけは残す。
 * このファイルは「誰かが受け取った 1 枚の HTML」なので、読めない理由が何であれ
 * 真っ白な画面より原文と訳が並んだ素の HTML の方がましである。
 */
function safeBoot(): void {
  try {
    boot();
  } catch (error) {
    const staticFallback = document.getElementById('lx-static');
    if (staticFallback) staticFallback.hidden = false;
    const root = document.getElementById('lx-root');
    if (root) root.replaceChildren();
    console.error('LogiXiv viewer failed to start', error);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', safeBoot);
} else {
  safeBoot();
}
