// ヘルプと設定の検索で共通に使う、語の正規化と言い換え。
//
// - 全角と半角、大文字と小文字、空白（全角の空白を含む）の違いは無視する（"API キー" と "apiキー" は同じ）
// - 同じ意味の言い方をまとめた表（SYNONYMS）で言い換える。検索語の中に表の語があれば、同じ組のどの語で当たってもよい
// - 表に無い残りの文字（助詞を除く）は、そのまま含まれている必要がある
// - 空白で区切った語は、すべて当たる必要がある

/** 比べるための形。NFKC で全角英数を半角に、小文字にし、空白をすべて除く。 */
export function normalizeQuery(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[\s　]+/g, "");
}

/** 同じ意味として扱う言い方の組。初めて使う人が打ちそうな言い方を足していく */
export const SYNONYMS: string[][] = [
  ["訳", "翻訳", "訳す", "訳し", "訳せない", "訳を", "和訳", "translate"],
  ["保存先", "保存場所", "場所", "フォルダ", "保管庫", "どこ"],
  ["キーボード操作", "ショートカット", "キー操作", "キーボード", "shortcut"],
  // 「ライト」は「ハイライト」に、「明るい」は表示の説明の多くに当たるため入れない
  ["ダーク", "暗い", "テーマ", "ダークモード", "配色", "ダークテーマ"],
  ["バックアップ", "書き出し", "書き出す", "移す", "移行", "別のpc", "エクスポート", "export"],
  ["料金", "お金", "費用", "課金", "無料", "有料", "値段"],
  ["apiキー", "apikey", "api"],
  ["表示されない", "開かない", "見えない", "出ない", "出てこない", "消えた"],
  ["動かない", "使えない", "できない", "エラー", "失敗"],
  ["取り込む", "取り込み", "追加", "インポート", "読み込む", "import"],
  ["マーカー", "ハイライト", "線を引く", "highlight"],
  ["用語", "単語", "用語集", "単語帳"],
  ["数式", "式", "tex", "latex"],
  ["記録", "メモ", "ノート", "note"],
  ["対訳", "1文ずつ", "一文ずつ", "原文"],
  ["スライド", "発表", "pptx", "プレゼン"],
  ["mcp", "aiエージェント", "エージェント", "claudedesktop", "claudecode"],
  ["obsidian", "オブシディアン"],
  ["拡大", "縮小", "倍率", "ズーム", "zoom"],
  ["検索", "探す", "さがす"],
];

const GROUPS = SYNONYMS.map((g) => g.map(normalizeQuery));
/** 言い換えの語（正規化済み）→ 属する組の語すべて。長い語から先に当てる */
const WORDS = [...new Set(GROUPS.flat())].sort((a, b) => b.length - a.length);
/**
 * 語の組の言い換え。1 文字の語（"訳"・"式"）は短すぎて多くの語に当たる（"対訳"・"数式"）ので、
 * 打った語そのものでない限り言い換えに使わない。
 */
const groupOf = (w: string) => [...new Set([w, ...GROUPS.filter((g) => g.includes(w)).flat().filter((x) => x.length >= 2)])];
/** これより長い検索語は切り詰める（打つたびに探すので、とても長い語で重くならないように） */
export const MAX_QUERY = 200;
/** 語と語のあいだの助詞や記号。残りの文字として扱わない */
const FILLER = /^[がをはのにでともへやかな、。・?？!！]+|[がをはのにでともへやかな、。・?？!！]+$/g;

/**
 * 1 つの語（空白を含まない）を、当てるべき条件の並びにする。条件は「どれかが含まれればよい」語の一覧。
 * 言い換えの表にある語は組ごとの条件にし、残りの文字（助詞などは除く）はそのまま条件にする。
 * 例: "pdfが表示されない" → [["pdf"], ["表示されない", "開かない", …]]
 */
export function expandTerm(term: string): string[][] {
  const t = normalizeQuery(term);
  const out: string[][] = [];
  let rest = "";
  const flush = () => {
    // 前後の助詞と記号を除く（"pdfが" → "pdf"）
    const word = rest.replace(FILLER, "");
    if (word) out.push([word]);
    rest = "";
  };
  for (let i = 0; i < t.length; ) {
    const w = WORDS.find((x) => t.startsWith(x, i));
    if (w) {
      flush();
      out.push(groupOf(w));
      i += w.length;
    } else {
      rest += t[i];
      i += 1;
    }
  }
  flush();
  return out;
}

/** 検索語を、当てるべき条件（どれかが含まれればよい語の一覧）の並びにする。 */
export function queryTerms(query: string): string[][] {
  return query.slice(0, MAX_QUERY).normalize("NFKC").split(/[\s\u3000]+/).flatMap(expandTerm);
}

/**
 * haystack（と extraKeywords）が検索語に当たるか。語はすべて当たる必要があり、各語は言い換えのどれかで当たればよい。
 * 空白を除いて比べるので、"API キー" でも "APIキー" でも同じ。
 */
export function matchesQuery(haystack: string, query: string, extraKeywords: string[] = []): boolean {
  const terms = queryTerms(query);
  if (!terms.length) return true;
  const hay = normalizeQuery([haystack, ...extraKeywords].join(" "));
  return terms.every((alts) => alts.some((w) => hay.includes(w)));
}
