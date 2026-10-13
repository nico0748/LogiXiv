// 画面の配置を保管庫の .paperlens/workspace.json に読み書きする。
// Obsidian の .obsidian/workspace.json と同じ考え方で、別の端末で開いても同じ配置に戻る。

import {
  DEFAULT_WORKSPACE,
  WORKSPACE_PATH,
  type WorkspaceState,
  normalizeWorkspace,
} from "../src/components/shell/workspaceState.ts";
import type { Vault } from "../src/lib/vault.ts";

export { DEFAULT_WORKSPACE, WORKSPACE_PATH, type WorkspaceState };

/** 無い・壊れているときは既定の配置を返す。 */
export async function readWorkspace(vault: Vault): Promise<WorkspaceState> {
  try {
    if (!(await vault.exists(WORKSPACE_PATH))) return { ...DEFAULT_WORKSPACE };
    return normalizeWorkspace(JSON.parse(await vault.readText(WORKSPACE_PATH)));
  } catch {
    return { ...DEFAULT_WORKSPACE };
  }
}

// 同じ保管庫への書き込みは順番に行う。読んでから書くまでの間に別の書き込みが割り込まないようにする。
// サーバーは要求ごとに NodeVault を作るので、保管庫のフォルダ（root）ごとに並べる
const queues = new Map<unknown, Promise<unknown>>();
const queueKey = (vault: Vault) => (vault as { root?: string }).root ?? vault;

/** 渡した項目だけを書き換える。書いた後の配置を返す。 */
export function writeWorkspace(vault: Vault, partial: Partial<WorkspaceState>): Promise<WorkspaceState> {
  const key = queueKey(vault);
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(async () => {
    const cur = await readWorkspace(vault);
    const merged = normalizeWorkspace(partial, cur);
    await vault.writeText(WORKSPACE_PATH, `${JSON.stringify(merged, null, 2)}\n`);
    return merged;
  });
  queues.set(key, next);
  // 書き終えて後ろに何も並んでいなければ片付ける
  void next.catch(() => undefined).then(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  return next;
}
