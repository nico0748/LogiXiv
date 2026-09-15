import type { DocumentStructure, Rect, Sentence, SentenceEdit } from './types.ts';
import { sentenceHash, sentenceId } from './hash.ts';

/**
 * 文の区切りを人が直せるようにする。
 *
 * 文分割は「迷ったら切る」側に倒してあるので、GROBID でも pdf.js でも
 * 切りすぎ・切り足りないが必ず残る。対訳リーダーは原文 1 文と訳 1 文が
 * 並ぶことが成立条件なので、ここを直せないと読めない箇所が出る。
 *
 * 約束は 3 つ。
 *
 * 1. **編集は hash で指し、一致する箇所すべてに適用する。** 訳は hash に付くので、
 *    同じ本文が 2 か所にあるとき片方だけ区切りが違うと、一方の訳がもう一方に
 *    出ない・進捗が合わない、といった説明のつかない状態になる。
 * 2. **記録は原文テキストを持ち、hash はそこから導く。** 正規化規則を変えた
 *    （STRUCTURE_VERSION を上げた）とき、hash だけでは付け替えられない。
 *    構造側の文はもう結合・分割済みで、編集前の文はどこにも残っていないため。
 * 3. **取り消しに再解析を要求しない。** 結合の逆は分割、分割の逆は結合なので、
 *    適用時に逆向きの情報を作っておけばその場で戻せる。とくに分割を戻すときは
 *    「元は空白で区切られていたか」まで持つ。空白を勝手に入れて戻すと、
 *    単語の途中で切った文が別の本文になり、訳が静かにはぐれる。
 */

export class SentenceEditError extends Error {}

function rebuildOrder(sentences: Sentence[]): Sentence[] {
  const occurrences = new Map<string, number>();
  return sentences.map((sentence, index) => {
    const occurrence = occurrences.get(sentence.hash) ?? 0;
    occurrences.set(sentence.hash, occurrence + 1);
    return { ...sentence, order: index, id: sentenceId(sentence.hash, occurrence) };
  });
}

/**
 * 同じ行に乗る矩形をまとめ直す（結合で細切れの枠が重なって出ないように）。
 * 横に離れているものはまとめない。段組の左右は y がほぼ同じなので、
 * 距離を見ないと 1 本の枠が柱間を跨いで無関係な段まで光る。
 */
function normalizeRects(rects: readonly Rect[]): Rect[] {
  const merged: Rect[] = [];
  for (const rect of [...rects].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)) {
    const last = merged[merged.length - 1];
    if (last && last.page === rect.page && Math.abs(last.y - rect.y) < Math.max(2, last.h * 0.5)) {
      const gap = rect.x - (last.x + last.w);
      if (gap < Math.max(4, last.h * 2)) {
        const x0 = Math.min(last.x, rect.x);
        const x1 = Math.max(last.x + last.w, rect.x + rect.w);
        const y0 = Math.min(last.y, rect.y);
        const y1 = Math.max(last.y + last.h, rect.y + rect.h);
        merged[merged.length - 1] = { page: last.page, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        continue;
      }
    }
    merged.push({ ...rect });
  }
  return merged;
}

/** 1 つの断片としての見え方に整える（前後の空白を落とし、内部の空白を 1 つにする）。 */
function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** サロゲートペアの内側を指す位置をずらす。文字を半分に割ると絵文字や 𝔸 が壊れる。 */
function snapToCodePoint(text: string, offset: number): number {
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  const insidePair = previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff;
  return insidePair ? offset + 1 : offset;
}

/** 分割位置を正規化する（重複除去・範囲外除去・コードポイント境界へ寄せる）。 */
function normalizeOffsets(text: string, offsets: readonly number[]): number[] {
  const cuts = new Set<number>();
  for (const raw of offsets) {
    if (!Number.isFinite(raw)) continue;
    const offset = Math.floor(raw);
    if (offset <= 0 || offset >= text.length) continue;
    const snapped = snapToCodePoint(text, offset);
    if (snapped > 0 && snapped < text.length) cuts.add(snapped);
  }
  return [...cuts].sort((a, b) => a - b);
}

