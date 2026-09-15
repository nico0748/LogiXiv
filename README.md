# LogiXiv

論文 PDF を **1 文単位**で読むための、ローカルファーストな対訳リーダー。

- 中央に原文 PDF、右サイドバーに 1 文ごとの日本語訳、その下にメモ
- サイドバーの文と PDF 上のマーカーが双方向に連動する
- 翻訳は **Claude を MCP 経由**で使う（翻訳 API キー不要・追加費用なし）
- PDF ごと畳み込んだ**単一 HTML** に書き出せる。他人の書き出しを取り込むこともできる
- PDF は端末から出ない。サーバーは既定で `127.0.0.1` にしか bind しない

## なぜ「OSS のローカル実行 Web アプリ」なのか

「Web アプリか OSS か」は二択ではない。OSS はライセンス、Web アプリは提供形態の話で、
LogiXiv は **OSS の、ローカル実行 Web アプリ**を採っている。

| 形態 | 判定 | 理由 |
| --- | --- | --- |
| SaaS（クローズド） | ✗ | 未公開論文を他人のサーバーに置く設計は研究室・企業で通らない |
| OSS + ホスト型 Web | ✗ | 結局 PDF がサーバーに上がる。運用コストを誰かが負う |
| **OSS + ローカル実行 Web** | **✓** | PDF が端末外に出ない / pdf.js が使える / 配布は git clone |
| OSS + デスクトップアプリ | △ | 将来 Tauri 化は可能。今は Electron の重さに見合わない |

決め手は 3 つ。

1. 扱う対象が未公開原稿なので、既定で `127.0.0.1` にのみ bind し、本文が外部へ出る経路をコードから消した
2. PDF 描画は pdf.js が圧倒的に強く、ネイティブで作り直す理由がない
3. 訳語の選び方・文の切り方は分野で好みが割れる。fork できること自体が実用価値になる

副作用として、翻訳を **Claude の MCP 経由**にできた。SaaS ならサーバー側で翻訳 API を叩き、
費用を誰かが負担し、本文が第三者の翻訳エンジンを通る。ローカル実行ならその全部が消える。

## 動かす

必要なのは **Node 22.6 以上**（`--experimental-strip-types` を使うため。`.nvmrc` あり）。

```bash
git clone https://github.com/nico0748/LogiXiv.git
cd LogiXiv
npm install
npm run build
npm start          # http://127.0.0.1:4173
```

開発中は UI だけ Vite の開発サーバーで動かす。

```bash
npm start          # 別ターミナルで本体
npm run dev        # http://localhost:5173（/api は本体へプロキシ）
```

### GROBID（強く推奨）

文の区切りと PDF 座標は GROBID から取る。無くても動くが精度は明確に落ちる。

```bash
docker compose -f docker/grobid.yml up -d      # http://localhost:8070
```

使うのは軽量な CRF 版（`grobid/grobid:0.9.1-crf`）。文の分割と座標付けはこれで実用になる。
精度が要るなら `-full`（Deep Learning 入り、GPU 推奨）に差し替えられる。

`LOGIXIV_GROBID_URL` で別のホストを指せる。GROBID に届かないときは pdf.js による
簡易解析に自動で切り替わり、その旨が UI のバッジと `parserNote` に出る。

### Claude から使う（MCP）

`claude_desktop_config.json`（または Claude Code の MCP 設定）に追加する。

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

本体（`npm start`）を起動したうえで、Claude に「LogiXiv の論文を訳して」と頼めばよい。
`translate_paper` プロンプトに手順がまとめてある。

## 技術的な中核 — なぜ「1 文ごと」が成立するか

GROBID に `segmentSentences=1` と `teiCoordinates=s` を付けて投げると、
**文単位で PDF 座標が付いた TEI** が返る。

```xml
<s coords="1,53.80,194.57,238.71,9.29;1,53.80,205.00,238.71,9.29">
  We study sparse attention under long contexts.
</s>
```

`page, x, y, w, h`（PDF ユーザー空間・左上原点）。行またぎの文には矩形が複数付く。
この座標に pdf.js の描画結果を重ねると、文とマーカーが 1 対 1 で対応する。
**ここだけは自前のテキスト抽出で代替できない**（2 段組・ハイフネーション・数式・脚注で必ず壊れる）。

## 構成

```
packages/core     型・TEIパーサ・文分割・検証・エクスポート/インポート・マージ・移行（唯一の真実、外部依存ゼロ）
packages/server   ローカル API（GROBIDプロキシ、ファイルストア、SSE、解析ワーカー）
packages/mcp      Claude 用 MCP サーバー（stdio、ツール11個＋プロンプト1個）
apps/web          Vite + React の本体 UI
apps/viewer       書き出しHTMLに埋め込む単一ファイルビューア（pdf.js 同梱）
```

