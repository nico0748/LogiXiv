// ヘルプの中身（章・よくある質問・更新情報）と、ヘルプ内検索。
// 画面の部品（src/components/help/）とは分けて、ここにはデータと純粋な処理だけを置く。
//
// 文の中の書き方（parseInline で読む）:
// - `code`        … コード・ファイル名
// - {{Ctrl + \}}  … キー（kbd）
// - [[import|論文を取り込む]] … 別の章へのリンク（id は HelpChapter.id、"faq" / "keys" / "changes" も可）

import { type SettingsPageId, openSettings } from "./settingsIndex.ts";
import { matchesQuery, queryTerms } from "./searchText.ts";

/** 設定画面のページ。SettingsModal の initialPage と同じ値 */
export type SettingsTarget = SettingsPageId;

export type HelpBlock =
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "steps"; items: string[] }
  | { kind: "tip"; text: string }
  /** 設定の該当ページを開くボタン */
  | { kind: "settings"; page: SettingsTarget; label: string }
  /** ツアーをもう一度始めるボタン */
  | { kind: "tour"; label: string };

export interface HelpChapter {
  id: string;
  title: string;
  /** 章の一覧と検索結果に出す 1 行の説明 */
  summary: string;
  blocks: HelpBlock[];
  /** 本文に無いが、この章で探されそうな語（検索だけに使う） */
  keywords?: string[];
}

export interface FaqItem {
  id: string;
  q: string;
  a: string[];
  /** 詳しく書いてある章 */
  chapter?: string;
  /** 本文に無いが、この質問で探されそうな語（検索だけに使う） */
  keywords?: string[];
}

export interface ChangeEntry {
  /** 新しい順に並べる。いちばん上の id を「読んだ」と記録する */
  id: string;
  date: string;
  title: string;
  items: string[];
}

const p = (text: string): HelpBlock => ({ kind: "p", text });
const h = (text: string): HelpBlock => ({ kind: "h", text });
const list = (...items: string[]): HelpBlock => ({ kind: "list", items });
const steps = (...items: string[]): HelpBlock => ({ kind: "steps", items });
const tip = (text: string): HelpBlock => ({ kind: "tip", text });
const settings = (page: SettingsTarget, label: string): HelpBlock => ({ kind: "settings", page, label });

