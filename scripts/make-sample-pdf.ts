/**
 * テスト用の最小 PDF を組み立てる。
 *
 * 外部ライブラリを入れないのは、E2E が「開発者がリポジトリを clone した直後の状態」で
 * 走ってほしいから。フォントは PDF 標準の Helvetica だけを使う。
 */

const LINES = [
  'We study sparse attention under long contexts.',
  'Transformers scale poorly with sequence length.',
  'Our approach uses block-sparse kernels and outperforms the baseline.',
  'We report 3.14 as the reference value following Smith et al.',
  'Does the improvement hold at scale? Yes, up to 32k tokens.',
];

function escapePdfText(text: string): string {
  return text.replace(/[\\()]/g, (c) => `\\${c}`);
}

export interface SamplePdfOptions {
  /** ページ数。複数ページの挙動（描画・スクロール・上限）を見たいときに増やす。 */
  pages?: number;
  /** 1 ページあたりの行。既定は LINES。 */
  lines?: string[];
}

export function makeSamplePdf(options: SamplePdfOptions = {}): Uint8Array {
  const pageCount = Math.max(1, options.pages ?? 1);
  const lines = options.lines ?? LINES;

  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length; // 1 始まりのオブジェクト番号
  };

  // 1: Catalog, 2: Pages（子が決まってから本文を差し替える）
  add('placeholder-catalog');
  add('placeholder-pages');
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const pageIds: number[] = [];
  for (let page = 1; page <= pageCount; page++) {
    const content = [
      'BT',
      '/F1 12 Tf',
      '14 TL',
      '50 780 Td',
      `(${escapePdfText(`Page ${page}.`)}) Tj T*`,
      ...lines.map((line) => `(${escapePdfText(line)}) Tj T*`),
      'ET',
    ].join('\n');
    const contentId = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
          `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
  }

  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

export const SAMPLE_LINES = LINES;
