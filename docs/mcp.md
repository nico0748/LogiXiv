# MCP インターフェース

LogiXiv の翻訳は Claude が MCP 経由で行う。翻訳 API のキーは要らず、追加費用も発生しない。

## 設定

本体を起動しておく。

```bash
npm start          # http://127.0.0.1:4173
```

Claude 側の MCP 設定に追加する。

```json
{
  "mcpServers": {
    "logixiv": {
      "command": "node",
      "args": ["/path/to/LogiXiv/packages/mcp/dist/index.js"],
      "env": { "LOGIXIV_URL": "http://127.0.0.1:4173" }
    }
  }
}
```

MCP サーバーはファイルを直接触らず、本体へ HTTP で話しかける。書き手を 1 プロセスに
絞ることで排他制御が 1 箇所で済み、Claude の書き込みがそのまま SSE で
開いているブラウザへ流れる。本体が落ちているときは、その旨と起動方法をエラーで返す。

## ツール

| ツール | 用途 |
| --- | --- |
| `list_documents` | 取り込み済みの論文と進捗。まずこれで `document_id` を決める |
| `get_document_outline` | タイトル・節構成・ページ数・解析方式・用語集・進捗 |
| `get_sentences` | 文を範囲・節・ページで取得（原文 + 既存訳 + メモ） |
| `get_untranslated_sentences` | 未訳の文を前後の文脈込みで取得。翻訳の起点 |
| `set_translations` | 訳をまとめて書き込む（最大 100 文） |
| `add_note` | 文にメモを付ける |
| `search_document` | 原文・訳文・メモを横断検索。訳語の揺れ探し |
| `set_glossary` | 訳語の対応表を更新 |
| `reparse_document` | 同じ PDF を解析し直す。訳とメモはハッシュで再結合される |

### 文の指定は必ず `sentenceHash`

順番でも ID でもなくハッシュで指すので、再解析をまたいでも Claude が指した文がずれない。

### 一括で渡し、一括で受け取る

`get_untranslated_sentences` は `context_before` / `context_after` を付けて返し、
`set_translations` は最大 100 文をまとめて受け取る。1 文ずつ往復させると
前後関係を見ずに訳すことになり、代名詞と時制がすぐ壊れる。

### 人手修正済みは上書きされない

`revisedByHuman` が立った訳に `set_translations` を当てても書き込まれず、
`skipped` に理由付きで返る。これは失敗ではなく設計どおりの挙動。

## プロンプト

`translate_paper`（引数: `document_id`、任意で `field`）に手順と訳し方の方針が入っている。

- 1 文は 1 文として訳す（画面上で原文と 1 対 1 に並ぶため、2 文に割らない）
- 専門用語は用語集に従う。無ければ `set_glossary` に足してから続ける
- 数式・記号・変数名・引用番号は原文のまま残す
- 原文が曖昧な箇所は片方を選んで訳し切り、`add_note` に理由を残す
- 分からない箇所を、それらしい日本語で埋めない

## 動作確認

```bash
npm run test:e2e
```

MCP を stdio で起動し、`initialize` → `tools/list`（9 個）→ `prompts/list`（1 個）→
`tools/call` まで通ることを確認する。
