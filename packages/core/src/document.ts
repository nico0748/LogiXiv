import type {
  Annotations,
  DocumentStructure,
  Note,
  PaperDocument,
  Sentence,
  SkippedSentence,
  Translation,
} from './types.ts';
import { emptyAnnotations } from './types.ts';
import { newId } from './hash.ts';

export interface CreateDocumentInput {
  structure: DocumentStructure;
  sourceFileName: string;
  title?: string;
  id?: string;
  annotations?: Annotations;
}

export function createDocument(input: CreateDocumentInput): PaperDocument {
  const now = new Date().toISOString();
  return {
    id: input.id ?? newId('doc'),
    title: input.title ?? input.structure.title ?? input.sourceFileName.replace(/\.pdf$/i, ''),
    sourceFileName: input.sourceFileName,
    createdAt: now,
    updatedAt: now,
    structure: input.structure,
    annotations: input.annotations ?? emptyAnnotations(),
  };
}

export function setTranslation(
  document: PaperDocument,
  sentenceHash: string,
  text: string,
  options: { source?: Translation['source']; revisedByHuman?: boolean } = {},
): { document: PaperDocument; applied: boolean; reason?: string } {
  const known = document.structure.sentences.some((s) => s.hash === sentenceHash);
  if (!known) {
    return { document, applied: false, reason: 'この文書に該当する文がありません' };
  }
  const existing = document.annotations.translations[sentenceHash];
  const source = options.source ?? 'claude';
  const revisedByHuman = options.revisedByHuman ?? source === 'human';

  // 人手修正済みの訳は機械が上書きしない。
  if (existing?.revisedByHuman && !revisedByHuman) {
    return { document, applied: false, reason: '人手修正済みのため上書きしません' };
  }

  const translations: Record<string, Translation> = {
    ...document.annotations.translations,
    [sentenceHash]: { sentenceHash, text, source, revisedByHuman, updatedAt: new Date().toISOString() },
  };
  return {
    document: {
      ...document,
      updatedAt: new Date().toISOString(),
      annotations: { ...document.annotations, translations },
    },
    applied: true,
  };
}

/**
 * メモを付ける。
 *
 * 存在しない hash を黙って受け付けてはいけない。メモは hash でしか文に結び付かないので、
 * 1 文字違うだけで「保存はされたがどの画面にも二度と出ないメモ」になる。
 * Claude には「訳せない箇所の判断をメモに残せ」と指示しているぶん、
 * いちばん大事な情報が静かに消える経路になる。
 */
export function addNote(
  document: PaperDocument,
  sentenceHash: string,
  body: string,
  author: string | null = null,
): { document: PaperDocument; note: Note | null; applied: boolean; reason?: string } {
  if (!document.structure.sentences.some((s) => s.hash === sentenceHash)) {
    return { document, note: null, applied: false, reason: 'この文書に該当する文がありません' };
  }
  if (body.trim().length === 0) {
    return { document, note: null, applied: false, reason: 'メモが空です' };
  }
  const now = new Date().toISOString();
  const note: Note = { id: newId('note'), sentenceHash, body, author, createdAt: now, updatedAt: now };
  return {
    document: {
      ...document,
      updatedAt: now,
      annotations: { ...document.annotations, notes: [...document.annotations.notes, note] },
    },
    note,
    applied: true,
  };
}

export function updateNote(
  document: PaperDocument,
  noteId: string,
  body: string,
): { document: PaperDocument; applied: boolean } {
  let applied = false;
  const notes = document.annotations.notes.map((note) => {
    if (note.id !== noteId) return note;
    applied = true;
    return { ...note, body, updatedAt: new Date().toISOString() };
  });
  if (!applied) return { document, applied };
  return {
    document: { ...document, updatedAt: new Date().toISOString(), annotations: { ...document.annotations, notes } },
    applied,
  };
}

export function deleteNote(document: PaperDocument, noteId: string): { document: PaperDocument; applied: boolean } {
  const notes = document.annotations.notes.filter((note) => note.id !== noteId);
  if (notes.length === document.annotations.notes.length) return { document, applied: false };
  return {
    document: { ...document, updatedAt: new Date().toISOString(), annotations: { ...document.annotations, notes } },
    applied: true,
  };
}

/** 訳さないと判断した文の一覧（古い保存データには無い）。 */
export function skippedOf(document: PaperDocument): Record<string, SkippedSentence> {
  return document.annotations.skipped ?? {};
}

/** 訳す必要がまだ残っている文か。 */
export function needsTranslation(document: PaperDocument, sentence: Sentence): boolean {
  return !document.annotations.translations[sentence.hash] && !skippedOf(document)[sentence.hash];
}

/** 翻訳がまだ無く、訳さないとも決めていない文を、原文の並び順で返す。 */
export function untranslatedSentences(document: PaperDocument, limit = 20): Sentence[] {
  return document.structure.sentences.filter((s) => needsTranslation(document, s)).slice(0, limit);
}

