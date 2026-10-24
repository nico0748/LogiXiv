// スライドの取り込み。PPTX は PDF に変換してから置く（画面は PDF と同じ pdf.js で描く）。
//
// 変換は、端末にあるアプリを次の順に試す。
//   1. LibreOffice（環境変数 PAPERLENS_SOFFICE、PATH の soffice / libreoffice、macOS の LibreOffice.app）
//   2. macOS の Keynote（AppleScript で開いて PDF に書き出す。初回は「オートメーション」の許可を求められる）
// どれも無ければ、PDF に書き出してから取り込むよう伝える。
// PowerPoint の自動操作は使わない。開いた文書を確実に指せず（利用者が開いている別のプレゼンを閉じるおそれがある）、
// サンドボックスのため一時フォルダのファイルを開けないことがあるため。

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Rect } from "../src/lib/model.ts";
import { type SlideDeck, markupName, overlapRatio, putSlides, slidesPdfPath, sortMarkups } from "../src/lib/slides.ts";
import type { NodeVault } from "./nodeVault.ts";
import { pdfjs } from "./pdfjs.ts";
import { readPages } from "./pdftext.ts";
import { requirePaper } from "./service.ts";

export class SlidesConvertError extends Error {}

const run = (file: string, args: string[], timeout: number) =>
  new Promise<void>((resolve, reject) => {
    execFile(file, args, { timeout }, (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve()));
  });

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function which(name: string) {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const ext of exts) if (dir && (await exists(path.join(dir, name + ext)))) return path.join(dir, name + ext);
  }
  return null;
}

async function findSoffice() {
  if (process.env.PAPERLENS_SOFFICE) return process.env.PAPERLENS_SOFFICE;
  for (const n of ["soffice", "libreoffice"]) {
    const p = await which(n);
    if (p) return p;
  }
  const candidates =
    process.platform === "darwin"
      ? ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]
      : process.platform === "win32"
        ? ["C:\\Program Files\\LibreOffice\\program\\soffice.exe", "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe"]
        : [];
  for (const c of candidates) if (await exists(c)) return c;
  return null;
}

const KEYNOTE = "/Applications/Keynote.app";

/** AppleScript の文字列に入れる */
const as = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// 開いた文書だけを閉じる。書き出しに失敗しても閉じてから、誤りを返す。
// Apple Event の既定の待ち時間（120 秒）より長く待つ
const keynoteScript = (src: string, out: string) => `
with timeout of 170 seconds
  tell application "Keynote"
    set d to open (POSIX file ${as(src)})
    try
      export d to (POSIX file ${as(out)}) as PDF
    on error msg
      close d saving no
      error msg
    end try
    close d saving no
  end tell
end timeout`;

/** 変換に使える方法の名前（設定画面やエラーの文言に出す） */
export async function converters(): Promise<string[]> {
  const out: string[] = [];
  if (await findSoffice()) out.push("LibreOffice");
  if (process.platform === "darwin" && (await exists(KEYNOTE))) out.push("Keynote");
  return out;
}

