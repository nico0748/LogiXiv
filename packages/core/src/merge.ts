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
    glossaryAddedTerms: [],
    skippedAdded: 0,
    skippedIgnored: 0,
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
    // 語そのものを返す。件数だけでは「別の論文の訳語方針が混ざった」を
    // 見つけられないし、混ざった後に 1 件ずつ取り消すこともできない。
    report.glossaryAddedTerms.push(entry.term);
  }

  /**
   * 「訳さない」は落とさないが、**無条件には受け取らない**。
   *
   * 以前は `{...base, ...incoming}` で丸ごと重ねていた。これだと、同僚が参考文献や
   * 図表キャプションをまとめて対象外にしてから訳した書き出しを取り込むだけで、
   * こちらがまだ訳していない文まで「訳さない」に移る。progress() は skipped を
   * remaining から外すので残件が減り、MCP はその文を二度と返さない。
   * 終了条件は remainingUnique === 0 なので、Claude は訳していない文を抱えたまま
   * 「翻訳は完了しています」と報告することになる。
   *
   * そこで訳・メモと同じ条件に揃える:
   *  - こちらの文書に無い文は受け取らない（orphaned として数える）
   *  - こちらが既に訳している文は対象外にしない（skipSentences と同じ規則）
   *  - 何件が新しく「訳さない」に移ったかを必ず報告する（＝減った残件の数）
   */
  const skipped = { ...(base.skipped ?? {}) };
  for (const [hash, entry] of Object.entries(incoming.skipped ?? {})) {
    if (!knownHashes.has(hash)) {
      report.orphaned++;
      if (policy === 'drop') {
        report.skippedIgnored++;
        continue;
      }
    }
    // 既にこちらも同じ判断をしているなら、理由と日付は自分のものを残す。
    if (skipped[hash]) continue;
    if (translations[hash]) {
      report.skippedIgnored++;
      continue;
    }
    skipped[hash] = entry;
    report.skippedAdded++;
  }

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
): {
  document: PaperDocument;
  adopted: number;
  skipped: number;
  /** こちら側の注釈のうち、区切りが変わってどの文にも結び付かなくなった数。 */
  detached: { translations: number; notes: number };
} {
  const none = { translations: 0, notes: 0 };
  const known = new Set((document.annotations.sentenceEdits ?? []).map(editKey));
  const candidates = incoming.filter((edit) => !known.has(editKey(edit)));
  if (candidates.length === 0) return { document, adopted: 0, skipped: 0, detached: none };

  const replay = applySentenceEdits(document.structure, candidates);
  if (replay.applied.length === 0) {
    return { document, adopted: 0, skipped: replay.stale.length, detached: none };
  }

  // 相手の区切りに合わせると、こちらが既に付けていた訳やメモが外れることがある。
  // 取り込み結果の orphaned は「相手の注釈」の話なので、これはそこに出てこない。
  const survivors = new Set(replay.structure.sentences.map((sentence) => sentence.hash));
  const lost = new Set(
    document.structure.sentences.map((s) => s.hash).filter((hash) => !survivors.has(hash)),
  );
  const detached = {
    translations: [...lost].filter((hash) => document.annotations.translations[hash]).length,
    notes: document.annotations.notes.filter((note) => lost.has(note.sentenceHash)).length,
  };

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
    detached,
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
      //
      // 当たらなかった手順も detached の印を付けて残す。捨てていた頃は、
      // 解析方式を変えた時点で手順が消え、「元の方式に戻せば戻ります」という
      // 案内が嘘になっていた（戻しても手順が無いので再現されない）。
      annotations: { ...document.annotations, sentenceEdits: [...replay.applied, ...replay.stale] },
    },
    rebound,
    orphaned,
    editsReapplied: replay.applied.length,
    editsDropped: replay.stale.length,
  };
}
