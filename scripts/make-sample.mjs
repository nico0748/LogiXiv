// お試し用の架空の論文 PDF を作る。node scripts/make-sample.mjs
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFileSync } from "node:fs";

const doc = await PDFDocument.create();
doc.setTitle("Sparse Window Attention for Reading Long Scientific Documents");
doc.setAuthor("A. Example, B. Sample");
const times = await doc.embedFont(StandardFonts.TimesRoman);
const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
const italic = await doc.embedFont(StandardFonts.TimesRomanItalic);

const W = 595, H = 842, M = 72, LW = W - M * 2;
let page, y;
const newPage = () => { page = doc.addPage([W, H]); y = H - M; };
const wrap = (text, font, size) => {
  const words = text.split(" "); const lines = []; let line = "";
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(t, size) > LW) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
};
const para = (text, { font = times, size = 11, gap = 8, lh = 1.45 } = {}) => {
  for (const l of wrap(text, font, size)) {
    if (y < M + size) newPage();
    page.drawText(l, { x: M, y, size, font, color: rgb(0, 0, 0) }); y -= size * lh;
  }
  y -= gap;
};
const center = (text, font, size, gap = 6) => {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: (W - w) / 2, y, size, font }); y -= size * 1.3 + gap;
};
const eq = (text, no) => {
  const size = 12; const w = italic.widthOfTextAtSize(text, size);
  page.drawText(text, { x: (W - w) / 2, y, size, font: italic });
  page.drawText(`(${no})`, { x: W - M - 18, y, size: 11, font: times });
  y -= 26;
};

newPage();
center("Sparse Window Attention for Reading", bold, 17, 0);
center("Long Scientific Documents", bold, 17, 8);
center("A. Example and B. Sample", times, 11, 2);
center("Sample text generated for PaperLens. Not a real paper.", italic, 9.5, 18);
para("Abstract", { font: bold, size: 11, gap: 2 });
para("Transformer models struggle to read long scientific documents because the cost of self-attention grows quadratically with sequence length. We propose sparse window attention, which restricts each token to a local window and a small set of global tokens. On a benchmark of 2,000 full-length papers, our model reduces memory usage by 71% while keeping question-answering accuracy within 0.8 points of dense attention. We also show that the learned global tokens align with section headings, which suggests that the model recovers document structure without supervision.", { size: 10.5 });
para("1 Introduction", { font: bold, size: 12, gap: 2 });
para("Researchers spend a large share of their time reading papers. Automatic reading assistants promise to shorten this time, but most language models are trained on inputs of a few thousand tokens, whereas a typical paper with appendices exceeds 20,000 tokens. Truncating the input discards the method and experiment sections, which are often the parts a reader needs most.");
para("Prior work addresses this limitation in two ways. Retrieval-based methods split a document into chunks and select relevant chunks for each query. Efficient attention methods change the attention pattern itself so that cost grows linearly. Retrieval loses information that spans chunks, while existing efficient attention methods often degrade on tasks that require precise long-range references, such as resolving a citation to its bibliography entry.");
para("Our contributions are as follows. First, we introduce sparse window attention, a pattern that combines a sliding window with learned global tokens. Second, we provide an ablation study that isolates the effect of window size and the number of global tokens. Third, we release an evaluation set of questions that require reading across sections.");
para("2 Method", { font: bold, size: 12, gap: 2 });
para("We start from scaled dot-product attention. Given queries Q, keys K, and values V, the output is computed as follows, where d_k is the dimension of the keys.");
eq("Attention(Q, K, V) = softmax( Q K^T / sqrt(d_k) ) V", 1);
para("In sparse window attention, token i attends only to the set N(i), which contains the tokens within distance w and the G global tokens. The attention weight between token i and token j is therefore");
eq("a_ij = exp(q_i . k_j / sqrt(d_k)) / sum_{l in N(i)} exp(q_i . k_l / sqrt(d_k))", 2);
para("Because |N(i)| = 2w + G is independent of the sequence length n, the cost of one layer is O(n(2w + G)) instead of O(n^2). We set w = 256 and G = 32 unless stated otherwise.");
para("3 Experiments", { font: bold, size: 12, gap: 2 });
para("We evaluate on LongPaperQA, which contains 6,400 questions over 2,000 papers from computer science and biology. Each question requires evidence from at least two sections. We compare against dense attention with truncation to 4,096 tokens, a retrieval baseline, and two efficient attention methods. All models have 350M parameters and are trained with the same data and learning rate schedule.");
para("Sparse window attention reaches an F1 score of 61.2, compared with 62.0 for dense attention on inputs that fit in memory and 48.5 for the truncated baseline. Memory usage at 32,000 tokens is 71% lower than dense attention. Accuracy drops sharply when G is smaller than 8, which indicates that global tokens carry most of the cross-section information.");
para("4 Limitations", { font: bold, size: 12, gap: 2 });
para("Our evaluation covers only English papers from two fields. The global tokens are learned per model, so they cannot be inspected directly as section labels. We did not evaluate documents with heavy mathematical notation, where tokenization of formulas may affect the window size that is needed.");
writeFileSync(new URL("../src/demo/sample.pdf", import.meta.url), await doc.save());
console.log("ok");