/** PPTX を PDF に変換する。試した方法がすべて失敗したら SlidesConvertError */
export async function pptxToPdf(data: ArrayBuffer): Promise<ArrayBuffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperlens-slides-"));
  const src = path.join(dir, "slides.pptx");
  const out = path.join(dir, "slides.pdf");
  const tried: string[] = [];
  try {
    await fs.writeFile(src, new Uint8Array(data));
    const attempts: [string, () => Promise<void>][] = [];
    const soffice = await findSoffice();
    if (soffice) {
      // 利用者が開いている LibreOffice とプロファイルを分ける（同じプロファイルだと、何もせずに終わることがある）
      const profile = pathToFileURL(path.join(dir, "profile")).href;
      attempts.push(["LibreOffice", () => run(soffice, [`-env:UserInstallation=${profile}`, "--headless", "--norestore", "--convert-to", "pdf", "--outdir", dir, src], 180_000)]);
    }
    if (process.platform === "darwin" && (await exists(KEYNOTE))) {
      attempts.push(["Keynote", () => run("osascript", ["-e", keynoteScript(src, out)], 180_000)]);
    }
    for (const [name, fn] of attempts) {
      try {
        await fn();
        const b = await fs.readFile(out);
        if (b.subarray(0, 5).toString("latin1") === "%PDF-") return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
        tried.push(`${name}（PDF ができませんでした）`);
      } catch (e) {
        // 一時フォルダのパスなど、利用者に意味のない部分は出さない
        const raw = (e as NodeJS.ErrnoException).code === "ENOENT" ? "PDF ができませんでした" : e instanceof Error ? e.message : String(e);
        const msg = raw.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("Command failed")).pop() ?? "";
        tried.push(`${name}（${msg.replaceAll(dir, "…").slice(0, 160) || "変換に失敗しました"}）`);
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  throw new SlidesConvertError(
    tried.length
      ? `PPTX を PDF に変換できませんでした。試した方法: ${tried.join("、")}。PowerPoint などで PDF に書き出してから取り込んでください。`
      : "PPTX を PDF に変換するアプリ（LibreOffice か Keynote）が見つかりません。LibreOffice を入れるか、PowerPoint などで PDF に書き出してから取り込んでください。",
  );
}

/** PPTX か。拡張子で決め、拡張子が無いときは ZIP の中に ppt/ があるかで見分ける */
export function isPptx(name: string, data: ArrayBuffer) {
  if (/\.pptx$/i.test(name)) return true;
  if (/\.[a-z0-9]{1,5}$/i.test(name)) return false;
  const head = new Uint8Array(data.slice(0, 64 * 1024));
  return head[0] === 0x50 && head[1] === 0x4b && new TextDecoder("latin1").decode(head).includes("ppt/");
}

/** pdf.js で開けるか確かめる。先頭が %PDF でも中身が壊れていれば、前のスライドを上書きしない */
async function checkPdf(data: ArrayBuffer) {
  if (!new TextDecoder().decode(new Uint8Array(data.slice(0, 5))).startsWith("%PDF")) return; // putSlides がわかる言葉で断る
  try {
    const { getDocument } = await pdfjs();
    const doc = await getDocument({ data: new Uint8Array(data.slice(0)), isEvalSupported: false, verbosity: 0 }).promise;
    const n = doc.numPages;
    await doc.destroy();
    if (n < 1) throw new Error("ページがありません");
  } catch (e) {
    throw new Error(`スライドの PDF を開けませんでした（${e instanceof Error ? e.message : String(e)}）。今のスライドはそのまま残しています。`);
  }
}

/** PDF か PPTX のスライドを、論文に取り込む */
export async function importSlides(vault: NodeVault, id: string, fileName: string, data: ArrayBuffer, convert = pptxToPdf): Promise<SlideDeck> {
  await requirePaper(vault, id);
  if (/\.(ppt|key|odp|potx|ppsx|pps)$/i.test(fileName)) throw new Error("この形式のスライドはそのまま取り込めません。PPTX か PDF に書き出してから取り込んでください。");
  if (isPptx(fileName, data)) {
    const pdf = await convert(data);
    await checkPdf(pdf);
    return putSlides(vault, id, fileName, pdf, data);
  }
  await checkPdf(data);
  return putSlides(vault, id, fileName, data);
}

/** スライドの各マークアップの中にある文字（AI エージェントが論文と対応づけるときに使う） */
export async function markupTexts(vault: NodeVault, id: string, deck: SlideDeck) {
  const pages = await readPages(vault.resolve(slidesPdfPath(id)));
  return sortMarkups(deck.markups).map((m) => ({
    name: markupName(m),
    text: textIn(pages.find((p) => p.page === m.page)?.items ?? [], m.rect),
  }));
}

function textIn(items: { str: string; rect: Rect }[], box: Rect) {
  return items
    .filter((it) => it.str.trim() && overlapRatio(it.rect, box) >= 0.5)
    .map((it) => it.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** スライドのページ数 */
export async function slideCount(vault: NodeVault, id: string) {
  const { getDocument } = await pdfjs();
  const doc = await getDocument({ data: new Uint8Array(await fs.readFile(vault.resolve(slidesPdfPath(id)))), isEvalSupported: false, verbosity: 0 }).promise;
  try {
    return doc.numPages;
  } finally {
    await doc.destroy();
  }
}
