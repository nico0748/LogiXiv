// Claude に送る指示の組み立て。文体・訳語の固定・送る本文の量・訳す言語を設定から反映する。
// SDK は使わない純粋な関数だけを置く（テストしやすいように claude.ts から分けている）。

import type { AiSettings, ContextSize, GlossPair, TargetLang } from "./prefs.ts";

export const DEFAULT_STYLE: Record<TargetLang, string> = {
  ja: `日本語は次の方針で書く。
- 学術的な平叙文（である調）。1文は40字前後を目安にし、読点は1文に2つまで。
- 比喩や誇張を使わない。「〜と言えるでしょう」のような締めの言葉を付けない。
- 原文にない主張や数値を足さない。原文の条件や数値はそのまま残す。
- 専門用語は日本語の定訳を使い、初出で英語を括弧で添える。例: 自己注意（self-attention）。定訳が無い語は英語のまま書く。
- 指示語（これ、それ）より具体的な名詞を使う。`,
  en: `英語は次の方針で書く。
- 学術論文の平叙文。1文は25語前後を目安にする。
- 比喩や誇張を使わない。原文にない主張や数値を足さない。原文の条件や数値はそのまま残す。
- 専門用語は分野で通用する英語の用語を使う。`,
};

export const LANG_LABEL: Record<TargetLang, string> = { ja: "日本語", en: "英語" };

/** 選んだ範囲の前後に添える文字数（片側） */
export const CONTEXT_CHARS: Record<ContextSize, number> = { less: 250, normal: 600, more: 1500 };

export const langOf = (s: AiSettings): TargetLang => s.lang ?? "ja";

export function styleOf(s: AiSettings): string {
  const lang = langOf(s);
  return s.style?.[lang]?.trim() || DEFAULT_STYLE[lang];
}

/**
 * 前後の本文を、選んだ文の前後 chars 文字ずつに切り詰める。
 * 選んだ文が見つからないときは先頭から chars * 2 文字。
 */
export function trimAround(around: string, text: string, chars: number): string {
  if (around.length <= text.length + chars * 2) return around;
  const key = text.slice(0, 40);
  const i = key ? around.indexOf(key) : -1;
  if (i < 0) return around.slice(0, chars * 2);
  return around.slice(Math.max(0, i - chars), i + text.length + chars);
}

/**
 * 訳語の固定のうち、送る文に語として出てくるものだけ（大文字と小文字は区別しない）。
 * 英数字の語は前後が英数字でないときだけ当てる（"head" は "ahead" に当てない）。入力の途中の空白は除く。
 */
export function glossaryFor(pairs: GlossPair[] | undefined, ...texts: string[]): GlossPair[] {
  if (!pairs?.length) return [];
  const hay = texts.join("\n");
  return pairs.flatMap((p) => {
    const en = p.en.trim();
    const ja = p.ja.trim();
    if (!en || !ja) return [];
    const esc = en.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, "i");
    return re.test(hay) ? [{ en, ja }] : [];
  });
}

/** システムプロンプトに添える訳語の指示。対象が無ければ空文字 */
export function glossaryRule(pairs: GlossPair[]): string {
  if (!pairs.length) return "";
  return `\n次の語は、決められた訳語を使う。\n${pairs.map((p) => `- ${p.en} → ${p.ja}`).join("\n")}`;
}

/**
 * 用語の見出しから訳語の対を取り出す。「日本語（English）」と「English（日本語）」の形に対応する。
 * どちらも英語か日本語のときは null。
 */
export function termToPair(term: string): GlossPair | null {
  const m = term.trim().match(/^(.+?)\s*[（(]\s*(.+?)\s*[）)]$/);
  if (!m) return null;
  const [a, b] = [m[1].trim(), m[2].trim()];
  const latin = (s: string) => /^[\x20-\x7e]+$/.test(s) && /[A-Za-z]/.test(s);
  if (latin(b) && !latin(a)) return { en: b, ja: a };
  if (latin(a) && !latin(b)) return { en: a, ja: b };
  return null;
}

/** 対訳の用語集の項目（英語の語と短い訳）を訳語の対にする。説明文のように長いものは使わない */
export function glossaryItemToPair(term: string, meaning: string): GlossPair | null {
  const fromTerm = termToPair(term);
  if (fromTerm) return fromTerm;
  const en = term.trim();
  const ja = meaning.trim();
  if (!en || !ja || ja.length > 24 || /[。．.]/.test(ja)) return null;
  if (!/^[\x20-\x7e]+$/.test(en) || /^[\x20-\x7e]+$/.test(ja)) return null;
  return { en, ja };
}

/** 既にある対（英語の語で比べる）を除いて足す。足した数も返す */
export function mergeGlossary(base: GlossPair[], add: GlossPair[]): { list: GlossPair[]; added: number } {
  const seen = new Set(base.map((p) => p.en.trim().toLowerCase()));
  const list = [...base];
  for (const p of add) {
    const k = p.en.trim().toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    list.push(p);
  }
  return { list, added: list.length - base.length };
}
