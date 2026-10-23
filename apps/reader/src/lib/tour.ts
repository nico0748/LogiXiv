// 初めて開いたときの画面の案内（ツアー）。手順のデータと、始めるかどうか・進め方の純粋な処理。
// 画面（強調と吹き出し）は src/components/help/Tour.tsx。
//
// - 終えた・スキップしたら localStorage に記録し、次からは出さない（ヘルプからいつでも始め直せる）
// - 「あとで」はこの画面（タブ）を開いている間だけ出さない。次に開いたときにまた出す
// - e2e テストなどでは出さない: URL に ?notour、window.__PAPERLENS_NO_TOUR = true、
//   または localStorage の paperlens.tour が "off"

/** 動かし方。ブラウザ版（1 つの HTML）には対訳・リスト・URL からの取り込み・MCP が無い */
export type AppMode = "browser" | "server" | "desktop";

const MODE_NAME: Record<AppMode, string> = { browser: "ブラウザ版", server: "サーバー版", desktop: "デスクトップ版" };

export interface TourStep {
  id: string;
  title: string;
  body: string[];
  /** 強調する要素。前から順に探し、最初に見つかったものを使う。無ければ画面の中央に出す */
  targets: string[];
  /** この手順を見せる前に開いておくもの。"none" は、狭い画面で中央に重なるサイドバーを両方閉じる */
  open?: "left" | "right" | "none";
  /** この手順の間だけ選ぶタブ（押すタブの CSS セレクタ）。手順を離れたら元のタブに戻す */
  tab?: string;
  /** 論文がまだ無いときに「サンプルの論文を取り込む」を出す */
  sample?: boolean;
}

/** 動かし方に合わせた手順。ブラウザ版では対訳の手順を省き、使えない機能には触れない。 */
export function tourSteps(mode: AppMode): TourStep[] {
  const server = mode !== "browser";
  const steps: (TourStep | false)[] = [
    {
      id: "ribbon",
      title: "PaperLens へようこそ",
      body: [
        "論文の PDF を読みながら、訳・用語・数式・読解メモを Markdown のノートに残すアプリです。",
        server
          ? "左端の帯（リボン）から、論文一覧・検索・リスト・グラフ・スライドとの対応を開きます。"
          : "左端の帯（リボン）から、論文一覧・検索・グラフ・スライドとの対応を開きます。",
        server
          ? `いま開いているのは${MODE_NAME[mode]}です。`
          : "いま開いているのはブラウザ版です。対訳・リスト・AI エージェント（MCP）は、サーバー版とデスクトップ版で使えます。",
      ],
      targets: ["nav.ribbon"],
    },
    {
      id: "import",
      title: "論文を取り込む",
      body: server
        ? [
            "左サイドバーの上の、紙に＋のアイコン（論文を追加）を押し、「PDF ファイルを選ぶ」か「URL から追加」を選びます。URL には arXiv の番号も使えます。",
            "PDF を画面にドロップしても取り込めます。取り込むと読解ノートを作ります。",
          ]
        : [
            "左サイドバーの上の、紙に＋のアイコン（PDF を追加）で PDF を選びます。PDF を画面にドロップしても取り込めます。",
            "取り込むと読解ノートを作ります。",
          ],
      targets: [
        "aside.sidebar.left .sidebar-tab-header button[aria-label='論文を追加']",
        "aside.sidebar.left .sidebar-tab-header button[aria-label='PDF を追加']",
        "aside.sidebar.left .sidebar-inner",
        "nav.ribbon .ribbon-item[aria-label='論文一覧']",
      ],
      open: "left",
      sample: true,
    },
    {
      id: "select",
      title: "文を選んで記録する",
      body: [
        "PDF の文をドラッグで選ぶと、操作の帯が出ます。",
        "色の丸でマーカー、「訳す」で訳、「用語を調べる」で用語の説明、「数式にする」で TeX を残します。",
      ],
      targets: [".view-content"],
      open: "none",
    },
    {
      id: "right",
      title: "右サイドバー",
      body: [
        server
          ? "対訳と、選んだ箇所の訳・用語・数式、読解の記録がタブで並びます。"
          : "選んだ箇所の訳・用語・数式と、読解の記録がタブで並びます。",
        "入力は読解ノート（note.md）に自動で保存します。",
      ],
      targets: ["aside.sidebar.right"],
      open: "right",
    },
    server && {
      id: "sentences",
      title: "対訳で読む",
      body: [
        "「対訳」タブでは、論文を 1 文ずつに分けて原文と訳を並べます。j・k で前後の文へ移ります。",
        "全文の訳は、MCP でつないだ Claude に頼みます。つなぎ方はヘルプの「AI エージェントから使う」にあります。",
      ],
      targets: ["#tab-sentences", "aside.sidebar.right .tabs", "aside.sidebar.right"],
      open: "right",
      tab: "#tab-sentences",
    },
    {
      id: "slides",
      title: "スライドと論文を対応させる",
      body: ["発表のスライドを論文の横に並べ、スライドの一部を囲んで論文の文章・図・数式にリンクできます。"],
      targets: ["nav.ribbon .ribbon-item[aria-label='発表スライドと論文の対応']"],
    },
    {
      id: "help",
      title: "設定とヘルプ",
      body: [
        "下の歯車が設定、? がヘルプです。困ったときはヘルプの「よくある質問」を見てください。",
        "? キーでキーボード操作の早見表を開けます。この案内はヘルプからもう一度見られます。",
      ],
      targets: ["nav.ribbon .ribbon-bottom"],
    },
  ];
  return steps.filter((x): x is TourStep => x !== false);
}

