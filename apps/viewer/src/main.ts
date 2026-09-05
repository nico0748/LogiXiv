import './style.css';
import type { ExportPayload, Note, Sentence } from './types.ts';
import { base64ToBytes, loadPdf, renderPage } from './pdf.ts';

/**
 * 書き出し HTML の中で動くビューア。
 *
 * ここは「他人が受け取ったファイル」を開く場所なので、次の 2 つを守る。
 *  - ネットワークに一切出ない（fetch も外部フォントも無い）
 *  - 埋め込みデータは JSON.parse で読むだけ。innerHTML への流し込みもしない
 */

const DATA_ELEMENT_ID = 'logixiv-data';

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
  const sectionTitles = new Map(paper.structure.sections.map((s) => [s.id, s.title]));
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
  const meta = el(
    'span',
    'lxv-meta',
    `${sentences.length} 文 · ${paper.structure.parser === 'grobid' ? 'GROBID 解析' : '簡易解析'}`,
  );
  header.append(title, search, meta);

  const pdfColumn = el('main', 'lxv-pdf');
  const sidebar = el('aside', 'lxv-sidebar');
  layout.append(header, pdfColumn, sidebar);
  root.append(layout);

  // --- サイドバー（1 文 = 1 カード）---------------------------------------
  const cards = new Map<string, HTMLElement>();
  let lastSection: string | null | undefined;
  for (const sentence of sentences) {
    if (sentence.sectionId !== lastSection) {
      lastSection = sentence.sectionId;
      const heading = lastSection ? sectionTitles.get(lastSection) : null;
      if (heading) sidebar.append(el('h2', 'lxv-section', heading));
    }
    sidebar.append(buildCard(sentence));
  }

  function buildCard(sentence: Sentence): HTMLElement {
    const card = el('article', 'lxv-card');
    card.dataset['id'] = sentence.id;
    card.tabIndex = 0;

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
      if (event.key === 'Enter') select(sentence.id, 'sidebar');
    });
    cards.set(sentence.id, card);
    return card;
  }

  // --- PDF とマーカー -----------------------------------------------------
  const markers = new Map<string, HTMLElement[]>();
  let selectedId: string | null = null;

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

  async function renderPdf(): Promise<void> {
    pdfColumn.textContent = '';
    const status = el('p', 'lxv-status', 'PDF を読み込んでいます…');
    pdfColumn.append(status);

    let pdf: Awaited<ReturnType<typeof loadPdf>>;
    try {
      pdf = await loadPdf(base64ToBytes(pdfBase64));
    } catch (error) {
      status.textContent = `PDF を開けませんでした: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    status.remove();

    const cssWidth = Math.max(320, Math.min(pdfColumn.clientWidth - 32, 900));
    const byPage = new Map<number, Sentence[]>();
    for (const sentence of sentences) {
      for (const rect of sentence.rects) {
        const list = byPage.get(rect.page);
        if (list) list.push(sentence);
        else byPage.set(rect.page, [sentence]);
      }
    }

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const rendered = await renderPage(pdf, pageNumber, cssWidth);
      const overlay = el('div', 'lxv-overlay');
      for (const sentence of new Set(byPage.get(pageNumber) ?? [])) {
        for (const rect of sentence.rects) {
          if (rect.page !== pageNumber) continue;
          const marker = el('button', 'lxv-marker');
          marker.type = 'button';
          marker.style.left = `${rect.x * rendered.scale}px`;
          marker.style.top = `${rect.y * rendered.scale}px`;
          marker.style.width = `${rect.w * rendered.scale}px`;
          marker.style.height = `${rect.h * rendered.scale}px`;
          marker.title = sentence.text.slice(0, 120);
          if (paper.annotations.translations[sentence.hash]) marker.classList.add('is-translated');
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
  search.addEventListener('input', () => {
    const needle = search.value.trim().toLowerCase();
    for (const sentence of sentences) {
      const card = cards.get(sentence.id);
      if (!card) continue;
      if (needle.length === 0) {
        card.hidden = false;
        continue;
      }
      const haystack = [
        sentence.text,
        paper.annotations.translations[sentence.hash]?.text ?? '',
        ...(notesByHash.get(sentence.hash) ?? []).map((note) => note.body),
      ]
        .join(' ')
        .toLowerCase();
      card.hidden = !haystack.includes(needle);
    }
  });

  void renderPdf();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
