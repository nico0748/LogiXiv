import type { Annotations, PaperDocument } from './types.ts';
import {
  EXPORT_DATA_ELEMENT_ID,
  EXPORT_FORMAT,
  LEGACY_EXPORT_DATA_ELEMENT_IDS,
  LEGACY_EXPORT_FORMATS,
} from './export.ts';

/** 書き出しデータとみなす script の id。改名前の書き出しも読めるよう古い id も含める。 */
const DATA_ELEMENT_IDS = new Set([EXPORT_DATA_ELEMENT_ID, ...LEGACY_EXPORT_DATA_ELEMENT_IDS]);
const ACCEPTED_FORMATS = new Set([EXPORT_FORMAT, ...LEGACY_EXPORT_FORMATS]);
import { decodeEntities } from './xml.ts';
import { newId } from './hash.ts';
import { sanitizeAnnotations, sanitizeDocument, emptySanitizeReport, isRecord, type SanitizeReport } from './validate.ts';

/**
 * 他人が書き出した HTML の読み込み。
 *
 * ここで守る一線は「埋め込まれた JS を絶対に実行しない」こと。
 * 取り込みは該当の script 要素を切り出して JSON.parse するだけで、
 * DOM も作らないし eval も new Function も使わない。
 * 論文の書き出しは人づてに回るファイルなので、実行経路を残さない。
 *
 * 探索は正規表現ではなく線形スキャンで行う。理由は 2 つ:
 *  - `<script[^>]*id=...>` は一致しない入力でバックトラックし、入力長に対して二次で劣化する
 *    （PaperLens 製でない大きな HTML を投げたとき＝いちばん起きやすい誤操作で固まる）
 *  - 属性値に `>` を含む script タグを取りこぼす
 * さらに、該当 script が複数あるときは「最初の 1 つ」を黙って採らずエラーにする。
 * 本物の前に偽のデータ script を置いた HTML を配られる経路を残さないため。
 */

export class ImportError extends Error {}

/** 取り込み対象の HTML の上限。これを超えるものは書き出しではなく事故とみなす。 */
const MAX_HTML_BYTES = 400 * 1024 * 1024;

interface FoundScript {
  json: string;
  at: number;
}

/**
 * HTML の属性を読む。**XML 用の parseAttrs は使わない。**
 *
 * HTML の要素名と属性名は大文字小文字を区別せず、属性値は引用符が無くてもよい。
 * XML の規則で読むと `<SCRIPT id=paperlens-data>` がこちらには見えず、ブラウザには
 * 見える、という食い違いが作れる。取り込んだ側とビューアが別の payload を読む状態は、
 * 「同じファイルなのに人によって中身が違う」という最悪の壊れ方になる。
 */
function parseHtmlAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    if (match[0].trim().length === 0) {
      if (re.lastIndex === match.index) re.lastIndex++;
      continue;
    }
    const name = match[1]!.toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? '');
  }
  return attrs;
}

/**
 * 開始タグの終わりを探す。**HTML の状態機械に従う。**
 *
 * XML 用の findTagEnd は引用符を無条件に区切りとして扱うので、
 * `id=paperlens-data data-x=a'b>` のように引用符なしの値に `'` が混ざると
 * そこから引用中だと思い込み、タグの終わりを見失う。
 * ブラウザは `'` を値の一部として読むので、そこで両者の見え方が割れる。
 */
function findHtmlTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | null = null;
  let expectingValue = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '=') {
      expectingValue = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // 値の開始位置にある引用符だけが区切り。値の途中の `'` はただの文字。
      if (expectingValue) quote = ch;
      expectingValue = false;
      continue;
    }
    if (ch === '>') return i;
    if (!/\s/.test(ch)) expectingValue = false;
  }
  return -1;
}

/**
 * ブラウザから見えない領域を飛ばす。
 *
 * コメントの中と <template> の中は、`document.querySelectorAll` が返さない。
 * ここを読んでしまうと、ブラウザには 1 つしか見えない文書を
 * 「データが 2 個あるので取り込めない」と断ったり、逆に仕掛けられた偽の payload を
 * 本物として読んだりする。生テキスト要素（textarea・title・noscript）も同じ理由で飛ばす。
 */
const HIDDEN_REGIONS: { open: RegExp; close: string }[] = [
  { open: /^<!--/, close: '-->' },
  { open: /^<template[\s>]/, close: '</template' },
  { open: /^<textarea[\s>]/, close: '</textarea' },
  { open: /^<title[\s>]/, close: '</title' },
  { open: /^<noscript[\s>]/, close: '</noscript' },
];

function findDataScripts(html: string): FoundScript[] {
  // 走査は小文字化した写しの上で行う（位置は元の文字列と 1 対 1 で対応する）。
  const lower = html.toLowerCase();
  const found: FoundScript[] = [];
  let cursor = 0;

  while (cursor < html.length) {
    const open = lower.indexOf('<', cursor);
    if (open === -1) break;

    const hidden = HIDDEN_REGIONS.find((region) => region.open.test(lower.slice(open, open + 12)));
    if (hidden) {
      const end = lower.indexOf(hidden.close, open + 1);
      cursor = end === -1 ? html.length : end + hidden.close.length;
      continue;
    }

    if (!lower.startsWith('<script', open) || /[a-z0-9_-]/.test(lower[open + 7] ?? '')) {
      cursor = open + 1;
      continue;
    }

    const tagEnd = findHtmlTagEnd(html, open + 7);
    if (tagEnd === -1) {
      // 読めないタグでも走査は止めない。1 つの壊れたタグで残り全部が見えなくなると、
      // その後ろにある本物のデータを見落とす。
      cursor = open + 7;
      continue;
    }

    const attrs = parseHtmlAttrs(html.slice(open + 7, tagEnd));
    const close = lower.indexOf('</script', tagEnd + 1);
    const bodyEnd = close === -1 ? html.length : close;
    if (DATA_ELEMENT_IDS.has(attrs['id'] ?? '')) {
      found.push({ json: html.slice(tagEnd + 1, bodyEnd), at: open });
    }
    cursor = close === -1 ? html.length : close + 8;
  }
  return found;
}

