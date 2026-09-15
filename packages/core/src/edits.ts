import type { DocumentStructure, Rect, Sentence, SentenceEdit } from './types.ts';
import { sentenceHash, sentenceId } from './hash.ts';

/**
 * 文の区切りを人が直せるようにする。
 *
 * 文分割は「迷ったら切る」側に倒してあるので、GROBID でも pdf.js でも
 * 切りすぎ・切り足りないが必ず残る。対訳リーダーは原文 1 文と訳 1 文が
 * 並ぶことが成立条件なので、ここを直せないと読めない箇所が出る。
 *
 * **編集は hash で指し、一致する箇所すべてに適用する。**
 * 訳は hash に付くので、同じ本文が 2 か所にあるとき片方だけ区切りが違うと、
 * 一方の訳がもう一方に出ない・進捗が合わない、といった説明のつかない状態になる。
 * 「同じ本文はいつも同じ区切り」を保てば、位置を覚えなくても再解析に追随できる。
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

/** 同じ行に乗る矩形をまとめ直す（結合で細切れの枠が重なって出ないように）。 */
function normalizeRects(rects: readonly Rect[]): Rect[] {
  const merged: Rect[] = [];
  for (const rect of [...rects].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)) {
    const last = merged[merged.length - 1];
    if (last && last.page === rect.page && Math.abs(last.y - rect.y) < Math.max(2, last.h * 0.5)) {
      const x0 = Math.min(last.x, rect.x);
      const x1 = Math.max(last.x + last.w, rect.x + rect.w);
      const y0 = Math.min(last.y, rect.y);
      const y1 = Math.max(last.y + last.h, rect.y + rect.h);
      merged[merged.length - 1] = { page: last.page, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      continue;
    }
    merged.push({ ...rect });
  }
  return merged;
}

function joinText(parts: readonly string[]): string {
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export interface EditOutcome {
  structure: DocumentStructure;
  /** 取り消しに必要な情報。結合なら「結合後の hash と元の境目」、分割なら「分割後の hash 列」。 */
  undo: { hashes: string[]; offsets?: number[] };
  /** 何か所に適用されたか。 */
  occurrences: number;
}

/**
 * 連続する複数の文を 1 文に結合する。一致する並びが複数あればすべて結合する。
 * 重なり合う候補は前から順に取るので、同じ文が二重に使われることはない。
 */
export function mergeSentences(structure: DocumentStructure, hashes: readonly string[]): EditOutcome {
  if (hashes.length < 2) throw new SentenceEditError('結合するには 2 文以上を指定してください');

  const sentences = structure.sentences;
  const next: Sentence[] = [];
  let applied = 0;
  let undo: { hashes: string[]; offsets?: number[] } | null = null;

  for (let i = 0; i < sentences.length; ) {
    const matches =
      i + hashes.length <= sentences.length &&
      hashes.every((hash, offset) => sentences[i + offset]!.hash === hash);
    if (!matches) {
      next.push(sentences[i]!);
      i++;
      continue;
    }
    const parts = sentences.slice(i, i + hashes.length);
    const pieces = parts.map((part) => joinText([part.text]));
    const text = pieces.join(' ');
    const hash = sentenceHash(text);
    if (!undo) {
      // 取り消し用に「元はどこで切れていたか」を、結合後テキスト上の位置で持っておく。
      // 各断片は空白 1 個で連結されるので、境目は「次の断片の先頭」に置く。
      const boundaries: number[] = [];
      let at = 0;
      for (const piece of pieces.slice(0, -1)) {
        at += piece.length + 1;
        boundaries.push(at);
      }
      undo = { hashes: [hash], offsets: boundaries.filter((b) => b > 0 && b < text.length) };
    }
    next.push({
      id: sentenceId(hash, 0),
      hash,
      order: parts[0]!.order,
      page: parts[0]!.page,
      text,
      rects: normalizeRects(parts.flatMap((s) => s.rects)),
      sectionId: parts[0]!.sectionId,
    });
    applied++;
    i += hashes.length;
  }

  if (applied === 0 || !undo) {
    throw new SentenceEditError('指定された文が連続して見つかりません（再解析で区切りが変わった可能性があります）');
  }
  return { structure: { ...structure, sentences: rebuildOrder(next) }, undo, occurrences: applied };
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
): EditOutcome {
  const target = structure.sentences.find((s) => s.hash === hash);
  if (!target) throw new SentenceEditError('指定された文が見つかりません');

  const cuts = [...new Set(offsets.map((offset) => Math.floor(offset)))]
    .filter((offset) => offset > 0 && offset < target.text.length)
    .sort((a, b) => a - b);
  if (cuts.length === 0) throw new SentenceEditError('分割位置が文の内側にありません');

  const bounds = [0, ...cuts, target.text.length];
  const pieces: { text: string; from: number; to: number }[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const text = target.text.slice(bounds[i]!, bounds[i + 1]!).trim();
    if (text.length === 0) continue;
    pieces.push({ text, from: bounds[i]!, to: bounds[i + 1]! });
  }
  if (pieces.length < 2) throw new SentenceEditError('分割の結果が 1 文にしかなりません');

  const length = target.text.length;
  let occurrences = 0;
  const next = structure.sentences.flatMap((sentence): Sentence[] => {
    if (sentence.hash !== hash) return [sentence];
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

  return {
    structure: { ...structure, sentences: rebuildOrder(next) },
    undo: { hashes: pieces.map((piece) => sentenceHash(piece.text)) },
    occurrences,
  };
}

export interface ApplyEditsResult {
  structure: DocumentStructure;
  /** 適用できた編集（この順で再現できる）。 */
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
  return edit.type === 'merge'
    ? splitSentence(structure, undo.hashes[0]!, undo.offsets ?? []).structure
    : mergeSentences(structure, undo.hashes).structure;
}

/**
 * 記録された編集を順に適用する。
 * 適用できないものは飛ばして続ける（古い編集 1 件で再解析全体を失敗させない）。
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
      current = applySentenceEdit(current, edit).structure;
      applied.push(edit);
    } catch (error) {
      if (error instanceof SentenceEditError) stale.push(edit);
      else throw error;
    }
  }

  return { structure: current, applied, stale };
}
