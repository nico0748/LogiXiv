import { parseXml, findPath, firstChild, descendants, textContent, type XmlElement } from './xml.ts';
import { STRUCTURE_VERSION, sentenceHash, sentenceId, stableId } from './hash.ts';
import type { DocumentStructure, PageSize, Rect, Section, Sentence } from './types.ts';

/**
 * GROBID の TEI を DocumentStructure に落とす。
 *
 * 前提: processFulltextDocument を segmentSentences=1, teiCoordinates=s で呼んでいること。
 * この 2 つが無いと <s> も coords も出てこないので、そのときは座標なしの文になる。
 */

/** coords="1,53.80,194.57,238.71,9.29;1,53.80,205.00,..." を矩形列にする。 */
export function parseCoords(coords: string | undefined): Rect[] {
  if (!coords) return [];
  const rects: Rect[] = [];
  for (const part of coords.split(';')) {
    const fields = part.split(',');
    if (fields.length < 5) continue;
    const [page, x, y, w, h] = fields.map((f) => Number.parseFloat(f.trim()));
    if (![page, x, y, w, h].every((n) => Number.isFinite(n))) continue;
    rects.push({ page: page as number, x: x as number, y: y as number, w: w as number, h: h as number });
  }
  return rects;
}

function parseFacsimile(tei: XmlElement): PageSize[] {
  const facsimile = firstChild(tei, 'facsimile');
  if (!facsimile) return [];
  const pages: PageSize[] = [];
  for (const surface of descendants(facsimile, 'surface')) {
    const page = Number.parseInt(surface.attrs['n'] ?? '', 10);
    const lrx = Number.parseFloat(surface.attrs['lrx'] ?? '');
    const lry = Number.parseFloat(surface.attrs['lry'] ?? '');
    const ulx = Number.parseFloat(surface.attrs['ulx'] ?? '0');
    const uly = Number.parseFloat(surface.attrs['uly'] ?? '0');
    if (!Number.isFinite(page) || !Number.isFinite(lrx) || !Number.isFinite(lry)) continue;
    pages.push({ page, width: lrx - (Number.isFinite(ulx) ? ulx : 0), height: lry - (Number.isFinite(uly) ? uly : 0) });
  }
  return pages.sort((a, b) => a.page - b.page);
}

/** 空白の正規化。TEI のインデントがそのまま文に混ざるのを防ぐ。 */
function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 本文として辿らない要素。
 *
 * GROBID は <body> の直下に図表・脚注・数式も <s> 付きで出す。素通しすると
 * 図キャプション・表のセルの数値・脚注・数式が「文」としてサイドバーに並び、
 * order も本文と入り混じって読めなくなる。座標を持たないものが多いので
 * 「座標あり n/m 文」の警告まで誤作動していた。
 */
const SKIP_ELEMENTS = new Set([
  'figure',
  'figdesc',
  'table',
  'formula',
  'note',
  'listbibl',
  'biblstruct',
  'teiheader',
  'facsimile',
]);

interface Collector {
  sentences: Sentence[];
  sections: Section[];
  occurrences: Map<string, number>;
  sectionIds: Set<string>;
  currentSectionId: string | null;
  /** 本文として採らなかった <s> の数。UI へ出すために数えておく。 */
  skipped: number;
}

function pushSentence(collector: Collector, element: XmlElement): void {
  const text = tidy(textContent(element));
  if (text.length === 0) return;
  const rects = parseCoords(element.attrs['coords']);
  const hash = sentenceHash(text);
  const occurrence = collector.occurrences.get(hash) ?? 0;
  collector.occurrences.set(hash, occurrence + 1);
  collector.sentences.push({
    id: sentenceId(hash, occurrence),
    hash,
    order: collector.sentences.length,
    page: rects[0]?.page ?? collector.sentences[collector.sentences.length - 1]?.page ?? 1,
    text,
    rects,
    sectionId: collector.currentSectionId,
  });
}

/**
 * 節 ID は見出しの内容から作る。
 * 並び順から作ると、includeAbstract の有無だけで本文の節 ID が 1 つずつずれて、
 * 設定違いの再解析で UI の参照が全部外れる。
 */
