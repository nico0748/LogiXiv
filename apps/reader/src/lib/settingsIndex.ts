// 設定のページと項目の一覧。左のナビと設定内の検索、ヘルプからの呼び出しで使う。
// 項目の id は画面の要素の id（set-<id>）にもなる。検索で選ぶと、そのページを開いてその項目へ動く。

import { matchesQuery, normalizeQuery } from "./searchText.ts";

export type SettingsPageId = "general" | "display" | "ai" | "template" | "data" | "mcp" | "obsidian" | "shortcuts" | "about";

export interface SettingsPageInfo {
  id: SettingsPageId;
  label: string;
  group: string;
  /** ヘルプの章（HelpButton の chapter） */
  help: string;
}

export const SETTINGS_PAGES: SettingsPageInfo[] = [
  { id: "general", label: "全般", group: "オプション", help: "settings" },
  { id: "display", label: "表示", group: "オプション", help: "settings" },
  { id: "ai", label: "読解と AI", group: "オプション", help: "settings" },
  { id: "template", label: "テンプレート", group: "オプション", help: "settings" },
  { id: "data", label: "データ", group: "オプション", help: "settings" },
  { id: "mcp", label: "AI エージェント（MCP）", group: "連携", help: "mcp" },
  { id: "obsidian", label: "Obsidian", group: "連携", help: "settings" },
  { id: "shortcuts", label: "ショートカット", group: "情報", help: "keys" },
  { id: "about", label: "このアプリについて", group: "情報", help: "settings" },
];

export const isSettingsPage = (v: unknown): v is SettingsPageId => SETTINGS_PAGES.some((p) => p.id === v);

export interface SettingItemInfo {
  id: string;
  page: SettingsPageId;
  label: string;
  desc: string;
  /** 画面には出さない検索用の語 */
  keywords?: string;
}

