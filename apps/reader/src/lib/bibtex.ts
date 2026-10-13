// 読解ノートの frontmatter から BibTeX を作る。画面の「BibTeX をコピー」と MCP の get_bibtex で使う。
//
// 種類の決め方:
//   1. arxiv があり、venue が空か arXiv        → @misc（eprint と archivePrefix を付ける）
//   2. venue が会議・ワークショップらしい名前  → @inproceedings（booktitle）
//   3. それ以外で venue がある                 → @article（journal）
//   4. どちらも無い                            → @misc

import { type FmValue, fmText } from "./frontmatter.ts";

const CONF_RE = /proceedings|conference|workshop|symposium|\b(neurips|icml|iclr|acl|emnlp|naacl|cvpr|iccv|eccv|aaai|ijcai|kdd|sigir|chi)\b/i;

/** 英語の題名でキーに使わない語 */
const STOP = new Set(["a", "an", "the", "on", "of", "for", "in", "to", "and", "with", "towards", "toward", "via", "is", "are", "at", "by", "from", "do", "does"]);

/** BibTeX の特殊文字をエスケープする。 */
export function escapeTex(s: string): string {
  return s.replace(/[\\{}&%$#_~^]/g, (c) =>
    c === "\\" ? "\\textbackslash{}" : c === "~" ? "\\textasciitilde{}" : c === "^" ? "\\textasciicircum{}" : `\\${c}`,
  );
}

const ascii = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

/** 著者の一覧。文字列（既存の保管庫の "A, B"）は誤って分けないよう 1 つの値として扱う。 */
const authorList = (v: FmValue | undefined) => (Array.isArray(v) ? v.map((x) => x.trim()).filter(Boolean) : v?.trim() ? [v.trim()] : []);

/** 引用キー: 第一著者の姓＋年＋題名の最初の内容語（例 vaswani2017attention）。著者が無ければ論文 ID の英数字。 */
export function bibKey(fm: Record<string, FmValue>, paperId: string): string {
  const first = authorList(fm.authors)[0];
  const fallback = paperId.replace(/[^A-Za-z0-9]/g, "") || "paper";
  if (!first) return fallback;
  const surname = ascii(first.includes(",") ? first.split(",")[0] : first.split(/\s+/).pop() ?? "");
  // 英字で書けない姓（日本語など）は、キーを論文 ID から作る
  if (!surname) return fallback;
  const year = fmText(fm.year).replace(/\D/g, "").slice(0, 4);
  const word = fmText(fm.title).split(/[^A-Za-zÀ-ɏ]+/).map(ascii).find((w) => w && !STOP.has(w)) ?? "";
  return `${surname}${year}${word}`;
}

const stripDoi = (s: string) => s.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");

export function toBibtex(fm: Record<string, FmValue>, paperId: string): string {
  const venue = fmText(fm.venue).trim();
  const arxiv = fmText(fm.arxiv).trim();
  const fields: [string, string][] = [];
  let type = "misc";
  const title = fmText(fm.title).trim();
  if (title) fields.push(["title", `{${escapeTex(title)}}`]);
  const authors = Array.isArray(fm.authors) ? authorList(fm.authors).join(" and ") : fmText(fm.authors).trim();
  if (authors) fields.push(["author", escapeTex(authors)]);
  const year = fmText(fm.year).trim();
  if (year) fields.push(["year", escapeTex(year)]);
  if (arxiv && (!venue || /^arxiv$/i.test(venue))) {
    fields.push(["eprint", escapeTex(arxiv)], ["archivePrefix", "arXiv"]);
  } else if (venue && CONF_RE.test(venue)) {
    type = "inproceedings";
    fields.push(["booktitle", escapeTex(venue)]);
  } else if (venue) {
    type = "article";
    fields.push(["journal", escapeTex(venue)]);
  }
  const doi = stripDoi(fmText(fm.doi));
  if (doi) fields.push(["doi", escapeTex(doi)]);
  if (arxiv) fields.push(["url", `https://arxiv.org/abs/${arxiv}`]);
  const body = fields.map(([k, v]) => `  ${k} = {${v}}`).join(",\n");
  return `@${type}{${bibKey(fm, paperId)},\n${body}\n}\n`;
}
