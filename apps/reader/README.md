# PaperLens

論文を読みながら、訳・用語・数式・読解メモを Markdown のノートに残すアプリです。

- 中央に論文の PDF、右側に選んだ文の訳、用語の説明、TeX 形式の数式を表示します。
- 記録はテンプレートから作った読解ノート（note.md）に書き込みます。保存先フォルダは Obsidian の保管庫としてそのまま開けます。
- データはすべて保存先フォルダの普通のファイルです。データベースは使いません。
- MCP サーバーを登録すると、Claude Desktop や Claude Code などの AI エージェントが、画面と同じ操作（取り込み、本文の読み取り、マーカーと訳、用語、数式、記録欄の入力、読解の段階の変更）を行えます。

構成は [SecOwl](https://github.com/nico0748/secowl) と同じです。ローカルサーバー（127.0.0.1 だけで待ち受け）が保存先フォルダを読み書きし、画面はブラウザかデスクトップ版（Electron）で表示します。MCP サーバーは同じ処理を直接呼ぶため、アプリを起動していなくても使えます。

## 必要なもの

| もの | 用途 | 備考 |
| --- | --- | --- |
| Node.js 22.6 以上 | アプリと MCP サーバーの実行 | `node -v` で確認できます |
| Claude の API キー | 画面からの訳・用語の説明・数式の書き起こし | 任意です。無くても手で入力できます。AI エージェントから使う場合は不要です |

## 実行方法

### 1. 取得と準備

PaperLens は LogiXiv リポジトリの `apps/reader` にあります。依存パッケージはリポジトリの最上位でまとめて入れます。

```bash
git clone https://github.com/nico0748/LogiXiv.git
cd LogiXiv
npm install
cd apps/reader
```

以降のコマンドは `apps/reader` で実行します。

### 2. 起動する

目的に合わせて、次の4つから選んでください。

#### デスクトップ版で動かす（普段使いの場合）

```bash
npm run app
```

ビルドしてから PaperLens のウィンドウを開きます。保存先は、初回は `apps/reader/data` です。設定画面の「別のフォルダを選ぶ」で変えられます。
配布用のアプリ（.dmg など）を作るときは `npm run dist` を実行します。`release/` にできます。配布用のアプリでは、保存先の初期値が「書類」フォルダの `PaperLens` になります。

#### ブラウザで動かす

```bash
npm run build
npm start
```

表示された URL（初期設定では http://127.0.0.1:5175 ）をブラウザで開きます。止めるときは `Ctrl + C` を押します。
ポートは環境変数 `PAPERLENS_PORT` で変えられます。

#### 開発サーバーで動かす（コードを変更しながら使う場合）

```bash
npm run dev
```

http://localhost:5173 を開きます。画面のコードを保存すると自動で反映され、サーバーのコードを保存するとサーバーが再起動します。

#### 1つの HTML ファイルにまとめる（サーバーを立てずに試す場合）

```bash
npm run build:single
```

`dist-single/index.html` ができます。Chrome か Edge で直接開くと、ブラウザで選んだフォルダに保存して動きます。
この形では MCP サーバーと保存先の自動反映は使えません。

### 3. 使い始める

1. 左上の「PDF を追加」で論文を取り込みます。取り込むと、テンプレートから読解ノートを作ります。
2. PDF の文を選択すると、次の操作が出ます。
   - 色の丸: その色のマーカーを引く
   - 訳す: 選んだ文を日本語に訳す
   - 用語を調べる: 選んだ語の説明を作る
   - 数式にする: 選んだ数式を TeX に書き起こす
3. 右側の「記録」タブに読解メモを入力します。入力は note.md に自動で保存されます。
4. 左端の「グラフ」で、論文と用語のつながりを見られます。

Obsidian で保存先フォルダを開いてノートを書き換えても、PaperLens の画面にすぐ反映されます。

### 4. Claude を使う（任意）

左端の「設定」から「API キーとモデルを設定する」を押し、API キーを入力します。

- キーはブラウザにだけ保存し、保存先フォルダには書き込みません。
- Claude に送るのは、選択した範囲の文、その前後の本文、論文の題名です。数式では選択範囲の画像も送ります。PDF 全体は送りません。
- 初期設定のモデルは `claude-opus-5-5` です。

## AI エージェントから使う（MCP）

左端の「設定」の「AI エージェント（MCP）」に、この端末での登録方法が表示されます。「コピーする」を押して貼り付けてください。

### Claude Code

```bash
claude mcp add paperlens -e PAPERLENS_CONFIG=<apps/reader>/paperlens.config.json -- node <apps/reader>/dist-server/mcp.js
```

### Claude Desktop

設定ファイル（macOS は `~/Library/Application Support/Claude/claude_desktop_config.json`）の `mcpServers` に次を加え、Claude Desktop を再起動します。

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

`<apps/reader>` は実際のパスに置き換えてください。設定画面に表示されるものは置き換え済みです。
`dist-server/mcp.js` は `npm run build` で作られます。ビルド前は `node --experimental-strip-types mcp/main.ts` でも動きます。

### できること

| ツール | 内容 |
| --- | --- |
| `get_settings` | 保存先、フォルダ構成、読解の段階、テンプレートの記録欄 |
| `list_papers` / `get_paper` / `get_note` | 論文の一覧、論文1本の記録（記録欄・マーカー・用語・数式）、ノートの本文 |
| `read_paper_text` / `find_in_paper` | PDF の本文をページごとに読む、本文の中を探す |
| `search_notes` / `get_graph` | すべてのノートの横断検索、論文と用語のつながり |
| `import_paper` | 端末の PDF や URL（arXiv など）から取り込む |
| `set_fields` / `set_status` / `set_meta` | 記録欄、読解の段階、書誌情報（著者・年など）を書く |
| `add_highlight` / `update_highlight` | 本文の文にマーカーと訳を付ける。PDF の該当位置にも色が付く |
| `add_term` / `update_term` / `add_equation` / `update_equation` | 用語と数式を登録する |
| `remove_annotation` | マーカー・用語・数式を消す |
| `get_template` / `set_template` / `reset_template` | テンプレートを読む、書き換える、初期状態に戻す |
| `set_data_root` | 保存先を変える |

ほかに、段階を追って論文を読む `read_paper` と、読んだ論文をふり返る `review_notes` のプロンプトがあります。読解ノートは `paperlens://papers/<論文ID>/note.md` の資料としても読めます。

- 環境変数 `PAPERLENS_MCP_READONLY=1` を付けると、読み取りのツールだけを公開します。設定画面の「読み取りだけを許可する」で、その設定を作れます。
- アプリを起動している間は、エージェントの変更が画面にすぐ反映されます。画面とエージェントが同じ論文を同時に編集しても、互いの変更を消しません。

## 保存先

保存先フォルダは次の順に決まります。

1. 環境変数 `PAPERLENS_DATA`
2. 設定ファイルの `dataRoot`（`PAPERLENS_CONFIG`、無ければ `apps/reader/paperlens.config.json`。デスクトップ版はアプリのデータフォルダ）
3. 初期値（`apps/reader/data`）

設定画面で保存先を変えると設定ファイルに書き込みます。MCP サーバーも同じ設定ファイルを読むため、AI エージェントも新しい保存先に付いてきます。

```
<保存先>/
  _templates/reading-note.md    読解ノートのテンプレート
  papers/20261012-attention/
    paper.pdf                   取り込んだ PDF
    note.md                     読解ノート
    paperlens.json              マーカーの位置などの補助データ
```

## テンプレートを変える

保存先の `_templates/reading-note.md` を編集すると、これから取り込む論文のノートに反映されます。
「設定」の「テンプレートを編集する」からも編集できます。
入力欄は次の形で書きます。直前の `##` 見出しが、記録タブでのまとまり（読解の段階）になります。

```markdown
### 一言でいうと
<!-- field: summary | 一言でいうと | 何をして何が分かったかを1〜2文で書く -->
<!-- /field -->
```

アプリと AI エージェントは `<!-- field -->` と `<!-- list -->` で囲んだ範囲だけを書き換えます。範囲の外に書いた内容は変更しません。
詳しい仕様は [docs/design.md](docs/design.md) にあります。

## 開発者向けのコマンド

| コマンド | 内容 |
| --- | --- |
| `npm test` | 単体テスト（テンプレート、注釈の差分、サーバーの API、MCP のツール） |
| `npx tsc --noEmit` | 型を検査する。最上位の `npm run typecheck` にも含まれます |
| `npm run e2e` | ヘッドレス Chromium で操作を確認する。先に `npm run build:single` と `npm run build` を実行してください |
| `npm run sample` | お試し用のサンプル PDF（`src/demo/sample.pdf`）を作り直す |

`npm run e2e` を初めて実行する前に、`npx playwright install chromium` でブラウザを入れてください。

```
server/      ローカルサーバー（API、保存先の見張り、PDF の本文取り出し）
mcp/         MCP サーバー（tools.ts にツールの定義）
electron/    デスクトップ版
src/         画面（React）。src/lib/ の論文フォルダの処理はサーバーと MCP からも使う
```

## うまく動かないとき

| 症状 | 対処 |
| --- | --- |
| ブラウザに「画面がまだビルドされていません」と出る | `npm run build` を実行してから `npm start` を実行してください |
| Claude Desktop にツールが出てこない | 設定ファイルの JSON が正しいか確かめ、Claude Desktop を再起動してください。`node` が見つからない場合は、`command` を `which node` の結果に置き換えてください |
| エージェントが別のフォルダを見ている | 設定画面に表示される登録方法で登録し直してください。保存先を `PAPERLENS_DATA` で固定している場合は、その値がアプリとそろっているか確かめてください |
| 訳を頼むと「API キーが正しくありません」と表示される | 設定画面でキーを入れ直してください |
| PDF の文を選択できない | 画像だけの PDF（スキャンした PDF）は文字情報が無いため選択できません。OCR をかけてから取り込んでください |

## ライセンス

MIT
