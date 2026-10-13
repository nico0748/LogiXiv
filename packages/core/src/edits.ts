import type { DocumentStructure, NonBodySentence, Rect, Sentence, SentenceEdit } from './types.ts';
import { sentenceHash, sentenceId } from './hash.ts';
import { estimateTextAdvance } from './advance.ts';

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
 *
 * 横に離れているものはまとめない。段組の左右は y がほぼ同じなので、距離を見ないと
 * 1 本の枠が柱間を跨いで無関係な段まで光る。許容量は空白 1 個ぶん（文字高の 0.6 倍）。
 * 二段組の柱間は狭くても 12pt（layout.ts の MIN_GUTTER）あるので、これで混ざらない。
 *
 * 解析側（sentences.ts の mergeRects）は、行の途中で終わる文には**その文が占めた
 * x 範囲だけ**の矩形を出す。1 行を共有していた 2 文を結合すると、ここで空白 1 個ぶんの
 * 隙間を跨いで 1 本の枠に戻る（逆に、結合していない文の枠が繋がることはない）。
 */
function normalizeRects(rects: readonly Rect[]): Rect[] {
  const merged: Rect[] = [];
  for (const rect of [...rects].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)) {
    const last = merged[merged.length - 1];
    if (last && last.page === rect.page && Math.abs(last.y - rect.y) < Math.max(2, last.h * 0.5)) {
      const gap = rect.x - (last.x + last.w);
      if (gap < Math.max(4, last.h * 0.6)) {
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
 * 断片同士を元どおりに繋ぎ直すための文字列。元の文にあった空白をそのまま持つ。
 * 単語の途中で切った場合は空文字になる。ここで空白 1 個を決め打ちすると、
 * 取り消したときに元と違う本文ができて、訳が静かにはぐれる。
 */
function joinersBetween(source: string, pieces: readonly Piece[]): string[] {
  const joiners: string[] = [];
  for (let i = 0; i < pieces.length - 1; i++) {
    joiners.push(sanitizeJoiner(source.slice(pieces[i]!.to, pieces[i + 1]!.from)));
  }
  return joiners;
}

/** 繋ぎ文字は空白類だけ。長さも切る（外から来た記録で本文を作らせない）。 */
export function sanitizeJoiner(gap: string): string {
  const clean = gap.replace(/[^\s]/g, '').slice(0, 8);
  return clean;
}

/** 断片を繋いで 1 文にする。 */
function joinPieces(texts: readonly string[], joiners: readonly string[] | undefined): string {
  return texts
    .map((text, index) => (index === 0 ? tidy(text) : `${joinerAt(joiners, index - 1)}${tidy(text)}`))
    .join('');
}

function joinerAt(joiners: readonly string[] | undefined, index: number): string {
  const joiner = joiners?.[index];
  return joiner === undefined ? ' ' : joiner;
}

/** 結合後テキストの上で、元の境目がどこだったかを測る。 */
function boundariesIn(texts: readonly string[], joiners: readonly string[] | undefined, total: number): number[] {
  const boundaries: number[] = [];
  let at = 0;
  for (let i = 0; i < texts.length - 1; i++) {
    at += tidy(texts[i]!).length + joinerAt(joiners, i).length;
    if (at > 0 && at < total) boundaries.push(at);
  }
  return boundaries;
}

/**
 * 編集記録の導出部分（hash と取り消し情報）を、原文テキストと分割位置だけから作り直す。
 * 正規化規則を変えたときの移行は、これを呼び直すだけで済む。
 */
export function deriveEdit(
  type: 'merge' | 'split' | 'drop',
  sourceTexts: readonly string[],
  offsets: readonly number[] = [],
  joiners: readonly string[] | undefined = undefined,
): { hashes: string[]; offsets: number[]; undo: NonNullable<SentenceEdit['undo']> } {
  if (type === 'drop') {
    // 取り除きは本文を書き換えないので、導けるのは対象の hash だけ。
    // 戻す先の位置（at）と付物の id は編集したときにしか分からないので、呼び出し側が持つ。
    const hash = sentenceHash(sourceTexts[0] ?? '');
    return { hashes: [hash], offsets: [], undo: { hashes: [hash] } };
  }
  if (type === 'merge') {
    const text = joinPieces(sourceTexts, joiners);
    return {
      hashes: sourceTexts.map((source) => sentenceHash(source)),
      offsets: [],
      undo: {
        hashes: [sentenceHash(text)],
        offsets: boundariesIn(sourceTexts, joiners, text.length),
        joiners: sourceTexts.slice(0, -1).map((_, index) => joinerAt(joiners, index)),
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
  /** 実際に使った繋ぎ文字（merge のときだけ意味を持つ）。 */
  joiners: string[];
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
  /** 先頭から数えて何か所までに適用するか。 */
  limit?: number;
  /**
   * ここに挙げた通し番号から始まる並びだけを対象にする。
   * 件数だけを上限にすると、同じ本文が手前にもあるとき、編集していない方を
   * ほどいてしまう（そして記録は消えるので二度と直せない）。
   */
  at?: readonly number[];
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
  const wanted = options.at ? new Set(options.at) : null;
  const sentences = structure.sentences;
  const next: Sentence[] = [];
  const at: number[] = [];
  let applied = 0;
  let sourceTexts: string[] | null = null;

  for (let i = 0; i < sentences.length; ) {
    const matches =
      applied < limit &&
      (wanted === null || wanted.has(sentences[i]!.order)) &&
      i + hashes.length <= sentences.length &&
      hashes.every((hash, offset) => sentences[i + offset]!.hash === hash);
    if (!matches) {
      next.push(sentences[i]!);
      i++;
      continue;
    }
    at.push(next.length);
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

  const joiners = sourceTexts.slice(0, -1).map((_, index) => joinerAt(options.joiners, index));
  const derived = deriveEdit('merge', sourceTexts, [], joiners);
  return {
    structure: { ...structure, sentences: rebuildOrder(next) },
    sourceTexts,
    joiners,
    undo: { ...derived.undo, occurrences: applied, at },
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
  /** ここに挙げた通し番号の文だけを対象にする（merge の at と同じ理由）。 */
  at?: readonly number[];
  /**
   * 分割後にこの hash 列になるように切り位置を探し直す。
   *
   * 再解析すると、正規化すると同じ hash でも綴りの長さが変わることがある
   * （"block- sparse" → "block-sparse"）。文字位置をそのまま当てると
   * 関係ない場所で切れて、両方の断片が別の本文になる。
   */
  pieceHashes?: readonly string[];
}

/**
 * 断片の hash 列から切り位置を探し直す。
 * 語の切れ目を先に試し、見つからなければ全位置を試す（文はせいぜい数百文字）。
 */
function relocateCuts(text: string, pieceHashes: readonly string[]): number[] | null {
  if (pieceHashes.length < 2 || text.length > 8000) return null;
  const wordStarts: number[] = [];
  const word = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = word.exec(text)) !== null) if (match.index > 0) wordStarts.push(match.index);
  const everywhere = Array.from({ length: text.length - 1 }, (_, index) => index + 1);

  const search = (candidates: readonly number[]): number[] | null => {
    const cuts: number[] = [];
    let start = 0;
    for (let piece = 0; piece < pieceHashes.length - 1; piece++) {
      const found = candidates.find(
        (candidate) =>
          candidate > start && sentenceHash(tidy(text.slice(start, candidate))) === pieceHashes[piece],
      );
      if (found === undefined) return null;
      cuts.push(found);
      start = found;
    }
    return sentenceHash(tidy(text.slice(start))) === pieceHashes[pieceHashes.length - 1] ? cuts : null;
  };

  return search(wordStarts) ?? search(everywhere);
}

/**
 * 1 文を複数に割る。`offsets` は原文テキスト内の文字位置。
 * 同じ本文の文がほかにもあれば、そちらも同じ位置で割る。
 *
 * 矩形は字形の幅の見積もりの比で按分する（advance.ts）。行の継ぎ目の空白も幅に数えるので
 * 境目は少しずれうるが、「どのあたりか」が分かる方が、枠が消えるより読みやすい。
 */
export function splitSentence(
  structure: DocumentStructure,
  hash: string,
  offsets: readonly number[],
  options: SplitOptions = {},
): EditOutcome {
  const target = structure.sentences.find((sentence) => sentence.hash === hash);
  if (!target) throw new SentenceEditError('指定された文が見つかりません');

  const relocated = options.pieceHashes ? relocateCuts(target.text, options.pieceHashes) : null;
  const cuts = relocated ?? normalizeOffsets(target.text, offsets);
  if (cuts.length === 0) throw new SentenceEditError('分割位置が文の内側にありません');
  if (options.pieceHashes && !relocated) {
    // 記録どおりの断片を作れない。文字位置で当てずっぽうに切るより、当てられなかったことにする。
    throw new SentenceEditError('本文が変わったため、記録どおりの位置で分割できません');
  }
  const pieces = cutIntoPieces(target.text, cuts);
  if (pieces.length < 2) throw new SentenceEditError('分割の結果が 1 文にしかなりません');

  const limit = options.limit ?? Infinity;
  const wanted = options.at ? new Set(options.at) : null;
  const length = target.text.length;
  // 枠の按分は文字数ではなく**字形の幅の見積もり**の比で行う（解析側の mergeRects と同じ。
  // advance.ts）。文字数の比では、和文に欧文が混ざる文や語間の広い行で境目が数文字ずれる。
  const totalAdvance = estimateTextAdvance(target.text);
  const advanceRatio = (offset: number): number =>
    totalAdvance > 0 ? estimateTextAdvance(target.text.slice(0, offset)) / totalAdvance : offset / length;
  let occurrences = 0;
  const at: number[] = [];
  let emitted = 0;
  const next = structure.sentences.flatMap((sentence): Sentence[] => {
    if (sentence.hash !== hash || occurrences >= limit || (wanted !== null && !wanted.has(sentence.order))) {
      emitted++;
      return [sentence];
    }
    occurrences++;
    at.push(emitted);
    emitted += pieces.length;
    return pieces.map((piece) => {
      const pieceHash = sentenceHash(piece.text);
      const rects = sliceRects(sentence.rects, advanceRatio(piece.from), advanceRatio(piece.to));
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
    joiners: [],
    undo: { ...derived.undo, occurrences, at },
    occurrences,
    offsets: cuts,
  };
}

export interface DropOptions {
  /** 先頭から数えて何か所までに適用するか。 */
  limit?: number;
  /** ここに挙げた通し番号の文だけを対象にする（merge / split の at と同じ理由）。 */
  at?: readonly number[];
}

/** 付物の id を作る。本文の文の id とぶつからないよう接頭辞を分ける（sentences.ts と同じ規則）。 */
function nonBodyId(hash: string, used: ReadonlySet<string>): string {
  let occurrence = 0;
  let id = `nb_${hash}`;
  while (used.has(id)) {
    occurrence++;
    id = `nb_${hash}_${occurrence}`;
  }
  return id;
}

/**
 * 文を本文から取り除き、`nonBody`（訳さないもの）へ移す。
 *
 * **なぜこの操作が要るか。** 本文 1 文の真ん中に図の枠内文字や表の行が割り込むことがある。
 * merge と split だけでは取り除けず、「3 つに split → 真ん中を skip → 前後を merge」は
 * `指定された文が連続して見つかりません` で拒否される（skip は「訳さない」印であって、
 * 文の列からは消えないため）。実際にそこで詰まって、英語 1 文が日本語では
 * 半端な 2 文のまま確定した。
 *
 * **取り除いたものは消さない。** `nonBody` に移すので、画面は
 * 「（訳さない：…）」として本文の間の正しい位置に出せる。この道具の一貫した方針は
 * 「PDF には見えているのに右に無い」を作らないこと。訳す対象からは外れるので、
 * 進捗の分母も正しくなる。
 *
 * 適用の単位は merge / split と揃える — hash で指して一致する箇所すべてに効き、
 * `at` で位置を絞れる。
 */
export function dropSentence(
  structure: DocumentStructure,
  hash: string,
  options: DropOptions = {},
): EditOutcome {
  const limit = options.limit ?? Infinity;
  const wanted = options.at ? new Set(options.at) : null;

  const kept: Sentence[] = [];
  const removed: Sentence[] = [];
  /** 取り除いた後の並びでの位置。取り消すときは、ここへ挿し戻せば元に戻る。 */
  const at: number[] = [];
  /** 取り除く前の通し番号。付物の列のどこに挟むかを決めるのに使う。 */
  const originalOrders: number[] = [];
  let occurrences = 0;

  for (const sentence of structure.sentences) {
    const matches =
      sentence.hash === hash &&
      occurrences < limit &&
      (wanted === null || wanted.has(sentence.order));
    if (!matches) {
      kept.push(sentence);
      continue;
    }
    at.push(kept.length);
    originalOrders.push(sentence.order);
    removed.push(sentence);
    occurrences++;
  }

  if (occurrences === 0) {
    throw new SentenceEditError('指定された文が見つかりません（再解析で区切りが変わった可能性があります）');
  }
  if (kept.length === 0) {
    // 本文が 1 文も残らない取り除き方は、事故としか考えられない。
    throw new SentenceEditError('本文の文がすべて無くなるため取り除けません');
  }

  const nonBody = [...(structure.nonBody ?? [])];
  const used = new Set(nonBody.map((entry) => entry.id));
  const nonBodyIds: string[] = [];

  removed.forEach((sentence, index) => {
    // 直前に残った本文の文。取り除いた後の並びで見るので、`at` の 1 つ手前。
    const previous = at[index]! > 0 ? kept[at[index]! - 1] : undefined;
    const id = nonBodyId(sentence.hash, used);
    used.add(id);
    nonBodyIds.push(id);
    const entry: NonBodySentence = {
      id,
      hash: sentence.hash,
      order: 0, // 下で振り直す
      page: sentence.page,
      text: sentence.text,
      rects: sentence.rects,
      sectionId: sentence.sectionId,
      // 版面の規則で落としたものではなく、人が「本文ではない」と判断したもの。
      // 種類としてはどれにも当てはまらないので other。
      kind: 'other',
      afterOrder: previous ? at[index]! - 1 : -1,
      afterHash: previous?.hash ?? null,
    };
    // 付物の列の中で、紙面の順に近い位置へ挟む。並べ替えはしない
    // （既存の件の afterOrder は編集前の番号なので、取り除く前の番号で比べる）。
    const insertAt = nonBody.findIndex((existing) => existing.afterOrder > originalOrders[index]!);
    if (insertAt < 0) nonBody.push(entry);
    else nonBody.splice(insertAt, 0, entry);
  });

  return {
    structure: {
      ...structure,
      sentences: rebuildOrder(kept),
      nonBody: nonBody.map((entry, order) => ({ ...entry, order })),
    },
    sourceTexts: [removed[0]!.text],
    joiners: [],
    undo: { hashes: [hash], occurrences, at, nonBodyIds },
    occurrences,
    offsets: [],
  };
}

/**
 * 取り除いた文を本文へ挿し戻す（drop の取り消し）。
 *
 * 戻す相手は `undo.nonBodyIds` で名指しする。hash だけで探すと、もともと同じ本文の
 * 付物があったときにそちらを本文へ混ぜてしまう。
 */
export function restoreDroppedSentence(structure: DocumentStructure, edit: SentenceEdit): DocumentStructure {
  const undo = edit.undo;
  const ids = undo?.nonBodyIds ?? [];
  const positions = undo?.at ?? [];
  if (ids.length === 0 || positions.length !== ids.length) {
    throw new SentenceEditError('この編集には取り消しの情報がありません');
  }

  const nonBody = structure.nonBody ?? [];
  const byId = new Map(nonBody.map((entry) => [entry.id, entry]));
  let restored = ids.map((id) => byId.get(id));
  if (restored.some((entry) => entry === undefined)) {
    // id で引けないのは、正規化規則を変えた移行を通った記録（id は作り直される）。
    // そのときだけ hash で探す。同じ本文の付物がもともとあると取り違えうるので、
    // **人が取り除いたもの（kind = other）**に限り、後ろから必要な数だけ取る。
    const fallback = nonBody.filter((entry) => entry.hash === edit.hashes[0] && entry.kind === 'other');
    if (fallback.length < ids.length) {
      throw new SentenceEditError('取り除いた文が見つかりません（すでに戻されている可能性があります）');
    }
    restored = fallback.slice(fallback.length - ids.length);
  }
  const restoredIds = new Set(restored.map((entry) => entry!.id));

  const sentences = [...structure.sentences];
  // 後ろから挿し戻す。前から入れると、後ろの位置がそのぶんずれる。
  for (let i = ids.length - 1; i >= 0; i--) {
    const entry = restored[i]!;
    const place = Math.min(Math.max(positions[i]!, 0), sentences.length);
    sentences.splice(place, 0, {
      id: entry.id,
      hash: entry.hash,
      order: place,
      page: entry.page,
      text: entry.text,
      rects: entry.rects,
      sectionId: entry.sectionId,
    });
  }

  const remaining = nonBody.filter((entry) => !restoredIds.has(entry.id));
  return {
    ...structure,
    sentences: rebuildOrder(sentences),
    nonBody: remaining.map((entry, order) => ({ ...entry, order })),
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
  if (edit.type === 'merge') return mergeSentences(structure, edit.hashes, { joiners: edit.joiners });
  if (edit.type === 'drop') return dropSentence(structure, edit.hashes[0] ?? '');
  return splitSentence(structure, edit.hashes[0] ?? '', edit.offsets ?? [], { pieceHashes: edit.undo?.hashes });
}

/** 記録された編集を打ち消す。結合は分割で、分割は結合で戻す。 */
export function revertSentenceEdit(structure: DocumentStructure, edit: SentenceEdit): DocumentStructure {
  const undo = edit.undo;
  if (!undo || undo.hashes.length === 0) {
    throw new SentenceEditError('この編集には取り消しの情報がありません');
  }
  // 編集した箇所だけを戻す。件数しか見ないと、同じ本文が手前にもあるとき
  // 編集していない方をほどいてしまい、記録は消えるので二度と直せない。
  // 位置が分からない古い記録では 1 か所に留める（戻しすぎる方が壊れ方が重い）。
  const limit = undo.occurrences ?? 1;
  const at = undo.at;
  // 取り除きの逆は「挿し戻し」。結合⇄分割のような対ではないので、専用の処理を持つ。
  if (edit.type === 'drop') return restoreDroppedSentence(structure, edit);
  return edit.type === 'merge'
    ? splitSentence(structure, undo.hashes[0]!, undo.offsets ?? [], {
        limit,
        at,
        // 結合を戻すときの断片は、結合前の文そのもの。hash で位置を探し直せば、
        // 再解析で綴りが変わっていても正しい場所で切れる。
        pieceHashes: edit.hashes.length >= 2 ? edit.hashes : undefined,
      }).structure
    : mergeSentences(structure, undo.hashes, { joiners: undo.joiners, limit, at }).structure;
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
        ...(edit.type === 'split'
          ? { offsets: outcome.offsets }
          : { joiners: outcome.joiners }),
        undo: outcome.undo,
        // 前は外れていた手順が当たったので、印を外す。
        detached: false,
      });
    } catch (error) {
      // 当たらなかった手順も記録としては残す（呼び出し側が印を付けて保存する）。
      // 取り消し情報は当たったときに作り直されるので、外れている間の古い undo は
      // 使われない（undoSentenceEdit は外れている手順を構造に当てない）。
      if (error instanceof SentenceEditError) stale.push({ ...edit, detached: true });
      else throw error;
    }
  }

  return { structure: current, applied, stale };
}
