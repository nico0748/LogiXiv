import { createHash, randomUUID } from 'node:crypto';

/**
 * 注釈の結合キーになる正規化。ここを変えると既存の訳が全部はぐれるので、
 * 変更するときは structure.version を上げてマイグレーションを書くこと。
 *
 * - Unicode 正規化（NFKC）
 * - 連続空白の潰し込みと前後トリム
 * - 行末ハイフネーションの結合（GROBID が残す "informa- tion" を潰す）
 * - 各種ダッシュ・引用符を ASCII に寄せる
 * - 大文字小文字は保持する（Nature と nature を同じ文にしたくない）
 */
export function normalizeSentence(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/(\p{Ll})-\s+(\p{Ll})/gu, '$1$2')
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
