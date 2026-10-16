/**
 * PaperLens のデータモデル。
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
  /**
   * この文の**中に**、本文として採らなかった行が重なっていたことの印。
   *
   * 文書単位のバッジでは足りない。実測（ML 理論の論文、本文 52 文）で、
   * 正しく取れた 46 文と、原文と内容が違う 6 文が同じ顔で並んだ。読む側が知りたいのは
   * 「この文書は怪しい」ではなく「**どの文か**」。
   *
   * 印が付く文は、次のどちらかの形で数式・表・擬似コードの行と重なっている:
   *   - その行が、この文の行の**内側**にある（Σ の上下の添字、分数の分子と分母）
   *   - その行を**またいで**前後が繋がっている（別行立ての式を飛ばして次の段落と癒着）
   *
   * どちらも、画面には**文法の通る英文**として出るのがたちの悪いところ。実測:
   *   `We minimise F (x) = Fm(x) where each Fm is L-smooth …`（平均 1/M と Σ が消えた）
   *   `… ≥ η2(1 − δ)ζ2, as claimed.`（1/4 が消え、4 倍強い主張になった）
   * 訳す側にも読む側にも、原文がそう書いてあるようにしか見えない。
   *
   * 古い保存データと GROBID 経路には無い。書き出し HTML の取り込みでも復元されない。
   */
  seam?: SentenceSeam;
}

/** 文の中に重なっていた、本文として採らなかった行の記録。 */
export interface SentenceSeam {
  /** 重なっていた行の種類（重複なし、版面に出てくる順）。 */
  kinds: NonBodyKind[];
  /** 重なっていた行の矩形。画面で「ここが抜けている」と指せる。 */
  rects: Rect[];
  /**
   * 重なっていた行の**本文**（版面に出てくる順、`rects` と同じ並び）。
   *
   * 矩形だけだと、読む側にできるのは「この文は飛ばす」しかない。落ちたのが
   * 補題の主張そのもの（実測: order 28 の行）だったときに、飛ばしてよいかどうかを
   * 決める材料が無い。文字列があれば、訳す側がその場で継ぎ直せる。
   *
   * 落とした行の生の文字列なので、文として読めるとは限らない（数式の断片、
   * 表のセル、行がばらけた残骸）。**本文の文としては扱わないこと** —
   * ここに入るのは「本文だったかもしれないが、本文として出していないもの」で、
   * `sentences` に混ぜると本文でない行が対訳に並ぶ。
   */
  texts?: string[];
}

/**
 * 本文として扱わなかった行の種類。
 *
 * 「なぜ右（対訳）に出ていないのか」を画面でその場に言うために要る。
 * 落とすこと自体は正しくても（参考文献を訳す必要はない）、落としたことが
 * 誰にも見えないと「まだ訳が来ていないのか、自分が見落としたのか」を
 * 区別できない。この道具は原文と訳が 1 対 1 で並ぶことが成立条件なので、
 * PDF に見えているものが右に無いなら、無い理由がその場に要る。
 */
export type NonBodyKind =
  /** 表題・著者・所属など、本文が始まる前の行。 */
  | 'frontMatter'
  /** ページの上下で繰り返される柱（ランニングヘッド）。 */
  | 'runningHead'
  /** ノンブル（ページ番号）。 */
  | 'pageNumber'
  /** 図表キャプションとその続きの行。 */
  | 'caption'
  /** 参考文献の 1 エントリ、および参考文献節より後ろ。 */
  | 'reference'
  /** 脚注。 */
  | 'footnote'
  /** 別行立ての数式（式番号を含む）。 */
  | 'formula'
  /** 表のセル。 */
  | 'table'
  /** 上のどれとも決められなかったもの。 */
  | 'other';

