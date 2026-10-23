// キーボード操作の一覧。ヘルプの早見表と設定の「ショートカット」ページが同じデータを読む。
// 割り当ての変更はまだできない（キー処理が各所に散っているため）。ここは表示用の一覧。

export interface Shortcut {
  /** 表示用のキー（例: "Ctrl + \\"） */
  keys: string;
  /** 何が起きるか */
  action: string;
  /** どの画面で効くか（"全体" / "スライドの画面" など） */
  scope: string;
}

/** Mac では ⌘、それ以外では Ctrl。 */
export const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

export const SHORTCUTS: Shortcut[] = [
  { keys: `${MOD} + \\`, action: "左サイドバー（論文一覧）を開く・閉じる", scope: "全体" },
  { keys: `${MOD} + Shift + L`, action: "用語・数式のリストを開く", scope: "全体" },
  { keys: "Esc", action: "開いている画面（リスト・設定・ヘルプ）を閉じる", scope: "全体" },
  { keys: "?", action: "ショートカットの早見表を開く", scope: "全体" },
  { keys: "J / K", action: "次の文 / 前の文へ移る", scope: "対訳のタブ" },
  { keys: "N", action: "まだ訳していない次の文へ移る", scope: "対訳のタブ" },
  { keys: "+ / −", action: "拡大する / 縮小する", scope: "グラフ" },
  { keys: "0", action: "全体が収まる大きさに戻す", scope: "グラフ" },
  { keys: "R / V", action: "スライドの一部を囲む / 選ぶ", scope: "スライドの画面" },
  { keys: "T / F / E", action: "グループを論文の文章 / 図 / 数式にリンクする道具に替える", scope: "スライドの画面" },
  { keys: "[ / ]", action: "[スライド | 論文] / [論文 | 補足情報（対訳・訳・用語・数式・記録）] に切り替える", scope: "スライドの画面" },
  { keys: "P", action: "スライドと論文を並べたまま全画面にする・戻す（全画面は Esc でも終える）", scope: "スライドの画面" },
  { keys: "Delete / Backspace", action: "選んでいるグループを消す（論文側のリンクも一緒に消える）", scope: "スライドの画面" },
  { keys: `${MOD} + Z`, action: "消したグループを元に戻す（消したあとの知らせが出ている間）", scope: "スライドの画面" },
];

/** キー・説明・画面のどれかに語が含まれるものだけ残す。空白区切りの語はすべて含む必要がある。 */
export function filterShortcuts(list: Shortcut[], query: string): Shortcut[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((s) => {
    const hay = `${s.keys} ${s.action} ${s.scope}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
