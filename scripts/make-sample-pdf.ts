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

export function makeSamplePdf(): Uint8Array {
  const content = [
    'BT',
    '/F1 12 Tf',
    '14 TL',
    '50 780 Td',
    ...LINES.map((line) => `(${escapePdfText(line)}) Tj T*`),
    'ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];

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