interface Piece {
  /** 表示・ハッシュに使う本文。 */
  text: string;
  /** 元の文における、前後の空白を落としたあとの範囲。 */
  from: number;
  to: number;
}

/**
 * 元の文を分割位置で切る。空白だけになる断片は落とす。
 * from/to は trim 後の範囲なので、断片と断片の間に何があったかをここから測れる。
 */
function cutIntoPieces(text: string, cuts: readonly number[]): Piece[] {
  const bounds = [0, ...cuts, text.length];
  const pieces: Piece[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i]!;
    const slice = text.slice(start, bounds[i + 1]!);
    const leading = slice.length - slice.replace(/^\s+/, '').length;
    const trailing = slice.length - slice.replace(/\s+$/, '').length;
    if (slice.length - leading - trailing <= 0) continue;
    pieces.push({
      text: tidy(slice),
      from: start + leading,
      to: bounds[i + 1]! - trailing,
    });
  }
  return pieces;
}

/**
 * 断片同士を元どおりに繋ぎ直すための文字列。
 * 単語の途中で切った場合は空文字になる。ここで空白 1 個を決め打ちすると、
 * 取り消したときに元と違う本文ができて、訳が静かにはぐれる。
 */
function joinersBetween(source: string, pieces: readonly Piece[]): string[] {
  const joiners: string[] = [];
  for (let i = 0; i < pieces.length - 1; i++) {
    const gap = source.slice(pieces[i]!.to, pieces[i + 1]!.from);
    joiners.push(gap.length === 0 ? '' : ' ');
  }
  return joiners;
}

/** 断片を繋いで 1 文にする。 */
function joinPieces(texts: readonly string[], joiners: readonly string[] | undefined): string {
  return texts
    .map((text, index) => (index === 0 ? tidy(text) : `${joiners?.[index - 1] ?? ' '}${tidy(text)}`))
    .join('');
}

/** 結合後テキストの上で、元の境目がどこだったかを測る。 */
function boundariesIn(texts: readonly string[], joiners: readonly string[] | undefined, total: number): number[] {
  const boundaries: number[] = [];
  let at = 0;
  for (let i = 0; i < texts.length - 1; i++) {
    at += tidy(texts[i]!).length + (joiners?.[i] ?? ' ').length;
    if (at > 0 && at < total) boundaries.push(at);
  }
  return boundaries;
}

/**
 * 編集記録の導出部分（hash と取り消し情報）を、原文テキストと分割位置だけから作り直す。
 * 正規化規則を変えたときの移行は、これを呼び直すだけで済む。
 */
export function deriveEdit(
  type: 'merge' | 'split',
  sourceTexts: readonly string[],
  offsets: readonly number[] = [],
  joiners: readonly string[] | undefined = undefined,
): { hashes: string[]; offsets: number[]; undo: NonNullable<SentenceEdit['undo']> } {
  if (type === 'merge') {
    const text = joinPieces(sourceTexts, joiners);
    return {
      hashes: sourceTexts.map((source) => sentenceHash(source)),
      offsets: [],
      undo: {
        hashes: [sentenceHash(text)],
        offsets: boundariesIn(sourceTexts, joiners, text.length),
        joiners: sourceTexts.slice(0, -1).map((_, index) => joiners?.[index] ?? ' '),
      },
    };
  }

  const source = sourceTexts[0] ?? '';
  const cuts = normalizeOffsets(source, offsets);
  const pieces = cutIntoPieces(source, cuts);
  return {
    hashes: [sentenceHash(source)],
    offsets: cuts,
    undo: {
      hashes: pieces.map((piece) => sentenceHash(piece.text)),
      joiners: joinersBetween(source, pieces),
    },
  };
}

export interface EditOutcome {
  structure: DocumentStructure;
  /** 編集の対象になった文の原文。移行で hash を作り直すために記録に残す。 */
  sourceTexts: string[];
  /** 取り消しに必要な情報。 */
  undo: NonNullable<SentenceEdit['undo']>;
  /** 実際に適用された箇所の数。 */
  occurrences: number;
  /** 正規化後の分割位置（split のときだけ意味を持つ）。 */
  offsets: number[];
}