export function extractPayloadJson(html: string): string {
  const found = findDataScripts(html);
  if (found.length === 0) {
    throw new ImportError('PaperLens の書き出しデータが見つかりません（この HTML は PaperLens 製ではないかもしれません）');
  }
  if (found.length > 1) {
    throw new ImportError(
      `PaperLens の書き出しデータが ${found.length} 個見つかりました。どれが本物か判断できないため取り込みません。`,
    );
  }
  return found[0]!.json;
}

export interface ParsedImport {
  exportedAt: string;
  documentTitle: string;
  /** 取り込み元の文書 ID（表示用。こちらの ID としては使わない）。 */
  documentId: string;
  /** 検証済みの注釈。既存文書へのマージはこれを使う。 */
  annotations: Annotations;
  /** 取り込み元の全文ハッシュ（今の正規化規則で作り直した値）。重なり具合の判定に使う。 */
  sentenceHashes: string[];
  /**
   * 取り込み元が名乗っていた構造バージョン（書かれていなければ null）。
   *
   * `document.structure.version` は sanitize が今の規則に揃えてしまうので、
   * 「新しい版で書かれたものを断る」の判断はこちらを見る。
   */
  declaredStructureVersion: number | null;
  /** PDF も含まれていた場合のみ。新規文書として取り込むときに使う。 */
  pdfBase64: string | null;
  /**
   * 検証済みの文書。新規文書として取り込むときはこれをそのまま保存してよい。
   * 生の JSON は**公開しない** — 型で嘘をつくと、その先の保存処理が必ず信用してしまう。
   */
  document: PaperDocument | null;
  /** 検証で落とした件数。 */
  sanitizeReport: SanitizeReport;
}

export function parseExportHtml(html: string): ParsedImport {
  if (html.length > MAX_HTML_BYTES) {
    throw new ImportError('HTML が大きすぎます');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractPayloadJson(html));
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError('埋め込みデータの JSON を解析できませんでした');
  }
  if (!isRecord(parsed)) throw new ImportError('埋め込みデータの形式が不正です');
  if (typeof parsed['format'] !== 'string' || !ACCEPTED_FORMATS.has(parsed['format'])) {
    throw new ImportError('PaperLens の書き出し形式ではありません');
  }
  if (parsed['formatVersion'] !== 1) {
    throw new ImportError(`未対応の書き出しバージョンです: ${String(parsed['formatVersion'])}`);
  }
  const rawDocument = parsed['document'];
  if (!isRecord(rawDocument)) throw new ImportError('document がありません');

  const { document, report } = sanitizeDocument(rawDocument, { id: newId('doc') });
  // マージ用の注釈は document と同じ検証結果を使う（二重に検証しない）。
  const annotations = document.annotations;

  const pdfBase64 = typeof parsed['pdfBase64'] === 'string' ? parsed['pdfBase64'] : null;
  const hasPdf = pdfBase64 !== null && /^[A-Za-z0-9+/=\s]*$/.test(pdfBase64.slice(0, 4096));

  return {
    exportedAt: typeof parsed['exportedAt'] === 'string' ? parsed['exportedAt'] : new Date(0).toISOString(),
    documentTitle: document.title,
    documentId: typeof rawDocument['id'] === 'string' ? rawDocument['id'] : 'unknown',
    annotations,
    sentenceHashes: document.structure.sentences.map((s) => s.hash),
    declaredStructureVersion: report.declaredStructureVersion,
    pdfBase64: hasPdf ? pdfBase64 : null,
    document: document.structure.sentences.length > 0 ? document : null,
    sanitizeReport: report,
  };
}

/** 注釈だけを検証したいとき（テストや外部ツール向け）。 */
export function sanitizeImportedAnnotations(value: unknown): Annotations {
  return sanitizeAnnotations(value, emptySanitizeReport());
}

/**
 * 取り込み元と取り込み先がどれだけ同じ文を持っているか（0〜1）。
 *
 * 取り込みの前に「これは同じ論文か」を判断するための関門。低いまま通すと、
 * 別の論文の用語集と訳がこの文書に混ざり、以後 Claude はその訳語方針に従う。
 * 文が 1 つも無い書き出し（注釈だけ）は判断材料が無いので 0 を返す。
 * 呼び出し側はその場合を「低い」ではなく「判定できない」として扱うこと。
 */
export function overlapRatio(incoming: ParsedImport, target: PaperDocument): number {
  if (incoming.sentenceHashes.length === 0) return 0;
  const targetHashes = new Set(target.structure.sentences.map((s) => s.hash));
  let shared = 0;
  for (const hash of incoming.sentenceHashes) {
    if (targetHashes.has(hash)) shared++;
  }
  return shared / incoming.sentenceHashes.length;
}