export const HELP_CHAPTERS: HelpChapter[] = [
  {
    id: "start",
    keywords: ["使い方", "初めて", "概要", "ブラウザ版", "サーバー版", "デスクトップ版", "保存場所"],
    title: "はじめに",
    summary: "PaperLens でできることと、画面の見方です。",
    blocks: [
      p("PaperLens は、論文の PDF を読みながら、訳・用語・数式・読解メモを Markdown の読解ノート（`note.md`）に残すアプリです。"),
      h("画面の見方"),
      list(
        "左端の細い帯（リボン）: 論文一覧、検索、リスト、グラフ、発表スライドとの対応、設定、ヘルプを開きます。",
        "左サイドバー: 論文一覧と、読解ノートの検索です。{{⌘/Ctrl + \\}} で開け閉めします。",
        "中央: 論文の PDF です。文を選ぶと、マーカー・訳・用語・数式の操作が出ます。",
        "右サイドバー: 対訳・訳・用語・数式・記録のタブです。見出しの右端のボタンで開け閉めします。",
        "下の帯（ステータスバー）: 保存の状態、マーカーの数、論文の数、保存先の名前を出します。",
      ),
      h("3 つの動かし方"),
      list(
        "ブラウザ版（1 つの HTML ファイル）: Chrome か Edge で開き、保管庫にするフォルダを選びます。対訳、MCP、URL からの取り込み、リストは使えません。",
        "ローカルサーバー版（`npm start`）: 表示された URL（初期設定では http://127.0.0.1:5175 ）をブラウザで開きます。",
        "デスクトップ版（`npm run app`）: PaperLens のウィンドウで開きます。",
      ),
      h("データの置き場所"),
      p("データはすべて、保存先フォルダ（保管庫）の普通のファイルです。論文ごとに `papers/<論文ID>/` を作り、PDF（`paper.pdf`）と読解ノート（`note.md`）を置きます。データベースは使いません。"),
      p("保存先フォルダは Obsidian の保管庫としてそのまま開けます。Obsidian でノートを書き換えても、PaperLens の画面にすぐ反映されます。"),
      { kind: "tour", label: "画面の案内（ツアー）をもう一度見る" },
    ],
  },
  {
    id: "import",
    keywords: ["PDF を開く", "論文を追加", "URL", "arXiv", "並べ替え", "タグ"],
    title: "論文を取り込む",
    summary: "PDF を選ぶ・ドロップする、URL や arXiv の番号から取り込む方法です。",
    blocks: [
      steps(
        "リボンの「論文一覧」を押すか、{{⌘/Ctrl + \\}} で左サイドバーを開きます。",
        "左サイドバーの上の、紙に＋のアイコンを押して PDF を選びます。サーバー版とデスクトップ版では「論文を追加」から「PDF ファイルを選ぶ」、ブラウザ版では「PDF を追加」です。PDF を画面にドロップしても取り込めます。",
        "取り込むと、テンプレートから読解ノートを作り、その論文を開きます。右サイドバーは「記録」タブになります。",
      ),
      tip("試しに使うときは、ブラウザ版の最初の画面の「サンプルの論文で試す」か、ツアーの「サンプルの論文を取り込む」で、お試し用の論文を開けます。"),
      h("URL や arXiv の番号から"),
      p("サーバー版とデスクトップ版では、「論文を追加」から「URL から追加」を選ぶと、PDF の URL か arXiv の番号（例 2410.12345）から取り込めます。arXiv の論文は、題名・著者・年も自動で入ります。ブラウザ版では使えません。"),
      h("一覧で探す・並べる"),
      list(
        "検索欄で、題名・著者・年と、ノートの中を探せます。2 文字以上でノートの中も探します。",
        "段階のチップ（未読・概要把握・精読・検討・まとめ済み）で一覧を絞り込めます。",
        "見出しの右の「並び順」で、追加日・題名・発行年・読解の段階の順に並べ替えられます。",
        "ノートの frontmatter の `tags` は、行の下に #タグ として出ます。押すとそのタグの論文だけになります。検索欄に `#ml` のように打っても同じです。",
      ),
    ],
  },
  {
    id: "read",
    keywords: ["PDF が表示されない", "ページ", "倍率", "ズーム", "前回の位置", "サイドバー"],
    title: "読む（PDF の操作）",
    summary: "拡大・縮小、ページの移動、前回の位置、サイドバーの幅です。",
    blocks: [
      list(
        "PDF の上の帯の「−」「＋」で縮小・拡大します。「幅に合わせる」で、ページの幅を画面の幅に合わせます。",
        "ページ番号の欄に数字を入れて Enter を押すと、そのページへ移ります。",
        "論文を開き直すと、前回の位置から表示します。下に出る「先頭に戻る」で 1 ページ目へ戻れます。",
        "サイドバーの端をつまむと幅を変えられます（ダブルクリックで元の幅）。開け閉めと幅は保存先の `.paperlens/workspace.json` に保存します。",
        "論文の上の帯の右にある外へ出る矢印のアイコン（名前は「Obsidian で開く」）で、読解ノートを Obsidian で開けます（保存先がフォルダのときだけ出ます）。",
      ),
      p("文を選んで記録する方法は [[record|記録する]] を見てください。"),
    ],
  },
  {
    id: "record",
    keywords: ["翻訳", "訳せない", "ハイライト", "メモ", "API キー"],
    title: "記録する（マーカー・訳・用語・数式・記録欄）",
    summary: "PDF の文を選んで、マーカー・訳・用語・数式を残す方法と、右サイドバーのタブです。",
    blocks: [
      p("PDF の文をドラッグで選ぶと、操作の帯が出ます。"),
      list(
        "色の丸: その色（黄色・水色・桃色・緑色）のマーカーを引きます。「訳」タブに並びます。",
        "訳す: マーカーを引いて、選んだ文を Claude で日本語に訳します。",
        "用語を調べる: 「用語」タブに用語を足し、Claude で説明を作ります。",
        "数式にする: 「数式」タブに数式を足し、TeX に書き起こします。選んだ範囲の画像も Claude に送ります。",
      ),
      tip("Claude の API キーが無くても項目はできます。訳や説明は手で入力してください。"),
      settings("ai", "API キーとモデルを設定する"),
      h("右サイドバーのタブ"),
      list(
        "訳: マーカーを引いた文、訳、メモです。「p.番号」を押すと PDF のその位置へ移ります。PDF のマーカーを押すと、その項目を開きます。",
        "用語: 読み、短い説明、詳しい説明、この論文での使われ方、関連語です。",
        "数式: TeX、説明、記号の一覧です。論文中の場所を表示したり、PDF で場所を囲み直したりできます。",
        "記録: テンプレートの記録欄と、読解の段階、書誌情報（題名・著者・年・掲載先・DOI）です。",
      ),
      p("入力した内容は、読解ノート（`note.md`）の対応する箇所に自動で保存します。保存の状態はステータスバーに出ます。"),
    ],
  },
  {
    id: "sentences",
    keywords: ["翻訳", "全文の訳", "GROBID", "1 文ずつ"],
    title: "対訳で読む",
    summary: "論文を 1 文ずつに分けて、原文と訳を並べて読む方法です。",
    blocks: [
      p("対訳はサーバー版とデスクトップ版で使えます。取り込むと PDF を 1 文ずつに分けます。GROBID が動いていれば使い、無ければ pdf.js で簡易に分けます。"),
      list(
        "右サイドバーの「対訳」タブに文が並びます。カードを押すと PDF のその位置へ、PDF 上の文の枠を押すとそのカードへ移ります。",
        "{{j}} / {{k}} で前後の文へ、{{n}} で次の未訳の文へ移ります。",
        "カードでは、訳の手直し（ダブルクリックでも直せます）、メモ、訳を消す、次の文との結合、文の分割、訳す対象から外す、ができます。",
        "上の検索欄で原文・訳文・メモを探せます。「未訳だけ」で訳の無い文だけにできます。",
        "目のアイコンで、PDF の文の枠を出す・隠すを切り替えます。",
      ),
      h("解析の方式と崩れ"),
      p("タブの上に「GROBID 解析」か「簡易解析」と、崩れの疑いが出ます。文が途中で切れている、2 段組の左右が混ざっているときは、GROBID を起動してから「解析し直す」で GROBID を選んでください。訳・メモ・区切りの直しは引き継ぎます。"),
      h("全文を訳す"),
      p("全文の訳は、MCP サーバーをつないだ Claude に頼みます。「PaperLens で開いている論文『…』を訳して」と頼むと、訳が画面にすぐ届きます。人が直した訳は上書きしません。つなぎ方は [[mcp|AI エージェントから使う]] にあります。"),
    ],
  },
  {
    id: "glossary",
    keywords: ["単語帳", "数式帳", "つながり"],
    title: "用語集とグラフ",
    summary: "対訳の用語集、すべての論文の単語帳と数式帳（リスト）、論文と用語のグラフです。",
    blocks: [
      h("対訳の用語集"),
      p("対訳タブの上の本のアイコンで、その論文の用語集を開きます。Claude が全文を訳すときは、この訳語にそろえます。"),
      h("リスト（単語帳と数式帳）"),
      p("リボンの「リスト」（{{⌘/Ctrl + Shift + L}}）で、すべての論文の用語（対訳の用語集を含む）と数式を、単語帳と数式帳として引けます。項目を選ぶと、その論文の該当ページへ移れます。サーバー版とデスクトップ版で使えます。"),
      h("グラフ"),
      p("リボンの「グラフ」で、論文と用語のつながりを見られます。同じ用語を調べた論文どうしが近くに集まります。"),
      list(
        "ホイールかピンチで拡大・縮小、ドラッグで移動します。{{+}} / {{-}} / {{0}}（全体を表示）も使えます。",
        "用語を押すとその意味を、論文を押すと題名と「開く」を出します。論文はダブルクリックでも開きます。",
      ),
    ],
  },
  {
    id: "slides",
    keywords: ["発表", "プレゼン", "PPTX"],
    title: "スライドと論文を対応させる",
    summary: "論文発表会のスライドの一部を囲み、論文の文章・図・数式にリンクする方法です。",
    blocks: [
      p("リボンの「発表スライドと論文の対応」で、発表のスライド（PDF か PPTX）を論文の左に並べます。"),
      steps(
        "スライドをドロップするか「スライドを追加」で取り込みます。PPTX は PDF に変換して表示します（LibreOffice か Keynote が必要です）。",
        "「囲む」（{{r}}）でスライドの一部をドラッグして囲むと、グループができます。名前は「Markup-ページ.番号」です（3 ページ目の 2 個目は Markup-03.02）。",
        "グループを選んでいる間に、「文章」（{{t}}）のまま論文の文をドラッグで選んで「文章としてリンク」を押すか、「図」（{{f}}）・「数式」（{{e}}）に替えて論文の範囲を囲むと、リンクできます。",
        "グループと論文の該当箇所は、グループの色の線でつながります。「選んだ線だけ」で、選んでいるグループの線だけを出せます。",
      ),
      h("そのほかの操作"),
      list(
        "上の「スライド」「補足情報」のタブ（横スクロールか {{[}} / {{]}} でも）で、[スライド | 論文] と [論文 | 補足情報] を切り替えます。補足情報には右サイドバーと同じタブが出ます。",
        "右側にグループの一覧が出ます。メモ、色、リンクの種類を直したり、リンクやグループを消したりできます。",
        "グループを選んで {{Delete}} / {{Backspace}} で消せます。消したあとに出る「元に戻す」か {{⌘/Ctrl + Z}} で戻せます。",
        "発表のときは「発表」（{{p}}）で、スライドと論文を別の窓に全画面で映し、この窓には台本（スライドの順に、グループのメモとリンクした論文の箇所）を出します。外部ディスプレイがあれば、発表の窓はそちらに出ます。台本でページやグループを押すと発表の窓がそこへ動き、{{←}} / {{→}} でスライドを送れます。「発表を終える」か {{p}} で戻ります。ブラウザで開いているときなど別の窓を開けないときは、この画面を全画面にします（{{Esc}} か {{p}} で戻ります）。",
        "対応はノートの「発表スライドとの対応」にも書き出します。",
      ),
    ],
  },
  {
    id: "export",
    keywords: ["バックアップ", "エクスポート", "引用", ".bib", "Markdown"],
    title: "書き出す（BibTeX・Markdown）",
    summary: "BibTeX のコピーと .bib ファイル、Markdown の読解ノートの使い方です。",
    blocks: [
      h("BibTeX"),
      list(
        "1 本ずつ: 記録タブの「書誌情報」の「BibTeX をコピー」でコピーします。",
        "まとめて: 論文一覧の下の「すべての BibTeX を書き出す」で、1 つの .bib ファイルに保存します。絞り込み中は「表示中の … 件の BibTeX を書き出す」になり、表示している論文だけを書き出します。",
        "引用キーが重なったときは、2 つ目から末尾に a, b, … を付けます。",
      ),
      h("Markdown（読解ノート）"),
      p("記録はすべて、保存先フォルダの `papers/<論文ID>/note.md` に Markdown で残っています。書き出しの操作は要りません。Obsidian やほかのエディタでそのまま開けます。"),
      p("アプリと AI エージェントは、ノートの `<!-- field -->` と `<!-- list -->` で囲んだ範囲だけを書き換えます。範囲の外に書いた内容は変更しません。"),
      tip("保管庫を公開の Git リポジトリにするときは、PDF を入れないでください。`.gitignore` に `papers/*/paper.pdf` と書くと、ノートだけを共有できます。"),
    ],
  },
  {
    id: "mcp",
    keywords: ["Claude Desktop", "Claude Code", "エージェント", "つながらない"],
    title: "AI エージェントから使う（MCP）",
    summary: "Claude Desktop や Claude Code から PaperLens を操作する方法です。",
    blocks: [
      p("MCP サーバーを登録すると、Claude Desktop や Claude Code などの AI エージェントが、画面と同じ操作（取り込み、本文の読み取り、全文の対訳、マーカーと訳、用語、数式、記録欄の入力、読解の段階の変更）を行えます。アプリを起動していなくても使えます。"),
      steps(
        "サーバー版かデスクトップ版で PaperLens を開きます。ブラウザ版（1 つの HTML ファイル）からは登録できません。サーバー版は、リポジトリの `apps/reader` で `npm run build` のあと `npm start` を実行し、表示された URL（http://127.0.0.1:5175 ）をブラウザで開きます。デスクトップ版は `npm run app` で開きます。",
        "設定の「AI エージェント（MCP）」を開き、Claude Code のコマンドか Claude Desktop の設定を「コピーする」でコピーします。",
        "Claude Code では端末に貼り付けて実行します。Claude Desktop では設定ファイルの `mcpServers` に加え、Claude Desktop を再起動します。",
      ),
      settings("mcp", "AI エージェント（MCP）の設定を開く"),
      list(
        "「読み取りだけを許可する」で、ノートを書き換えるツールを公開しない設定を作れます。",
        "アプリを起動している間は、エージェントの変更が画面にすぐ反映されます。同じ論文を同時に編集しても、互いの変更を消しません。",
      ),
      p("頼み方の例: 「PaperLens の論文一覧を見せて」「開いている論文を 1 文ずつ訳して」「この論文の用語を 5 つ登録して」。"),
    ],
  },
  {
    id: "settings",
    keywords: ["ダークモード", "テーマ", "文字の大きさ", "API キー", "モデル", "保存場所"],
    title: "設定",
    summary: "保存先、表示、Claude、テンプレート、データ、連携の設定です。",
    blocks: [
      p("リボンの下の「設定」（歯車）で開きます。左の項目を押すと、そのページだけを表示します。上の検索欄で、項目名と説明から探せます。"),
      list(
        "全般: 保存先フォルダ（保管庫）と、起動したときに開くものです。",
        "表示: 明るい表示と暗い表示、文字の大きさ、PDF の既定の倍率などです。",
        "読解と AI: Claude の API キーとモデル、訳と説明の文体、送る範囲です。",
        "テンプレート: 読解ノートのテンプレート（`_templates/reading-note.md`）を編集します。変更は、これから取り込む論文のノートに使われます。",
        "データ: 設定の書き出し・読み込みと、前回の位置などのリセットです。",
        "連携: AI エージェント（MCP）と Obsidian です。",
        "情報: キーボード操作の一覧と、このアプリについて（版、保存先、不具合を知らせるときの情報）です。",
      ),
      p("表示や API キーなど、端末ごとの設定はこのブラウザ（またはデスクトップ版）にだけ保存します。テンプレートと画面の配置は保存先フォルダに置きます。"),
      settings("general", "設定を開く"),
    ],
  },
];