/**
 * 本文ではないと判断した、紙面の 1 かたまり。
 *
 * `DocumentStructure.sentences` には**入れない**。入れると訳す対象になり、
 * 進捗の分母も狂う（「26 / 27 文」が急に「26 / 60 文」になる）。
 * かといって捨てもしない。画面は `afterOrder` を見て本文の文の間に差し込み、
 * 「（訳さない：参考文献）」のように理由つきで並べられる。
 *
 * 1 件 = **紙面の 1 かたまり**（折り返したキャプション 1 つ、参考文献 1 エントリ）で、
 * 文には割らない。参考文献 1 件が 3 枚のカードに割れるより読みやすく、
 * 「なぜ右に無いのか」という問いにそのまま答える単位になるため。
 */
export interface NonBodySentence extends Sentence {
  /** なぜ本文として扱わなかったか。 */
  kind: NonBodyKind;
  /**
   * 読み順で直前に来る本文の文の `order`。本文より前にあるものは -1。
   * 画面はこれを見て、本文の文の間の正しい位置に差し込める。
   */
  afterOrder: number;
  /**
   * 同じ「直前の本文の文」を `hash` で指したもの。本文より前にあるものは null。
   *
   * `afterOrder` は解析時点の通し番号なので、人が文の区切りを直すと
   * （`fix_sentence_boundary` の結合・分割で通し番号が振り直される）ずれる。
   * hash なら、その編集に巻き込まれた文以外は追随する。
   * 画面はまず hash で探し、見つからないときだけ `afterOrder` に落ちればよい。
   */
  afterHash: string | null;
}

export type ParserKind = 'grobid' | 'fallback';

/**
 * 解析結果がどれくらい怪しいか、という**解析側からの自己申告**。
 *
 * これが無かったとき、画面に出るのは「簡易解析」バッジの一択だった。
 * 完璧に取れた文書にも、本文 45 文のうち 15 文しか原形で取れていない文書にも、
 * 同じものが出る。読む側には見分けようがなく、崩れたまま最後まで訳し進められる。
 *
 * ここで足りないのは精度ではなく、**精度についての正直さ**の方。
 * 崩れを直せなくても、崩れていると分かれば読む側は原文を見に行ける。
 *
 * 誤検出（きれいに取れた文書に警告を出す）は害が大きい。全部に警告を出す実装は
 * バッジ 1 種類だったときと同じで、見分けが付かないという問題をそのまま戻す。
 * だから判定は「実際に測れる痕跡があるときだけ」に絞ってある。
 */
