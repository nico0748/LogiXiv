import type { Annotations, MergeReport, Note, PaperDocument, DocumentStructure, Translation } from './types.ts';
import { newId, normalizeSentence } from './hash.ts';

/**
 * マージ規則は訳とメモで意図的に非対称にしてある。
 *
 * 訳は「正解が 1 つに収束するもの」なので、勝ち負けを決めて上書きする。
 * ただし人手修正済み（revisedByHuman）の訳は機械由来の訳に絶対に負けない。
 * メモは「多いほど良いもの」なので、衝突しても消さずに両方残す。
 */

function emptyReport(): MergeReport {
  return {
    translationsAdded: 0,
    translationsUpdated: 0,
    translationsKept: 0,
    notesAdded: 0,
    notesSkippedAsDuplicate: 0,
    glossaryAdded: 0,
    orphaned: 0,
  };
}

/**
 * 取り込む側の訳が既存の訳に勝つか。
 *
 * 日付が壊れている側は「情報が無い」として扱う。以前は Date.parse の NaN が
 * どちらの比較でも false になるため、既存の updatedAt が不正な訳だけが
 * 「何をしても更新されない」状態に固着していた（しかも症状が無反応なので気づけない）。
 */
export function incomingWins(existing: Translation, incoming: Translation): boolean {
  if (existing.revisedByHuman !== incoming.revisedByHuman) {
    return incoming.revisedByHuman;
  }
  const existingAt = Date.parse(existing.updatedAt);
  const incomingAt = Date.parse(incoming.updatedAt);
  if (!Number.isFinite(existingAt)) return true;
  if (!Number.isFinite(incomingAt)) return false;
  return incomingAt > existingAt;
}

function noteKey(note: Note): string {
  return `${note.sentenceHash} ${normalizeSentence(note.body)}`;
}

export interface MergeOptions {
  /**
   * 取り込み先の文書に存在しない文の注釈をどう扱うか。
   * 'drop' は捨てる（他人の書き出しを取り込むときの既定）。
   * 'keep' は残す（同じ文書を再解析したときに使う）。
   */
  orphanPolicy?: 'drop' | 'keep';
}

export function mergeAnnotations(
  base: Annotations,
  incoming: Annotations,
  knownHashes: ReadonlySet<string>,
  options: MergeOptions = {},
): { annotations: Annotations; report: MergeReport } {
  const policy = options.orphanPolicy ?? 'drop';
  const report = emptyReport();

  const translations: Record<string, Translation> = { ...base.translations };
  for (const [hash, incomingTranslation] of Object.entries(incoming.translations)) {
    if (!knownHashes.has(hash)) {
      report.orphaned++;
      if (policy === 'drop') continue;
    }
    const existing = translations[hash];
    if (!existing) {
      translations[hash] = incomingTranslation;
      report.translationsAdded++;
    } else if (incomingWins(existing, incomingTranslation)) {
      translations[hash] = incomingTranslation;
      report.translationsUpdated++;
    } else {
      report.translationsKept++;
    }
  }

  const notes: Note[] = [...base.notes];
  const seenKeys = new Set(notes.map(noteKey));
  const seenIds = new Set(notes.map((n) => n.id));
  for (const note of incoming.notes) {
    if (!knownHashes.has(note.sentenceHash)) {
      report.orphaned++;
      if (policy === 'drop') continue;
    }
    if (seenKeys.has(noteKey(note))) {
      report.notesSkippedAsDuplicate++;
      continue;
    }
    // 本文が違うのに ID が衝突しているものは、消さずに新しい ID を振って残す。
    const stored: Note = seenIds.has(note.id) ? { ...note, id: newId('note') } : note;
    notes.push(stored);
    seenKeys.add(noteKey(stored));
    seenIds.add(stored.id);
    report.notesAdded++;
  }

  const glossary = [...base.glossary];
  const seenTerms = new Set(glossary.map((entry) => entry.term.toLowerCase()));
  for (const entry of incoming.glossary) {
    if (seenTerms.has(entry.term.toLowerCase())) continue;
    glossary.push(entry);
    seenTerms.add(entry.term.toLowerCase());
    report.glossaryAdded++;
  }

  return { annotations: { translations, notes, glossary }, report };
}

/**
 * 再解析。構造だけ差し替え、注釈は文のハッシュで自動的に再結合される。
 * 対応する文が消えた注釈も捨てない（GROBID のバージョン差で一時的に消えることがあるため）。
 */
export function applyStructure(
  document: PaperDocument,
  structure: DocumentStructure,
): { document: PaperDocument; rebound: number; orphaned: number } {
  const hashes = new Set(structure.sentences.map((s) => s.hash));
  let rebound = 0;
  let orphaned = 0;
  for (const hash of Object.keys(document.annotations.translations)) {
    if (hashes.has(hash)) rebound++;
    else orphaned++;
  }
  return {
    document: {
      ...document,
      title: structure.title ?? document.title,
      structure,
      updatedAt: new Date().toISOString(),
    },
    rebound,
    orphaned,
  };
}
