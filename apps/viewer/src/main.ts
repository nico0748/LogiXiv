import './style.css';
import type { ExportPayload, NonBodySentence, Note, Section, Sentence } from './types.ts';
// 本文以外の行をどの文の後ろに置くかは、画面・書き出しの静的部分と同じ規則を使う。
// 規則を写し持っていたせいで、3 か所とも同じずれ方をしていた。
import { placeNonBody } from '../../../packages/core/src/nonbody.ts';
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
  // 取り込み側と同じものを指す。id だけで拾うと、<div id="logixiv-data"> のような
  // 取り込み側には見えない要素からビューアだけが起動してしまう。
  const elements = document.querySelectorAll(`script#${DATA_ELEMENT_ID}[type="application/json"]`);
  if (elements.length !== 1) return null;
  try {
    const payload = JSON.parse(elements[0]!.textContent ?? '') as ExportPayload;
    const paper = payload?.document;
    if (!paper || typeof paper !== 'object') return null;
    if (!Array.isArray(paper.structure?.sentences)) return null;
    if (!Array.isArray(paper.structure?.sections)) return null;
    // 座標が無い文は珍しくない（GROBID が返さないことがある）。ここで落とさず補う。
    for (const sentence of paper.structure.sentences) {
      if (!Array.isArray(sentence?.rects)) sentence.rects = [];
    }
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

/**
 * 見出しに出す文の数。
 *
 * 訳は「同じ本文ごとに 1 つ」付くので、作業量は**異なり文**の数で数える。
 * 延べ数だけを出していたので、本体側が「298 文」と言っている論文の書き出しが
 * 「403 文」と名乗っていた。受け取った側は同じ文書について違う数を見る。
 */
function countLabel(
  paper: ExportPayload['document'],
  sentences: readonly { hash: string }[],
): string {
  const hashes = new Set(sentences.map((sentence) => sentence.hash));
  const translations = paper.annotations.translations;
  const skipped = paper.annotations.skipped ?? {};
  let translated = 0;
  let skippedCount = 0;
  for (const hash of hashes) {
    // 訳と「訳さない」を足して 1 つの数にすると、27 文中 26 文しか訳していない論文が
    // 「27 / 27 文」と名乗る。訳し残しが無いという意味に読まれてしまう。
    if (translations[hash]) translated++;
    else if (skipped[hash]) skippedCount++;
  }
  const repeats = sentences.length > hashes.size ? `（画面には延べ ${sentences.length} 行）` : '';
  const notTranslated = skippedCount > 0 ? `（訳さない ${skippedCount}）` : '';
  return `${translated} / ${hashes.size} 文${notTranslated}${repeats}`;
}

function seamLabel(kinds: NonBodySentence['kind'][]): string {
  const names = kinds.map((kind) => NON_BODY_LABELS[kind] ?? '行');
  if (names.length === 0) return '行';
  if (names.length <= 2) return names.join('と');
  return `${names.slice(0, 2).join('と')}など`;
}

const NON_BODY_LABELS: Record<NonBodySentence['kind'], string> = {
  frontMatter: '表題・著者',
  runningHead: '柱',
  pageNumber: 'ページ番号',
  caption: '図表キャプション',
  reference: '参考文献',
  footnote: '脚注',
  formula: '数式',
  table: '表',
  other: '本文以外',
};

/**
 * 用語集は何件までなら開いたまま出すか。
 *
 * 論文によっては数百件あるので、全部開くと対訳が下へ追いやられる。
 * かといって既定で畳むと、少数の用語集は「無い」のと変わらない。
 */
const GLOSSARY_OPEN_MAX = 20;

/**
 * 用語集をビューアにも出す。
 *
 * これまで用語集は静的フォールバック（JS が動かない環境用の素の HTML）の中にしか
 * 出力されておらず、ビューアは起動時にその div ごと外していた。つまり普通に開いた
 * 人には 1 文字も見えず、**JS を切った人にだけ**見えていた。
 * 訳語をどう決めたかが伝わらないと受け取った側は同じ語を別の訳で書き直すので、
 * 用語集を書き出す意味そのものが無くなる。
 *
 * 埋め込みデータは他人から来たファイルなので、ここでも textContent にしか入れない。
 */
function glossaryPanel(entries: ExportPayload['document']['annotations']['glossary']): HTMLElement {
  const panel = el('details', 'lxv-glossary');
  const list = (Array.isArray(entries) ? entries : []).filter(
    (entry) => entry && typeof entry === 'object' && typeof entry.term === 'string',
  );
  if (list.length === 0) {
    panel.hidden = true;
    return panel;
  }
  panel.open = list.length <= GLOSSARY_OPEN_MAX;
  const summary = el('summary', 'lxv-glossary-summary', `用語集（${list.length}）`);
  panel.append(summary);

  const table = el('table', 'lxv-glossary-table');
  const head = el('tr');
  for (const label of ['原語', '訳語', 'メモ']) head.append(el('th', undefined, label));
  table.append(head);
  for (const entry of list) {
    const row = el('tr');
    const term = el('td', 'lxv-glossary-term', entry.term);
    term.lang = 'en';
    row.append(term);
    row.append(el('td', undefined, typeof entry.translation === 'string' ? entry.translation : ''));
    row.append(el('td', 'lxv-glossary-note', typeof entry.note === 'string' && entry.note ? entry.note : ''));
    table.append(row);
  }
  panel.append(table);
  return panel;
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
    countLabel(paper, sentences) +
      ` · ${paper.structure.parser === 'grobid' ? 'GROBID 解析' : '簡易解析'}` +
      // 受け取った側にも、原文が信用できるかどうかは要る。
      // 崩れを直せなくても、崩れていると分かれば読み方を変えられる。
      (paper.structure.quality?.readingOrderRisk === 'high' ? ' · 読み順に崩れの疑い' : '') +
      (paper.structure.quality?.coverageRisk === 'high' ? ' · 本文の欠落の疑い' : ''),
  );
  header.append(title, search, meta);

  const pdfColumn = el('main', 'lxv-pdf');
  const sidebar = el('aside', 'lxv-sidebar');
  const emptyMessage = el('p', 'lxv-empty', '一致する文がありません。');
  emptyMessage.hidden = true;
  /** 絞り込みの結果に「何が何件当たったか」。訳の付かないカードが並ぶ理由をその場に出す。 */
  const filterNote = el('p', 'lxv-filter-note');
  filterNote.hidden = true;
  layout.append(header, pdfColumn, sidebar);
  root.append(layout);

  // --- サイドバー（1 文 = 1 カード）---------------------------------------
  const cards = new Map<string, HTMLElement>();
  /** 見出しと、その見出しに属するカード。0 件になったら見出しごと隠す。 */
  const groups: { heading: HTMLElement | null; cards: HTMLElement[] }[] = [];
  let currentGroup: { heading: HTMLElement | null; cards: HTMLElement[] } = { heading: null, cards: [] };
  groups.push(currentGroup);

  /**
   * 本文として扱わなかった行を、直前の本文の後ろに差し込む。
   * 位置の決め方は core と共有する（同じ本文が 2 回出る論文で、手前の出現に
   * 吸い寄せられて参考文献が序論の途中に出ていた）。
   */
  const placement = placeNonBody(sentences, paper.structure.nonBody);

  /** 本文以外のカード。検索でも当てるので、本文と別に持っておく。 */
  const nonBodyCards: { item: NonBodySentence; card: HTMLElement }[] = [];

  let lastSection: string | null | undefined;
  sidebar.append(glossaryPanel(paper.annotations.glossary));
  sidebar.append(filterNote);
  sidebar.append(emptyMessage);
  for (const item of placement.head) {
    const card = buildNonBodyCard(item);
    currentGroup.cards.push(card);
    sidebar.append(card);
  }
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
    for (const item of placement.after.get(sentence.id) ?? []) {
      const extra = buildNonBodyCard(item);
      currentGroup.cards.push(extra);
      sidebar.append(extra);
    }
  }

  function buildNonBodyCard(item: NonBodySentence): HTMLElement {
    const card = el('article', 'lxv-card lxv-nonbody');
    card.dataset['id'] = item.id;
    const kind = el('p', 'lxv-nonbody-kind', `${NON_BODY_LABELS[item.kind]}（訳しません）`);
    // 検索に当たったときの印。訳が付かないカードなので、本文のヒットと
    // 同じ見た目で並ぶと「訳し忘れの一致」に読まれる。
    kind.append(el('span', 'lxv-nonbody-match', '検索に一致'));
    card.append(kind);
    card.append(el('p', 'lxv-source', item.text));
    nonBodyCards.push({ item, card });
    return card;
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
    } else if (paper.annotations.skipped?.[sentence.hash]) {
      // 「訳さない」は判断であって、訳し忘れではない。混ぜると、受け取った側は
      // 片付いているものを残件だと読む。
      card.append(el('p', 'lxv-skipped', '（訳さない）'));
      card.classList.add('is-skipped');
    } else {
      card.append(el('p', 'lxv-untranslated', '（未訳）'));
    }
    card.append(el('p', 'lxv-source', sentence.text));

    // 受け取った側にも、どの文の原文が怪しいかは要る。訳文だけを読むと
    // 記号が落ちた文も「そう書いてある」としか見えない。
    if (sentence.seam) {
      const seam = el(
        'p',
        'lxv-seam',
        `この文には、本文として取り出せなかった${seamLabel(sentence.seam.kinds)}が挟まっています（記号や語が抜けているおそれ）。`,
      );
      if (sentence.seam.texts && sentence.seam.texts.length > 0) {
        // 抜けた中身をその場に出す。読み手が PDF を開き直さずに補える。
        seam.append(el('span', 'lxv-seam-text', ` 抜けたのはここ: ${sentence.seam.texts.join(' / ')}`));
      }
      card.append(seam);
    }

    for (const note of notesByHash.get(sentence.hash) ?? []) {
      const noteElement = el('p', 'lxv-note', note.body);
      // 書き手を title 属性にだけ入れていたので、ホバーしないと見えなかった。
      // メモは取り込みのたびに積み上がる（衝突しても消さない規則なので）ため、
      // Claude の「自信が無い」と同僚の断定と自分の書きかけが混ざる。
      // 誰が言ったかが判断材料そのものなので、本文と同じ面に出す。
      if (note.author) noteElement.append(el('span', 'lxv-note-author', note.author));
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

    if (origin === 'pdf') {
      card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    const marker = markers.get(id)?.[0];
    if (!marker) return;
    // 飛び先のページを先に描く。観測任せだと、着いた先が白い枠のままになる。
    const page = marker.closest('.lxv-page');
    if (page instanceof HTMLElement) drawPage?.(Number(page.dataset['page']));
    marker.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  let renderToken = 0;
  let pageObserver: IntersectionObserver | null = null;
  /** 描いたページを見える範囲の近さで手放すための、直近に描いた順の並び。 */
  const MAX_DRAWN_PAGES = 12;
  /** 選択された文のページを、観測を待たずに描くための取っ掛かり。 */
  let drawPage: ((pageNumber: number) => void) | null = null;

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
    drawPage = null;
    pdfColumn.textContent = '';
    // 画面を作り直すので、一度出した注意書きも出し直せるようにする。
    resourceWarningShown = false;
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

    /**
     * 描いたページは「直近 MAX_DRAWN_PAGES 枚」だけ残す。
     *
     * 交差の監視は状態が**変わったとき**しか通知しないので、「画面から
     * 6 画面ぶん離れたら手放す」という条件はそもそも発火しない（離れた瞬間は
     * 必ず 1 画面ぶんの距離しかない）。200 ページを普通にスクロールするだけで
     * キャンバスが 111 枚・477MB 積み上がっていた。件数で抑える方が確実。
     */
    const drawn = new Map<number, HTMLElement>();
    const release = (pageNumber: number): void => {
      const container = drawn.get(pageNumber);
      drawn.delete(pageNumber);
      const canvas = container?.querySelector('canvas');
      if (!canvas) return;
      // 実体を手放す。width=0 にしないと、要素を外してもピクセルは解放されない。
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
    };
    const evict = (keep: number): void => {
      while (drawn.size > MAX_DRAWN_PAGES) {
        const oldest = [...drawn.keys()].find((page) => page !== keep);
        if (oldest === undefined) return;
        release(oldest);
      }
    };
    const draw = async (container: HTMLElement, pageNumber: number): Promise<void> => {
      if (drawn.has(pageNumber) || token !== renderToken) return;
      drawn.set(pageNumber, container);
      try {
        const canvas = await renderPageCanvas(pdf, pageNumber, cssWidth);
        if (token !== renderToken) return;
        container.prepend(canvas);
        evict(pageNumber);
        if (needsMissingResources()) showResourceWarning();
      } catch {
        drawn.delete(pageNumber);
      }
    };

    // 選んだ文のページは、観測の通知を待たずに描く。待つと、飛んだ直後に
    // 真っ白な枠だけが見える時間ができる。
    drawPage = (pageNumber: number): void => {
      const container = pdfColumn.querySelector(`.lxv-page[data-page="${pageNumber}"]`);
      if (container instanceof HTMLElement) void draw(container, pageNumber);
    };

    pageObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const container = entry.target as HTMLElement;
          const pageNumber = Number(container.dataset['page']);
          if (entry.isIntersecting) void draw(container, pageNumber);
        }
      },
      // root は実際にスクロールする要素にする。ここを null にすると rootMargin が
      // 効かず（画面外は段組の overflow で切られている）、先読みが一切起きない。
      { root: pdfColumn, rootMargin: '900px 0px' },
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

  /** 描画が途中で落ちても、理由を画面に出す（白いだけの欄を残さない）。 */
  function reportRenderFailure(error: unknown): void {
    pdfColumn.textContent = '';
    pdfColumn.append(
      el('p', 'lxv-status', `PDF を表示できませんでした: ${error instanceof Error ? error.message : String(error)}`),
    );
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
      // 絞り込みを解いたら、本文以外の行も元どおり全部出す。
      for (const entry of nonBodyCards) {
        entry.card.hidden = false;
        entry.card.classList.remove('is-match');
      }
      for (const group of groups) if (group.heading) group.heading.hidden = false;
      for (const list of markers.values()) {
        for (const marker of list) marker.classList.remove('is-filtered-out', 'is-match');
      }
      emptyMessage.hidden = true;
      filterNote.hidden = true;
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

    // 本文以外の行も同じ検索語で当てる。画面に現に出ているカードを検索が
    // 「ありません」と言う状態を作らないため。訳の対象ではないので、
    // 当たったカードには印を付けて本文のヒットと見分けが付くようにする。
    let nonBodyMatches = 0;
    for (const entry of nonBodyCards) {
      const matched = entry.item.text.toLowerCase().includes(needle);
      entry.card.hidden = !matched;
      entry.card.classList.toggle('is-match', matched);
      if (matched) nonBodyMatches++;
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
    filterNote.hidden = false;
    filterNote.textContent =
      `一致: 本文 ${visibleIds.size} 件` +
      (nonBodyMatches > 0 ? ` ／ 訳さない行 ${nonBodyMatches} 件（参考文献・図表など）` : '');
    emptyMessage.hidden = visibleIds.size + nonBodyMatches > 0;
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
      void renderPdf().then(applyFilter).catch(reportRenderFailure);
    }, RESIZE_DEBOUNCE_MS);
  });

  lastWidth = pdfColumn.clientWidth;
  // ここまで来たら画面は組み上がっている。静的フォールバックを外してよい。
  if (staticFallback) staticFallback.remove();
  void renderPdf().catch(reportRenderFailure);
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
