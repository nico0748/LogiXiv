// pdf.js を最初に使うときに読み込む。
// 読み込みには 0.2 秒ほどかかる（pdf.js が使う @napi-rs/canvas が端末のフォントを走査する）。
// 起動や一覧の表示など PDF を扱わない処理では読み込まない。

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let loading: Promise<PdfJs> | undefined;

export const pdfjs = (): Promise<PdfJs> => (loading ??= import("pdfjs-dist/legacy/build/pdf.mjs"));
