// PDF から本文を取り出す。AI エージェントが論文を読むときと、
// 指定された文の位置（マーカーを引く場所）を探すときに使う。

import fs from "node:fs/promises";
import { attachGlyphs, type FontLike, layoutGlyphs } from "../src/lib/glyphs.ts";
import type { Rect } from "../src/lib/model.ts";
import { type PageText, findText, type Match } from "../src/lib/findText.ts";
import { type LaidItem, layoutItems, mergeLineRects, type TextItemLike, textRotation } from "../src/lib/pageText.ts";
import { pdfjs } from "./pdfjs.ts";

export { type PageText, findText, type Match };

type Item = LaidItem;

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
  const { AnnotationMode, getDocument, OPS } = await pdfjs();
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

/** 同じ行に並ぶ矩形を1つにまとめる（縦横とも外接矩形。画面の選択と同じ src/lib/pageText.ts の関数）。 */
export function mergeLines(rects: Rect[]): Rect[] {
  return mergeLineRects(rects);
}