/**
 * 「これは訳す対象ではない」と記録する。
 *
 * フォールバック解析では参考文献の断片・ページ番号・数式が本文に混ざる。
 * 飛ばすだけだと次の取得でまた返ってくるので、翻訳の手順が終わらない。
 */
export function skipSentences(
  document: PaperDocument,
  sentenceHashes: readonly string[],
  reason = 'other',
): { document: PaperDocument; applied: number; unknown: string[] } {
  const known = new Set(document.structure.sentences.map((s) => s.hash));
  const skipped = { ...skippedOf(document) };
  const unknown: string[] = [];
  const at = new Date().toISOString();
  let applied = 0;
  for (const hash of sentenceHashes) {
    if (!known.has(hash)) {
      unknown.push(hash);
      continue;
    }
    if (skipped[hash]) continue;
    skipped[hash] = { sentenceHash: hash, reason, at };
    applied++;
  }
  if (applied === 0) return { document, applied, unknown };
  return {
    document: {
      ...document,
      updatedAt: at,
      annotations: { ...document.annotations, skipped },
    },
    applied,
    unknown,
  };
}

/** 「訳さない」の取り消し。 */
export function unskipSentences(
  document: PaperDocument,
  sentenceHashes: readonly string[],
): { document: PaperDocument; applied: number } {
  const skipped = { ...skippedOf(document) };
  let applied = 0;
  for (const hash of sentenceHashes) {
    if (skipped[hash]) {
      delete skipped[hash];
      applied++;
    }
  }
  if (applied === 0) return { document, applied };
  return {
    document: {
      ...document,
      updatedAt: new Date().toISOString(),
      annotations: { ...document.annotations, skipped },
    },
    applied,
  };
}

export interface Progress {
  /** 文の総数（同じ文が複数回出ればその数だけ数える）。 */
  sentences: number;
  /** 異なり文の数。訳はこの単位で付く。 */
  uniqueSentences: number;
  translated: number;
  revisedByHuman: number;
  skipped: number;
  /** まだ訳す必要がある異なり文の数。 */
  remaining: number;
}

export function progress(document: PaperDocument): Progress {
  const hashes = new Set(document.structure.sentences.map((s) => s.hash));
  const skipped = skippedOf(document);
  let translated = 0;
  let revisedByHuman = 0;
  let skippedCount = 0;
  for (const hash of hashes) {
    if (skipped[hash]) skippedCount++;
    const translation = document.annotations.translations[hash];
    if (!translation) continue;
    translated++;
    if (translation.revisedByHuman) revisedByHuman++;
  }
  const remaining = [...hashes].filter((h) => !document.annotations.translations[h] && !skipped[h]).length;
  return {
    sentences: document.structure.sentences.length,
    uniqueSentences: hashes.size,
    translated,
    revisedByHuman,
    skipped: skippedCount,
    remaining,
  };
}

/**
 * 文書内の全文検索。原文・訳文・メモを横断する。
 * ヒットには訳文とメモも入れる（訳語の揺れを探すのが主な用途なのに、
 * 原文しか返らないと「どの訳語が使われているか」を確認するためにもう一往復要る）。
 */
export interface SearchHit {
  sentence: Sentence;
  where: ('source' | 'translation' | 'note')[];
  translation: string | null;
  notes: string[];
}

export function searchDocument(document: PaperDocument, query: string, limit = 30): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const notesByHash = new Map<string, string[]>();
  for (const note of document.annotations.notes) {
    const list = notesByHash.get(note.sentenceHash);
    if (list) list.push(note.body);
    else notesByHash.set(note.sentenceHash, [note.body]);
  }

  const hits: SearchHit[] = [];
  for (const sentence of document.structure.sentences) {
    const where: ('source' | 'translation' | 'note')[] = [];
    if (sentence.text.toLowerCase().includes(needle)) where.push('source');
    const translation = document.annotations.translations[sentence.hash] ?? null;
    if (translation && translation.text.toLowerCase().includes(needle)) where.push('translation');
    const notes = notesByHash.get(sentence.hash) ?? [];
    const matchedNotes = notes.filter((body) => body.toLowerCase().includes(needle));
    if (matchedNotes.length > 0) where.push('note');
    if (where.length > 0) {
      hits.push({ sentence, where, translation: translation?.text ?? null, notes: matchedNotes });
    }
    if (hits.length >= limit) break;
  }
  return hits;
}

/** hash から文を引く。検索結果や MCP からの指定を辿るときに使う。 */
export function sentencesByHash(document: PaperDocument, hashes: readonly string[]): Sentence[] {
  const wanted = new Set(hashes);
  return document.structure.sentences.filter((s) => wanted.has(s.hash));
}

export function structureSummary(structure: DocumentStructure): string {
  const withCoords = structure.sentences.filter((s) => s.rects.length > 0).length;
  return [
    `parser=${structure.parser}`,
    `sentences=${structure.sentences.length}`,
    `withCoords=${withCoords}`,
    `sections=${structure.sections.length}`,
    `pages=${structure.pageSizes.length}`,
  ].join(' ');
}
