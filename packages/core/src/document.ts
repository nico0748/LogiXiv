import type { Annotations, DocumentStructure, Note, PaperDocument, Sentence, Translation } from './types.ts';
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

export function addNote(
  document: PaperDocument,
  sentenceHash: string,
  body: string,
  author: string | null = null,
): { document: PaperDocument; note: Note } {
  const now = new Date().toISOString();
  const note: Note = { id: newId('note'), sentenceHash, body, author, createdAt: now, updatedAt: now };
  return {
    document: {
      ...document,
      updatedAt: now,
      annotations: { ...document.annotations, notes: [...document.annotations.notes, note] },
    },
    note,
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

/** 翻訳がまだ無い文を、原文の並び順で返す。 */
export function untranslatedSentences(document: PaperDocument, limit = 20): Sentence[] {
  return document.structure.sentences
    .filter((s) => !document.annotations.translations[s.hash])
    .slice(0, limit);
}

export function progress(document: PaperDocument): { total: number; translated: number; revisedByHuman: number } {
  const hashes = new Set(document.structure.sentences.map((s) => s.hash));
  let translated = 0;
  let revisedByHuman = 0;
  for (const hash of hashes) {
    const translation = document.annotations.translations[hash];
    if (!translation) continue;
    translated++;
    if (translation.revisedByHuman) revisedByHuman++;
  }
  return { total: hashes.size, translated, revisedByHuman };
}

/** 文書内の全文検索。原文・訳文・メモを横断する。 */
export function searchDocument(
  document: PaperDocument,
  query: string,
  limit = 30,
): { sentence: Sentence; where: ('source' | 'translation' | 'note')[] }[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const notesByHash = new Map<string, string[]>();
  for (const note of document.annotations.notes) {
    const list = notesByHash.get(note.sentenceHash);
    if (list) list.push(note.body);
    else notesByHash.set(note.sentenceHash, [note.body]);
  }

  const hits: { sentence: Sentence; where: ('source' | 'translation' | 'note')[] }[] = [];
  for (const sentence of document.structure.sentences) {
    const where: ('source' | 'translation' | 'note')[] = [];
    if (sentence.text.toLowerCase().includes(needle)) where.push('source');
    const translation = document.annotations.translations[sentence.hash];
    if (translation && translation.text.toLowerCase().includes(needle)) where.push('translation');
    const notes = notesByHash.get(sentence.hash) ?? [];
    if (notes.some((body) => body.toLowerCase().includes(needle))) where.push('note');
    if (where.length > 0) hits.push({ sentence, where });
    if (hits.length >= limit) break;
  }
  return hits;
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
