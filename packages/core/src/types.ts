/**
 * LogiXiv のデータモデル。
 *
 * 設計上いちばん重要な点は「構造データ（PDF から機械的に得られるもの）」と
 * 「注釈データ（人と Claude が積み上げるもの）」を分離していること。
 * 再解析で構造が作り直されても、注釈は文の正規化ハッシュで再結合されるので消えない。
 */

/** PDF ユーザー空間の矩形（左上原点、GROBID の teiCoordinates と同じ座標系）。 */
export interface Rect {
  /** 1 始まりのページ番号。 */
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageSize {
  page: number;
  width: number;
  height: number;
}

export interface Section {
  id: string;
  title: string;
  /** 1 = 章、2 = 節。GROBID の n 属性から推定する。 */
  level: number;
  order: number;
}

export interface Sentence {
  /** 文書内で一意。並び順に依存しない安定 ID。 */
  id: string;
  /** 正規化テキストの SHA-256（先頭 16 文字）。注釈の結合キー。 */
  hash: string;
  /** 文書全体での通し番号（0 始まり）。 */
  order: number;
  /** 文の先頭がある物理ページ。 */
  page: number;
  text: string;
  /** 行またぎの文は矩形が複数付く。GROBID が座標を返さなかった文では空配列。 */
  rects: Rect[];
  sectionId: string | null;
}

export type ParserKind = 'grobid' | 'fallback';

export interface DocumentStructure {
  /** 構造スキーマのバージョン。hash.ts の STRUCTURE_VERSION と揃える。 */
  version: number;
  parser: ParserKind;
  /** UI に「今どちらで解析されたか」を出すための説明文。 */
  parserNote: string;
  parsedAt: string;
  title: string | null;
  abstract: string | null;
  pageSizes: PageSize[];
  sections: Section[];
  sentences: Sentence[];
}

export type TranslationSource = 'claude' | 'human' | 'import';

export interface Translation {
  /** 対応する文の hash。 */
  sentenceHash: string;
  text: string;
  /** true の訳は機械が上書きしない。 */
  revisedByHuman: boolean;
  source: TranslationSource;
  updatedAt: string;
}

export interface Note {
  id: string;
  sentenceHash: string;
  body: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GlossaryEntry {
  term: string;
  translation: string;
  note: string | null;
}

export interface Annotations {
  /** キーは文の hash。 */
  translations: Record<string, Translation>;
  notes: Note[];
  glossary: GlossaryEntry[];
}

export interface PaperDocument {
  id: string;
  title: string;
  /** 元 PDF のファイル名（表示用）。 */
  sourceFileName: string;
  createdAt: string;
  updatedAt: string;
  structure: DocumentStructure;
  annotations: Annotations;
}

/** 書き出し HTML に埋め込む JSON のかたち。 */
export interface ExportPayload {
  format: 'logixiv-export';
  formatVersion: 1;
  exportedAt: string;
  document: PaperDocument;
  /** data URL ではなく生の base64。ビューアが Blob に組み立てる。 */
  pdfBase64: string;
}

export interface MergeReport {
  translationsAdded: number;
  translationsUpdated: number;
  translationsKept: number;
  notesAdded: number;
  notesSkippedAsDuplicate: number;
  glossaryAdded: number;
  /** 取り込み元にあったが、こちらの文書に対応する文が無かった注釈の数。 */
  orphaned: number;
}

export function emptyAnnotations(): Annotations {
  return { translations: {}, notes: [], glossary: [] };
}
