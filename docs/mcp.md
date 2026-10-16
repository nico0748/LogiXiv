# MCP インターフェース

PaperLens の全文翻訳は Claude が MCP 経由で行う。翻訳 API のキーは要らず、追加費用も発生しない。
MCP サーバーは `apps/reader/mcp`（stdio）。読解ノートの操作（記録欄・マーカー・用語・数式）と、
旧 LogiXiv から移した 1 文ずつの対訳の操作を、同じサーバーで公開している。

## 設定

**いちばん簡単なのは、設定画面の「AI エージェント（MCP）」。** この端末の絶対パスが入った
Claude Desktop の設定（JSON）と Claude Code のコマンドが出るので、「コピーする」で貼ればよい。
以下は同じ内容を手で書く場合の説明。`<apps/reader>` は実際のパスに置き換える。

貼り先は OS で違う。

| OS | 場所 |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "paperlens": {
      "command": "node",
      "args": ["<apps/reader>/dist-server/mcp.js"],
      "env": { "PAPERLENS_CONFIG": "<apps/reader>/paperlens.config.json" }
    }
  }
}
```

Claude Code なら 1 行で済む。

```bash
claude mcp add paperlens -e PAPERLENS_CONFIG=<apps/reader>/paperlens.config.json -- node <apps/reader>/dist-server/mcp.js
```

`dist-server/mcp.js` は `apps/reader` の `npm run build` で作られる。ビルド前は
`node --experimental-strip-types <apps/reader>/mcp/main.ts` でも動く。

**MCP サーバーは保管庫のファイルを直接読み書きする。** アプリを起動していなくても使える。
保管庫の場所はアプリと同じ決め方（`PAPERLENS_DATA` → `PAPERLENS_CONFIG` の設定ファイル → 初期値）で、
登録方法には保管庫そのものではなく設定ファイルの場所を入れる。画面で保管庫を変えると、
Claude も同じフォルダに付いてくる。アプリを開いていれば、Claude の書き込みはファイルの見張りを
通じて画面にすぐ反映される。

`PAPERLENS_MCP_READONLY=1` を付けると、読み取りのツールだけを公開する。

### 旧 LogiXiv Web 版の MCP について

旧 Web 版（`apps/web`）には別の MCP サーバー（`packages/mcp`）がある。こちらはファイルを
直接触らず、本体（`npm start`、`http://127.0.0.1:4173`）へ HTTP で話しかける。書き手を
1 プロセスに絞って排他を 1 箇所で済ませ、Claude の書き込みをそのまま SSE で流すための形だった。
接続先は `PAPERLENS_SERVER_URL`（旧名 `LOGIXIV_URL` も可）。この版には取り込みツールが無い
（ローカルの任意パスを読むツールを MCP の面に出さない、という判断）。PaperLens 本体はこの判断を
変え、`import_paper` で端末の PDF の絶対パスか URL から取り込めるようにした（中身が `%PDF` で
始まらないファイルは断る）。読み取りだけに絞りたいときは `PAPERLENS_MCP_READONLY=1` を使う。

以下は PaperLens 本体（`apps/reader/mcp`）の説明。設計の理由は旧 Web 版と共通で、
違うのは主にツール名と引数名（下の対応表）。

## ツール

### 対訳（1 文ずつの全文翻訳）

| ツール | 用途 |
| --- | --- |
| `get_sentence_outline` | タイトル・節構成・ページ数・解析方式（`caveat` / `quality`）・用語集・進捗・再開位置（`firstUntranslatedOrder`） |
| `get_sentences` | 文を範囲・節・ページで取得（原文 + 既存訳 + メモ）。`from` は**通し番号 (order)** |
| `get_translation_batch` | 翻訳作業の入口。連続した本文と、そのうちの未訳リストを返す |
| `search_sentences` | 原文・訳文・メモを横断検索。ヒットに訳文とメモが入る |
| `parse_sentences` | PDF を文に分ける・分け直す（`parser`: `auto` / `grobid` / `fallback`）。訳とメモはハッシュで再結合される |
| `set_translations` | 訳をまとめて書き込む（1 回 最大 120 文）。結果は JSON |
| `add_sentence_note` | 文にメモを付ける。存在しない hash は拒否される |
| `update_glossary` | 訳語の対応表（用語集）を更新。既定は追記、`mode: "replace"` で全置換 |
| `skip_sentences` | 「この文は訳す対象ではない」と記録する。未訳の集計から外れる。`undo: true` で取り消し |
| `fix_sentence_boundary` | 文の区切りを直す（結合・分割・**取り除き**・取り消し）。再解析しても保たれる |

