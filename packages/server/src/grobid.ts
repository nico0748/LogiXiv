import { parseTei, type DocumentStructure } from '@logixiv/core';

/**
 * GROBID 呼び出し。
 *
 * 効いているパラメータ:
 *   segmentSentences=1   文単位の <s> を出させる。これが無いと 1 文リーダーが成立しない。
 *   teiCoordinates=s     <s> に PDF 座標を付けさせる。マーカー連動の根拠。
 *   consolidateHeader=0  既定値の 1 は CrossRef へ問い合わせに行く。
 *                        未公開原稿のタイトルを外部に出さないため必ず 0 にする。
 *   consolidateCitations=0 同上（参考文献も外に出さない）。
 */

export class GrobidUnavailableError extends Error {}

/**
 * GROBID は動いているが、この PDF を処理できなかった。
 *
 * 「GROBID が落ちている（＝別の PDF なら通る）」と分けてある。前者は待つ／起動する話、
 * 後者はその PDF をどうにかする話で、人がやることが違う。
 */
export class GrobidParseError extends Error {}

export interface GrobidOptions {
  baseUrl: string;
  timeoutMs?: number;
}

export async function isGrobidAlive(baseUrl: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/isalive`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

/** multipart/form-data を自前で組む（依存を足さないため）。 */
function buildForm(pdf: Uint8Array, fileName: string): { body: Buffer; contentType: string } {
  const boundary = `----logixiv${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const safeName = fileName.replace(/["\r\n]/g, '_');
  const fields: [string, string][] = [
    ['segmentSentences', '1'],
    ['teiCoordinates', 's'],
    ['consolidateHeader', '0'],
    ['consolidateCitations', '0'],
    ['includeRawAffiliations', '0'],
  ];

  const parts: Buffer[] = [];
  for (const [name, value] of fields) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="input"; filename="${safeName}"\r\n` +
        'Content-Type: application/pdf\r\n\r\n',
      'utf8',
    ),
  );
  parts.push(Buffer.from(pdf));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));

  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function processFulltext(
  pdf: Uint8Array,
  fileName: string,
  options: GrobidOptions,
): Promise<{ tei: string; structure: DocumentStructure }> {
  const { body, contentType } = buildForm(pdf, fileName);
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}/api/processFulltextDocument`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, Accept: 'application/xml' },
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
    });
  } catch (error) {
    throw new GrobidUnavailableError(
      `GROBID (${options.baseUrl}) に接続できませんでした: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (response.status === 503) {
    throw new GrobidUnavailableError('GROBID が処理中で受け付けられません（同時実行数の上限）。少し待って再試行してください。');
  }
  if (!response.ok) {
    // GROBID の本文は英語（`[NO_BLOCKS] PDF parsing …` など）。そのまま前に出すと
    // pdf.js のときと同じで「何をしようとして失敗したのか」がどこにも書かれない文になる。
    // 人が読む文は日本語で組み立て、GROBID の返事は原因を追うための添え物にする。
    const detail = (await response.text()).slice(0, 500).trim();
    throw new GrobidParseError(
      `「${fileName}」を GROBID で解析しようとしましたが、GROBID が処理できませんでした（HTTP ${response.status}）。` +
        'PDF が壊れている、暗号化されている、または本文がすべて画像（スキャン）の可能性があります。' +
        '簡易解析（pdf.js）で取り込み直すと、この PDF の何が読めないかがより具体的に分かります。' +
        (detail.length > 0 ? `\nGROBID の返答: ${detail}` : ''),
    );
  }

  const tei = await response.text();
  return { tei, structure: parseTei(tei) };
}
