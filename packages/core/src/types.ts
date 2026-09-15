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

/** 「これは訳す対象ではない」と判断した文の記録。 */
export interface SkippedSentence {
  sentenceHash: string;
  /** なぜ訳さないのか。参考文献・図表・数式・柱など。 */
  reason: string;
  at: string;
}

/**
 * 文の区切りを人が直した記録。
 *
 * 構造そのものではなく注釈として持つ。構造は再解析で作り直されるが、この記録は
 * 残るので、同じ直しを二度やらなくてよい。対象は hash で指すので、本文が
 * 変わらない限り追随する。適用できなくなった編集は読み出し時に黙って飛ばす。
 */
export interface SentenceEdit {
  id: string;
  /** merge = 連続する複数文を 1 文に、split = 1 文を複数に。 */
  type: 'merge' | 'split';
  /** merge のときは結合する文の hash を順に、split のときは対象 1 件。 */
  hashes: string[];
  /** split のときだけ使う、原文テキスト内の分割位置（昇順）。 */
  offsets?: number[];
  /**
   * 対象の原文そのもの。hash はここから計算できる。
   *
   * 正規化規則を変えた（STRUCTURE_VERSION を上げた）とき、hash だけでは付け替えられない。
   * 構造側の文はもう結合・分割済みで、編集前の文はどこにも残っていないため。
   */
  sourceTexts?: string[];
  /**
   * 取り消し用。merge なら「結合後の hash と元の境目」、split なら「分割後の hash 列」。
   * これが無いと取り消しに再解析が要る（数十秒かかるので、実質「戻せない」になる）。
   *
   * joiners は分割を戻すときに断片を繋ぐ文字列。単語の途中で切った場合は空文字になる。
   * ここで空白を決め打ちすると、戻した文が元と違う本文になり訳がはぐれる。
   * occurrences は適用された箇所の数。元から在った同じ本文の文まで巻き込まないための上限。
   */
  undo?: { hashes: string[]; offsets?: number[]; joiners?: string[]; occurrences?: number };
  createdAt: string;
}

export interface Annotations {
  /** キーは文の hash。 */
  translations: Record<string, Translation>;
  notes: Note[];
  glossary: GlossaryEntry[];
  /**
   * 訳さないと判断した文（キーは hash）。未訳の集計から外れる。
   *
   * これが無いと「参考文献の断片なので訳さない」と決めた文が毎回未訳として返り、
   * 翻訳の手順が永久に終わらない。古い保存データには無いので任意。
   */
  skipped?: Record<string, SkippedSentence>;
  /** 文の分割・結合の記録。適用順に並ぶ。古い保存データには無いので任意。 */
  sentenceEdits?: SentenceEdit[];
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
  return { translations: {}, notes: [], glossary: [], skipped: {}, sentenceEdits: [] };
}
