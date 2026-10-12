// PDF から本文を取り出す。AI エージェントが論文を読むときと、
// 指定された文の位置（マーカーを引く場所）を探すときに使う。

import fs from "node:fs/promises";
import { getDocument, Util } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Rect } from "../src/lib/model.ts";

interface Item {
  str: string;
  /** 0〜1 に正規化した文字列全体の矩形 */
  rect: Rect;
}

export interface PageText {
  page: number;
  text: string;
  items: Item[];
}

const cache = new Map<string, { mtime: number; pages: PageText[] }>();

/** PDF の全ページの文字と位置を読む。同じファイルは更新されるまで読み直さない。 */
export async function readPages(file: string): Promise<PageText[]> {
  const stat = await fs.stat(file);
  const hit = cache.get(file);
  if (hit && hit.mtime === stat.mtimeMs) return hit.pages;

  const data = new Uint8Array(await fs.readFile(file));
  const doc = await getDocument({ data, isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  const pages: PageText[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: Item[] = [];
      let text = "";
      for (const raw of content.items) {
        if (!("str" in raw)) continue;
        const tx = Util.transform(vp.transform, raw.transform);
        const h = Math.hypot(tx[2], tx[3]);
        items.push({
          str: raw.str,
          rect: { x: tx[4] / vp.width, y: (tx[5] - h) / vp.height, w: (raw.width * vp.scale) / vp.width, h: (h * 1.15) / vp.height },
        });
        text += raw.str + (raw.hasEOL ? "\n" : "");
      }
      pages.push({ page: n, text, items });
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  cache.set(file, { mtime: stat.mtimeMs, pages });
  if (cache.size > 8) cache.delete(cache.keys().next().value as string);
  return pages;
}

export interface Match {
  page: number;
  rects: Rect[];
  /** PDF 上の実際の文字列（空白の違いを吸収したあとの原文） */
  text: string;
  /** 前後を含む本文。訳や用語の説明を作るときの文脈に使う */
  around: string;
}

/**
 * 文の位置を探す。空白・改行の違いと大文字小文字は無視する。
 * page を指定するとそのページだけを探す。
 */
export function findText(pages: PageText[], query: string, page?: number): Match | null {
  const q = query.replace(/\s+/g, "").toLowerCase();
  if (!q) return null;
  for (const p of pages) {
    if (page && p.page !== page) continue;
    // 空白を除いた文字列と、各文字がどの項目の何文字目かの対応表を作る
    let flat = "";
    const map: [number, number][] = [];
    p.items.forEach((it, i) => {
      for (let c = 0; c < it.str.length; c++) {
        if (/\s/.test(it.str[c])) continue;
        flat += it.str[c].toLowerCase();
        map.push([i, c]);
      }
    });
    const at = flat.indexOf(q);
    if (at < 0) continue;
    const [si, sc] = map[at];
    const [ei, ec] = map[at + q.length - 1];
    const rects: Rect[] = [];
    let text = "";
    for (let i = si; i <= ei; i++) {
      const it = p.items[i];
      const from = i === si ? sc : 0;
      const to = i === ei ? ec + 1 : it.str.length;
      if (!it.str.length || to <= from) continue;
      const r = it.rect;
      rects.push({ x: r.x + (r.w * from) / it.str.length, y: r.y, w: (r.w * (to - from)) / it.str.length, h: r.h });
      text += it.str.slice(from, to) + (i < ei ? " " : "");
    }
    const flatText = p.text.replace(/\s+/g, " ");
    const words = text.replace(/\s+/g, " ").trim();
    const idx = flatText.indexOf(words.slice(0, 40));
    const around = idx >= 0 ? flatText.slice(Math.max(0, idx - 300), idx + words.length + 300) : words;
    return { page: p.page, rects: mergeLines(rects), text: words, around };
  }
  return null;
}

/** 同じ行に並ぶ矩形を1つにまとめる。 */
function mergeLines(rects: Rect[]) {
  const out: Rect[] = [];
  for (const r of rects) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - r.y) < r.h * 0.5 && r.x - (last.x + last.w) < 0.02) {
      const x2 = Math.max(last.x + last.w, r.x + r.w);
      last.x = Math.min(last.x, r.x);
      last.w = x2 - last.x;
      last.h = Math.max(last.h, r.h);
    } else out.push({ ...r });
  }
  return out;
}
