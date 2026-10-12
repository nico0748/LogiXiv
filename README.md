# PaperLens

論文を読みながら、訳・用語・数式・読解メモを Markdown のノートに残すアプリです。

- 中央に論文の PDF、右側に選んだ文の訳、用語の説明、TeX 形式の数式を表示します。
- 記録はテンプレートから作った読解ノート（note.md）に書き込みます。Obsidian でもそのまま開けます。
- データはすべて、選んだフォルダの中に普通のファイルとして保存します。

## 使い方

```bash
npm install
npm run dev        # http://localhost:5173 を Chrome か Edge で開く
```

1. 「保管庫にするフォルダを選ぶ」で、ノートを置くフォルダを選びます。Obsidian の保管庫でもかまいません。
2. 「PDF を追加」で論文を取り込みます。テンプレートから `papers/<ID>/note.md` を作ります。
3. PDF の文を選択すると、マーカー・訳す・用語を調べる・数式にする、の操作が出ます。
4. 右側の「記録」タブに入力すると、note.md の対応する箇所に保存されます。

訳と用語の説明を自動で入れるには、「Claude の設定」で API キーを入力してください。キーはブラウザにだけ保存します。

## テンプレート

保管庫の `_templates/reading-note.md` を編集すると、これから取り込む論文のノートに反映されます。
入力欄は次の形で書きます。直前の `##` 見出しが、記録タブでのまとまりになります。

```markdown
### 一言でいうと
<!-- field: summary | 一言でいうと | 何をして何が分かったかを1〜2文で書く -->
<!-- /field -->
```

詳しい仕様は [docs/design.md](docs/design.md) にあります。

## 開発

```bash
npm test               # 単体テスト
npm run typecheck
npm run build:single   # 1つの HTML ファイルにまとめる（dist-single/index.html）
node e2e/smoke.mjs     # build:single の後に実行。ヘッドレス Chromium で操作を確認する
```

## ライセンス

MIT