export const HELP_FAQ: FaqItem[] = [
  {
    id: "faq-cost",
    q: "お金はかかりますか",
    a: [
      "PaperLens そのものは無料です。PDF を読む、マーカーを引く、訳やメモを手で書く、対訳を読む、などは Claude を使わずにできます。",
      "画面から「訳す」「用語を調べる」「数式にする」で Claude を使うと、Claude の API の利用料が Anthropic からかかります。料金と使った量は Anthropic Console（https://console.anthropic.com ）で確かめられます。",
      "MCP で Claude Desktop や Claude Code から使うときは、それぞれのプランの範囲で使えます。",
    ],
    chapter: "record",
    keywords: ["料金", "無料", "有料", "課金", "費用"],
  },
  {
    id: "faq-select",
    q: "PDF の文を選べない",
    keywords: ["PDF が表示されない", "文字が選べない", "スキャン"],
    a: [
      "画像だけの PDF（スキャンした PDF）は文字の情報が無いため選べません。OCR をかけてから取り込み直してください。",
      "スライドの画面で「囲む」などの道具を選んでいると、ドラッグは囲む操作になります。「選ぶ」（{{v}}）に戻してください。",
    ],
    chapter: "record",
  },
  {
    id: "faq-pdf-blank",
    q: "PDF が表示されない",
    a: [
      "論文を選んでいないときは「論文を開いてください」と出ます。左サイドバーの論文一覧から選んでください。",
      "「読み込んでいます」のまま変わらないときは、PDF が壊れているか、PDF ではないファイルの可能性があります。ほかのアプリで開けるか確かめ、取り込み直してください。",
    ],
    chapter: "read",
    keywords: ["見えない", "真っ白", "開かない"],
  },
  {
    id: "faq-ai",
    q: "「訳す」を押しても訳が入らない（AI が動かない）",
    keywords: ["訳せない", "翻訳できない", "API キー", "エラー"],
    a: [
      "画面から訳・用語の説明・数式の書き起こしを作るには、Claude の API キーが必要です。設定の「読解と AI」で入力してください。",
      "「API キーが正しくありません」と出るときは、キーを入れ直してください。キーはこの端末にだけ保存し、保存先フォルダには書き込みません。",
      "キーが無くても、訳や説明は手で入力できます。",
    ],
    chapter: "record",
  },
  {
    id: "faq-mcp",
    q: "MCP がつながらない（Claude Desktop にツールが出ない）",
    a: [
      "設定ファイルの JSON が正しいか確かめ、Claude Desktop を再起動してください。",
      "`node` が見つからない場合は、`command` を `which node` の結果に置き換えてください。",
      "エージェントが別のフォルダを見ているときは、設定に出る登録方法で登録し直してください。",
    ],
    chapter: "mcp",
  },
  {
    id: "faq-note",
    q: "ノートはどこにありますか",
    keywords: ["保存場所", "保存先", "フォルダ", "ファイル"],
    a: [
      "保存先フォルダの `papers/<論文ID>/note.md` です。サーバー版とデスクトップ版の保存先は、設定の「全般」で確かめられます。",
      "ブラウザ版の「サンプルの論文で試す」はメモリに保存するため、ページを閉じると消えます。",
    ],
    chapter: "export",
  },
  {
    id: "faq-obsidian",
    q: "Obsidian で開くには",
    a: [
      "Obsidian の「フォルダを保管庫として開く」で、PaperLens の保存先フォルダを選んでください。",
      "論文を開いているときは、論文の上の帯の右にある外へ出る矢印のアイコン（名前は「Obsidian で開く」）で、そのノートを開けます。",
    ],
    chapter: "export",
  },
  {
    id: "faq-move",
    q: "データを別の PC に移したい",
    keywords: ["バックアップ", "移行", "コピー"],
    a: [
      "保存先フォルダをそのまま新しい PC にコピーし、PaperLens の設定でそのフォルダを選んでください。論文・ノート・テンプレート・画面の配置が移ります。",
      "API キーと表示の設定は端末ごとです。設定の「データ」で書き出して読み込むか、入れ直してください（API キーは書き出しに含めません）。",
    ],
    chapter: "settings",
  },
  {
    id: "faq-parse",
    q: "対訳が「簡易解析」になる・文が途中で切れる",
    a: [
      "GROBID に届いていません。`docker compose -f docker/grobid.yml up -d` で起動してから、対訳タブの「解析し直す」で GROBID を選んでください。",
    ],
    chapter: "sentences",
  },
  {
    id: "faq-no-sentences",
    q: "対訳のタブやリストが出ない",
    a: ["対訳とリストは、サーバー版とデスクトップ版だけで使えます。ブラウザ版（1 つの HTML ファイル）では出ません。"],
    chapter: "start",
  },
  {
    id: "faq-url",
    q: "URL から取り込めない",
    a: [
      "大学や会社のプロキシの内側では取得できないことがあります。ブラウザで PDF を保存し、左サイドバーの上の紙に＋のアイコン（サーバー版とデスクトップ版は「論文を追加」→「PDF ファイルを選ぶ」）で取り込んでください。",
      "ブラウザ版では URL からの取り込みは使えません。",
    ],
    chapter: "import",
  },
  {
    id: "faq-pptx",
    q: "PPTX のスライドが「変換できませんでした」と出る",
    a: ["LibreOffice か Keynote が必要です。どちらも無ければ、PowerPoint などで PDF に書き出してから取り込んでください。"],
    chapter: "slides",
  },
  {
    id: "faq-sidebar",
    q: "サイドバーが消えた",
    keywords: ["表示されない", "見えない"],
    a: ["左サイドバーは {{⌘/Ctrl + \\}} かリボンの「論文一覧」で、右サイドバーは見出しの右端のボタンで開きます。"],
    chapter: "read",
  },
  {
    id: "faq-tour",
    q: "最初の画面の案内をもう一度見たい",
    a: ["ヘルプの「はじめに」の「画面の案内（ツアー）をもう一度見る」を押してください。"],
    chapter: "start",
  },
];

