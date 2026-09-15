import type { PaperDocument, SentenceEdit } from './types.ts';
import { STRUCTURE_VERSION, sentenceHash, sentenceId } from './hash.ts';
import { deriveEdit } from './edits.ts';

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

export class FutureStructureError extends Error {}

export function migrateDocument(document: PaperDocument): MigrationResult {
  const from = document.structure.version;
  // 新しい版で書かれたものを、古い規則のまま読んで書き戻してはいけない。
  // ハッシュの計算規則が違うので、片方の規則で付けた訳が混ざったファイルができ、
  // しかも版の印は新しいままなので、将来の移行が二度と走らない。
  if (from > STRUCTURE_VERSION) {
    throw new FutureStructureError(
      `この文書は新しい版の LogiXiv で作られています（構造 v${from} / このプログラムは v${STRUCTURE_VERSION} まで）。` +
        'LogiXiv を更新してください。',
    );
  }
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

  // skipped も hash がキーなので付け替える。ここを忘れると「訳さない」と決めた文が
  // 移行のたびに未訳へ戻り、しかも古いキーがゴミとして残り続ける。
  const skipped: NonNullable<PaperDocument['annotations']['skipped']> = {};
  for (const [oldHash, entry] of Object.entries(document.annotations.skipped ?? {})) {
    const newHash = remap.get(oldHash) ?? oldHash;
    skipped[newHash] = { ...entry, sentenceHash: newHash };
  }

  // 区切りの直しは hash で対象を指しているが、その対象（編集前の文）は
  // 構造側にもう残っていないので、対応表では付け替えられない。
  // 記録が原文テキストを持っているぶんだけ、新しい規則で計算し直す。
  // 持っていない古い記録は、hash の付け替えで当たる範囲だけ拾っておく。
  const mapHashes = (hashes: readonly string[]): string[] => hashes.map((hash) => remap.get(hash) ?? hash);
  const sentenceEdits: SentenceEdit[] = (document.annotations.sentenceEdits ?? []).map((edit) => {
    if (!edit.sourceTexts || edit.sourceTexts.length === 0) {
      return {
        ...edit,
        hashes: mapHashes(edit.hashes),
        ...(edit.undo ? { undo: { ...edit.undo, hashes: mapHashes(edit.undo.hashes) } } : {}),
      };
    }
    const joiners = edit.type === 'merge' ? (edit.joiners ?? edit.undo?.joiners) : undefined;
    const derived = deriveEdit(edit.type, edit.sourceTexts, edit.offsets ?? [], joiners);
    return {
      ...edit,
      hashes: derived.hashes,
      ...(edit.type === 'split' ? { offsets: derived.offsets } : { joiners: derived.undo.joiners }),
      // 位置は元の記録のまま。件数が無い古い記録は 1 か所に留める（戻しすぎより軽い）。
      undo: { ...derived.undo, occurrences: edit.undo?.occurrences ?? 1, at: edit.undo?.at },
    };
  });

  return {
    document: {
      ...document,
      structure: { ...document.structure, version: STRUCTURE_VERSION, sentences },
      annotations: { ...document.annotations, translations, notes, skipped, sentenceEdits },
    },
    migrated: true,
    from,
    to: STRUCTURE_VERSION,
    remappedTranslations,
    remappedNotes,
    collisions,
  };
}