論文の指定はすべて `paper`（`papers/` の下のフォルダ名。`list_papers` が返す `id`）。
`list_papers` は対訳の進み具合も添えて返す。

`parse_sentences` は最大 50 秒だけ解析の終わりを待ち、それを過ぎたら `status: "parsing"` を返す
（長い論文の GROBID で MCP の呼び出しが時間切れにならないように）。そのときは
しばらく待って `get_sentence_outline` を呼び直す。取り込んだ直後は自動で解析が始まるので、
たいていは呼ばなくてよい。

### 読解ノート

| ツール | 用途 |
| --- | --- |
| `get_settings` | 保管庫、フォルダ構成、読解の段階、テンプレートの記録欄 |
| `list_papers` / `get_paper` / `get_note` | 論文の一覧、論文 1 本の記録（記録欄・マーカー・用語・数式）、ノートの本文 |
| `read_paper_text` / `find_in_paper` | PDF の本文をページごとに読む、本文の中を探す |
| `search_notes` / `get_graph` | すべてのノートの横断検索、論文と用語のつながり |
| `import_paper` | 端末の PDF や URL（arXiv など）から取り込む。取り込み後に文への解析を自動で始める |
| `set_fields` / `set_status` / `set_meta` | 記録欄、読解の段階、書誌情報を書く |
| `add_highlight` / `update_highlight` | 本文の文にマーカーと訳を付ける。PDF の該当位置にも色が付く |
| `add_term` / `update_term` / `add_equation` / `update_equation` | 用語と数式を登録する |
| `remove_annotation` | マーカー・用語・数式を消す |
| `get_template` / `set_template` / `reset_template` | テンプレートを読む、書き換える、初期状態に戻す |
| `set_data_root` | 保管庫を変える |
| `get_slide_markups` | 発表スライド（`slides.pdf`）で囲んだグループの一覧。名前（Markup-03.02）、四角の中の文字、論文へのリンク |
| `link_slide_markup` / `unlink_slide_markup` / `set_slide_markup_memo` | グループを論文の文章（`text` で探す）・図・数式（`page` と `rect`）につなぐ、外す、メモを書く |

読解ノートは `paperlens://papers/<論文ID>/note.md` の資料（resource）としても読める。

`update_glossary`（対訳の訳語の統一）と `add_term`（ノートに用語の説明を残す。Obsidian で
リンクされる）は別物。前者は `sentences.json` に、後者は `paperlens.json` と `note.md` に入る。
画面の「リスト」の単語帳には、両方が論文をまたいで集まる。

### 旧 Web 版のツール名との対応

| 旧 LogiXiv（`packages/mcp`） | PaperLens（`apps/reader/mcp`） |
| --- | --- |
| `list_documents` | `list_papers` |
| `get_document_outline` | `get_sentence_outline` |
| `search_document` | `search_sentences` |
| `add_note` | `add_sentence_note` |
| `reparse_document` | `parse_sentences` |
| `get_sentences` / `get_translation_batch` / `set_translations` / `update_glossary` / `skip_sentences` / `fix_sentence_boundary` | 同名 |
| 引数 `document_id` | 引数 `paper` |

### 割り込んだ断片は `drop` で取り除く

簡易解析では、図の枠内文字や表の行が**本文 1 文の真ん中に割り込む**ことがある。

```
The expert count is E = 64 and (schematic of the two-branch layer) Model Active
In-domain Shifted Dense 1.3B 100% 61.2 54.8 GRR (ours) 18% 59.7 51.6 k = 2 unless
stated otherwise, and the residual fraction is ρ = 0.25.
```

`merge` と `split` だけだとここで行き止まりになる（3 つに割って真ん中を
`skip_sentences` に回しても、文の列からは消えないので前後を `merge` できない）。
`drop` を使う。

1. `split` で 3 つに割る
2. 割り込みを `drop`（`sentence_hashes` は 1 件だけ）
3. 残った前後を `merge`

取り除いた断片は**消えない**。`structure.nonBody` に移って画面には
「訳しません」として元の位置に出る。`undo` で本文の元の位置へ戻せる。
再解析をまたいでも保たれる（当たらなくなったら `detached` の印が付く）。

### 文の指定は必ず `sentenceHash`

順番でも ID でもなくハッシュで指すので、再解析をまたいでも Claude が指した文がずれない。

### 文脈は「範囲」で渡す

