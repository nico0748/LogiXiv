// 読解ノートの frontmatter（先頭の --- と --- の間の YAML）を項目ごとに読み書きする。
//
// YAML の構文解析のライブラリは使わない。PaperLens が書くのは最上位の項目だけで、値の形は次の 3 つに限る。
//   - 1 行の文字列           title: Attention Is All You Need
//   - ブロック形式の一覧     authors:\n  - A. Example\n  - B. Sample   （Obsidian の Properties が書く形）
//   - フロー形式の一覧       tags: [paper, ml]
// それ以外の形（複数行の文字列 | >、入れ子の対応表、アンカー & *）の項目は opaque として読み飛ばし、書き換えない。
// 書き換えるときは、対象の項目の行だけを置き換える。ほかの項目・コメント・空行・frontmatter の外は 1 文字も変えない。

export type FmValue = string | string[];

export interface FmEntry {
  key: string;
  /** scalar: 1 行の値 / list: 一覧 / opaque: 書き換えない形（複数行の文字列・入れ子・アンカー） */
  kind: "scalar" | "list" | "opaque";
  /** list のときの書き方 */
  style?: "block" | "flow";
  /** opaque のときは "" */
  value: FmValue;
  /** frontmatter の中での行の範囲（0 始まり、end は含まない）。続きの行（字下げ・"- "）を含む */
  start: number;
  end: number;
}

export class FrontmatterError extends Error {}

interface Parsed {
  entries: FmEntry[];
  /** frontmatter の中の行（改行文字は含まない） */
  lines: string[];
  /** frontmatter の後ろ（閉じの --- の直後）が始まる位置 */
  bodyStart: number;
  /** 元の改行（"\n" か "\r\n"）。書き戻すときに使う */
  eol: string;
}

// 開きの --- から閉じの --- まで。閉じの --- の後ろは改行か文字列の終わり
const FM_RE = /^---(\r?\n)(?:([\s\S]*?)\r?\n)?---(?=\r?\n|$)/;

/**
 * 項目の始まりの行。字下げが無く、"- " と "#" で始まらず、":" の後が空白か行末である行。
 * 項目名には日本語・スペース・引用符を許す（Obsidian では自由に項目名を付けられるため）。
 */
