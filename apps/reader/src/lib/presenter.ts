// 発表のときの 2 つの窓のやりとり。
//   発表の窓（別のウィンドウ・全画面）: スライドと論文を並べて映す。URL は ?present=<論文ID>
//   元の窓: グループのメモとリンク先を、スライドの順に台本として出す（ScriptView）
// 同じオリジンの BroadcastChannel で送る（Electron でもブラウザでも同じ）。論文ごとに名前を分ける。

export type PresentMsg =
  // 発表の窓 → 元の窓
  | { t: "hello"; page: number; count: number }
  | { t: "page"; page: number; count: number }
  | { t: "active"; id: string | null }
  | { t: "bye" }
  // 元の窓 → 発表の窓
  | { t: "focus"; id: string; link?: string }
  | { t: "goto"; page: number }
  | { t: "close" }
  | { t: "ping" };

const PARAM = "present";
/** 発表の窓の名前。同じ名前で開き直すと、新しい窓を増やさず同じ窓を使う */
export const PRESENT_WINDOW = "paperlens-present";

/** この窓が発表の窓なら、その論文の ID */
export const presentingPaper = (search: string) => new URLSearchParams(search).get(PARAM) || null;

export function presenterUrl(href: string, paperId: string) {
  const u = new URL(href);
  u.search = `?${PARAM}=${encodeURIComponent(paperId)}`;
  u.hash = "";
  return u.toString();
}

export const presentChannel = (paperId: string) => new BroadcastChannel(`paperlens-present:${paperId}`);
export const canPresent = () => typeof BroadcastChannel !== "undefined" && typeof window !== "undefined" && typeof window.open === "function";