export const CHANGELOG: ChangeEntry[] = [
  {
    id: "2026-10-25-presenter",
    date: "2026-10-25",
    title: "発表の窓と台本",
    items: [
      "スライドの画面の「発表」（{{p}}）で、スライドと論文を別の窓に全画面で映し、元の窓にはグループのメモとリンクを台本のように並べます。外部ディスプレイがあれば、発表の窓はそちらに出ます。",
      "台本で押したページやグループへ、発表の窓が動きます。{{←}} / {{→}} でスライドを送れます。",
      "デスクトップ版を npm run app で開いたとき、Dock の名前が Electron ではなく PaperLens になりました。",
    ],
  },
  {
    id: "2026-10-23-help",
    date: "2026-10-23",
    title: "ヘルプと設定を新しくしました",
    items: [
      "初めて開いたときに、画面の案内（ツアー）が出ます。",
      "ヘルプを章に分け、ヘルプ内の検索と、よくある質問を足しました。",
      "{{?}} でキーボード操作の早見表を開けます。",
      "画面の各所の「?」から、その場所の説明を開けます。",
      "設定を項目ごとのページに分け、設定内の検索を足しました。",
    ],
  },
  {
    id: "2026-10-slides",
    date: "2026-10",
    title: "発表スライドと論文の対応",
    items: [
      "発表のスライドの一部を囲み、論文の文章・図・数式にリンクできます。",
      "「補足情報」の面と、スライドと論文を並べた全画面の表示を足しました。",
    ],
  },
  {
    id: "2026-10-sentences",
    date: "2026-10",
    title: "1 文ごとの対訳",
    items: [
      "旧 LogiXiv の文分割と対訳を取り込みました。右サイドバーの「対訳」タブで読めます。",
      "全文の訳は MCP サーバー経由で Claude が入れます。",
    ],
  },
  {
    id: "2026-10-list",
    date: "2026-10",
    title: "論文一覧と書き出し",
    items: [
      "URL や arXiv の番号から取り込めます。",
      "論文一覧の並び順、#タグでの絞り込み、BibTeX の書き出しを足しました。",
      "リスト（単語帳と数式帳）とグラフを足しました。",
    ],
  },
];