export interface SentenceMergeOptions {
  /** 断片を繋ぐ文字列。省略すると空白 1 個。分割の取り消しで元の区切りを再現するために使う。 */
  joiners?: readonly string[];
  /** 先頭から数えて何か所までに適用するか。取り消しで、元から在った同文まで巻き込まないために使う。 */
  limit?: number;
}

/**
 * 連続する複数の文を 1 文に結合する。一致する並びが複数あればすべて結合する。
 * 重なり合う候補は前から順に取るので、同じ文が二重に使われることはない。
 */
export function mergeSentences(
  structure: DocumentStructure,
  hashes: readonly string[],
  options: SentenceMergeOptions = {},
): EditOutcome {
  if (hashes.length < 2) throw new SentenceEditError('結合するには 2 文以上を指定してください');

  const limit = options.limit ?? Infinity;
  const sentences = structure.sentences;
  const next: Sentence[] = [];
  let applied = 0;
  let sourceTexts: string[] | null = null;

  for (let i = 0; i < sentences.length; ) {
    const matches =
      applied < limit &&
      i + hashes.length <= sentences.length &&
      hashes.every((hash, offset) => sentences[i + offset]!.hash === hash);
    if (!matches) {
      next.push(sentences[i]!);
      i++;
      continue;
    }
    const parts = sentences.slice(i, i + hashes.length);
    const text = joinPieces(
      parts.map((part) => part.text),
      options.joiners,
    );
    const hash = sentenceHash(text);
    sourceTexts ??= parts.map((part) => part.text);
    next.push({
      id: sentenceId(hash, 0),
      hash,
      order: parts[0]!.order,
      page: parts[0]!.page,
      text,
      rects: normalizeRects(parts.flatMap((part) => part.rects)),
      sectionId: parts[0]!.sectionId,
    });
    applied++;
    i += hashes.length;
  }

  if (applied === 0 || !sourceTexts) {
    throw new SentenceEditError('指定された文が連続して見つかりません（再解析で区切りが変わった可能性があります）');
  }

  const derived = deriveEdit('merge', sourceTexts, [], options.joiners);
  return {
    structure: { ...structure, sentences: rebuildOrder(next) },
    sourceTexts,
    undo: { ...derived.undo, occurrences: applied },
    occurrences: applied,
    offsets: [],
  };
}

/** 文字位置の範囲を、矩形列の幅の比に写して切り出す。 */
function sliceRects(rects: readonly Rect[], fromRatio: number, toRatio: number): Rect[] {
  const totalWidth = rects.reduce((sum, rect) => sum + rect.w, 0);
  if (totalWidth === 0) return rects.map((rect) => ({ ...rect }));
  const out: Rect[] = [];
  let consumed = 0;
  for (const rect of rects) {
    const rectFrom = consumed / totalWidth;
    const rectTo = (consumed + rect.w) / totalWidth;
    consumed += rect.w;
    const overlapFrom = Math.max(fromRatio, rectFrom);
    const overlapTo = Math.min(toRatio, rectTo);
    if (overlapTo <= overlapFrom) continue;
    const span = rectTo - rectFrom || 1;
    out.push({
      page: rect.page,
      x: rect.x + ((overlapFrom - rectFrom) / span) * rect.w,
      y: rect.y,
      w: ((overlapTo - overlapFrom) / span) * rect.w,
      h: rect.h,
    });
  }
  return out;
}

export interface SplitOptions {
  /** 先頭から数えて何か所までに適用するか。 */
  limit?: number;
}

/**
 * 1 文を複数に割る。`offsets` は原文テキスト内の文字位置。
 * 同じ本文の文がほかにもあれば、そちらも同じ位置で割る。
 *
 * 矩形は文字数の比で按分する。等幅ではないので境目は数文字ずれるが、
 * 「どのあたりか」が分かる方が、枠が消えるより読みやすい。
 */
