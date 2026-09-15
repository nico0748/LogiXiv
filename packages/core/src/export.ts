import type { ExportPayload, PaperDocument, Sentence } from './types.ts';
import { escapeHtml, escapeJsonForScript } from './escape.ts';
import { progress } from './document.ts';
import { LOGIXIV_VERSION } from './hash.ts';

/**
 * 書き出し HTML の作り。
 *
 * 1 ファイルに PDF・訳・メモ・ビューアを全部畳み込む。外部 URL は 1 つも参照しない
 * （ネットワークが無い環境、10 年後、審査中の匿名環境でも開けることを狙っている）。
 *
 * JS が動かない場合に備えて、本文は静的な HTML としても書き出す。
 * ビューアは起動時にその静的部分を隠すので、通常は二重に見えることはない。
 */

export interface BuildExportInput {
  document: PaperDocument;
  /** 元 PDF の base64（data URL ではなく生の base64）。 */
  pdfBase64: string;
  /** apps/viewer のビルド成果物（単一ファイル JS）。 */
  viewerScript: string;
  /** ビューアの CSS。 */
  viewerStyle: string;
  /** 書き出し日時を固定したいとき（テスト用）。 */
  exportedAt?: string;
}

/**
 * インラインの <script> / <style> の中身が、自分を閉じるタグを含まないようにする。
 *
 * 今のバンドルにはたまたま出てこないが、pdf.js や Vite の更新で文字列リテラルに
 * "</script" が 1 つ入るだけで、ビューアが起動しない書き出しが黙って量産される。
 * JS でも CSS でもこの置換は意味を変えない。
 */
function sealInline(source: string, kind: 'script' | 'style'): string {
  return source.replaceAll(`</${kind}`, `<\\/${kind}`);
}

export const EXPORT_DATA_ELEMENT_ID = 'logixiv-data';

export function buildExportPayload(input: {
  document: PaperDocument;
  pdfBase64: string;
  exportedAt?: string;
}): ExportPayload {
  return {
    format: 'logixiv-export',
    formatVersion: 1,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    document: input.document,
    pdfBase64: input.pdfBase64,
  };
}

function staticFallback(document: PaperDocument): string {
  const notesByHash = new Map<string, string[]>();
  for (const note of document.annotations.notes) {
    const list = notesByHash.get(note.sentenceHash);
    if (list) list.push(note.body);
    else notesByHash.set(note.sentenceHash, [note.body]);
  }
  const sectionTitles = new Map(document.structure.sections.map((s) => [s.id, s.title]));

  const rows: string[] = [];
  let lastSection: string | null = null;
  for (const sentence of document.structure.sentences) {
    if (sentence.sectionId !== lastSection) {
      lastSection = sentence.sectionId;
      const title = lastSection ? sectionTitles.get(lastSection) : null;
      if (title) rows.push(`<h2>${escapeHtml(title)}</h2>`);
    }
    rows.push(renderSentence(sentence, document, notesByHash.get(sentence.hash) ?? []));
  }
  return rows.join('\n');
}

function renderSentence(sentence: Sentence, document: PaperDocument, notes: string[]): string {
  const translation = document.annotations.translations[sentence.hash];
  const parts = [
    `<article class="lx-pair" id="static-${escapeHtml(sentence.id)}">`,
    `<p class="lx-source" lang="en">${escapeHtml(sentence.text)}</p>`,
  ];
  if (translation) {
    const mark = translation.revisedByHuman ? ' data-human="1"' : '';
    parts.push(`<p class="lx-target" lang="ja"${mark}>${escapeHtml(translation.text)}</p>`);
  } else if (document.annotations.skipped?.[sentence.hash]) {
    // 「訳さない」と決めた文まで（未訳）にすると、受け取った側には
    // やり残しにしか見えない。
    parts.push('<p class="lx-target lx-skipped">（訳さない）</p>');
  } else {
    parts.push('<p class="lx-target lx-untranslated">（未訳）</p>');
  }
  for (const note of notes) {
    parts.push(`<p class="lx-note">${escapeHtml(note)}</p>`);
  }
  parts.push('</article>');
  return parts.join('');
}

const STATIC_STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 0; font: 15px/1.7 -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; }
  .lx-static { max-width: 46rem; margin: 0 auto; padding: 2rem 1.25rem 6rem; }
  .lx-static h1 { font-size: 1.4rem; line-height: 1.4; }
  .lx-static h2 { font-size: 1.05rem; margin-top: 2.5rem; padding-bottom: .3rem; border-bottom: 1px solid rgba(128,128,128,.35); }
  .lx-pair { margin: 0 0 1.4rem; }
  .lx-source { margin: 0; color: #6b7280; font-size: .92rem; }
  .lx-target { margin: .2rem 0 0; }
  .lx-target[data-human="1"]::after { content: " ✓"; color: #059669; }
  .lx-target.lx-untranslated, .lx-target.lx-skipped { color: #9ca3af; }
  .lx-note { margin: .35rem 0 0; padding-left: .7rem; border-left: 3px solid #f59e0b; font-size: .88rem; }
  .lx-banner { max-width: 46rem; margin: 1rem auto 0; padding: .6rem .9rem; border: 1px solid rgba(128,128,128,.4); border-radius: 6px; font-size: .85rem; }
`;

export function buildExportHtml(input: BuildExportInput): string {
  const payload = buildExportPayload(input);
  const json = escapeJsonForScript(JSON.stringify(payload));
  const title = escapeHtml(input.document.title);
  // 受け取った側がまず知りたいのは「どこまで訳してあるか」。
  // 文数と解析方式だけでは、開いて（未訳）の壁に当たるまで分からない。
  const stats = progress(input.document);
  const exportedAt = new Date(input.exportedAt ?? Date.now()).toLocaleString('ja-JP', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const progressLine = escapeHtml(
    `${stats.uniqueSentences} 文中 ${stats.translated} 文訳済み` +
      (stats.skipped > 0 ? `・${stats.skipped} 文は訳さない判断` : '') +
      ` ／ ${exportedAt} 時点`,
  );

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="LogiXiv ${LOGIXIV_VERSION}">
<title>${title} — LogiXiv</title>
<style>${STATIC_STYLE}</style>
<style>${sealInline(input.viewerStyle, 'style')}</style>
</head>
<body>
<div id="lx-root"></div>
<div class="lx-static" id="lx-static">
<h1>${title}</h1>
<p class="lx-banner">${progressLine}</p>
<p class="lx-banner">この HTML は LogiXiv の書き出しです。JavaScript が動く環境では PDF と対訳が並んだビューアが開きます。動かない環境では以下の対訳がそのまま読めます。<br>（未訳）＝まだ訳していない文、（訳さない）＝参考文献や数式など訳す対象から外した文、✓ ＝人が手を入れた訳です。</p>
${staticFallback(input.document)}
</div>
<script type="application/json" id="${EXPORT_DATA_ELEMENT_ID}">${json}</script>
<script>${sealInline(input.viewerScript, 'script')}</script>
</body>
</html>
`;
}
