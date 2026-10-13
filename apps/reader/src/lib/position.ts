// 論文ごとの「前回の位置」。端末の localStorage にだけ保存する（保管庫と MCP からは見えない）。
//
// キーは paperlens.pos.<保存先>/<論文 ID>。保存先は、サーバー版はフォルダのフルパス、単体 HTML 版は保管庫の名前。
// localStorage が使えない環境（プライベートウィンドウ、テストの Node.js など）では、何もしない。

export interface Pos {
  /** 表示している範囲の上から 1/3 の位置にあるページ */
  page: number;
  /** 表示している範囲の上端の位置。page の先頭からの距離を、ページの高さに対する割合で表す（拡大率を変えても同じ位置になる） */
  y: number;
}

export const posKey = (root: string, id: string) => `paperlens.pos.${root}/${id}`;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadPos(key: string): Pos | null {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Pos>;
    if (!Number.isInteger(p.page) || (p.page as number) < 1 || typeof p.y !== "number" || !Number.isFinite(p.y)) return null;
    return { page: p.page as number, y: Math.max(-1, Math.min(1, p.y)) };
  } catch {
    return null;
  }
}

export function savePos(key: string, pos: Pos) {
  try {
    storage()?.setItem(key, JSON.stringify({ page: pos.page, y: Math.round(pos.y * 1e4) / 1e4 }));
  } catch {
    // 保存できなくても読むのには困らない
  }
}

/**
 * 呼び出しを ms に 1 回までに間引く。間引いた最後の呼び出しは、時間が来たら必ず実行する。
 * flush で、待っている呼び出しをすぐに実行する（論文を切り替えるときなど）。
 */
export function throttleTrailing<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;
  const run = () => {
    timer = null;
    if (!pending) return;
    const args = pending;
    pending = null;
    last = Date.now();
    fn(...args);
  };
  return {
    call(...args: A) {
      pending = args;
      if (timer) return;
      const wait = last + ms - Date.now();
      if (wait <= 0) run();
      else timer = setTimeout(run, wait);
    },
    flush() {
      if (timer) clearTimeout(timer);
      run();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
