import type { PaperDocument } from './types.ts';
import { STRUCTURE_VERSION, sentenceHash, sentenceId } from './hash.ts';

/**
 * 正規化規則を変えたときの移行。
 *
 * 注釈は文のハッシュで結合されているので、規則を変えると全部はぐれる。
 * ただし構造には原文がそのまま残っているので、
 * 「旧ハッシュ → 原文 → 新ハッシュ」の対応表を作れば付け替えられる。
 *
 * v1 → v2: NFKC を NFC にし、ダッシュの種類を保ち、letter 間のハイフンを落とすようにした。
 * （v1 は上付き文字や ℃ を潰していて、別々の文が同じ訳を共有しうる状態だった）
 */

export interface MigrationResult {
  document: PaperDocument;
  migrated: boolean;
  from: number;
  to: number;
  /** 付け替えられた訳の数。 */
  remappedTranslations: number;
  /** 付け替えられたメモの数。 */
  remappedNotes: number;
  /** 新旧のハッシュが衝突して統合された訳の数。 */
  collisions: number;
}

export function migrateDocument(document: PaperDocument): MigrationResult {
  const from = document.structure.version;
  if (from >= STRUCTURE_VERSION) {
    return {
      document,
      migrated: false,
      from,
      to: STRUCTURE_VERSION,
      remappedTranslations: 0,
      remappedNotes: 0,
      collisions: 0,
    };
  }

  // 旧ハッシュ → 新ハッシュ。原文は構造にそのまま残っているので再計算できる。
  const remap = new Map<string, string>();
  const occurrences = new Map<string, number>();
  const sentences = document.structure.sentences.map((sentence) => {
    const hash = sentenceHash(sentence.text);
    remap.set(sentence.hash, hash);
    const occurrence = occurrences.get(hash) ?? 0;
    occurrences.set(hash, occurrence + 1);
    return { ...sentence, hash, id: sentenceId(hash, occurrence) };
  });

  let remappedTranslations = 0;
  let collisions = 0;
  const translations: PaperDocument['annotations']['translations'] = {};
  for (const [oldHash, translation] of Object.entries(document.annotations.translations)) {
    const newHash = remap.get(oldHash) ?? oldHash;
    if (newHash !== oldHash) remappedTranslations++;
    const existing = translations[newHash];
    if (existing) {
      collisions++;
      // 衝突したら人手修正済みを優先し、同条件なら新しい方を残す。
      const keepExisting =
        existing.revisedByHuman !== translation.revisedByHuman
          ? existing.revisedByHuman
          : Date.parse(existing.updatedAt) >= Date.parse(translation.updatedAt);
      if (keepExisting) continue;
    }
    translations[newHash] = { ...translation, sentenceHash: newHash };
  }

  let remappedNotes = 0;
  const notes = document.annotations.notes.map((note) => {
    const newHash = remap.get(note.sentenceHash) ?? note.sentenceHash;
    if (newHash !== note.sentenceHash) remappedNotes++;
    return { ...note, sentenceHash: newHash };
  });

  return {
    document: {
      ...document,
      structure: { ...document.structure, version: STRUCTURE_VERSION, sentences },
      annotations: { ...document.annotations, translations, notes },
    },
    migrated: true,
    from,
    to: STRUCTURE_VERSION,
    remappedTranslations,
    remappedNotes,
    collisions,
  };
}
