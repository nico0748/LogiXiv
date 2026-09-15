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
  /** merge のときだけ使う、断片を繋ぐ文字列。既定は空白 1 個。 */
  joiners?: string[];
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
   * occurrences は適用された箇所の数、at はその通し番号。
   * 件数だけでは「何か所戻すか」しか決まらず、同じ本文が手前にもあると
   * 編集していない方をほどいてしまう。
   */
  undo?: {
    hashes: string[];
    offsets?: number[];
    joiners?: string[];
    occurrences?: number;
    at?: number[];
  };
  /**
   * いまの構造には当たらない（外れている）区切り直し。記録としては残す。
   *
   * 以前は当たらなかった手順を記録ごと捨てていた。ところが解析方式を変えると
   * 文の切れ目が変わるので手順は当然当たらなくなり、そこで消える。
   * 「元の方式で解析し直せば戻ります」と案内しておきながら、戻したときには
   * 手順がもう存在せず、結合した文に付けていた訳は永久に宙に浮いた。
   * 訳す前に区切りを直せ、と勧めている以上、手を入れた人ほど失う壊れ方だった。
   *
   * 外れていても残しておけば、元の方式に戻したときに再び当たって復活する。
   */
  detached?: boolean;
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
  /**
   * 実際に足した用語そのもの。
   *
   * 用語集は「これから訳すとき」の方針なので、別の論文の書き出しから混ざると
   * 以後の訳が黙ってそれに従う。件数だけでは何が入ったか分からず取り消せないので、
   * 語を返して 1 件ずつ消せるようにする（removeGlossaryEntry）。
   */
  glossaryAddedTerms: string[];
  /**
   * 取り込み元の「訳さない」のうち、こちらに新しく記録したもの。
   *
   * これは**自分の残件がその数だけ減る**ということ。progress() は skipped を
   * remaining から外し、get_translation_batch はその文を二度と返さない。
   * 黙って減らすと「訳していない文を抱えたまま翻訳完了」が成立するので、必ず報告する。
   */
  skippedAdded: number;
  /** 取り込み元の「訳さない」のうち、当てられずに無視したもの（該当文なし／こちらは既に訳してある）。 */
  skippedIgnored: number;
  /** 取り込み元にあったが、こちらの文書に対応する文が無かった注釈の数。 */
  orphaned: number;
}

export function emptyAnnotations(): Annotations {
  return { translations: {}, notes: [], glossary: [], skipped: {}, sentenceEdits: [] };
}