export const SETTING_ITEMS: SettingItemInfo[] = [
  { id: "vault", page: "general", label: "保存先フォルダ・保管庫", desc: "論文の PDF と読解ノートを保存するフォルダです。", keywords: "フォルダ 場所 パス vault 保存場所 保存先 どこ" },
  { id: "startup", page: "general", label: "起動時の動作", desc: "開いたときに、前回の論文を開くか、論文一覧を開くかを選びます。", keywords: "起動 開く 最初 立ち上げ" },
  { id: "theme", page: "display", label: "テーマ", desc: "明るい表示、暗い表示、端末の設定に合わせる、から選びます。", keywords: "ダーク ライト 明暗 dark light システム ダークモード 夜 黒" },
  { id: "accent", page: "display", label: "アクセント色", desc: "ボタンや選んだ項目の色です。", keywords: "色 カラー テーマカラー" },
  { id: "font-body", page: "display", label: "補足情報の文字サイズ", desc: "右サイドバーの訳・用語・対訳のカードの文字の大きさです。", keywords: "フォント 大きさ 文字 文字サイズ 小さい 大きい 読みにくい 本文" },
  { id: "font-note", page: "display", label: "記録欄の文字サイズ", desc: "記録タブの入力欄の文字の大きさです。", keywords: "フォント 大きさ 記録 ノート メモ" },
  { id: "font-sidebar", page: "display", label: "論文一覧の文字サイズ", desc: "左サイドバー（論文一覧・検索）の文字の大きさです。", keywords: "フォント 大きさ 一覧 サイドバー" },
  { id: "leading", page: "display", label: "行間", desc: "訳・対訳・記録の行の間隔です。", keywords: "行の高さ 間隔" },
  { id: "pdf-zoom", page: "display", label: "PDF の既定の倍率", desc: "論文を開いたときの PDF の大きさです。", keywords: "ズーム 拡大 倍率 幅に合わせる 100%" },
  { id: "sentence-marks", page: "display", label: "対訳の文の枠", desc: "PDF の上に、対訳の文の枠を出します。", keywords: "文マーク 対訳" },
  { id: "paper-sort", page: "display", label: "論文一覧の並び順", desc: "左サイドバーの論文一覧を並べる順です。", keywords: "並べ替え ソート 順番" },
  { id: "api-key", page: "ai", label: "API キー", desc: "訳・用語の説明・数式の書き起こしに使う Claude の API キーです。", keywords: "Claude Anthropic キー 接続 APIキー apikey 料金 課金 Console" },
  { id: "model", page: "ai", label: "モデル", desc: "Claude のモデルを候補から選ぶか、名前を入力します。", keywords: "Claude Opus Sonnet Haiku Fable 料金" },
  { id: "lang", page: "ai", label: "訳文の言語", desc: "訳と説明を書く言語です。", keywords: "日本語 英語 言語 翻訳 訳す言語" },
  { id: "style", page: "ai", label: "訳と説明の文体", desc: "Claude に渡す書き方の方針です。", keywords: "文体 プロンプト スタイル" },
  { id: "glossary", page: "ai", label: "訳語の固定", desc: "英語の語を、決めた日本語で訳してもらいます。用語集から取り込めます。", keywords: "訳語 用語 対訳 用語集" },
  { id: "context", page: "ai", label: "送る範囲", desc: "選んだ文の前後の本文を、どれだけ Claude に送るかを選びます。", keywords: "前後 本文 プライバシー 送信" },
  { id: "template", page: "template", label: "読解ノートのテンプレート", desc: "段階ごとの記録欄を決めます。", keywords: "テンプレート 記録欄 フィールド note" },
  { id: "export", page: "data", label: "設定の書き出しと読み込み", desc: "表示や AI の設定を JSON にします。API キーは含めません。", keywords: "バックアップ エクスポート インポート JSON 移す 別のPC 移行" },
  { id: "import-status", page: "data", label: "取り込み時の段階", desc: "新しく取り込んだ論文の読解の段階です。", keywords: "ステータス 段階 未読" },
  { id: "reset", page: "data", label: "リセット", desc: "前回の位置、画面の配置、表示の設定を初期に戻します。", keywords: "初期化 元に戻す 消す リセット 位置 配置" },
  { id: "mcp", page: "mcp", label: "AI エージェント（MCP）", desc: "Claude Desktop や Claude Code から PaperLens を操作します。", keywords: "MCP Claude Code Desktop エージェント 連携" },
  { id: "obsidian", page: "obsidian", label: "Obsidian で開く", desc: "保存先フォルダを Obsidian の保管庫として開く手順です。", keywords: "Obsidian 保管庫 vault Markdown" },
  { id: "shortcuts", page: "shortcuts", label: "ショートカットの一覧", desc: "キーボード操作の一覧です。", keywords: "キー キーボード 操作" },
  { id: "about", page: "about", label: "バージョンと動作モード", desc: "バージョン、保存先、動作モード、不具合報告用の情報です。", keywords: "バージョン 不具合 報告 情報 version" },
];

/**
 * 項目名・説明・検索用の語・ページ名で絞り込む（searchText.ts の決まり: 全角半角・空白の違いを無視し、言い換えも探す）。
 * 空白で区切った語はすべて当たるものだけ。項目名に当たるものを先に並べる
 */
export function searchSettings(query: string, items: SettingItemInfo[] = SETTING_ITEMS): SettingItemInfo[] {
  if (!normalizeQuery(query)) return [];
  const pageLabel = new Map(SETTINGS_PAGES.map((p) => [p.id, p.label]));
  const scored = items.flatMap((it) => {
    const hay = `${it.label} ${it.desc} ${pageLabel.get(it.page) ?? ""}`;
    if (!matchesQuery(hay, query, (it.keywords ?? "").split(/\s+/))) return [];
    return [{ it, score: matchesQuery(it.label, query) ? 1 : 0 }];
  });
  return scored.sort((a, b) => b.score - a.score).map((s) => s.it);
}

export const OPEN_SETTINGS_EVENT = "paperlens:settings";

/** 設定を指定のページで開く（ヘルプなど、App の外から呼ぶ） */
export function openSettings(page?: SettingsPageId, item?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { page, item } }));
}