/** ヘルプの中の行き先。章の id か、特別なページ */
export type HelpPage = string;
export const FAQ_PAGE = "faq";
export const KEYS_PAGE = "keys";
export const CHANGES_PAGE = "changes";

export function isHelpPage(id: string): boolean {
  return id === FAQ_PAGE || id === KEYS_PAGE || id === CHANGES_PAGE || HELP_CHAPTERS.some((c) => c.id === id);
}

// --- 文の中の書き方 -----------------------------------------------------------

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "kbd"; v: string }
  | { t: "link"; to: string; v: string };

/** `code`、{{キー}}、[[章|文字]] を読み分ける。閉じていない記号はそのまま文字にする。 */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`]+)`|\{\{(.+?)\}\}|\[\[([^\]|]+)\|([^\]]+)\]\]/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push({ t: "text", v: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: "code", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "kbd", v: m[2] });
    else out.push({ t: "link", to: m[3], v: m[4] });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ t: "text", v: s.slice(last) });
  return out;
}

/** 書き方の記号を外した、読むための文字だけ。検索と抜粋に使う。 */
export function plainText(s: string): string {
  return parseInline(s).map((x) => x.v).join("");
}

// --- ヘルプ内検索 ------------------------------------------------------------

export interface HelpHit {
  /** 開くページ（章の id か "faq" / "keys" / "changes"） */
  page: string;
  /** よくある質問のときは、その項目の id */
  anchor?: string;
  title: string;
  /** 当たった箇所の前後 */
  snippet: string;
  score: number;
}

