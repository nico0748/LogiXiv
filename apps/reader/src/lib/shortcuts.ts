// キーボード操作の一覧。ヘルプの早見表と設定の「ショートカット」ページが同じデータを読む。
// 割り当ての変更はまだできない（キー処理が各所に散っているため）。ここは表示用の一覧。

import { matchesQuery } from "./searchText.ts";

export interface Shortcut {
  /** 表示用のキー（例: "Ctrl + \\"）。文字のキーは実際に押す小文字で書く */
  keys: string;
  /** 何が起きるか */
  action: string;
  /** どの画面で効くか（"全体" / "スライドの画面" など） */
  scope: string;
  /** サーバー版とデスクトップ版だけにある機能（対訳・リスト）。ブラウザ版の一覧には出さない */
  serverOnly?: boolean;
  /** ブラウザ版での説明（対訳など、ブラウザ版に無いものに触れない言い方）。無ければ action のまま */
  browserAction?: string;
}

/** Mac では ⌘、それ以外では Ctrl。 */
export const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

export const SHORTCUTS: Shortcut[] = [
  { keys: `${MOD} + \\`, action: "左サイドバー（論文一覧）を開く・閉じる", scope: "全体" },
  { keys: `${MOD} + Shift + L`, action: "用語・数式のリストを開く", scope: "全体", serverOnly: true },
  { keys: "Esc", action: "開いている画面（リスト・設定・ヘルプ）を閉じる", scope: "全体" },
  { keys: "?", action: "キーボード操作の早見表を開く（文字の入力中は除く）", scope: "全体" },
  { keys: "j / k", action: "次の文 / 前の文へ移る", scope: "対訳のタブ", serverOnly: true },
  { keys: "n", action: "まだ訳していない次の文へ移る", scope: "対訳のタブ", serverOnly: true },
  { keys: "+ / -", action: "拡大する / 縮小する", scope: "グラフ" },
  { keys: "0", action: "全体が収まる大きさに戻す", scope: "グラフ" },
  { keys: "r / v", action: "スライドの一部を囲む / 選ぶ", scope: "スライドの画面" },
  { keys: "t / f / e", action: "グループを論文の文章 / 図 / 数式にリンクする道具に替える", scope: "スライドの画面" },
  {
    keys: "[ / ]",
    action: "[スライド | 論文] / [論文 | 補足情報（対訳・訳・用語・数式・記録）] に切り替える",
    browserAction: "[スライド | 論文] / [論文 | 補足情報（訳・用語・数式・記録）] に切り替える",
    scope: "スライドの画面",
  },
  { keys: "p", action: "発表を始める・終える（スライドと論文を別の窓に全画面で映し、この窓に台本を出す。別の窓を開けないときはこの画面を全画面にする。全画面は Esc でも終える）", scope: "スライドの画面" },
  { keys: "← / →", action: "発表中に、スライドを前後へ送る（台本の窓でも発表の窓でも）", scope: "スライドの画面" },
  { keys: "Delete / Backspace", action: "選んでいるグループを消す（論文側のリンクも一緒に消える）", scope: "スライドの画面" },
  { keys: `${MOD} + Z`, action: "消したグループを元に戻す（消したあとの知らせが出ている間）", scope: "スライドの画面" },
];

/** いまの版で使えるものだけ。server はサーバー版かデスクトップ版のとき true */
export function shortcutsFor(server: boolean, list: Shortcut[] = SHORTCUTS): Shortcut[] {
  return server ? list : list.filter((s) => !s.serverOnly).map((s) => (s.browserAction ? { ...s, action: s.browserAction } : s));
}

/** キー・説明・画面のどれかに当たるものだけ残す。空白区切りの語はすべて当たる必要がある（言い換えは searchText.ts）。 */
export function filterShortcuts(list: Shortcut[], query: string): Shortcut[] {
  return list.filter((s) => matchesQuery(`${s.keys} ${s.action} ${s.scope}`, query));
}
