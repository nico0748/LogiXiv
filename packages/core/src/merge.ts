import type {
  Annotations,
  MergeReport,
  Note,
  PaperDocument,
  DocumentStructure,
  SentenceEdit,
  Translation,
} from './types.ts';
import { newId, normalizeSentence } from './hash.ts';
import { applySentenceEdits } from './edits.ts';

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

  // skipped を落とさない。ここで取りこぼすと、取り込みのたびに「訳さない」判断が
  // 静かに消え、未訳が増えて見える。
  const skipped = { ...(base.skipped ?? {}), ...(incoming.skipped ?? {}) };

  // 区切りの直しはここでは混ぜない。こちらの構造には既に自分の手順が反映済みなので、
  // 記録だけ足すと記録と構造がずれる。相手の手順は adoptSentenceEdits が
  // 構造に当てながら取り込む（当たったものだけ記録に残る）。
  const sentenceEdits: SentenceEdit[] = [...(base.sentenceEdits ?? [])];

  return { annotations: { translations, notes, glossary, skipped, sentenceEdits }, report };
}

/** 同じ編集を二度取り込まないための鍵。原文と切り位置が同じなら同じ操作。 */
function editKey(edit: SentenceEdit): string {
  return [edit.type, (edit.sourceTexts ?? edit.hashes).join('\u0000'), (edit.offsets ?? []).join(',')].join('|');
}

/**
 * 他人の書き出しに入っていた「文の区切りの直し」を取り込む。
 *
 * これをやらないと、相手が 2 文を 1 文にまとめてから訳した場合、その訳は
 * こちらのどの文にも当たらず「対応なし」として捨てられる。区切りを先に揃えれば
 * そのまま乗る。当てられなかった手順は黙って飛ばす（相手と本文が違うだけなので）。
 */
export function adoptSentenceEdits(
  document: PaperDocument,
  incoming: readonly SentenceEdit[],
): { document: PaperDocument; adopted: number; skipped: number } {
  const known = new Set((document.annotations.sentenceEdits ?? []).map(editKey));
  const candidates = incoming.filter((edit) => !known.has(editKey(edit)));
  if (candidates.length === 0) return { document, adopted: 0, skipped: 0 };

  const replay = applySentenceEdits(document.structure, candidates);
  if (replay.applied.length === 0) return { document, adopted: 0, skipped: replay.stale.length };

  return {
    document: {
      ...document,
      structure: replay.structure,
      annotations: {
        ...document.annotations,
        sentenceEdits: [...(document.annotations.sentenceEdits ?? []), ...replay.applied],
      },
    },
    adopted: replay.applied.length,
    skipped: replay.stale.length,
  };
}

/**
 * 再解析。構造だけ差し替え、注釈は文のハッシュで自動的に再結合される。
 * 対応する文が消えた注釈も捨てない（GROBID のバージョン差で一時的に消えることがあるため）。
 *
 * 人が直した文の区切りは、新しい構造の上で順に流し直す。これをやらないと、
 * 再解析のたびに同じ結合・分割を手でやり直すことになり、再解析が事実上使えなくなる。
 * 本文が変わって当てられなくなった手順は記録から外す（残すと毎回失敗し続ける）。
 */
export function applyStructure(
  document: PaperDocument,
  structure: DocumentStructure,
): { document: PaperDocument; rebound: number; orphaned: number; editsReapplied: number; editsDropped: number } {
  const edits = document.annotations.sentenceEdits ?? [];
  const replay = applySentenceEdits(structure, edits);

  const hashes = new Set(replay.structure.sentences.map((s) => s.hash));
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
      structure: replay.structure,
      updatedAt: new Date().toISOString(),
      // 当てられた編集も含めて必ず書き戻す。取り消し情報は今の本文に合わせて
      // 作り直されているので、古いものを残すと「戻す」が別の場所を切る。
      annotations: { ...document.annotations, sentenceEdits: replay.applied },
    },
    rebound,
    orphaned,
    editsReapplied: replay.applied.length,
    editsDropped: replay.stale.length,
  };
}
