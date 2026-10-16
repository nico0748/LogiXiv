// PDF から本文を取り出す。AI エージェントが論文を読むときと、
// 指定された文の位置（マーカーを引く場所）を探すときに使う。

import fs from "node:fs/promises";
import { AnnotationMode, getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { attachGlyphs, type FontLike, layoutGlyphs } from "../src/lib/glyphs.ts";
import type { Rect } from "../src/lib/model.ts";
import { type LaidItem, layoutItems, mergeLineRects, segmentRects, type Segment, type TextItemLike, textRotation, toDisplay } from "../src/lib/pageText.ts";

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

const cache = new Map<string, { mtime: number; glyphs: boolean; pages: PageText[] }>();

/**
 * PDF の全ページの文字と位置を読む。同じファイルは更新されるまで読み直さない。
 * glyphs を true にすると、マーカー用に各文字の実際の横位置も求める（描画命令を読むので遅い）。
 */
export async function readPages(file: string, opts: { glyphs?: boolean } = {}): Promise<PageText[]> {
  const stat = await fs.stat(file);
  const hit = cache.get(file);
  if (hit && hit.mtime === stat.mtimeMs && (hit.glyphs || !opts.glyphs)) return hit.pages;

  const data = new Uint8Array(await fs.readFile(file));
  const doc = await getDocument({ data, isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  const pages: PageText[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const raws = content.items.filter((i): i is typeof i & TextItemLike => "str" in i);
      // 文字が横に流れる向きで並べる（/Rotate だけ立てた PDF では表示の向きと違う）
      const frameRotation = textRotation(raws, vp.rotation, (rotation) => page.getViewport({ scale: 1, rotation }));
      const fvp = frameRotation === vp.rotation ? vp : page.getViewport({ scale: 1, rotation: frameRotation });
      const items: Item[] = layoutItems(raws, content.styles, fvp);
      const text = raws.map((raw) => raw.str + (raw.hasEOL ? "\n" : "")).join("");
      if (opts.glyphs) {
        try {
          const ops = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
          const getFont = (name: string) => {
            try {
              return page.commonObjs.has(name) ? (page.commonObjs.get(name) as FontLike) : null;
            } catch {
              return null;
            }
          };
          const glyphs = layoutGlyphs(OPS, ops.fnArray, ops.argsArray, getFont, fvp.transform);
          const xs = attachGlyphs(items.map((it) => it.str), glyphs, fvp.width);
          if (xs) items.forEach((it, i) => (it.xs = xs[i]));
        } catch {
          // 描画命令が読めなくても、文字数での按分にはできる
        }
      }
      pages.push({ page: n, width: vp.width, height: vp.height, rotation: (vp.rotation - frameRotation + 360) % 360, text, items });
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  cache.set(file, { mtime: stat.mtimeMs, glyphs: !!opts.glyphs, pages });
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

/** 同じ行に並ぶ矩形を1つにまとめる（縦横とも外接矩形。画面の選択と同じ src/lib/pageText.ts の関数）。 */
export function mergeLines(rects: Rect[]): Rect[] {
  return mergeLineRects(rects);
}