export interface StructureQuality {
  /**
   * 読み順（特に 2 段組の左右の取り違え）が崩れている疑い。
   *
   * - `low`  … 自動で検出できる痕跡は無かった。**崩れが無いことの保証ではない**。
   * - `high` … 段の連結など、読み順が壊れている痕跡が実際に見つかった。
   */
  readingOrderRisk: 'low' | 'high';
  /** なぜそう判断したか。画面にそのまま出せる日本語の一文。 */
  reason: string;
  /**
   * PDF のテキストレイヤの文字のうち、**行き先の説明が付いた**割合（0〜1）。
   *
   * `readingOrderRisk` は生き残った本文行しか見ないので、**消された行は原理的に
   * 検出できない**。落とした行が数式や表なら正しいが、インライン数式が入っただけの
   * 本文を落としていたら、そこは黙って消える。実測（pdflatex の 2 段組）で、
   * 同じ文章にインライン数式を入れただけで本文 4 文が消え、残骸が文法の通る英文に
   * 癒着した。そのとき readingOrderRisk は low、警告なし、進捗は緑だった。
   * だから「何が失われたかを数える」別建ての物差しを持つ。
   *
   * 分母は行になった全文字、分子は「本文」と「本文でないと確信して落としたもの
   * （柱・ノンブル・キャプション・参考文献・脚注・前付）」の合計。
   * 版面の規則だけで落とした行（数式・表・擬似コード）のうち、**文章として読める
   * もの**だけを失われた側に数える。実測: 正しく取れている論文 5 本で 100.0%、
   * 本文が消えている 3 本で 77.7% / 70.5% / 93.9%。
   *
   * 古い保存データと GROBID 経路、書き出し HTML の取り込みでは入らない。
   */
  coverage?: number;
  /**
   * `coverage` が低すぎるか。
   *
   * - `low`  … 説明の付かない文字は僅かだった。**欠落が無いことの保証ではない**。
   * - `high` … 本文として読める行を、数式や表として落としている疑いがある。
   */
  coverageRisk?: 'low' | 'high';
  /** `coverage` についての、画面にそのまま出せる日本語の一文。 */
  coverageReason?: string;
}

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
  /**
   * 本文として扱わなかった行。古い保存データと GROBID 経路には無いので省略可。
   *
   * ここに入るものは訳の対象ではない（進捗の分母にも入らない）。
   * 画面に「PDF には見えているのに右に無い」を作らないためだけに持つ。
   */
  nonBody?: NonBodySentence[];
  /**
   * 解析結果の確からしさについての自己申告。古い保存データと GROBID 経路には無いので省略可。
   *
   * 注意: 書き出し HTML の取り込み（sanitizeStructure）では復元されない。
   * 取り込んだ文書は別の環境で解析されたものなので、こちらで測り直した値ではない。
   */
  quality?: StructureQuality;
  /**
   * 文の枠（rects）の文頭・文末の端を、どう決めたか。
   *
   * - `glyph`    … PDF の描画命令から求めた実際のグリフの端に合わせてある（PaperLens アプリのサーバーが解析後に直す）。
   *               照合できなかった端だけは見積もりのまま。
   * - `estimate` … グリフの位置が取れなかった（文字コードの対応表が壊れている等）ので、字幅の見積もりのまま。
   * - 無い       … この印より前に解析された。再解析すれば `glyph` になりうる（画面はそれを案内する）。
   *
   * 枠の座標だけの話で、本文・ハッシュは変わらない（STRUCTURE_VERSION は上げない）。
   */
  rectEdges?: 'glyph' | 'estimate';
  /**
   * 文の枠の縦の帯（上端・下端）を、どの版の規則で決めたか（band.ts の RECT_BAND_VERSION）。
   * 無い文書は「ベースライン − 字高 〜 ベースライン」の古い式で、字より 0.25em ほど上にずれている。
   * 座標だけの印で、本文・ハッシュは変わらない。
   */
  rectBand?: number;
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
  /**
   * merge = 連続する複数文を 1 文に、split = 1 文を複数に、drop = 本文から取り除く。
   *
   * drop が要る理由。本文 1 文の**真ん中**に図の枠内文字や表の行が割り込むことがある
   * （実測: `The expert count is E = 64 and (schematic of the two-branch layer) Model
   * Active In-domain … k = 2 unless stated otherwise, and …`）。merge と split には
   * 「中身を取り除く」操作が無いので、はじめて使った研究者は
   * 「3 つに split → 真ん中を skip → 前後を merge」を試して
   * `指定された文が連続して見つかりません` で行き止まりになった（skip しても
   * 文の列からは消えないため）。区切りを直せと勧めている当の操作が、
   * いちばん直したい形で詰んでいた。
   *
   * drop は split・merge と直交する 3 つ目の操作にしてある。割り込みを取り除けば
   * 前後が隣り合うので、既存の merge がそのまま使える（merge 側に例外は要らない）。
   */
  type: 'merge' | 'split' | 'drop';
  /** merge のときは結合する文の hash を順に、split・drop のときは対象 1 件。 */
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
    /**
     * drop で `nonBody` に移した件の id。取り消すときに**その件だけ**を戻すために要る。
     * hash だけで探すと、もともと同じ本文の付物があったときにそちらを本文へ混ぜてしまう。
     */
    nonBodyIds?: string[];
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
  format: 'paperlens-export';
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
