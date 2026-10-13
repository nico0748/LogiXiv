import type { ExportPayload, NonBodySentence, PaperDocument, Sentence } from './types.ts';
import { escapeHtml, escapeJsonForScript } from './escape.ts';
import { progress } from './document.ts';
import { placeNonBody } from './nonbody.ts';
import { PAPERLENS_VERSION } from './hash.ts';

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

export const EXPORT_DATA_ELEMENT_ID = 'paperlens-data';
export const EXPORT_FORMAT = 'paperlens-export';
/**
 * 改名前（LogiXiv）の書き出しが使っていた id と format。
 * 書くのは新しい名前だけだが、読むときは古い書き出しも受け付ける。
 */
export const LEGACY_EXPORT_DATA_ELEMENT_IDS: readonly string[] = ['logixiv-data'];
export const LEGACY_EXPORT_FORMATS: readonly string[] = ['logixiv-export'];

export function buildExportPayload(input: {
  document: PaperDocument;
  pdfBase64: string;
  exportedAt?: string;
}): ExportPayload {
  return {
    format: EXPORT_FORMAT,
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

  // 本文として扱わなかった行を、直前の本文の後ろに差し込む。
  // 割り付けの規則は画面・ビューアと共有する（nonbody.ts）。3 か所で並びが違うと、
  // 同じ論文を 3 通りの順序で見せることになる。
  const { head, after: nonBodyAfter } = placeNonBody(document.structure.sentences, document.structure.nonBody);

  const rows: string[] = head.map(renderNonBody);
  let lastSection: string | null = null;
  for (const sentence of document.structure.sentences) {
    if (sentence.sectionId !== lastSection) {
      lastSection = sentence.sectionId;
      const title = lastSection ? sectionTitles.get(lastSection) : null;
      if (title) rows.push(`<h2>${escapeHtml(title)}</h2>`);
    }
    rows.push(renderSentence(sentence, document, notesByHash.get(sentence.hash) ?? []));
    for (const item of nonBodyAfter.get(sentence.id) ?? []) rows.push(renderNonBody(item));
  }
  return rows.join('\n');
}

const NON_BODY_LABELS: Record<NonBodySentence['kind'], string> = {
  frontMatter: '表題・著者',
  runningHead: '柱',
  pageNumber: 'ページ番号',
  caption: '図表キャプション',
  reference: '参考文献',
  footnote: '脚注',
  formula: '数式',
  table: '表',
  other: '本文以外',
};

/** 本文として扱わなかった行。訳の対象ではないが、在ることは示す。 */
function renderNonBody(item: NonBodySentence): string {
  return (
    '<article class="lx-pair lx-nonbody">' +
    `<p class="lx-nonbody-kind">${escapeHtml(NON_BODY_LABELS[item.kind])}（訳しません）</p>` +
    `<p class="lx-source" lang="en">${escapeHtml(item.text)}</p>` +
    '</article>'
  );
}

/** 継ぎ目に挟まっていたものの呼び方。 */
function seamLabel(kinds: NonBodySentence['kind'][]): string {
  const names = kinds.map((kind) => NON_BODY_LABELS[kind] ?? '行');
  if (names.length === 0) return '行';
  if (names.length <= 2) return names.join('と');
  return `${names.slice(0, 2).join('と')}など`;
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
  if (sentence.seam) {
    // 訳文だけを読むと、記号が落ちた文も「そう書いてある」としか見えない。
    const missing =
      sentence.seam.texts && sentence.seam.texts.length > 0
        ? ` 抜けたのはここ: ${escapeHtml(sentence.seam.texts.join(' / '))}`
        : '';
    parts.push(
      `<p class="lx-seam">この文には、本文として取り出せなかった${escapeHtml(
        seamLabel(sentence.seam.kinds),
      )}が挟まっています（記号や語が抜けているおそれ）。${missing}</p>`,
    );
  }
  for (const note of notes) {
    parts.push(`<p class="lx-note">${escapeHtml(note)}</p>`);
  }
  parts.push('</article>');
  return parts.join('');
}

/**
 * 用語集も書き出す。
 *
 * これまで書き出し HTML に用語集は 1 文字も出ていなかった（JSON には入っているが
 * 誰も描かない）。訳語をどう決めたかが受け取った側に伝わらないので、
 * 相手は同じ語を別の訳で書き直し、2 人で訳すほど揺れる。
 * 訳文そのものより、訳語の方針の方が引き継ぎに効く。
 */
function glossarySection(document: PaperDocument): string {
  const entries = document.annotations.glossary;
  if (entries.length === 0) return '';
  const rows = entries
    .map(
      (entry) =>
        `<tr><td lang="en">${escapeHtml(entry.term)}</td><td>${escapeHtml(entry.translation)}</td>` +
        `<td>${entry.note ? escapeHtml(entry.note) : ''}</td></tr>`,
    )
    .join('');
  return (
    `<h2 id="lx-glossary">用語集（${entries.length}）</h2>` +
    '<table class="lx-glossary"><thead><tr><th>原語</th><th>訳語</th><th>メモ</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>`
  );
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
  .lx-glossary { border-collapse: collapse; font-size: .9rem; }
  .lx-glossary th, .lx-glossary td { text-align: left; padding: .25rem .8rem .25rem 0; border-bottom: 1px solid rgba(128,128,128,.25); vertical-align: top; }
  .lx-glossary th { color: #6b7280; font-weight: 600; }
  .lx-nonbody { opacity: .6; }
  .lx-nonbody-kind { margin: 0 0 .1rem; font-size: .72rem; color: #6b7280; }
  .lx-banner.lx-risk { border-left: 3px solid #b3261e; font-weight: 600; }
  .lx-seam { margin: .3rem 0 0; padding-left: .7rem; border-left: 3px solid #b45309; font-size: .82rem; }
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
  // 読み順が崩れている疑いは、受け取った側がいちばん先に知るべきこと。
  // 訳が正しくても、その訳が付いている原文が壊れていることがある。
  const quality = input.document.structure.quality;
  const riskLine =
    (quality?.readingOrderRisk === 'high'
      ? `<p class="lx-banner lx-risk">読み順に崩れの疑い: ${escapeHtml(quality.reason)}</p>`
      : '') +
    (quality?.coverageRisk === 'high'
      ? `<p class="lx-banner lx-risk">本文の欠落の疑い: ${escapeHtml(quality.coverageReason ?? '')}</p>`
      : '');
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
<meta name="generator" content="PaperLens ${PAPERLENS_VERSION}">
<title>${title} — PaperLens</title>
<style>${STATIC_STYLE}</style>
<style>${sealInline(input.viewerStyle, 'style')}</style>
</head>
<body>
<div id="lx-root"></div>
<div class="lx-static" id="lx-static">
<h1>${title}</h1>
<p class="lx-banner">${progressLine}</p>
${riskLine}
<p class="lx-banner">この HTML は PaperLens の書き出しです。JavaScript が動く環境では PDF と対訳が並んだビューアが開きます。動かない環境では以下の対訳がそのまま読めます。<br>（未訳）＝まだ訳していない文、（訳さない）＝参考文献や数式など訳す対象から外した文、✓ ＝人が手を入れた訳です。</p>
${staticFallback(input.document)}
${glossarySection(input.document)}
</div>
<script type="application/json" id="${EXPORT_DATA_ELEMENT_ID}">${json}</script>
<script>${sealInline(input.viewerScript, 'script')}</script>
</body>
</html>
`;
}
