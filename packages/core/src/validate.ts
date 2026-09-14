import type {
  Annotations,
  DocumentStructure,
  GlossaryEntry,
  Note,
  PageSize,
  PaperDocument,
  Rect,
  Section,
  Sentence,
  Translation,
} from './types.ts';
import { STRUCTURE_VERSION, newId, sentenceHash, sentenceId } from './hash.ts';

/**
 * 外から来た JSON を、型どおりだと保証できる値に落とす。
 *
 * 書き出し HTML は人づてに回るファイルで、中身は誰でも書き換えられる。
 * 型アサーションで通してしまうと `text: null` や `notes: "…"` がそのまま
 * ストアに書かれ、以降 progress / search / export が実行時に落ちる
 * （しかもディスクに残るので再起動しても直らない）。
 *
 * 方針は「捨てて続ける」。不正な要素は落とし、何件落としたかを呼び出し元へ返す。
 * 例外は投げない — 1 つの壊れた文で論文 1 本を読めなくする方が損が大きい。
 */

export interface SanitizeReport {
  droppedSentences: number;
  droppedTranslations: number;
  droppedNotes: number;
  droppedGlossary: number;
  /** 直した点（ハッシュ再計算など）。 */
  repaired: number;
}

export function emptySanitizeReport(): SanitizeReport {
  return { droppedSentences: 0, droppedTranslations: 0, droppedNotes: 0, droppedGlossary: 0, repaired: 0 };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, maxLength = 100_000): string | null {
  if (typeof value !== 'string') return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isoDate(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value : '';
  return Number.isFinite(Date.parse(text)) ? text : fallback;
}

const EPOCH = new Date(0).toISOString();

function sanitizeRect(value: unknown): Rect | null {
  if (!isRecord(value)) return null;
  const page = finiteNumber(value['page']);
  const x = finiteNumber(value['x']);
  const y = finiteNumber(value['y']);
  const w = finiteNumber(value['w']);
  const h = finiteNumber(value['h']);
  if (page === null || x === null || y === null || w === null || h === null) return null;
  if (page < 1 || page > 100_000) return null;
  return { page: Math.floor(page), x, y, w, h };
}

function sanitizeSection(value: unknown, order: number): Section | null {
  if (!isRecord(value)) return null;
  const id = str(value['id'], 200);
  const title = str(value['title'], 2000);
  if (!id || title === null) return null;
  const level = finiteNumber(value['level']);
  return { id, title, level: level === null ? 1 : Math.max(1, Math.min(9, Math.floor(level))), order };
}

function sanitizePageSize(value: unknown): PageSize | null {
  if (!isRecord(value)) return null;
  const page = finiteNumber(value['page']);
  const width = finiteNumber(value['width']);
  const height = finiteNumber(value['height']);
  if (page === null || width === null || height === null) return null;
  return { page: Math.floor(page), width, height };
}

/**
 * 文のハッシュは受け取った値を信用せず、原文から**必ず計算し直す**。
 * 注釈の結合キーなので、ここを外部入力に委ねると「別の文の訳が付く」を作り込める。
 */
function sanitizeSentences(value: unknown, report: SanitizeReport): Sentence[] {
  if (!Array.isArray(value)) return [];
  const sentences: Sentence[] = [];
  const occurrences = new Map<string, number>();
  for (const raw of value) {
    if (!isRecord(raw)) {
      report.droppedSentences++;
      continue;
    }
    const text = str(raw['text'], 20_000);
    if (text === null || text.trim().length === 0) {
      report.droppedSentences++;
      continue;
    }
    const rects = Array.isArray(raw['rects'])
      ? raw['rects'].map(sanitizeRect).filter((r): r is Rect => r !== null)
      : [];
    const hash = sentenceHash(text);
    if (raw['hash'] !== hash) report.repaired++;
    const occurrence = occurrences.get(hash) ?? 0;
    occurrences.set(hash, occurrence + 1);
    const page = finiteNumber(raw['page']);
    sentences.push({
      id: sentenceId(hash, occurrence),
      hash,
      order: sentences.length,
      page: rects[0]?.page ?? (page !== null && page >= 1 ? Math.floor(page) : 1),
      text,
      rects,
      sectionId: str(raw['sectionId'], 200),
    });
  }
  return sentences;
}

export function sanitizeStructure(value: unknown, report: SanitizeReport): DocumentStructure {
  const source = isRecord(value) ? value : {};
  const parser = source['parser'] === 'grobid' ? 'grobid' : 'fallback';
  const sentences = sanitizeSentences(source['sentences'], report);
  const sections = Array.isArray(source['sections'])
    ? source['sections'].map(sanitizeSection).filter((s): s is Section => s !== null)
    : [];
  const knownSections = new Set(sections.map((s) => s.id));
  for (const sentence of sentences) {
    if (sentence.sectionId !== null && !knownSections.has(sentence.sectionId)) sentence.sectionId = null;
  }

  const version = finiteNumber(source['version']);
  return {
    version: version === null ? STRUCTURE_VERSION : Math.floor(version),
    parser,
    parserNote: str(source['parserNote'], 2000) ?? '（取り込んだ文書。解析方式の記録なし）',
    parsedAt: isoDate(source['parsedAt'], EPOCH),
    title: str(source['title'], 2000),
    abstract: str(source['abstract'], 50_000),
    pageSizes: Array.isArray(source['pageSizes'])
      ? source['pageSizes'].map(sanitizePageSize).filter((p): p is PageSize => p !== null)
      : [],
    sections,
    sentences,
  };
}

export function sanitizeAnnotations(value: unknown, report: SanitizeReport): Annotations {
  const source = isRecord(value) ? value : {};

  const translations: Record<string, Translation> = {};
  if (isRecord(source['translations'])) {
    for (const [hash, raw] of Object.entries(source['translations'])) {
      if (!/^[0-9a-f]{4,64}$/.test(hash) || !isRecord(raw)) {
        report.droppedTranslations++;
        continue;
      }
      const text = str(raw['text'], 20_000);
      if (text === null) {
        report.droppedTranslations++;
        continue;
      }
      const origin = raw['source'];
      translations[hash] = {
        sentenceHash: hash,
        text,
        revisedByHuman: raw['revisedByHuman'] === true,
        source: origin === 'human' || origin === 'claude' ? origin : 'import',
        updatedAt: isoDate(raw['updatedAt'], EPOCH),
      };
    }
  }

  const notes: Note[] = [];
  if (Array.isArray(source['notes'])) {
    for (const raw of source['notes']) {
      if (!isRecord(raw)) {
        report.droppedNotes++;
        continue;
      }
      const body = str(raw['body'], 50_000);
      const sentenceHashValue = str(raw['sentenceHash'], 64);
      if (body === null || sentenceHashValue === null || !/^[0-9a-f]{4,64}$/.test(sentenceHashValue)) {
        report.droppedNotes++;
        continue;
      }
      const createdAt = isoDate(raw['createdAt'], EPOCH);
      const id = str(raw['id'], 64);
      notes.push({
        id: id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : newId('note'),
        sentenceHash: sentenceHashValue,
        body,
        author: str(raw['author'], 200),
        createdAt,
        updatedAt: isoDate(raw['updatedAt'], createdAt),
      });
    }
  }

  const glossary: GlossaryEntry[] = [];
  if (Array.isArray(source['glossary'])) {
    for (const raw of source['glossary']) {
      if (!isRecord(raw)) {
        report.droppedGlossary++;
        continue;
      }
      const term = str(raw['term'], 500);
      const translation = str(raw['translation'], 500);
      if (term === null || translation === null || term.trim().length === 0) {
        report.droppedGlossary++;
        continue;
      }
      glossary.push({ term, translation, note: str(raw['note'], 2000) });
    }
  }

  return { translations, notes, glossary };
}

/** 外から来た document を丸ごと安全な PaperDocument に落とす。id は呼び出し側が付け直す前提。 */
export function sanitizeDocument(
  value: unknown,
  overrides: { id: string; sourceFileName?: string },
): { document: PaperDocument; report: SanitizeReport } {
  const report = emptySanitizeReport();
  const source = isRecord(value) ? value : {};
  const structure = sanitizeStructure(source['structure'], report);
  const annotations = sanitizeAnnotations(source['annotations'], report);
  const now = new Date().toISOString();

  return {
    document: {
      id: overrides.id,
      title: str(source['title'], 2000) ?? structure.title ?? '(無題)',
      sourceFileName: overrides.sourceFileName ?? str(source['sourceFileName'], 500) ?? 'imported.pdf',
      createdAt: isoDate(source['createdAt'], now),
      updatedAt: now,
      structure,
      annotations,
    },
    report,
  };
}

export function describeSanitizeReport(report: SanitizeReport): string | null {
  const parts: string[] = [];
  if (report.droppedSentences > 0) parts.push(`文 ${report.droppedSentences} 件`);
  if (report.droppedTranslations > 0) parts.push(`訳 ${report.droppedTranslations} 件`);
  if (report.droppedNotes > 0) parts.push(`メモ ${report.droppedNotes} 件`);
  if (report.droppedGlossary > 0) parts.push(`用語 ${report.droppedGlossary} 件`);
  if (parts.length === 0) return null;
  return `形式が不正だったため ${parts.join(' / ')} を取り込みませんでした`;
}
