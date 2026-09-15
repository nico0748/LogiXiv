import type {
  Annotations,
  DocumentStructure,
  GlossaryEntry,
  Note,
  PaperDocument,
  Sentence,
  SentenceEdit,
  SkippedSentence,
  Translation,
} from './types.ts';
import { emptyAnnotations } from './types.ts';
import { newId } from './hash.ts';
import { applySentenceEdit, revertSentenceEdit, SentenceEditError } from './edits.ts';

export interface CreateDocumentInput {
  structure: DocumentStructure;
  sourceFileName: string;
  title?: string;
  id?: string;
  annotations?: Annotations;
}

/**
 * 題名として画面と書き出しに出せる形に整える。
 *
 * 題名は 3 経路から来る: PDF のメタデータ、GROBID の TEI、本文の 1 文目、
 * そして人が打ち直したもの。前の 3 つは外から来る文字列で、改行や制御文字、
 * 双方向テキストの上書き記号（U+202E など）がそのまま入り得る。
 * これが一覧・ツールバー・書き出した HTML の <h1> に流れると、
 * 1 行のはずの場所が崩れ、並びが逆に見え、見えない文字が混ざる。
 * 表示に使う値なので、入り口ではなく題名を作るところで落とす。
 */
export function sanitizeTitle(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    // 双方向の上書き・分離（文字が逆順に見える）と、幅ゼロの文字。
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 表示に使う題名。
 *
 * ファイル名を題名にしていたので、一覧にも書き出しにも `paper` や `2401.01234v2`
 * が並んでいた。GROBID が題名を返さない簡易解析の経路でも、本文の 1 文目は
 * たいてい表題そのものなので、そちらの方がまだ当たる。
 */
export function documentTitle(structure: DocumentStructure, sourceFileName: string): string {
  const fromStructure = sanitizeTitle(structure.title ?? '');
  if (fromStructure.length > 0) return fromStructure;

  const first = sanitizeTitle(structure.sentences[0]?.text ?? '');
  // 長すぎるもの・文末が句点のもの（＝本文の 1 文）は題名として使わない。
  if (first.length >= 8 && first.length <= 160 && !/[.!?。]$/.test(first)) return first;

  return sanitizeTitle(sourceFileName.replace(/\.pdf$/i, ''));
}

export function createDocument(input: CreateDocumentInput): PaperDocument {
  const now = new Date().toISOString();
  return {
    id: input.id ?? newId('doc'),
    title: input.title ?? documentTitle(input.structure, input.sourceFileName),
    sourceFileName: input.sourceFileName,
    createdAt: now,
    updatedAt: now,
    structure: input.structure,
    annotations: input.annotations ?? emptyAnnotations(),
  };
}

/**
 * 訳を消す。
 *
 * これが無かったので、いちど訳が付いた文は二度と未訳に戻せなかった。
 * 影響は「気に入らない訳を消せない」だけでは済まない。`skip_sentences` は
 * 既訳の文を対象外にできない（未訳の集計が減らないため）ので、
 * Claude が参考文献の断片や数式に先に訳を付けてしまうと、
 * その文を「訳す対象ではない」に移す道が塞がる。簡易解析ではそれが普通に起きる。
 *
 * 訳と同じく hash 単位なので、同じ本文が何か所に出ていても 1 回で消える。
 */
export function deleteTranslation(
  document: PaperDocument,
  sentenceHash: string,
): { document: PaperDocument; deleted: boolean } {
  if (!document.annotations.translations[sentenceHash]) return { document, deleted: false };
  const translations = { ...document.annotations.translations };
  delete translations[sentenceHash];
  return {
    document: {
      ...document,
      updatedAt: new Date().toISOString(),
      annotations: { ...document.annotations, translations },
    },
    deleted: true,
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
): { document: PaperDocument; applied: number; unknown: string[]; alreadyTranslated: string[] } {
  const known = new Set(document.structure.sentences.map((s) => s.hash));
  const skipped = { ...skippedOf(document) };
  const unknown: string[] = [];
  const alreadyTranslated: string[] = [];
  const at = new Date().toISOString();
  let applied = 0;
  for (const hash of sentenceHashes) {
    if (!known.has(hash)) {
      unknown.push(hash);
      continue;
    }
    // 既に訳が付いている文は記録しない。記録しても未訳の集計は 1 件も減らないので、
    // 「n 件を対象外にした」という返事だけが嘘になる。
    if (document.annotations.translations[hash]) {
      alreadyTranslated.push(hash);
      continue;
    }
    if (skipped[hash]) continue;
    skipped[hash] = { sentenceHash: hash, reason, at };
    applied++;
  }
  if (applied === 0) return { document, applied, unknown, alreadyTranslated };
  return {
    document: {
      ...document,
      updatedAt: at,
      annotations: { ...document.annotations, skipped },
    },
    applied,
    unknown,
    alreadyTranslated,
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

/** 記録済みの文分割・結合（古い保存データには無い）。 */
export function sentenceEditsOf(document: PaperDocument): SentenceEdit[] {
  return document.annotations.sentenceEdits ?? [];
}

export interface SentenceEditResult {
  document: PaperDocument;
  applied: boolean;
  /** 何か所に適用されたか。同じ本文が複数回出る文書では 1 より大きくなる。 */
  occurrences: number;
  /**
   * 区切りが変わったことで、どの文にも結び付かなくなった注釈の数。
   * 消してはいない（取り消せば戻る）が、画面から消えるので必ず伝える。
   */
  detached: { translations: number; notes: number; skipped: number };
  edit?: SentenceEdit;
  reason?: string;
}

/** 構造から消えた hash に付いていた注釈を数える。 */
function countDetached(
  document: PaperDocument,
  before: DocumentStructure,
  after: DocumentStructure,
): { translations: number; notes: number; skipped: number } {
  const survivors = new Set(after.sentences.map((sentence) => sentence.hash));
  const lost = new Set(before.sentences.map((s) => s.hash).filter((hash) => !survivors.has(hash)));
  const skipped = skippedOf(document);
  let translations = 0;
  let skippedCount = 0;
  for (const hash of lost) {
    if (document.annotations.translations[hash]) translations++;
    if (skipped[hash]) skippedCount++;
  }
  const notes = document.annotations.notes.filter((note) => lost.has(note.sentenceHash)).length;
  return { translations, notes, skipped: skippedCount };
}

/**
 * 文の区切りを直す。
 *
 * 直した結果は構造に焼き込みつつ、手順そのものも注釈に残す。
 * 構造だけ直すと再解析で元に戻ってしまい、手順だけ持つと読み出しのたびに
 * 再計算が要る。両方持てば、再解析のときだけ手順を流し直せばよい。
 */
export function editSentenceBoundary(
  document: PaperDocument,
  input: { type: 'merge' | 'split'; hashes: string[]; offsets?: number[] },
): SentenceEditResult {
  const now = new Date().toISOString();
  const edit: SentenceEdit = {
    id: newId('edit'),
    type: input.type,
    hashes: input.hashes,
    ...(input.type === 'split' ? { offsets: input.offsets ?? [] } : {}),
    createdAt: now,
  };
  let outcome;
  try {
    outcome = applySentenceEdit(document.structure, edit);
  } catch (error) {
    if (error instanceof SentenceEditError) {
      return {
        document,
        applied: false,
        occurrences: 0,
        detached: { translations: 0, notes: 0, skipped: 0 },
        reason: error.message,
      };
    }
    throw error;
  }
  const stored: SentenceEdit = {
    ...edit,
    sourceTexts: outcome.sourceTexts,
    ...(input.type === 'split' ? { offsets: outcome.offsets } : {}),
    undo: outcome.undo,
  };
  return {
    document: {
      ...document,
      updatedAt: now,
      structure: outcome.structure,
      annotations: { ...document.annotations, sentenceEdits: [...sentenceEditsOf(document), stored] },
    },
    applied: true,
    occurrences: outcome.occurrences,
    detached: countDetached(document, document.structure, outcome.structure),
    edit: stored,
  };
}

/**
 * 直前の（または指定した）区切り直しを取り消す。
 * 取り消しは逆向きの編集として適用し、記録からはその 1 件だけを消す。
 */
export function undoSentenceEdit(
  document: PaperDocument,
  editId?: string,
): { document: PaperDocument; applied: boolean; reason?: string } {
  const edits = sentenceEditsOf(document);
  // 外れている記録（detached）は今の構造に当たっていないので、取り消しの対象にしない。
  // 「直前の編集を戻す」で外れた古い記録を掘り当てると、当たってもいない場所を切る。
  const index = editId
    ? edits.findIndex((edit) => edit.id === editId)
    : edits.reduce((found, edit, at) => (edit.detached ? found : at), -1);
  if (index < 0) return { document, applied: false, reason: '取り消せる編集がありません' };
  const edit = edits[index]!;

  // 名指しで外れている記録を指されたときは、構造に触れず記録だけを捨てる。
  // 「もうこの直しは要らない」という意思表示なので、断るより消す方が正しい。
  if (edit.detached) {
    return {
      document: {
        ...document,
        updatedAt: new Date().toISOString(),
        annotations: {
          ...document.annotations,
          sentenceEdits: [...edits.slice(0, index), ...edits.slice(index + 1)],
        },
      },
      applied: true,
    };
  }

  let structure: DocumentStructure;
  try {
    structure = revertSentenceEdit(document.structure, edit);
  } catch (error) {
    if (error instanceof SentenceEditError) return { document, applied: false, reason: error.message };
    throw error;
  }
  return {
    document: {
      ...document,
      updatedAt: new Date().toISOString(),
      structure,
      annotations: {
        ...document.annotations,
        sentenceEdits: [...edits.slice(0, index), ...edits.slice(index + 1)],
      },
    },
    applied: true,
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
    const translation = document.annotations.translations[hash];
    if (translation) {
      translated++;
      if (translation.revisedByHuman) revisedByHuman++;
      continue;
    }
    // 訳と「訳さない」を二重に数えない。両方が付いた古いデータで
    // translated + skipped + remaining が異なり文の数を超えていた。
    if (skipped[hash]) skippedCount++;
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

export interface TermReplacement {
  sentenceHash: string;
  before: string;
  after: string;
  revisedByHuman: boolean;
  /**
   * どの文の訳なのかを画面で示すための原文と位置。
   *
   * 日本語の before/after だけを並べると、どこの行が書き換わるのか確認しようが無い。
   * 1 件ずつ見せる確認画面の意味は「実物と突き合わせられること」なので、
   * 原文・通し番号・ページを必ず添える。
   */
  text: string;
  order: number;
  page: number;
}

/**
 * 「今の構造に在る文」だけを、原文の並び順に、重複なしで返す。
 *
 * 訳は消さない設計なので annotations.translations は構造より単調に太る
 * （再解析や区切り直しで外れた訳も残る）。訳語の一括置換をその生の Map の上で
 * 回すと、**画面のどこにも無い訳**が候補に並び、実在する行と区別できないまま
 * 書き換わる。用語を扱う処理は必ずこの入口を通す。
 */
function liveTranslations(
  document: PaperDocument,
): { sentence: Sentence; translation: Translation }[] {
  const rows: { sentence: Sentence; translation: Translation }[] = [];
  const seen = new Set<string>();
  for (const sentence of document.structure.sentences) {
    if (seen.has(sentence.hash)) continue;
    seen.add(sentence.hash);
    const translation = document.annotations.translations[sentence.hash];
    if (translation) rows.push({ sentence, translation });
  }
  return rows;
}

/**
 * 訳語を変えたときに、既に書いた訳を追随させる。
 *
 * 用語集は「これから訳すとき」にしか効かない。途中で訳語を変えると、
 * 前半と後半で訳語が違う論文ができあがる。直すには検索して 1 件ずつ開き直す
 * しかなく、100 件あれば実質やらない。
 *
 * 人手修正済みの訳も対象にする。**用語を変えるのは人の意思**なので、
 * ここで機械が遠慮すると「自分で直した箇所だけ古い訳語のまま」という
 * いちばん厄介な状態になる。ただし件数は分けて返し、画面で断れるようにする。
 */
export function replaceInTranslations(
  document: PaperDocument,
  from: string,
  to: string,
  options: { includeRevisedByHuman?: boolean } = {},
): { document: PaperDocument; replacements: TermReplacement[] } {
  const needle = from.trim();
  if (needle.length === 0) return { document, replacements: [] };
  const includeHuman = options.includeRevisedByHuman ?? true;

  const replacements: TermReplacement[] = [];
  const translations: Record<string, Translation> = { ...document.annotations.translations };
  const now = new Date().toISOString();

  for (const { sentence, translation } of liveTranslations(document)) {
    if (!translation.text.includes(needle)) continue;
    if (translation.revisedByHuman && !includeHuman) continue;
    const after = translation.text.split(needle).join(to);
    if (after === translation.text) continue;
    replacements.push({
      sentenceHash: sentence.hash,
      before: translation.text,
      after,
      revisedByHuman: translation.revisedByHuman,
      text: sentence.text,
      order: sentence.order,
      page: sentence.page,
    });
    translations[sentence.hash] = { ...translation, text: after, updatedAt: now };
  }

  if (replacements.length === 0) return { document, replacements };
  return {
    document: { ...document, updatedAt: now, annotations: { ...document.annotations, translations } },
    replacements,
  };
}

/**
 * 「この訳をこう書き換える」を 1 件ずつ指定して適用する。
 *
 * 一括置換を件数だけの確認で走らせてはいけない。日本語には語の切れ目が無いので、
 * 「学習 → ラーニング」は機械学習を機械ラーニングに、学習率をラーニング率にする。
 * しかも既定で人手修正済みの訳まで書き換わり、取り消す手段は無い。
 * 訳語を変えたくなるのは論文を訳し込んだ後なので、いちばん積み上がった時点で
 * いちばん戻せない壊れ方をする。
 *
 * そこで、画面が見せた before と現在の本文が一致するものだけを書き換える。
 * 選んでいない行は触らず、確認している間に別の書き込みが入った行は stale として返す
 * （黙って上書きすると、Claude が今書いた訳が消える）。
 */
export function applyTranslationEdits(
  document: PaperDocument,
  edits: readonly { sentenceHash: string; before: string; after: string }[],
): { document: PaperDocument; applied: number; stale: string[] } {
  const translations: Record<string, Translation> = { ...document.annotations.translations };
  const stale: string[] = [];
  const now = new Date().toISOString();
  let applied = 0;

  for (const edit of edits) {
    const current = translations[edit.sentenceHash];
    if (!current || current.text !== edit.before) {
      stale.push(edit.sentenceHash);
      continue;
    }
    if (edit.after === edit.before) continue;
    translations[edit.sentenceHash] = { ...current, text: edit.after, updatedAt: now };
    applied++;
  }

  if (applied === 0) return { document, applied, stale };
  return {
    document: { ...document, updatedAt: now, annotations: { ...document.annotations, translations } },
    applied,
    stale,
  };
}

/** 用語集の 1 件だけを差し替える（画面が持っている古い一覧で全体を上書きしないため）。 */
export function upsertGlossaryEntry(
  document: PaperDocument,
  entry: GlossaryEntry,
): { document: PaperDocument; added: boolean } {
  const glossary = [...document.annotations.glossary];
  const at = glossary.findIndex((g) => g.term.toLowerCase() === entry.term.toLowerCase());
  if (at === -1) glossary.push(entry);
  else glossary[at] = entry;
  return {
    document: {
      ...document,
      updatedAt: new Date().toISOString(),
      annotations: { ...document.annotations, glossary },
    },
    added: at === -1,
  };
}

/** 用語集の 1 件だけを消す。 */
export function removeGlossaryEntry(
  document: PaperDocument,
  term: string,
): { document: PaperDocument; removed: boolean } {
  const glossary = document.annotations.glossary.filter((g) => g.term.toLowerCase() !== term.toLowerCase());
  if (glossary.length === document.annotations.glossary.length) return { document, removed: false };
  return {
    document: {
      ...document,
      updatedAt: new Date().toISOString(),
      annotations: { ...document.annotations, glossary },
    },
    removed: true,
  };
}

/** 置き換えずに、対象になる訳だけ数える（押す前に件数を出すため）。 */
export function countTermUses(document: PaperDocument, term: string): { total: number; revisedByHuman: number } {
  const needle = term.trim();
  if (needle.length === 0) return { total: 0, revisedByHuman: 0 };
  let total = 0;
  let revisedByHuman = 0;
  // 置換の対象と同じ母集団を数える。構造から外れた訳まで数えると、
  // 押す前に出す件数と、実際に書き換わる件数が食い違う。
  for (const { translation } of liveTranslations(document)) {
    if (!translation.text.includes(needle)) continue;
    total++;
    if (translation.revisedByHuman) revisedByHuman++;
  }
  return { total, revisedByHuman };
}