/** 検索の対象 1 つ分 */
interface HelpDoc {
  page: string;
  anchor?: string;
  title: string;
  summary: string;
  body: string;
  keywords: string[];
}

function blockTexts(b: HelpBlock): string[] {
  if (b.kind === "list" || b.kind === "steps") return b.items;
  if (b.kind === "settings" || b.kind === "tour") return [b.label];
  return [b.text];
}

/** 本文の中で最初に語が当たった場所の前後を切り出す。 */
function snippetOf(body: string, words: string[], width = 60): string {
  const low = body.normalize("NFKC").toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = low.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return body.length > width ? `${body.slice(0, width)}…` : body;
  const start = Math.max(0, at - 16);
  const end = Math.min(body.length, start + width);
  return `${start > 0 ? "…" : ""}${body.slice(start, end)}${end < body.length ? "…" : ""}`;
}

/** 特別なページ（よくある質問の一覧・キーボード操作・更新情報）の検索用の説明 */
export const EXTRA_DOCS: { page: string; title: string; summary: string; keywords: string[] }[] = [
  { page: "faq", title: "よくある質問・困ったとき", summary: "うまく動かないときの直し方です。", keywords: ["FAQ", "トラブル", "困った", "動かない", "エラー"] },
  { page: "keys", title: "キーボード操作", summary: "キーボードでできる操作の一覧です。? キーで早見表を開けます。", keywords: ["ショートカット", "キー操作", "キーボード", "早見表"] },
  { page: "changes", title: "更新情報", summary: "主な機能の追加です。", keywords: ["新機能", "リリース", "変更", "バージョン"] },
];

