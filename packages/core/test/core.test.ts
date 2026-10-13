import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSentence, sentenceHash } from '../src/hash.ts';
import { parseXml, textContent, descendants, firstChild } from '../src/xml.ts';
import { parseTei, parseCoords } from '../src/tei.ts';
import { splitIntoSentences, buildSentencesFromChunks, type TextChunk } from '../src/sentences.ts';
import { mergeAnnotations, incomingWins, applyStructure } from '../src/merge.ts';
import { createDocument, setTranslation, addNote, progress, searchDocument } from '../src/document.ts';
import { buildExportHtml } from '../src/export.ts';
import { parseExportHtml, overlapRatio, ImportError } from '../src/import.ts';
import type { Annotations, DocumentStructure, Translation } from '../src/types.ts';

const SAMPLE_TEI = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt><title level="a" type="main">Sparse Attention at Scale</title></titleStmt>
    </fileDesc>
    <profileDesc>
      <abstract>
        <div><p><s coords="1,53.80,120.00,238.71,9.29">We study sparse attention under long contexts.</s></p></div>
      </abstract>
    </profileDesc>
  </teiHeader>
  <facsimile>
    <surface n="1" ulx="0.0" uly="0.0" lrx="595.0" lry="842.0"/>
    <surface n="2" ulx="0.0" uly="0.0" lrx="595.0" lry="842.0"/>
  </facsimile>
  <text xml:lang="en">
    <body>
      <div xmlns="http://www.tei-c.org/ns/1.0">
        <head n="1.">Introduction</head>
        <p>
          <s coords="1,53.80,194.57,238.71,9.29;1,53.80,205.00,238.71,9.29">Transformers scale poorly with sequence length.</s>
          <s coords="1,53.80,220.00,238.71,9.29">We revisit this claim for x &lt; 10 tokens.</s>
        </p>
      </div>
      <div>
        <head n="2.">Method</head>
        <p><s coords="2,53.80,100.00,238.71,9.29">Our approach uses block-sparse kernels.</s></p>
      </div>
    </body>
  </text>