export function splitSentence(
  structure: DocumentStructure,
  hash: string,
  offsets: readonly number[],
  options: SplitOptions = {},
): EditOutcome {
  const target = structure.sentences.find((sentence) => sentence.hash === hash);
  if (!target) throw new SentenceEditError('指定された文が見つかりません');

  const cuts = normalizeOffsets(target.text, offsets);
  if (cuts.length === 0) throw new SentenceEditError('分割位置が文の内側にありません');
  const pieces = cutIntoPieces(target.text, cuts);
  if (pieces.length < 2) throw new SentenceEditError('分割の結果が 1 文にしかなりません');

  const limit = options.limit ?? Infinity;
  const length = target.text.length;
  let occurrences = 0;
  const next = structure.sentences.flatMap((sentence): Sentence[] => {
    if (sentence.hash !== hash || occurrences >= limit) return [sentence];
    occurrences++;
    return pieces.map((piece) => {
      const pieceHash = sentenceHash(piece.text);
      const rects = sliceRects(sentence.rects, piece.from / length, piece.to / length);
      return {
        id: sentenceId(pieceHash, 0),
        hash: pieceHash,
        order: sentence.order,
        page: rects[0]?.page ?? sentence.page,
        text: piece.text,
        rects,
        sectionId: sentence.sectionId,
      };
    });
  });

  const derived = deriveEdit('split', [target.text], cuts);
  return {
    structure: { ...structure, sentences: rebuildOrder(next) },
    sourceTexts: [target.text],
    undo: { ...derived.undo, occurrences },
    occurrences,
    offsets: cuts,
  };
}

export interface ApplyEditsResult {
  structure: DocumentStructure;
  /** 適用できた編集。取り消し情報は今の本文に合わせて作り直してある。 */
  applied: SentenceEdit[];
  /** 対象が見つからず適用できなかった編集。再解析で本文が変わると起きる。 */
  stale: SentenceEdit[];
}

export function applySentenceEdit(structure: DocumentStructure, edit: SentenceEdit): EditOutcome {
  return edit.type === 'merge'
    ? mergeSentences(structure, edit.hashes)
    : splitSentence(structure, edit.hashes[0] ?? '', edit.offsets ?? []);
}

/** 記録された編集を打ち消す。結合は分割で、分割は結合で戻す。 */
export function revertSentenceEdit(structure: DocumentStructure, edit: SentenceEdit): DocumentStructure {
  const undo = edit.undo;
  if (!undo || undo.hashes.length === 0) {
    throw new SentenceEditError('この編集には取り消しの情報がありません');
  }
  // 適用した箇所の数だけ戻す。元から在った同じ本文の文まで巻き込まないため。
  const limit = undo.occurrences;
  return edit.type === 'merge'
    ? splitSentence(structure, undo.hashes[0]!, undo.offsets ?? [], { limit }).structure
    : mergeSentences(structure, undo.hashes, { joiners: undo.joiners, limit }).structure;
}

/**
 * 記録された編集を順に適用する。
 * 適用できないものは飛ばして続ける（古い編集 1 件で再解析全体を失敗させない）。
 *
 * 適用できたものは、**今の本文に合わせて取り消し情報を作り直して**返す。
 * 再解析で本文の綴りが変わることがある（"block- sparse" → "block-sparse" は
 * 正規化すると同じ hash だが文字数が違う）。古い位置のまま取り消すと、
 * 関係ない場所で切って両方の文を壊す。
 */
export function applySentenceEdits(
  structure: DocumentStructure,
  edits: readonly SentenceEdit[],
): ApplyEditsResult {
  let current = structure;
  const applied: SentenceEdit[] = [];
  const stale: SentenceEdit[] = [];

  for (const edit of edits) {
    try {
      const outcome = applySentenceEdit(current, edit);
      current = outcome.structure;
      applied.push({
        ...edit,
        sourceTexts: outcome.sourceTexts,
        ...(edit.type === 'split' ? { offsets: outcome.offsets } : {}),
        undo: outcome.undo,
      });
    } catch (error) {
      if (error instanceof SentenceEditError) stale.push(edit);
      else throw error;
    }
  }

  return { structure: current, applied, stale };
}