`get_translation_batch` は連続した文を `window: [[order, hash, 原文], …]` の形で返し、
そのうち未訳のものを `untranslated: [order, …]` で別に列挙する。
既に訳のある文は `[order, hash, 原文, 1]` になる（訳文そのものは返さない）。

文ごとに前後 2 文を複製して返していた頃は、同じ文字列が最大 5 回 JSON に載り、
264 文の論文を訳し切るのに Claude が読むバイトは 210KB（約 6 万トークン）、
そのうち原文はわずか 12% だった。範囲で渡せば情報量は同じまま 1/4 以下になる。

### 終了条件は `remainingUnique === 0`

`get_translation_batch` は 2 つの「次」を返す。どちらも**終了条件ではない**。

- `nextFrom` … 窓の直後の位置。飛ばし読みに使う
- `nextUntranslatedFrom` … **次に見るべき**位置。末尾まで行くと先頭へ回り込む

終了は `remainingUnique === 0` で判定する。`set_translations` も同じ値を返すので、
最後の 1 文を書いたあとに確認のためだけの往復は要らない。

`nextFrom` を終了条件にしていた頃は、訳し終わった後も 15 回・52KB ぶん空振りした。
その後 `nextUntranslatedFrom` を前方にしか探していなかった頃は、途中で 1 文でも
保留すると「まだ残っているのに null（＝完了）」を返し、指示どおりに動く呼び出し側ほど
穴の空いた論文を訳し終えたと信じて終わった。

### 訳さない判断は記録する

参考文献の断片・ページ番号・数式だけの行は訳す対象ではない。これを `skip_sentences`
に渡すと未訳の集計から外れる。**飛ばすだけでは記録が残らず**、次の取得でまた返ってきて
`remainingUntranslated` が永久に 0 にならない（「分からないところを埋めるな」という
プロンプトの指示と手順が矛盾する）。UI 側にも「訳さない」として表示され、取り消せる。

既に訳が付いている文は対象外にできない（記録しても未訳の集計は減らないので、
返事だけが嘘になる）。`alreadyTranslated` に載って返ってくる。その文を片付けたいときは、
画面でその文の「**訳を消して外す**」を押す。訳を消す操作は画面側にしかない
（MCP から他人の訳を消せる口は開けていない）。

### 同じ本文が複数回あるとき

訳は**文の正規化ハッシュ**に付く。同じ本文が Introduction と Results に出てくる文書では、
1 件の訳が両方に反映される。再解析で訳が外れないための設計だが、進捗の数え方に影響する:

- `get_sentence_outline` は `sentences`（延べ）と `uniqueSentences`（異なり文）を別に返す
- `set_translations` は `applied`（書き込んだ異なり文）と `sentencesAffected`（反映された延べ数）を返す
- 同じ hash を 1 回の呼び出しに複数入れると、後勝ちで 1 件として扱い、`hint` にその件数が出る

### 検索は総数と続きを返す

`search_sentences` は `{total, nextFrom, hits}` を返し、`limit` / `from` で
続きを取れる。ヒットには `order` / `hash` / `translation` / `notes` が入っているので、
訳語の揺れは `search_sentences` → `set_translations` の 2 手で直せる。
参考文献・図表キャプションなど本文として扱わなかった行も `isBody: false` で返る（訳の対象ではない）。

### 書き込みの結果は機械可読

`set_translations` は `{applied, overwritten, sentencesAffected, remainingUnique, nextUntranslatedFrom, skipped: [{sentenceHash, code, reason}]}` を返す。
`code` は次のいずれかで、必要な対応が正反対なので分けてある。

- `revised_by_human` … 人手修正済み。**対応不要**（上書きしないのが仕様）
- `unknown_hash` … この論文に無い hash。取り直すべき（読んでから書くまでの間に再解析が挟まった場合もこれになる）

打ち切りはしない（1 回 120 件上限なので全件返しても小さい）。

### 項目名はツールごとに違う

同じ「訳語」でも、`set_translations` では `text`、`update_glossary` では `translation` になる。
手順だけを読んで `translation` と書いた呼び出しが実際に 1 回失敗しているので、表にしておく。

