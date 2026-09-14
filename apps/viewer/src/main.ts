import './style.css';
import type { ExportPayload, Note, Section, Sentence } from './types.ts';
import { base64ToBytes, loadPdf, renderPage } from './pdf.ts';

/**
 * 書き出し HTML の中で動くビューア。
 *
 * ここは「他人が受け取ったファイル」を開く場所なので、次の 2 つを守る。
 *  - ネットワークに一切出ない（fetch も外部フォントも無い）
 *  - 埋め込みデータは JSON.parse で読むだけ。innerHTML への流し込みもしない
 */

const DATA_ELEMENT_ID = 'logixiv-data';
const RESIZE_DEBOUNCE_MS = 300;

function readPayload(): ExportPayload | null {
  const element = document.getElementById(DATA_ELEMENT_ID);
  if (!element) return null;
  try {
    return JSON.parse(element.textContent ?? '') as ExportPayload;
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
  if (staticFallback) staticFallback.remove();

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

  async function renderPdf(): Promise<void> {
    const token = ++renderToken;
    pdfColumn.textContent = '';
    markers.clear();
    const status = el('p', 'lxv-status', 'PDF を読み込んでいます…');
    pdfColumn.append(status);

    let pdf: Awaited<ReturnType<typeof loadPdf>>;
    try {
      pdf = await loadPdf(base64ToBytes(pdfBase64));
    } catch (error) {
      status.textContent = `PDF を開けませんでした: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    if (token !== renderToken) return;
    status.remove();

    const cssWidth = Math.max(320, Math.min(pdfColumn.clientWidth - 32, 1400));
    const byPage = new Map<number, Set<Sentence>>();
    for (const sentence of sentences) {
      for (const rect of sentence.rects) {
        const list = byPage.get(rect.page);
        if (list) list.add(sentence);
        else byPage.set(rect.page, new Set([sentence]));
      }
    }

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const rendered = await renderPage(pdf, pageNumber, cssWidth);
      if (token !== renderToken) return;
      const overlay = el('div', 'lxv-overlay');
      for (const sentence of byPage.get(pageNumber) ?? []) {
        for (const rect of sentence.rects) {
          if (rect.page !== pageNumber) continue;
          const marker = el('button', 'lxv-marker');
          marker.type = 'button';
          // 文書全体で数千個になるのでタブ順から外す。操作はサイドバーに一本化する。
          marker.tabIndex = -1;
          marker.setAttribute('aria-hidden', 'true');
          marker.style.left = `${rect.x * rendered.scale}px`;
          marker.style.top = `${rect.y * rendered.scale}px`;
          marker.style.width = `${rect.w * rendered.scale}px`;
          marker.style.height = `${rect.h * rendered.scale}px`;
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
      rendered.container.append(overlay);
      pdfColumn.append(rendered.container);
    }
  }

  // --- 検索 ---------------------------------------------------------------
  function applyFilter(): void {
    const needle = search.value.trim().toLowerCase();
    if (needle.length === 0) {
      visibleIds = null;
      for (const card of cards.values()) card.hidden = false;
      for (const group of groups) if (group.heading) group.heading.hidden = false;
      for (const list of markers.values()) for (const marker of list) marker.classList.remove('is-filtered-out');
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
      for (const marker of list) marker.classList.toggle('is-filtered-out', !visibleIds.has(id));
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
  void renderPdf();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