</TEI>`;

test('normalizeSentence は行末ハイフネーションと空白差を吸収する', () => {
  const a = 'We use informa-  tion   retrieval.';
  const b = 'We use information retrieval.';
  assert.equal(normalizeSentence(a), normalizeSentence(b));
  assert.equal(sentenceHash(a), sentenceHash(b));
});

test('normalizeSentence は大文字小文字を保持する', () => {
  assert.notEqual(sentenceHash('Nature is complex.'), sentenceHash('nature is complex.'));
});

test('XML パーサは実体参照・CDATA・属性内の > を正しく扱う', () => {
  const doc = parseXml('<r a="1 &gt; 0"><b><![CDATA[x < y]]></b><c/>&amp;tail</r>');
  const root = firstChild(doc, 'r');
  assert.ok(root);
  assert.equal(root.attrs['a'], '1 > 0');
  assert.equal(textContent(root), 'x < y&tail');
  assert.equal([...descendants(root, 'c')].length, 1);
});

test('XML パーサは閉じタグの対応が崩れても全体を捨てない', () => {
  const doc = parseXml('<r><a>one</b><c>two</c></a></r>');
  const root = firstChild(doc, 'r');
  assert.ok(root);
  assert.ok(textContent(root).includes('one'));
  assert.ok(textContent(root).includes('two'));
});

test('parseCoords は行またぎの複数矩形を返す', () => {
  const rects = parseCoords('1,53.80,194.57,238.71,9.29;2,10,20,30,40');
  assert.equal(rects.length, 2);
  assert.deepEqual(rects[1], { page: 2, x: 10, y: 20, w: 30, h: 40 });
  assert.deepEqual(parseCoords(undefined), []);
  assert.deepEqual(parseCoords('broken,1,2'), []);
});

test('parseTei は文・座標・見出し・ページサイズを取り出す', () => {
  const structure = parseTei(SAMPLE_TEI);
  assert.equal(structure.parser, 'grobid');
  assert.equal(structure.title, 'Sparse Attention at Scale');
  assert.equal(structure.pageSizes.length, 2);
  assert.deepEqual(structure.pageSizes[0], { page: 1, width: 595, height: 842 });

  // 抄録 1 文 + 本文 3 文。
  assert.equal(structure.sentences.length, 4);
  const first = structure.sentences[0]!;
  assert.equal(first.text, 'We study sparse attention under long contexts.');
  assert.equal(first.sectionId, 'sec_abstract');

  const multiline = structure.sentences[1]!;
  assert.equal(multiline.rects.length, 2);
  assert.equal(multiline.page, 1);

  // 実体参照が本文に復元されていること。
  assert.ok(structure.sentences[2]!.text.includes('x < 10'));

  // 見出しは文としてサイドバーに並ばない。
  assert.ok(!structure.sentences.some((s) => s.text === 'Introduction'));
  assert.deepEqual(
    structure.sections.map((s) => s.title),
    ['Abstract', '1. Introduction', '2. Method'],
  );

  const last = structure.sentences[3]!;
  assert.equal(last.page, 2);
  // 節 ID は並び順ではなく見出しの内容から作る（抄録の有無でずれないように）。
  assert.equal(last.sectionId, structure.sections.find((s) => s.title === '2. Method')!.id);
});

test('parseTei は座標が欠けていることを parserNote で知らせる', () => {
  const withoutCoords = SAMPLE_TEI.replace(/ coords="[^"]*"/g, '');
  const structure = parseTei(withoutCoords);
  assert.match(structure.parserNote, /teiCoordinates/);
});

test('splitIntoSentences は略語・小数・イニシャルで切らない', () => {
  const text =
    'We follow Smith et al. and report 3.14 as the baseline. J. Doe disagrees (see Fig. 2). Does it hold? Yes.';
  const sentences = splitIntoSentences(text);
  assert.equal(sentences.length, 4);
  assert.equal(sentences[0], 'We follow Smith et al. and report 3.14 as the baseline.');
  assert.equal(sentences[1], 'J. Doe disagrees (see Fig. 2).');
  assert.equal(sentences[2], 'Does it hold?');
});

test('フォールバック経路は行末ハイフンを結合し矩形をまとめる', () => {
  const chunks: TextChunk[] = [
    { page: 1, text: 'We use informa-', x: 50, y: 100, w: 90, h: 10 },
    { page: 1, text: 'tion retrieval.', x: 50, y: 112, w: 88, h: 10 },
    { page: 1, text: 'It works well.', x: 50, y: 124, w: 80, h: 10 },
  ];
  const { sentences } = buildSentencesFromChunks(chunks, []);
  assert.equal(sentences.length, 2);
  assert.equal(sentences[0]!.text, 'We use information retrieval.');
  assert.equal(sentences[0]!.rects.length, 2);
  assert.equal(sentences[0]!.hash, sentenceHash('We use information retrieval.'));
});

function translation(text: string, opts: Partial<Translation> = {}): Translation {
  return {
    sentenceHash: opts.sentenceHash ?? 'h1',
    text,
    revisedByHuman: opts.revisedByHuman ?? false,
    source: opts.source ?? 'claude',
    updatedAt: opts.updatedAt ?? '2026-01-01T00:00:00.000Z',
  };
}

test('人手修正済みの訳は新しい機械訳に負けない', () => {
  const human = translation('人手の訳', { revisedByHuman: true, source: 'human', updatedAt: '2026-01-01T00:00:00.000Z' });
  const machine = translation('機械の訳', { updatedAt: '2027-01-01T00:00:00.000Z' });
  assert.equal(incomingWins(human, machine), false);
  assert.equal(incomingWins(machine, human), true);
});

test('メモは衝突しても消えず、完全な重複だけが弾かれる', () => {
  const base: Annotations = {
    translations: {},
    notes: [
      { id: 'n1', sentenceHash: 'h1', body: '既存メモ', author: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ],
    glossary: [],
  };
  const incoming: Annotations = {
    translations: {},
    notes: [
      { id: 'n1', sentenceHash: 'h1', body: '既存メモ', author: null, createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
      { id: 'n1', sentenceHash: 'h1', body: '別人の別メモ', author: 'nico', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
    ],
    glossary: [{ term: 'sparse', translation: '疎', note: null }],
  };
  const { annotations, report } = mergeAnnotations(base, incoming, new Set(['h1']));
  assert.equal(annotations.notes.length, 2);
  assert.equal(report.notesAdded, 1);
  assert.equal(report.notesSkippedAsDuplicate, 1);
  assert.equal(report.glossaryAdded, 1);
  // ID 衝突は消さずに振り直す。
  assert.notEqual(annotations.notes[1]!.id, 'n1');
});

test('取り込み時、対応する文が無い注釈は既定で捨てられ、件数が報告される', () => {
  const incoming: Annotations = {
    translations: { known: translation('あり', { sentenceHash: 'known' }), unknown: translation('なし', { sentenceHash: 'unknown' }) },
    notes: [],
    glossary: [],
  };
  const dropped = mergeAnnotations({ translations: {}, notes: [], glossary: [] }, incoming, new Set(['known']));
  assert.equal(dropped.report.orphaned, 1);
  assert.equal(Object.keys(dropped.annotations.translations).length, 1);

  const kept = mergeAnnotations({ translations: {}, notes: [], glossary: [] }, incoming, new Set(['known']), {
    orphanPolicy: 'keep',
  });
  assert.equal(Object.keys(kept.annotations.translations).length, 2);
});

test('setTranslation は人手修正済みを機械訳で上書きしない', () => {
  const structure = parseTei(SAMPLE_TEI);
  let document = createDocument({ structure, sourceFileName: 'paper.pdf' });
  const hash = structure.sentences[0]!.hash;

  document = setTranslation(document, hash, '人手の訳', { source: 'human' }).document;
  const attempt = setTranslation(document, hash, '機械の訳', { source: 'claude' });
  assert.equal(attempt.applied, false);
  assert.equal(document.annotations.translations[hash]!.text, '人手の訳');

  const missing = setTranslation(document, 'ffffffffffffffff', 'x');
  assert.equal(missing.applied, false);

  const stats = progress(document);
  assert.equal(stats.uniqueSentences, 4);
  assert.equal(stats.translated, 1);
  assert.equal(stats.revisedByHuman, 1);
});

test('再解析しても注釈はハッシュで再結合される', () => {
  const structure = parseTei(SAMPLE_TEI);
  let document = createDocument({ structure, sourceFileName: 'paper.pdf' });
  document = setTranslation(document, structure.sentences[0]!.hash, '訳', { source: 'human' }).document;

  // 座標だけが変わった再解析結果（本文は同じ）。
  const reparsed: DocumentStructure = parseTei(SAMPLE_TEI.replace('194.57', '195.00'));
  const result = applyStructure(document, reparsed);
  assert.equal(result.rebound, 1);
  assert.equal(result.orphaned, 0);
  assert.equal(result.document.annotations.translations[structure.sentences[0]!.hash]!.text, '訳');
});

test('検索は原文・訳文・メモを横断する', () => {
  const structure = parseTei(SAMPLE_TEI);
  let document = createDocument({ structure, sourceFileName: 'paper.pdf' });
  document = setTranslation(document, structure.sentences[3]!.hash, 'ブロック疎カーネルを使う', { source: 'claude' }).document;
  document = addNote(document, structure.sentences[1]!.hash, '要確認: 主張の根拠').document;

  assert.equal(searchDocument(document, 'block-sparse')[0]!.where[0], 'source');
  assert.equal(searchDocument(document, 'カーネル')[0]!.where[0], 'translation');
  assert.equal(searchDocument(document, '要確認')[0]!.where[0], 'note');
  assert.equal(searchDocument(document, '  ').length, 0);
});

test('書き出し HTML は自己完結し、往復で訳とメモが復元される', () => {
  const structure = parseTei(SAMPLE_TEI);
  let document = createDocument({ structure, sourceFileName: 'paper.pdf' });
  document = setTranslation(document, structure.sentences[0]!.hash, '長い文脈における疎な注意機構を検討する。', {
    source: 'human',
  }).document;
  document = addNote(document, structure.sentences[0]!.hash, 'ここが主張の核', 'nico').document;

  const html = buildExportHtml({
    document,
    pdfBase64: 'JVBERi0xLjQK',
    viewerScript: 'console.log("viewer")',
    viewerStyle: '.lx{}',
  });

  // 外部参照ゼロ。
  assert.equal(/(src|href)\s*=\s*["']https?:/i.test(html), false);
  // JS が無くても読める静的フォールバック。
  assert.ok(html.includes('長い文脈における疎な注意機構を検討する。'));
  assert.ok(html.includes('ここが主張の核'));

  const parsed = parseExportHtml(html);
  assert.equal(parsed.documentTitle, document.title);
  assert.equal(parsed.pdfBase64, 'JVBERi0xLjQK');
  assert.equal(parsed.sentenceHashes.length, 4);
  assert.equal(parsed.annotations.notes.length, 1);
  assert.equal(parsed.annotations.translations[structure.sentences[0]!.hash]!.revisedByHuman, true);
  assert.equal(overlapRatio(parsed, document), 1);
});

test('新しい書き出しは PaperLens の id と format で書かれる', () => {
  const document = createDocument({ structure: parseTei(SAMPLE_TEI), sourceFileName: 'paper.pdf' });
  const html = buildExportHtml({ document, pdfBase64: '', viewerScript: '', viewerStyle: '' });
  assert.ok(html.includes('id="paperlens-data"'));
  assert.ok(html.includes('"format":"paperlens-export"'));
  assert.equal(/logixiv/i.test(html), false);
});

test('改名前（LogiXiv）の書き出し HTML もそのまま取り込める', () => {
  const structure = parseTei(SAMPLE_TEI);
  let document = createDocument({ structure, sourceFileName: 'paper.pdf' });
  document = setTranslation(document, structure.sentences[0]!.hash, '古い書き出しの訳。', { source: 'human' }).document;
  document = addNote(document, structure.sentences[0]!.hash, '古いメモ').document;
  // 改名前の版が書いていたとおりの id と format に戻す。
  const legacyHtml = buildExportHtml({ document, pdfBase64: 'JVBERi0xLjQK', viewerScript: '', viewerStyle: '' })
    .replace('id="paperlens-data"', 'id="logixiv-data"')
    .replace('"format":"paperlens-export"', '"format":"logixiv-export"');
  assert.ok(legacyHtml.includes('id="logixiv-data"'));
  assert.ok(legacyHtml.includes('"format":"logixiv-export"'));

  const parsed = parseExportHtml(legacyHtml);
  assert.equal(parsed.documentTitle, document.title);
  assert.equal(parsed.pdfBase64, 'JVBERi0xLjQK');
  assert.equal(parsed.annotations.notes[0]!.body, '古いメモ');
  assert.equal(parsed.annotations.translations[structure.sentences[0]!.hash]!.text, '古い書き出しの訳。');
});

test('新旧の id が両方あるときは、どれが本物か判断できないので断る', () => {
  const payload = '{"format":"paperlens-export","formatVersion":1}';
  const html =
    `<script type="application/json" id="paperlens-data">${payload}</script>` +
    `<script type="application/json" id="logixiv-data">${payload}</script>`;
  assert.throws(() => parseExportHtml(html), /2 個見つかりました/);
});

test('注釈に script 要素が混ざっても要素が閉じない', () => {
  const structure = parseTei(SAMPLE_TEI);
  let document = createDocument({ structure, sourceFileName: 'paper.pdf' });
  const payload = '</script><img src=x onerror=alert(1)>';
  document = addNote(document, structure.sentences[0]!.hash, payload).document;

  const html = buildExportHtml({ document, pdfBase64: '', viewerScript: '', viewerStyle: '' });
  assert.equal(html.includes('<img src=x'), false);
  assert.ok(html.includes('&lt;img src=x'));

  const parsed = parseExportHtml(html);
  assert.equal(parsed.annotations.notes[0]!.body, payload);
});

test('PaperLens 製でない HTML と壊れた JSON は ImportError になる', () => {
  assert.throws(() => parseExportHtml('<html><body>ただのページ</body></html>'), ImportError);
  assert.throws(
    () => parseExportHtml('<script type="application/json" id="paperlens-data">{ broken</script>'),
    ImportError,
  );
  assert.throws(
    () => parseExportHtml('<script type="application/json" id="paperlens-data">{"format":"other"}</script>'),
    ImportError,
  );
});
