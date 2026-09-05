import type { Annotations, ExportPayload, Note, PaperDocument, Translation } from './types.ts';
import { EXPORT_DATA_ELEMENT_ID } from './export.ts';

/**
 * 他人が書き出した HTML の読み込み。
 *
 * ここで守る一線は「埋め込まれた JS を絶対に実行しない」こと。
 * 取り込みは正規表現で JSON の script 要素を切り出して JSON.parse するだけで、
 * DOM も作らないし eval も new Function も使わない。
 * 論文の書き出しは人づてに回るファイルなので、実行経路を残さない。
 */

export class ImportError extends Error {}

const DATA_RE = new RegExp(
  `<script[^>]*\\bid=["']${EXPORT_DATA_ELEMENT_ID}["'][^>]*>([\\s\\S]*?)</script\\s*>`,
  'i',
);

export function extractPayloadJson(html: string): string {
  const match = DATA_RE.exec(html);
  if (!match || match[1] === undefined) {
    throw new ImportError('LogiXiv の書き出しデータが見つかりません（この HTML は LogiXiv 製ではないかもしれません）');
  }
  return match[1];
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ImportError(`${field} が文字列ではありません`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 取り込み側で信用するのは注釈だけ。構造は取り込み先のものを使う。 */
function sanitizeAnnotations(input: unknown): Annotations {
  if (!isRecord(input)) return { translations: {}, notes: [], glossary: [] };

  const translations: Record<string, Translation> = {};
  if (isRecord(input['translations'])) {
    for (const [hash, raw] of Object.entries(input['translations'])) {
      if (!isRecord(raw)) continue;
      const text = typeof raw['text'] === 'string' ? raw['text'] : null;
      if (text === null) continue;
      const source = raw['source'];
      translations[hash] = {
        sentenceHash: hash,
        text,
        revisedByHuman: raw['revisedByHuman'] === true,
        source: source === 'human' || source === 'claude' ? source : 'import',
        updatedAt: typeof raw['updatedAt'] === 'string' ? raw['updatedAt'] : new Date(0).toISOString(),
      };
    }
  }

  const notes: Note[] = [];
  if (Array.isArray(input['notes'])) {
    for (const raw of input['notes']) {
      if (!isRecord(raw)) continue;
      const body = typeof raw['body'] === 'string' ? raw['body'] : null;
      const sentenceHash = typeof raw['sentenceHash'] === 'string' ? raw['sentenceHash'] : null;
      if (body === null || sentenceHash === null) continue;
      const createdAt = typeof raw['createdAt'] === 'string' ? raw['createdAt'] : new Date(0).toISOString();
      notes.push({
        id: typeof raw['id'] === 'string' ? raw['id'] : `note_imported_${notes.length}`,
        sentenceHash,
        body,
        author: typeof raw['author'] === 'string' ? raw['author'] : null,
        createdAt,
        updatedAt: typeof raw['updatedAt'] === 'string' ? raw['updatedAt'] : createdAt,
      });
    }
  }

  const glossary: Annotations['glossary'] = [];
  if (Array.isArray(input['glossary'])) {
    for (const raw of input['glossary']) {
      if (!isRecord(raw)) continue;
      if (typeof raw['term'] !== 'string' || typeof raw['translation'] !== 'string') continue;
      glossary.push({
        term: raw['term'],
        translation: raw['translation'],
        note: typeof raw['note'] === 'string' ? raw['note'] : null,
      });
    }
  }

  return { translations, notes, glossary };
}

export interface ParsedImport {
  exportedAt: string;
  documentTitle: string;
  documentId: string;
  annotations: Annotations;
  /** 取り込み元の全文ハッシュ。どれだけ重なっているかを UI に出すために使う。 */
  sentenceHashes: string[];
  /** PDF も含まれていた場合のみ。新規文書として取り込むときに使う。 */
  pdfBase64: string | null;
  /** 元の構造。新規文書として取り込むときだけ使う。 */
  raw: ExportPayload | null;
}

export function parseExportHtml(html: string): ParsedImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractPayloadJson(html));
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError('埋め込みデータの JSON を解析できませんでした');
  }
  if (!isRecord(parsed)) throw new ImportError('埋め込みデータの形式が不正です');
  if (parsed['format'] !== 'logixiv-export') {
    throw new ImportError('LogiXiv の書き出し形式ではありません');
  }
  if (parsed['formatVersion'] !== 1) {
    throw new ImportError(`未対応の書き出しバージョンです: ${String(parsed['formatVersion'])}`);
  }
  const document = parsed['document'];
  if (!isRecord(document)) throw new ImportError('document がありません');
  const structure = isRecord(document['structure']) ? document['structure'] : null;
  const sentences = structure && Array.isArray(structure['sentences']) ? structure['sentences'] : [];

  const sentenceHashes: string[] = [];
  for (const sentence of sentences) {
    if (isRecord(sentence) && typeof sentence['hash'] === 'string') sentenceHashes.push(sentence['hash']);
  }

  return {
    exportedAt: typeof parsed['exportedAt'] === 'string' ? parsed['exportedAt'] : new Date(0).toISOString(),
    documentTitle: typeof document['title'] === 'string' ? document['title'] : '(無題)',
    documentId: asString(document['id'] ?? 'unknown', 'document.id'),
    annotations: sanitizeAnnotations(document['annotations']),
    sentenceHashes,
    pdfBase64: typeof parsed['pdfBase64'] === 'string' ? parsed['pdfBase64'] : null,
    raw: parsed as unknown as ExportPayload,
  };
}

/** 取り込み元と取り込み先がどれだけ同じ文を持っているか。 */
export function overlapRatio(incoming: ParsedImport, target: PaperDocument): number {
  if (incoming.sentenceHashes.length === 0) return 0;
  const targetHashes = new Set(target.structure.sentences.map((s) => s.hash));
  let shared = 0;
  for (const hash of incoming.sentenceHashes) {
    if (targetHashes.has(hash)) shared++;
  }
  return shared / incoming.sentenceHashes.length;
}
