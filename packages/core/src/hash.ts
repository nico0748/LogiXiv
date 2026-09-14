import { createHash, randomUUID } from 'node:crypto';

/** 構造スキーマのバージョン。正規化規則を変えたらここを上げ、migrate.ts に移行を書く。 */
export const STRUCTURE_VERSION = 2;

/** 書き出し HTML の generator などに出すバージョン。ここが唯一の定義。 */
export const LOGIXIV_VERSION = '0.1.0';

/**
 * 注釈の結合キーになる正規化。
 *
 * ここを変えると既存の訳が全部はぐれるので、変更するときは STRUCTURE_VERSION を上げて
 * migrate.ts に移行処理を足すこと（構造には原文が残っているので再計算はできる）。
 *
 * 規則と、その理由:
 *
 * - **NFC**（NFKC ではない）。NFKC は上付き・下付き・℃・µ・合字・ローマ数字を潰すので、
 *   "We set x² = 2." と "We set x2 = 2." が同じハッシュになってしまう。
 *   翻訳は hash をキーにした Map なので、衝突は「別の文に別の文の訳が付く」と同義。
 *
 * - **ダッシュは種類を保つ**。en dash（範囲 A–B）と hyphen（複合語 A-B）は別物として扱う。
 *   ただし U+2010/U+2011（hyphen, non-breaking hyphen）と全角ハイフンは ASCII の '-' に寄せる。
 *
 * - **letter 間のハイフンは落とす**。これがこのツールの生命線。GROBID は行の折り返しを
 *   解決した "block-sparse" を返すが、pdf.js 経由のフォールバックは行末で割れた
 *   "block-" + "sparse" を見る。どちらの経路でも "blocksparse" に正規化されるので、
 *   GROBID を後から立ち上げて再解析しても訳が外れない。
 *   代償は "re-cover" と "recover" が同じハッシュになること。実在の論文で
 *   「ハイフンの有無だけが違う 2 文」が同一文書に並ぶ確率より、再解析で訳が全部飛ぶ方が痛い。
 *
 * - 大文字小文字は保持する（Nature と nature を同じ文にしたくない）。
 */
export function normalizeSentence(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\u00ad/g, '') // soft hyphen は表示上の折り返し指示でしかない
    .replace(/[\u2010\u2011\uff0d]/g, '-')
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/(\p{L})[-]\s*(\p{L})/gu, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sentenceHash(text: string): string {
  return createHash('sha256').update(normalizeSentence(text), 'utf8').digest('hex').slice(0, 16);
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** 同じ文が同じ文書に複数回現れたとき用。hash + 出現回数で文 ID を作る。 */
export function sentenceId(hash: string, occurrence: number): string {
  return occurrence === 0 ? `s_${hash}` : `s_${hash}_${occurrence}`;
}

/** 内容から決まる安定した ID を作る。節 ID のように、並び順に依存させたくないものに使う。 */
export function stableId(prefix: string, seed: string, disambiguator = 0): string {
  const digest = createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 8);
  return disambiguator === 0 ? `${prefix}_${digest}` : `${prefix}_${digest}_${disambiguator}`;
}