const KEY_RE = /^(?![-#\s])("[^"]*"|'[^']*'|[^:]+?):(?=\s|$)/;

/** 続きの行: 字下げのある行、"- " で始まる行、空行 */
const isContinuation = (l: string) => /^[ \t]/.test(l) || /^-(\s|$)/.test(l) || l.trim() === "";
const LIST_ITEM_RE = /^\s*-(?:\s+(.*))?$/;

/** frontmatter を項目ごとに読む。frontmatter が無ければ null。 */
export function parseFrontmatter(md: string): Parsed | null {
  const m = md.match(FM_RE);
  if (!m) return null;
  const lines = m[2] === undefined ? [] : m[2].split(/\r?\n/);
  const entries: FmEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const km = lines[i].match(KEY_RE);
    if (!km) continue;
    let end = i + 1;
    while (end < lines.length && isContinuation(lines[end])) end++;
    // 範囲の末尾の空行は範囲に含めない
    while (end > i + 1 && lines[end - 1].trim() === "") end--;
    entries.push({ key: unquote(km[1].trim()), start: i, end, ...classify(lines[i].slice(km[0].length).trim(), lines.slice(i + 1, end)) });
    i = end - 1;
  }
  return { entries, lines, bodyStart: m[0].length, eol: m[1] };
}

function classify(rest: string, cont: string[]): Pick<FmEntry, "kind" | "style" | "value"> {
  const body = cont.filter((l) => l.trim() !== "");
  const opaque = { kind: "opaque" as const, value: "" };
  if (/^[|>&*{]/.test(rest)) return opaque;
  if (rest === "") {
    if (!body.length) return { kind: "scalar", value: "" };
    if (body.every((l) => LIST_ITEM_RE.test(l))) {
      return { kind: "list", style: "block", value: body.map((l) => unquote((l.match(LIST_ITEM_RE)![1] ?? "").trim())) };
    }
    return opaque; // 入れ子の対応表など
  }
  if (body.length) return opaque; // 複数行に折り返した値
  if (rest.startsWith("[") && rest.endsWith("]")) {
    const items = splitFlow(rest.slice(1, -1));
    return items ? { kind: "list", style: "flow", value: items } : opaque;
  }
  return { kind: "scalar", value: unquote(rest) };
}

/** フロー形式の一覧の中身を "," で分ける。"," は引用符の中だけで許す。入れ子は null（書き換えない）。 */
function splitFlow(s: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (const ch of s) {
    if (q) {
      cur += ch;
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === "[" || ch === "{") return null;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  const items = out.map((x) => x.trim());
  if (items.length === 1 && items[0] === "") return [];
  return items.filter((x) => x !== "").map(unquote);
}

/** 値を読む。一覧は配列で返す。opaque の項目は含めない。 */
export function readFrontmatter(md: string): Record<string, FmValue> {
  const p = parseFrontmatter(md);
  const out: Record<string, FmValue> = {};
  if (!p) return out;
  for (const e of p.entries) if (e.kind !== "opaque" && !(e.key in out)) out[e.key] = e.value;
  return out;
}

/** 一覧を表示用の 1 行にする（"A, B"）。文字列はそのまま返す。 */
export const fmText = (v: FmValue | undefined) => (Array.isArray(v) ? v.join(", ") : v ?? "");

/**
 * 文字列を一覧に分ける。改行・";"・"；" で分け、空の要素を除く。
 * "," では分けない（著者名に「Smith, J.」のような "," が入るため）。一覧は配列で渡すのが確実。
 */
export function splitList(s: string): string[] {
  return s.split(/\r?\n|;|；/).map((x) => x.trim()).filter(Boolean);
}

/** 1 項目を書く。項目が無ければ frontmatter の末尾に足す。複数行の値の項目は書き換えずに FrontmatterError を投げる。 */
export function setFrontmatterValue(md: string, key: string, value: FmValue): string {
  const p = parseFrontmatter(md);
  if (!p) return `---\n${render(key, value).join("\n")}\n---\n\n${md}`;
  const lines = [...p.lines];
  const e = p.entries.find((x) => x.key === key);
  if (!e) {
    lines.push(...render(key, value));
  } else {
    if (e.kind === "opaque") {
      throw new FrontmatterError(`frontmatter の「${key}」は複数行の値のため、PaperLens からは書き換えません。Obsidian で直してください。`);
    }
    // 元の項目名の書き方（引用符など）をそのまま使う
    const rawKey = lines[e.start].match(KEY_RE)![1];
    let next: string[];
    if (e.kind === "list") {
      const items = Array.isArray(value) ? value : splitList(value);
      // 空の一覧（key: []）は、ブロック形式で表せないためにその形になっているだけなので、ブロック形式で書く
      if (e.style === "flow" && (e.value as string[]).length) next = [`${rawKey}: [${items.map(yamlScalar).join(", ")}]`];
      else {
        const first = lines.slice(e.start + 1, e.end).find((l) => LIST_ITEM_RE.test(l));
        next = blockList(rawKey, items, first ? first.match(/^\s*/)![0] : "  ");
      }
    } else if (Array.isArray(value)) next = blockList(rawKey, value, "  ");
    else next = [`${rawKey}: ${yamlScalar(value)}`];
    lines.splice(e.start, e.end - e.start, ...next);
  }
  return `---${p.eol}${lines.join(p.eol)}${p.eol}---${md.slice(p.bodyStart)}`;
}

function render(key: string, value: FmValue) {
  return Array.isArray(value) ? blockList(key, value, "  ") : [`${key}: ${yamlScalar(value)}`];
}

/** ブロック形式の一覧。空の一覧はブロック形式で表せないので "key: []" にする。 */
function blockList(key: string, items: string[], indent: string) {
  if (!items.length) return [`${key}: []`];
  return [`${key}:`, ...items.map((x) => `${indent}- ${yamlScalar(x)}`)];
}

export function unquote(s: string) {
  if (/^".*"$/.test(s)) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/** YAML として別の型に読まれる語（大文字と小文字は区別しない） */
const RESERVED = /^(true|false|null|yes|no|on|off|~)$/i;
/** 先頭に来ると YAML の記号として読まれる文字 */
const SPECIAL_HEAD = /^[-?:[\]{}!&*#|>@`]/;

export function yamlScalar(v: string) {
  if (v === "") return '""';
  // 0 で始まる数字（007）は、引用符が無いと YAML では数の 7 になる
  if (RESERVED.test(v) || SPECIAL_HEAD.test(v) || /^0\d+$/.test(v)) return JSON.stringify(v);
  if (/^[\w　-鿿＀-￯-]+$/.test(v)) return v;
  return JSON.stringify(v);
}