データは `~/.logixiv/documents/<id>/` に `document.json` と `source.pdf` を置くだけ。DB は無い。
「アプリを捨ててもデータが読める」ことを優先している。書き込みは一時ファイル → rename。

## 主要な設計判断

- **構造データと注釈を分離した。** 再解析で訳が消えないよう、原文の正規化ハッシュで再結合する
- **正規化で文字間のハイフンを落とす。** GROBID の `block-sparse` と、行末で割れた `block-` + `sparse` を
  同じハッシュにするため。これが無いと「GROBID を後から入れて再解析」で訳が外れる
- **メモは衝突しても消さない。** 訳は「正解が 1 つ」だがメモは「多いほど良い」。マージ規則を非対称にした
- **人手修正フラグ。** `revisedByHuman` が立った訳を機械が上書きしない
- **エクスポート HTML に静的フォールバック。** JS が壊れても対訳とメモが素の HTML として読める
- **取り込む JSON は全部検証する。** 埋め込み JS を実行しないのは当然として、
  型が合わない値をストアに書かせない（1 回の取り込みで一覧 API を恒久的に壊せてしまう）
- **PDF 解析はワーカースレッド。** pdf.js は Node では同一スレッドで動くので、
  大きな PDF 1 本でサーバー全体が数十秒止まっていた
- **フォールバックでもレイアウトを読む。** 段組を検出してから行を組むので、
  2 段組で左右が混ざらない。柱・ノンブル・図表キャプション・数式・参考文献は本文から外し、
  節見出しも拾う（`npm run measure` で 2 段組の再現率 100% / 混入 0 を確認している）
- **「訳さない」を記録できる。** 参考文献の断片のように訳す対象でないものを
  飛ばすだけだと、翻訳の手順が永久に終わらない
- **`consolidateHeader=0`。** GROBID の既定値 1 は CrossRef へ問い合わせに行く。未公開原稿のタイトルを外部に出さない

詳しくは [docs/architecture.md](docs/architecture.md) と [docs/mcp.md](docs/mcp.md)。

## テスト

```bash
npm run typecheck   # 全パッケージ（apps/ 含む）の型チェック
npm test            # core 113 本 + server 35 本のユニット/API テスト
npm run test:e2e    # 取り込み→翻訳→SSE→書き出し→取り込み→MCP 起動の通し確認
npm run measure     # 論文風 PDF を生成して、解析の再現率と混入率を実測
```

`npm run measure` は「正解が分かっている論文風 PDF」（2 段組・柱・ノンブル・図表
キャプション・数式・参考文献つき）を生成して解析にかけ、本文の再現率と
本文以外の混入数を出す。再現率 90% 未満か混入 2 件以上で失敗する。

`test:e2e` は GROBID が居ない前提で走り、フォールバック経路を通す。
GROBID を上げた状態で確認したいときは `LOGIXIV_GROBID_URL` を指定する。

## 既知の制約

- スキャン PDF（画像のみ）は扱えない。先に OCR を通す必要がある
- 書き出し HTML は大きい（PDF + ビューア約 1.8MB）。PDF 60MB 超は書き出せない
- 回転ページや特殊な CropBox で座標がずれ得る
- フォールバック経路のマーカーは**行単位**。1 行に 2 文あると両方が同じ範囲で光る
  （GROBID 経路は文単位の座標なのでこの制約は無い）
- 柱が本文ブロックに密着している組み方では、柱が 1 文として残ることがある
  （本文の 1 行目を消すよりは害が小さい、という寄せ方）
- 1 ページだけの文書では柱を落とせない（同じ行が複数ページに出るかで判定するため）
- フォールバック解析は 400 ページで打ち切る（それ以上は GROBID を使う）
- 正規化の副作用として `re-cover` と `recover` は同じハッシュになる

## 翻訳の始め方

本体を起動して PDF を入れたら、リーダー画面の **「訳す」** を押す。
Claude 側の MCP 設定（絶対パス入り）と、Claude に言う一文がそのまま出るので、
順に貼るだけでよい。設定は一度だけ。詳細は `docs/mcp.md`。

翻訳 API のキーは要らず、追加費用も発生しない。

## これから

1. 図表の切り出しとサイドバー表示
2. 複数論文をまたいだ横断検索
3. Zotero / Obsidian への書き出し

## ライセンス

MIT
