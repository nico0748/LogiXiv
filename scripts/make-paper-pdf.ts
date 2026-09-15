/**
 * 「現実の論文らしい」PDF を組み立てる。解析品質の測定用。
 *
 * make-sample-pdf.ts は 1 段組の最小 PDF で、つなぎ目の確認にしか使えない。
 * こちらは学会論文の標準レイアウト（2 段組・ヘッダ・ページ番号・図キャプション・
 * 数式・脚注・参考文献）を再現し、**正解の文リストを一緒に返す**。
 * 正解が分かるので、解析結果を突き合わせて精度を数値で出せる。
 *
 * 依存は増やさない（clone 直後に走ることを優先）。フォントは標準の Helvetica。
 */

export interface PaperSpec {
  pages: number;
  /** 2 段組にするか。false なら 1 段組。 */
  twoColumn: boolean;
}

export interface GeneratedPaper {
  pdf: Uint8Array;
  /** 本文として正しく取れてほしい文（この順で並ぶのが理想）。 */
  expectedSentences: string[];
  /** 本文として取れて**ほしくない**もの（ページ番号・図キャプション・参考文献など）。 */
  expectedNonBody: string[];
}

interface Placed {
  text: string;
  x: number;
  y: number; // 左下原点（PDF 座標）
  size: number;
}

const BODY_SENTENCES = [
  'Sparse attention reduces the quadratic cost of self-attention.',
  'We evaluate on the test. We then report results in Table 1.',
  'Our block-sparse kernel outperforms the dense baseline by a wide margin.',
  'Prior work by Smith et al. introduced a related decomposition.',
  'We report 3.14 as the reference value for all experiments.',
  'The state-of-the-art model uses a hierarchical routing scheme.',
  'We call this variant method X. It converges faster than the baseline.',
  'Does the improvement hold at scale? Yes, up to 32k tokens.',
  'Information retrieval benefits from the same sparsity pattern.',
  'Large systems benefit most. Smaller ones see little change.',
];

const NON_BODY = [
  'Figure 1: Overview of the proposed pipeline.',
  'Table 1: Accuracy on the held-out split.',
  'y = softmax(QK^T / sqrt(d)) V',
  '[1] J. Doe and A. Smith. Sparse transformers. In Proc. NeurIPS, 2024.',
  '[2] R. Roe. Efficient attention. Journal of ML, 12(3):45-67, 2025.',
];

function escapePdfText(text: string): string {
  return text.replace(/[\\()]/g, (c) => `\\${c}`);
}

/**
 * 1 行に収まる幅で語を折り返す。行末でハイフネーションが起きるよう、
 * 長い語は意図的にハイフンで割る。
 */
function wrap(text: string, maxChars: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= maxChars) {
      current += ` ${word}`;
      continue;
    }
    // 残りが少なければ語をハイフンで割る（真のハイフネーション）。
    const room = maxChars - current.length - 1;
    if (room >= 4 && word.length >= 7 && /^[A-Za-z]+$/.test(word)) {
      lines.push(`${current} ${word.slice(0, room - 1)}-`);
      current = word.slice(room - 1);
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

export function makePaperPdf(spec: PaperSpec): GeneratedPaper {
  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 50;
  const columnGap = 20;
  const columns = spec.twoColumn ? 2 : 1;
  const columnWidth = (pageWidth - margin * 2 - columnGap * (columns - 1)) / columns;
  const charsPerLine = Math.floor(columnWidth / 5.0); // Helvetica 10pt のおおよその幅
  const lineHeight = 13;
  const bodyTop = pageHeight - margin - 30;
  const bodyBottom = margin + 30;
  const linesPerColumn = Math.floor((bodyTop - bodyBottom) / lineHeight);

  const expectedSentences: string[] = [];
  const expectedNonBody: string[] = [];

  // --- 段組に配置する ---------------------------------------------------
  const placedByPage = new Map<number, Placed[]>();
  let page = 1;
  let column = 0;
  let line = 0;
  let placedLines = 0;

  const pushLine = (text: string, size: number): void => {
    if (line >= linesPerColumn) {
      line = 0;
      column++;
      if (column >= columns) {
        column = 0;
        page++;
      }
    }
    const x = margin + column * (columnWidth + columnGap);
    const y = bodyTop - line * lineHeight;
    const list = placedByPage.get(page);
    const item: Placed = { text, x, y, size };
    if (list) list.push(item);
    else placedByPage.set(page, [item]);
    line++;
    placedLines++;
  };

  /**
   * 要求されたページ数ぶんの**行**を実際に流し込む。
   * 「何ブロック作るか」で決めると、内容が少ないときに 1 ページに収まってしまい、
   *  ページをまたぐ挙動（柱の除去、段の送り）が測定できない。
   */
  const capacity = spec.pages * columns * linesPerColumn;
  const reserve = 8; // 参考文献のぶん
  const sectionTitles = ['1. Introduction', '2. Method', '3. Results', '4. Discussion', '5. Conclusion'];
  let block = 0;
  let sectionIndex = 0;

  const emit = (text: string, kind: 'head' | 'body' | 'nonbody'): void => {
    if (kind === 'head') {
      pushLine(text, 11);
      return;
    }
    for (const wrapped of wrap(text, charsPerLine)) pushLine(wrapped, 10);
    if (kind === 'body') expectedSentences.push(text);
    else expectedNonBody.push(text);
  };

  while (placedLines < capacity - reserve) {
    if (block % 3 === 0 && sectionIndex < sectionTitles.length) {
      emit(sectionTitles[sectionIndex]!, 'head');
      sectionIndex++;
    }
    for (let i = 0; i < 3; i++) {
      emit(BODY_SENTENCES[(block * 3 + i) % BODY_SENTENCES.length]!, 'body');
      if (placedLines >= capacity - reserve) break;
    }
    if (block % 3 === 2 && placedLines < capacity - reserve) {
      emit(NON_BODY[block % 3]!, 'nonbody');
    }
    block++;
  }

  // 参考文献は最後に固めて置く。
  emit('References', 'head');
  emit(NON_BODY[3]!, 'nonbody');
  emit(NON_BODY[4]!, 'nonbody');

  // ヘッダとページ番号を全ページに足す。
  const totalPages = Math.max(page, 1);
  for (let p = 1; p <= totalPages; p++) {
    const list = placedByPage.get(p) ?? [];
    list.push({ text: 'Preprint. Under review.', x: margin, y: pageHeight - margin + 4, size: 8 });
    list.push({ text: String(p), x: pageWidth / 2, y: margin - 10, size: 9 });
    placedByPage.set(p, list);
  }
  expectedNonBody.push('Preprint. Under review.');

  // --- PDF を組む -------------------------------------------------------
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };
  add('placeholder-catalog');
  add('placeholder-pages');
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const pageIds: number[] = [];
  for (let p = 1; p <= totalPages; p++) {
    const items = placedByPage.get(p) ?? [];
    const parts = ['BT'];
    let lastSize = 0;
    for (const item of items) {
      if (item.size !== lastSize) {
        parts.push(`/F1 ${item.size} Tf`);
        lastSize = item.size;
      }
      parts.push(`1 0 0 1 ${item.x.toFixed(2)} ${item.y.toFixed(2)} Tm`);
      parts.push(`(${escapePdfText(item.text)}) Tj`);
    }
    parts.push('ET');
    const content = parts.join('\n');
    const contentId = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
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
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return {
    pdf: new Uint8Array(Buffer.from(pdf, 'latin1')),
    expectedSentences,
    expectedNonBody,
  };
}
