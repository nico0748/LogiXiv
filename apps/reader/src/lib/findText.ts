// PDF のページの文字列から、語句や文の位置（ページに対する割合の矩形）を探す。
// サーバー（server/pdftext.ts: AI エージェントのマーカー）と画面（用語を論文中で探す）で共有する。
// Node の機能は使わない。

import type { Rect } from "./model.ts";
import { type LaidItem, segmentRects, type Segment, toDisplay } from "./pageText.ts";

/**
 * 項目（src/lib/pageText.ts）。rect は 0〜1 に正規化した文字列全体の矩形で、縦は行の帯（lineBand）。
 * xs は各文字の左端・右端（ページ幅に対する割合）。描画命令から求めた実際のグリフの位置（src/lib/glyphs.ts）。
 * 対応が取れなかった文字は NaN、無いときは rect を文字数で按分する。
 * どちらも「フレーム」（文字が横に流れる向き）での値。回転したページでは表示の向きと違う（rotation）。
 */
type Item = LaidItem;

export interface PageText {
  page: number;
  /** ページの幅・高さ（pt、viewport の scale 1、表示の向き）。 */
  width: number;
  height: number;
  /**
   * フレームから表示の向きまでの時計回りの角度（0/90/180/270）。普通のページは 0。
   * items の矩形はフレームでの割合なので、表示の向きへは toDisplay で回す。
   */
  rotation: number;
  text: string;
  items: Item[];
}

export interface Match {
  page: number;
  rects: Rect[];
  /** PDF 上の実際の文字列（空白の違いを吸収したあとの原文） */
  text: string;
  /** 前後を含む本文。訳や用語の説明を作るときの文脈に使う */
  around: string;
}

const HYPHENS = /^[-‐‑­]$/;

/** 空白を除いた文字列と、各文字がどの項目の何文字目かの対応表を作る。dehyphen なら行末のハイフンを除く。 */
function flatten(p: PageText, dehyphen: boolean) {
  let flat = "";
  const map: [number, number][] = [];
  const all: [number, number][] = [];
  p.items.forEach((it, i) => {
    for (let c = 0; c < it.str.length; c++) if (!/\s/.test(it.str[c])) all.push([i, c]);
  });
  all.forEach(([i, c], k) => {
    const ch = p.items[i].str[c];
    if (dehyphen && HYPHENS.test(ch) && k + 1 < all.length) {
      const here = p.items[i].rect;
      const next = p.items[all[k + 1][0]].rect;
      // 次の文字が別の行にあれば、行末で語を割ったハイフンとみなす
      if (Math.abs(next.y - here.y) > Math.min(here.h, next.h) * 0.5) return;
    }
    flat += ch.toLowerCase();
    map.push([i, c]);
  });
  return { flat, map };
}

/**
 * 文の位置を探す。空白・改行の違いと大文字小文字、行末で語を割ったハイフンは無視する。
 * page を指定するとそのページだけを探す。
 */
export function findText(pages: PageText[], query: string, page?: number): Match | null {
  const q = query.replace(/\s+/g, "").toLowerCase();
  if (!q) return null;
  for (const dehyphen of [false, true]) {
    for (const p of pages) {
      if (page && p.page !== page) continue;
      const { flat, map } = flatten(p, dehyphen);
      const at = flat.indexOf(q);
      if (at < 0) continue;
      const [si, sc] = map[at];
      const [ei, ec] = map[at + q.length - 1];
      const segs: Segment[] = [];
      let text = "";
      for (let i = si; i <= ei; i++) {
        const it = p.items[i];
        const from = i === si ? sc : 0;
        const to = i === ei ? ec + 1 : it.str.length;
        if (!it.str.length || to <= from) continue;
        text += it.str.slice(from, to) + (i < ei ? " " : "");
        segs.push({ k: i, a: from, b: to });
      }
      // 画面で選んだマーカーと同じ関数で矩形にし、表示の向きへ回す
      const rects = segmentRects(p.items, segs).map((r) => toDisplay(r, p.rotation ?? 0));
      const flatText = p.text.replace(/\s+/g, " ");
      const words = text.replace(/\s+/g, " ").trim();
      const idx = flatText.indexOf(words.slice(0, 40));
      const around = idx >= 0 ? flatText.slice(Math.max(0, idx - 300), idx + words.length + 300) : words;
      return { page: p.page, rects, text: words, around };
    }
  }
  return null;
}

/**
 * 用語の見出しから、本文で探す語の候補を作る。
 * 「自己注意（self-attention）」なら、そのまま → 括弧の中（原語）→ 括弧の前、の順に試す。
 */
export function termNeedles(term: string): string[] {
  const t = term.trim();
  const out = [t];
  const m = t.match(/^(.*?)[（(]([^）)]+)[）)]\s*$/);
  if (m) out.push(m[2].trim(), m[1].trim());
  return [...new Set(out.filter((x) => x.length >= 2))];
}
