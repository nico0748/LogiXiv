import * as pdfjs from "pdfjs-dist";
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker&inline";

// pdf.js のワーカーはアプリ全体で1つを使い回す。
// 文書を閉じてもワーカーは止めないため、開き直しや React の再描画で処理が止まらない。
// 型定義では port が null に限られているが、実装は Worker を受け付ける
const worker = new pdfjs.PDFWorker({ port: new PdfWorker() } as unknown as ConstructorParameters<
  typeof pdfjs.PDFWorker
>[0]);

export function openPdf(data: ArrayBuffer) {
  return pdfjs.getDocument({ data: new Uint8Array(data.slice(0)), worker });
}
