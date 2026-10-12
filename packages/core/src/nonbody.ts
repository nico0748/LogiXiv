/**
 * 本文として扱わなかった行（nonBody）を、本文のどの文の後ろに差し込むかを決める。
 *
 * 画面（apps/web）・書き出しの静的部分（export.ts）・ビューア（apps/viewer）の
 * 3 か所が、**同じ位置**に差し込めないと意味がない。同じ論文を 3 通りの並びで
 * 見せる道具になってしまうため。以前は同じ十数行が 3 か所に写してあり、
 * 「hash の最初の出現を採る」という同じ誤りが 3 つとも入っていた。
 * 規則はここ 1 か所だけに置き、3 つともここを読む。
 *
 * 位置は `afterHash`（直前の本文の hash）と `afterOrder`（その通し番号）の
 * 2 つで来る。どちらか一方では足りない。
 *  - hash だけだと、**同じ本文が論文に 2 回出たとき**にどちらの後ろか決まらない。
 *    結論の 1 文を序論にも置くのは普通の書き方で、この道具はそれを前提にしている
 *    （サイドバーに「同じ本文が前にも出ています」という表示がある）。
 *    最初の出現を採ると、末尾の参考文献が序論の途中にカードとして出た。
 *  - order だけだと、人が文を結合・分割した瞬間に通し番号が振り直されて全部ずれる。
 *
 * そこで「hash が指す出現のうち、`afterOrder` にいちばん近いものを選ぶ」。
 * 結合・分割で番号が多少前後しても文の**順序**は保たれるので、近さで選べば当たる。
 *
 * この型は core の `Sentence` / `NonBodySentence` そのものを要求しない。
 * ビューアと画面は「その HTML 単体で 10 年後も開ける」ことを優先して
 * 自分用に最小限の型を写し持っているので、構造的に同じ形なら通るようにしてある。
 */

/** 差し込み先になれる本文の文。position を決めるのに要る 3 つだけ見る。 */
export interface NonBodyAnchor {
  id: string;
  hash: string;
  order: number;
}

/** 差し込む側。位置の指定だけ見る（種類や本文は呼び出し側が描く）。 */
export interface NonBodyPlaceable {
  afterOrder: number;
  afterHash: string | null;
}

export interface NonBodyPlacement<T> {
  /** 本文より前にあるもの（表題・著者行など）。先頭の文の前に置く。 */
  head: T[];
  /** 本文の文 id → その直後に置くもの。読み順で並ぶ。 */
  after: Map<string, T[]>;
}

/**
 * nonBody を本文の文へ割り付ける。
 *
 * 返すのは id の対応だけで、描き方には触れない（3 か所で見た目が違うため）。
 */
export function placeNonBody<S extends NonBodyAnchor, T extends NonBodyPlaceable>(
  sentences: readonly S[],
  nonBody: readonly T[] | undefined,
): NonBodyPlacement<T> {
  const head: T[] = [];
  const after = new Map<string, T[]>();
  if (!nonBody || nonBody.length === 0) return { head, after };

  // 同じ本文は何度でも出るので、hash → 出現**すべて**を持つ。
  const byHash = new Map<string, S[]>();
  const byOrder = new Map<number, S>();
  for (const sentence of sentences) {
    const list = byHash.get(sentence.hash);
    if (list) list.push(sentence);
    else byHash.set(sentence.hash, [sentence]);
    if (!byOrder.has(sentence.order)) byOrder.set(sentence.order, sentence);
  }
  // 通し番号そのものが無くなったときに「その手前で最も後ろの文」を引くための並び。
  const ordered = [...sentences].sort((a, b) => a.order - b.order);

  for (const item of nonBody) {
    const anchor = resolveAnchor(item, byHash, byOrder, ordered);
    if (!anchor) {
      head.push(item);
      continue;
    }
    const list = after.get(anchor.id);
    if (list) list.push(item);
    else after.set(anchor.id, [item]);
  }
  return { head, after };
}

function resolveAnchor<S extends NonBodyAnchor>(
  item: NonBodyPlaceable,
  byHash: Map<string, S[]>,
  byOrder: Map<number, S>,
  ordered: readonly S[],
): S | null {
  const candidates = item.afterHash ? byHash.get(item.afterHash) : undefined;
  if (candidates && candidates.length > 0) {
    if (candidates.length === 1) return candidates[0]!;
    // 同じ本文が何度も出るときだけ、通し番号でどの出現かを決める。
    // 番号が古くても「いちばん近い出現」は動かないので、結合・分割にも耐える。
    let best = candidates[0]!;
    let bestDistance = Math.abs(best.order - item.afterOrder);
    for (const candidate of candidates) {
      const distance = Math.abs(candidate.order - item.afterOrder);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  }

  // hash が当たらない（アンカーの文が結合・分割で消えた）ときだけ通し番号に落ちる。
  if (item.afterOrder < 0) return null;
  const exact = byOrder.get(item.afterOrder);
  if (exact) return exact;
  // その番号の文も無いとき（結合で文の数が減った場合など）は、手前でいちばん
  // 後ろの文に付ける。見つからないからと先頭へ送ると、末尾の参考文献がまとめて
  // 論文の冒頭に飛ぶ（本文より前に置くのは「本文より前にあった」ものだけでよい）。
  let fallback: S | null = null;
  for (const sentence of ordered) {
    if (sentence.order > item.afterOrder) break;
    fallback = sentence;
  }
  return fallback;
}