/**
 * 章・よくある質問・特別なページを探す。空白で区切った語がすべて当たるものだけを返す（言い換えは searchText.ts）。
 * 題名に当たったものを先に、次に説明と追加の語、本文の順に並べる。
 */
export function searchHelp(query: string, chapters: HelpChapter[] = HELP_CHAPTERS, faq: FaqItem[] = HELP_FAQ): HelpHit[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const docs: HelpDoc[] = [
    ...chapters.map((c) => ({ page: c.id, title: c.title, summary: c.summary, body: c.blocks.flatMap(blockTexts).map(plainText).join(" "), keywords: c.keywords ?? [] })),
    ...EXTRA_DOCS.map((d) => ({ ...d, body: "" })),
    ...faq.map((f) => ({ page: FAQ_PAGE, anchor: f.id, title: `よくある質問: ${f.q}`, summary: "", body: f.a.map(plainText).join(" "), keywords: f.keywords ?? [] })),
  ];
  const hits: HelpHit[] = [];
  for (const d of docs) {
    if (!matchesQuery(`${d.title} ${d.summary} ${d.body}`, query, d.keywords)) continue;
    // 語ごとに、どこで当たったかで点を付ける
    let score = 0;
    for (const alts of terms) {
      const inAny = (t: string) => alts.some((w) => t.includes(w));
      const norm = (t: string) => t.normalize("NFKC").toLowerCase().replace(/[\s\u3000]+/g, "");
      if (inAny(norm(d.title))) score += 10;
      else if (inAny(norm(`${d.summary} ${d.keywords.join(" ")}`))) score += 4;
      else score += 1;
    }
    const snippetSrc = d.body ? (d.summary ? `${d.summary} ${d.body}` : d.body) : d.summary;
    hits.push({ page: d.page, anchor: d.anchor, title: d.title, snippet: snippetOf(snippetSrc, terms.flat()), score });
  }
  // 同じ点数なら元の並び（章 → 特別なページ → よくある質問）のまま
  return hits.map((x, i) => ({ x, i })).sort((a, b) => b.x.score - a.x.score || a.i - b.i).map(({ x }) => x);
}

// --- 更新情報の未読 ------------------------------------------------------------

export const SEEN_CHANGE_KEY = "paperlens.help.seenChange";

/** 最後に読んだ更新情報の id と比べて、新しいものがあるか。 */
export function hasUnreadChanges(seen: string | null, log: ChangeEntry[] = CHANGELOG): boolean {
  return log.length > 0 && seen !== log[0].id;
}

// --- 画面の各所からヘルプを開く ------------------------------------------------

/** 画面の各所の「?」が出す知らせ。App が受けてヘルプをその章で開く */
export const HELP_EVENT = "paperlens:help";
/** 更新情報を読んだときの知らせ。リボンの印を消す */
export const CHANGES_SEEN_EVENT = "paperlens:changes-seen";

export interface HelpRequest {
  page: string;
  anchor?: string;
}

export function openHelp(page: string, anchor?: string): void {
  window.dispatchEvent(new CustomEvent<HelpRequest>(HELP_EVENT, { detail: { page, anchor } }));
}

/** 設定の該当ページを開く。受け取るのは App（設定の担当） */
export function openSettingsPage(page: SettingsTarget): void {
  openSettings(page);
}