function registerSection(collector: Collector, title: string): string {
  let disambiguator = 0;
  let id = stableId('sec', title);
  while (collector.sectionIds.has(id)) {
    disambiguator++;
    id = stableId('sec', title, disambiguator);
  }
  collector.sectionIds.add(id);
  collector.sections.push({ id, title, level: 1, order: collector.sections.length });
  return id;
}

/**
 * body を文書順に歩く。div に入るたびに head を見出しとして拾い、
 * その div の中の <s> をその節に属させる。
 */
function walk(node: XmlElement, collector: Collector): void {
  for (const child of node.children) {
    if (child.type !== 'element') continue;

    if (SKIP_ELEMENTS.has(child.name.toLowerCase())) {
      for (const _ of descendants(child, 's')) collector.skipped++;
      continue;
    }

    if (child.name === 'div') {
      const previous = collector.currentSectionId;
      const head = firstChild(child, 'head');
      if (head) {
        const rawTitle = tidy(textContent(head));
        if (rawTitle.length > 0) {
          const n = head.attrs['n'] ?? '';
          const title = n ? `${n} ${rawTitle}` : rawTitle;
          const id = registerSection(collector, title);
          const section = collector.sections[collector.sections.length - 1]!;
          section.level = n ? n.replace(/\.$/, '').split('.').length : 1;
          collector.currentSectionId = id;
        }
      }
      walk(child, collector);
      collector.currentSectionId = previous;
      continue;
    }

    if (child.name === 's') {
      pushSentence(collector, child);
      continue;
    }

    // head 自体は本文の文として拾わない（サイドバーに見出しが文として並ぶのを避ける）。
    if (child.name === 'head') continue;

    walk(child, collector);
  }
}

export interface ParseTeiOptions {
  /** 抄録も対訳の対象にするか。既定は true。 */
  includeAbstract?: boolean;
}

export function parseTei(xml: string, options: ParseTeiOptions = {}): DocumentStructure {
  const includeAbstract = options.includeAbstract ?? true;
  const document = parseXml(xml);
  const tei = firstChild(document, 'TEI') ?? document;

  const titleElement = findPath(tei, 'teiHeader/fileDesc/titleStmt/title');
  const title = titleElement ? tidy(textContent(titleElement)) || null : null;

  const abstractElement = findPath(tei, 'teiHeader/profileDesc/abstract');
  const abstract = abstractElement ? tidy(textContent(abstractElement)) || null : null;

  const collector: Collector = {
    sentences: [],
    sections: [],
    occurrences: new Map(),
    sectionIds: new Set(),
    currentSectionId: null,
    skipped: 0,
  };

  if (includeAbstract && abstractElement) {
    collector.sections.push({ id: 'sec_abstract', title: 'Abstract', level: 1, order: 0 });
    collector.sectionIds.add('sec_abstract');
    collector.currentSectionId = 'sec_abstract';
    for (const s of descendants(abstractElement, 's')) pushSentence(collector, s);
    collector.currentSectionId = null;
  }

  const body = findPath(tei, 'text/body');
  if (body) walk(body, collector);

  const withCoords = collector.sentences.filter((s) => s.rects.length > 0).length;
  const total = collector.sentences.length;
  const skippedNote = collector.skipped > 0 ? `。図表・脚注・数式の ${collector.skipped} 文は本文から除外` : '';
  const parserNote =
    total === 0
      ? 'GROBID は本文の文を返しませんでした。segmentSentences=1 を付けているか確認してください。'
      : withCoords === total
        ? `GROBID による文単位解析（全文に PDF 座標あり）${skippedNote}`
        : `GROBID による文単位解析（座標あり ${withCoords}/${total} 文。teiCoordinates=s を確認してください）${skippedNote}`;

  return {
    version: STRUCTURE_VERSION,
    parser: 'grobid',
    parserNote,
    parsedAt: new Date().toISOString(),
    title,
    abstract,
    pageSizes: parseFacsimile(tei),
    sections: collector.sections,
    sentences: collector.sentences,
  };
}