/** サーバー版の手順（全部）。テストと、手順の数の目安に使う */
export const TOUR_STEPS: TourStep[] = tourSteps("server");

export const TOUR_KEY = "paperlens.tour";
export const TOUR_LATER_KEY = "paperlens.tour.later";

/** localStorage の値。"done" は終えた・スキップした、"off" はテストなどで出さない */
export type TourRecord = "done" | "off" | null;

export interface TourEnv {
  record: TourRecord;
  /** このタブで「あとで」を押したか */
  later: boolean;
  /** URL の ?notour か、window.__PAPERLENS_NO_TOUR */
  disabled: boolean;
}

/** 開いたときに自動で始めるか。 */
export function shouldAutoStart(env: TourEnv): boolean {
  return !env.disabled && !env.later && env.record === null;
}

/** URL の検索部分と全体の印から、ツアーを出さない指定かを読む。 */
export function isTourDisabled(search: string, flag: unknown): boolean {
  return flag === true || new URLSearchParams(search).has("notour");
}

export function readRecord(v: string | null): TourRecord {
  return v === "done" || v === "off" ? v : null;
}

// --- 進め方 ----------------------------------------------------------------

export interface TourState {
  open: boolean;
  index: number;
}

export type TourAction =
  | { type: "start" }
  | { type: "next" }
  | { type: "prev" }
  | { type: "go"; index: number }
  /** スキップ・終える（記録する） */
  | { type: "finish" }
  /** あとで（記録しない） */
  | { type: "later" };

export const TOUR_CLOSED: TourState = { open: false, index: 0 };

/** ツアーの状態を進める。最後の手順で next を受けたら閉じる（呼び出し側が「終えた」と記録する）。 */
export function tourReducer(s: TourState, a: TourAction, total: number = TOUR_STEPS.length): TourState {
  switch (a.type) {
    case "start":
      return { open: true, index: 0 };
    case "next":
      if (!s.open) return s;
      return s.index + 1 >= total ? { open: false, index: 0 } : { open: true, index: s.index + 1 };
    case "prev":
      if (!s.open) return s;
      return { open: true, index: Math.max(0, s.index - 1) };
    case "go":
      if (!s.open) return s;
      return { open: true, index: Math.min(total - 1, Math.max(0, a.index)) };
    case "finish":
    case "later":
      return TOUR_CLOSED;
  }
}

// --- 吹き出しの位置 ----------------------------------------------------------

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Placement = "right" | "left" | "bottom" | "top" | "center" | "sheet";

/**
 * 吹き出しを置く場所を決める。対象の右 → 左 → 下 → 上の順に、窓に収まるところを選ぶ。
 * 窓が狭い（幅 560px 未満）ときは、横いっぱいの帯（sheet）として画面の下に出す。対象が下半分にあれば上に出す。
 * 対象が無いときは中央に出す。返す left/top は吹き出しの左上。
 */
export function placePopover(target: Box | null, pop: { width: number; height: number }, view: { width: number; height: number }, gap = 12, margin = 16): { placement: Placement; left: number; top: number } {
  if (view.width < 560) {
    // 下の帯にすると対象を隠すとき（対象が画面の下半分にあるとき）は、上の帯にする
    const low = target !== null && target.top + target.height / 2 > view.height / 2;
    return { placement: "sheet", left: margin, top: low ? margin : view.height - pop.height - margin };
  }
  if (!target) return { placement: "center", left: (view.width - pop.width) / 2, top: (view.height - pop.height) / 2 };
  const clampX = (x: number) => Math.min(Math.max(margin, x), view.width - pop.width - margin);
  const clampY = (y: number) => Math.min(Math.max(margin, y), view.height - pop.height - margin);
  const cy = target.top + target.height / 2 - pop.height / 2;
  const cx = target.left + target.width / 2 - pop.width / 2;
  const right = target.left + target.width + gap;
  if (right + pop.width + margin <= view.width) return { placement: "right", left: right, top: clampY(cy) };
  const left = target.left - gap - pop.width;
  if (left >= margin) return { placement: "left", left, top: clampY(cy) };
  const below = target.top + target.height + gap;
  if (below + pop.height + margin <= view.height) return { placement: "bottom", left: clampX(cx), top: below };
  const above = target.top - gap - pop.height;
  if (above >= margin) return { placement: "top", left: clampX(cx), top: above };
  // 対象が画面のほとんどを占めるときは、対象の中の下寄りに重ねる
  return { placement: "center", left: clampX(cx), top: clampY(view.height - pop.height - margin * 2) };
}