| ツール | 1 件の形 |
| --- | --- |
| `set_translations` | `{ "sentenceHash": "…", "text": "日本語訳" }` |
| `update_glossary` | `{ "term": "原語", "translation": "訳語", "note": "なぜその訳か（任意）" }` |
| `add_sentence_note` | `{ "paper": "…", "sentence_hash": "…", "body": "メモ本文" }` |
| `skip_sentences` | `{ "paper": "…", "sentence_hashes": ["…"], "reason": "…" }` |
| `fix_sentence_boundary` | `{ "paper": "…", "action": "merge"｜"split"｜"drop"｜"undo", "sentence_hashes": ["…"], "offsets": [12] }` |

`skip_sentences` の `reason` は自由文字列ではなく、次のどれか:
`reference` / `figure` / `table` / `equation` / `header` / `footer` / `unreadable` / `other`。
**`unreadable` は「解析が崩れていて文として読めない」**で、簡易解析ではいちばん多い理由になる。
他と分けてあるのは、再解析で直ったときにそれだけを拾い直せるようにするため。

間違えたときのエラーも直し方を返す。`set_translations` に `translation` と書くと
「訳の項目名は text です（translation ではありません）」と、正しい形の例が返る。

### 解析方式による制約はその場で伝える

簡易解析で分けた論文は、`get_sentence_outline` と `get_translation_batch`（最初の呼び出し）が
`caveat` に理由と対処（GROBID を起動して `parse_sentences` を `parser="grobid"` で）を入れて返す。節が取れなかったときだけ
「節は取れていません」が付く（簡易解析でも節はたいてい取れるので、
取れているものを取れないと言わない）。

**本文の欠落が疑われるときは、それをいちばん先に言う。** 数式を含む行を本文から
外す判定が効きすぎると段落が丸ごと落ち、残骸が文法の通る英文に癒着する。
**欠けた文はそもそも `get_sentences` にも `get_translation_batch` にも出てこない**ので、
呼び出し側は「全部訳した」と判断してしまう。この疑いが出ているときは PDF と
突き合わせること。

**読み順が崩れている疑いが検出されているときも、それを先に言う。** 2 段組の左右が
語単位で噛み合うと、訳が正しくても原文そのものが壊れている。この状態は
`fix_sentence_boundary` では戻せない（結合と分割では噛み合った語をほどけない）ので、
訳す前に原文を確かめ、GROBID を立てて `parse_sentences` するのが唯一の道になる。

## プロンプト

`translate_paper`（引数: `paper`、任意で `field`）に手順と訳し方の方針が入っている。

- 1 文は 1 文として訳す（画面上で原文と 1 対 1 に並ぶため、2 文に割らない）
- 専門用語は用語集に従う。無ければ `update_glossary` に足してから続ける（既定は追記）
- 数式・記号・変数名・引用番号は原文のまま残す
- 原文が曖昧な箇所は片方を選んで訳し切り、`add_sentence_note` に理由を残す
- 分からない箇所を、それらしい日本語で埋めない
- 訳す対象でない断片は `skip_sentences` に渡す（飛ばすだけでは残り続ける）
- 人が直した訳（`revisedByHuman`）は上書きされない

ほかに、テンプレートの段階に沿って読解ノートを埋める `read_paper`（引数: `paper`、任意で `focus`）と、
読んだ論文を横断してふり返る `review_notes`（任意で `topic`）がある。

## 動作確認

```bash
cd apps/reader
npm test
```

`server/mcp-sentences.test.ts` が、MCP のクライアントから対訳のツールを呼び、概要・窓の取得
（同じ本文は 1 回だけ）・訳の書き込み（人手修正済みと未知の hash を機械可読に断る）・
訳さない記録・終了判定・区切りの直しと取り消し・読み取り専用の公開範囲を確かめる。旧 Web 版の MCP は、リポジトリの最上位の
`npm run test:e2e` が stdio で起動し、`initialize` → `tools/list` → `prompts/list` →
`tools/call` まで通ることと、`get_translation_batch` の応答に文脈の重複が無いことを確かめる。

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

窓の行は `[order, hash, 原文]`、既に訳のある文は `[order, hash, 原文, 1]` になる。
**自分が書いた訳文は返さない。** 返していた頃は受信の 4 割強が日本語の読み返しで、
文脈として要るのは原文の並びだけだった。訳語の統一は用語集が担う。
どうしても要るときは `include_translations: true` を渡す。

`set_translations` は書き込みの結果と一緒に `remainingUnique` を返す。
最後の 1 文を書いたあと、終わったかどうかを確かめるためだけに
`get_translation_batch` をもう一度呼ぶ必要はない。

同じ位置を残件も変わらないまま取り直すと `noProgress: true` が付く。
保留を続けても先へは進まないので、訳すか `skip_sentences` に渡すこと。
