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
開いているブラウザへ流れる。本体が落ちているときは、その旨と `npm start` の案内をエラーで返す。

最初の 1 本はブラウザから入れる。MCP には取り込みツールを置いていない
（ローカルの任意パスを読むツールを MCP の面に出さない、という判断）。

## ツール

| ツール | 用途 |
| --- | --- |
| `list_documents` | 取り込み済みの論文と進捗、GROBID の生死。まずこれで `document_id` を決める |
| `get_document_outline` | タイトル・節構成・ページ数・解析方式・用語集・進捗 |
| `get_sentences` | 文を範囲・節・ページで取得（原文 + 既存訳 + メモ）。`from` は**通し番号 (order)** |
| `get_translation_batch` | 翻訳作業の入口。連続した本文と、そのうちの未訳リストを返す |
| `set_translations` | 訳をまとめて書き込む（最大 100 文）。結果は JSON |
| `add_note` | 文にメモを付ける。存在しない hash は拒否される |
| `search_document` | 原文・訳文・メモを横断検索。ヒットに訳文とメモが入る |
| `update_glossary` | 用語集を更新。既定は追記、`mode: "replace"` で全置換 |
| `skip_sentences` | 「この文は訳す対象ではない」と記録する。未訳の集計から外れる |
| `fix_sentence_boundary` | 文の区切りを直す（結合・分割・取り消し）。再解析しても保たれる |
| `reparse_document` | 同じ PDF を解析し直す。訳とメモはハッシュで再結合される |

### 文の指定は必ず `sentenceHash`

順番でも ID でもなくハッシュで指すので、再解析をまたいでも Claude が指した文がずれない。

### 文脈は「範囲」で渡す

`get_translation_batch` は連続した文を `window: [[order, 原文, 訳?], …]` の形で返し、
そのうち未訳のものを `untranslated: [[order, hash], …]` で別に列挙する。

文ごとに前後 2 文を複製して返していた頃は、同じ文字列が最大 5 回 JSON に載り、
264 文の論文を訳し切るのに Claude が読むバイトは 210KB（約 6 万トークン）、
そのうち原文はわずか 12% だった。範囲で渡せば情報量は同じまま 1/4 以下になる。

### 終了条件は `nextUntranslatedFrom`

`get_translation_batch` は 2 つの「次」を返す。

- `nextFrom` … 窓の直後の位置。飛ばし読みに使う
- `nextUntranslatedFrom` … **次に訳す必要がある**文の位置。null なら翻訳は終わり

終了判定に使うのは後者。`nextFrom` を終了条件にしていた頃は、訳し終わった後も
15 回・52KB ぶん空振りし、90% 訳済みの文書を再開すると 12/15 回が空の窓だった。

### 訳さない判断は記録する

参考文献の断片・ページ番号・数式だけの行は訳す対象ではない。これを `skip_sentences`
に渡すと未訳の集計から外れる。**飛ばすだけでは記録が残らず**、次の取得でまた返ってきて
`remainingUntranslated` が永久に 0 にならない（「分からないところを埋めるな」という
プロンプトの指示と手順が矛盾する）。UI 側にも「訳さない」として表示され、取り消せる。

### 同じ本文が複数回あるとき

訳は**文の正規化ハッシュ**に付く。同じ本文が Introduction と Results に出てくる文書では、
1 件の訳が両方に反映される。再解析で訳が外れないための設計だが、進捗の数え方に影響する:

- `get_document_outline` は `sentences`（延べ）と `uniqueSentences`（異なり文）を別に返す
- `set_translations` は `applied`（書き込んだ異なり文）と `sentencesAffected`（反映された延べ数）を返す
- 同じ hash を 1 回の呼び出しに複数入れると、後勝ちで 1 件として扱い `duplicates` に載せる

### 検索は総数と続きを返す

`search_document` は `{total, truncated, nextFrom, hits}` を返し、`limit` / `from` で
続きを取れる。ヒットには `order` / `translation` / `notes` が入っているので、
訳語の揺れは `search_document` → `set_translations` の 2 手で直せる。

### 書き込みの結果は機械可読

`set_translations` は `{applied, skipped: [{sentenceHash, reason, code}]}` を返す。
`code` は次のいずれかで、必要な対応が正反対なので分けてある。

- `revised_by_human` … 人手修正済み。**対応不要**（上書きしないのが仕様）
- `unknown_hash` … この文書に無い hash。取り直すべき
- `other` … その他

打ち切りはしない（1 回 100 件上限なので全件返しても小さい）。

### 解析方式による制約はその場で伝える

GROBID 未接続で取り込んだ文書は節が取れない。`get_document_outline` と
`get_sentences` は、そのとき `caveat` に理由と対処（`reparse_document`）を入れて返す。

## プロンプト

`translate_paper`（引数: `document_id`、任意で `field`）に手順と訳し方の方針が入っている。

- 1 文は 1 文として訳す（画面上で原文と 1 対 1 に並ぶため、2 文に割らない）
- 専門用語は用語集に従う。無ければ `update_glossary` に足してから続ける（既定は追記）
- 数式・記号・変数名・引用番号は原文のまま残す
- 原文が曖昧な箇所は片方を選んで訳し切り、`add_note` に理由を残す
- 分からない箇所を、それらしい日本語で埋めない
- 訳す対象でない断片は訳さずに飛ばす

## 動作確認

```bash
npm run test:e2e
```

MCP を stdio で起動し、`initialize` → `tools/list`（`TOOL_NAMES` と一致するか）→
`prompts/list` → `tools/call` まで通ることと、`get_translation_batch` の応答に
文脈の重複が無いことを確認する。

## 翻訳の終わりをどう判定するか

**`remainingUnique` が 0 になったときだけが終わり。**

`get_translation_batch` が返す `nextUntranslatedFrom` は「次に見るべき位置」であって、
終了条件ではない。末尾まで行くと先頭に回り込むので、途中で保留した文があれば
必ずもう一度回ってくる。

以前はこれを前方にしか探しておらず、「手前に未訳が残っているのに null（＝完了）」を
返していた。指示どおりに動く呼び出し側ほど、穴の空いた論文を訳し終えたと信じて終わる。

数え方が 2 つあることにも注意がいる。

| 値 | 意味 |
| --- | --- |
| `remainingUnique` | 未訳の**異なり文**の数。訳はこの単位で付くので、作業量はこちら |
| `remainingUntranslated` | 未訳の**延べ**数。同じ本文が 15 回出ればその 15 回を数える |

同じ本文の文は `untranslated` に 1 回しか出ない（残りは `duplicateOf` に載る）。
同じ訳を 2 回作らないためで、1 回書けば全出現に反映される。
