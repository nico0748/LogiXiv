// 保管庫を初めて開いたときに _templates/reading-note.md として書き出すテンプレート。
// 利用者はこのファイルを編集して、自分の読み方に合わせた項目に変えられる。

export const DEFAULT_TEMPLATE = `---
title: {{title}}
authors: []
year: ""
venue: ""
doi: ""
status: 未読
tags: [paper]
created: {{date}}
pdf: "{{pdf}}"
---

# {{title}}

![[{{pdf}}]]

## 1. 概要をつかむ

アブストラクト、図、結論だけを読んで書く。

### 一言でいうと
<!-- field: summary | 一言でいうと | 何をして何が分かったかを1〜2文で書く -->

<!-- /field -->

### 解決したい課題
<!-- field: problem | 解決したい課題 | 既存手法で何ができていないか -->

<!-- /field -->

### 読む目的
<!-- field: purpose | 読む目的 | この論文から何を得たいか -->

<!-- /field -->

## 2. 精読する

### 提案手法
<!-- field: method | 提案手法 | 手法の要点。図や数式の番号も書いておく -->

<!-- /field -->

### 実験と結果
<!-- field: results | 実験と結果 | データセット、比較対象、主な数値 -->

<!-- /field -->

## 3. 検討する

### 強み
<!-- field: strengths | 強み | 先行研究と比べて優れている点 -->

<!-- /field -->

### 限界と疑問点
<!-- field: limitations | 限界と疑問点 | 著者が認めている限界と、自分が疑問に思った点 -->

<!-- /field -->

## 4. まとめる

### 自分の研究との関係
<!-- field: relevance | 自分の研究との関係 | 使える点、使えない点 -->

<!-- /field -->

### 次に読む論文
<!-- field: next | 次に読む論文 | 参考文献から選ぶ -->

<!-- /field -->

## マーカーと訳

<!-- list: highlights -->
<!-- /list -->

## 用語

<!-- list: terms -->
<!-- /list -->

## 数式

<!-- list: equations -->
<!-- /list -->
`;

/** 読解の段階。frontmatter の status に書き込む。 */
export const STATUSES = ["未読", "概要把握", "精読", "検討", "まとめ済み"] as const;
export type Status = (typeof STATUSES)[number];
