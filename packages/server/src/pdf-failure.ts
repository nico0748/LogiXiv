/**
 * 「PDF を読めなかった」の言い方を 1 箇所に集める。
 *
 * pdf.js は失敗を英語の 1 行（`No password given` / `Invalid PDF structure.`）で返す。
 * それをそのまま画面に出していた頃は、**どのファイルの話なのか・LogiXiv が何を
 * しようとしていたのか・次に何をすればいいのか**が、どこにも書かれていなかった。
 * 他の失敗表示は全部日本語なので、ここだけライブラリの内部文字列が素通りしていた。
 *
 * 出版社 PDF の暗号化と、ダウンロードの途中切れは、壊れた入力のうちいちばん
 * 起きやすい 2 つで、しかも**人がやるべきことが正反対**（前者は暗号化を外す、
 * 後者は落とし直す）。ひとまとめに「読めません」と言ってはいけない。
 *
 * 元の英語は捨てずに `detail` に残す。人が最初に読む文にはしないが、
 * 症状を検索したり報告したりするときの唯一の手がかりになる。
 */

/** 何が起きたか。文言の出し分けだけでなく、画面側が分岐できるように機械可読な値で持つ。 */
export type PdfFailureReason =
  | 'encrypted'
  | 'password-wrong'
  | 'truncated'
  | 'corrupt'
  | 'not-pdf'
  | 'missing'
  | 'unknown';

export class PdfUnreadableError extends Error {
  readonly reason: PdfFailureReason;
  /** 何のファイルの話か。取り込み時はアップロード名、保存済み文書なら source.pdf。 */
  readonly fileName: string | null;
  /** pdf.js や OS が返した元のメッセージ（英語）。原因を追えるように必ず残す。 */
  readonly detail: string | null;

  constructor(
    reason: PdfFailureReason,
    message: string,
    options: { fileName?: string | null; detail?: string | null } = {},
  ) {
    super(message);
    this.name = 'PdfUnreadableError';
    this.reason = reason;
    this.fileName = options.fileName ?? null;
    this.detail = options.detail ?? null;
  }
}

/** 文頭に「〈ファイル名〉を…」と置く。名前が無いときは黙って省く。 */
function subject(fileName: string | null, verb: string): string {
  return fileName === null || fileName.length === 0 ? verb : `「${fileName}」を${verb}`;
}

/**
 * PDF は必ず `%%EOF` で終わる。末尾に無ければ、ファイルの後ろが欠けている。
 *
 * pdf.js は「途中で切れた PDF」も「PDF の形をしていない何か」も同じ
 * `Invalid PDF structure.` で返すので、この 2 つはこちらで見分ける。
 * 人がやるべきことが違う（落とし直す / そもそも別のファイルを探す）。
 * 末尾は署名などで伸びることがあるので、少し広めに見る。
 */
function looksTruncated(pdf: Uint8Array | null): boolean {
  if (pdf === null) return false;
  const tail = Buffer.from(pdf.subarray(Math.max(0, pdf.byteLength - 2048))).toString('latin1');
  return !tail.includes('%%EOF');
}

export interface RawPdfFailure {
  /** pdf.js の例外クラス名（PasswordException / InvalidPDFException など）。 */
  name: string | null;
  message: string;
}

/**
 * pdf.js の失敗を、人が読める日本語に翻訳する。
 *
 * 文の形は「何をしようとして / なぜ駄目で / 次に何ができるか」の 3 つで固定する。
 * 3 つ目が無い文は、読んだ人をその場に置き去りにする。
 */
export function describePdfFailure(
  raw: RawPdfFailure,
  context: { fileName?: string | null; pdf?: Uint8Array | null } = {},
): PdfUnreadableError {
  const fileName = context.fileName ?? null;
  const pdf = context.pdf ?? null;
  const detail = raw.message;

  if (raw.name === 'PasswordException') {
    // code 2 は「渡したパスワードが違う」だが、LogiXiv はパスワードを渡さないので
    // 実際に届くのは常に「パスワードが要る」側。どちらでも人のやることは同じ。
    return new PdfUnreadableError(
      'encrypted',
      `${subject(fileName, '読もうとしましたが、この PDF は暗号化されていて開けません。')}` +
        '出版社の配布 PDF によくあります。' +
        '閲覧用パスワードを外したファイル（印刷や「PDF として保存」で作り直したもの、' +
        'または qpdf --decrypt の出力）を取り込み直してください。',
      { fileName, detail },
    );
  }

  if (raw.name === 'InvalidPDFException' || /invalid pdf/i.test(raw.message)) {
    if (looksTruncated(pdf)) {
      return new PdfUnreadableError(
        'truncated',
        `${subject(fileName, '読もうとしましたが、ファイルが途中で切れています（PDF の終わりの印が見つかりません）。')}` +
          'ダウンロードが最後まで終わっていない可能性が高いので、落とし直してから取り込み直してください。',
        { fileName, detail },
      );
    }
    return new PdfUnreadableError(
      'corrupt',
      `${subject(fileName, '読もうとしましたが、PDF の中身が壊れていて解析できません。')}` +
        '別の場所から取得し直すか、ビューアで開いて「PDF として保存」し直したファイルで試してください。',
      { fileName, detail },
    );
  }

  if (raw.name === 'MissingPDFException') {
    return new PdfUnreadableError(
      'missing',
      `${subject(fileName, '読もうとしましたが、ファイルが見つかりませんでした。')}`,
      { fileName, detail },
    );
  }

  return new PdfUnreadableError(
    'unknown',
    `${subject(fileName, '解析できませんでした。')}` +
      'PDF が壊れているか、LogiXiv が扱えない作りのファイルです。' +
      `原因の手がかり: ${detail}`,
    { fileName, detail },
  );
}

/** 保存してあるはずの PDF 本体が消えている、というときの言い方。 */
export function missingStoredPdf(documentId: string, path: string, detail: string): PdfUnreadableError {
  return new PdfUnreadableError(
    'missing',
    `この文書の PDF 本体（source.pdf）が見つかりません。文書の記録は残っていますが、` +
      'PDF が要る操作（表示・書き出し・再解析）はできません。' +
      '元の PDF をもう一度取り込み直すか、この文書を削除してください。' +
      `（置き場: ${path}）`,
    { fileName: 'source.pdf', detail: `${detail} [document=${documentId}]` },
  );
}
