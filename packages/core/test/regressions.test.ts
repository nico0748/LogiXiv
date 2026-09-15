import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSentence, sentenceHash, STRUCTURE_VERSION } from '../src/hash.ts';
import { parseXml, textContent, descendants, firstChild, decodeEntities } from '../src/xml.ts';
import { parseTei } from '../src/tei.ts';
import { splitIntoSentences, buildSentencesFromChunks, type TextChunk } from '../src/sentences.ts';
import { incomingWins } from '../src/merge.ts';
import { createDocument, addNote, setTranslation, searchDocument } from '../src/document.ts';
import { buildExportHtml } from '../src/export.ts';
import { parseExportHtml, ImportError } from '../src/import.ts';
import { sanitizeDocument, emptySanitizeReport, sanitizeStructure } from '../src/validate.ts';
import { migrateDocument } from '../src/migrate.ts';
import type { PaperDocument, Translation } from '../src/types.ts';

/**
 * サイクル1の批評で見つかった不具合の回帰テスト。
 * どれも「批評エージェントが実際に再現させた入力」をそのまま固定してある。
 */

// --- 文分割 -------------------------------------------------------------

test('略語判定が単語境界を見るので、test./systems./first. で文が切れる', () => {
  assert.equal(splitIntoSentences('We evaluate on the test. We then report results.').length, 2);
  assert.equal(splitIntoSentences('We study large systems. They are complex.').length, 2);
  assert.equal(splitIntoSentences('Consider the first. Consider the second.').length, 2);
  assert.equal(splitIntoSentences('We deploy the app. It runs.').length, 2);
  assert.equal(splitIntoSentences('We visited America. It was far.').length, 2);
});

test('本物の略語ではまだ切れない', () => {
  assert.equal(splitIntoSentences('We follow Smith et al. and report the result.').length, 1);
  assert.equal(splitIntoSentences('See Fig. 2 for details.').length, 1);
  assert.equal(splitIntoSentences('We use e.g. beam search here.').length, 1);
  assert.equal(splitIntoSentences('Run No. 3 failed.').length, 1);
  assert.equal(splitIntoSentences('We report 3.14 as the baseline.').length, 1);
});

test('"method X." のようなラベル終わりは文末として切る', () => {
  assert.equal(splitIntoSentences('We call this method X. It works well.').length, 2);
  assert.equal(splitIntoSentences('Results are in group A. Group B differs.').length, 2);
  // 人名イニシャルは結合したまま。
  assert.equal(splitIntoSentences('J. Doe disagrees with this claim.').length, 1);
});

// --- ハイフネーション ----------------------------------------------------

test('行末で割れたハイフン付き複合語が、両方の解析経路で同じハッシュになる', () => {
  // GROBID は折り返しを解決済みの一文を返す。
  const grobid = 'Our approach uses block-sparse kernels and outperforms the baseline.';
  // フォールバックは行末で割れた状態を見る。
  const fallbackChunks: TextChunk[] = [
    { page: 1, text: 'Our approach uses block-', x: 50, y: 100, w: 140, h: 10 },
    { page: 1, text: 'sparse kernels and outperforms the baseline.', x: 50, y: 112, w: 240, h: 10 },
  ];
  const { sentences } = buildSentencesFromChunks(fallbackChunks, []);
  assert.equal(sentences.length, 1);
  assert.equal(
    sentences[0]!.hash,
    sentenceHash(grobid),
    '再解析で訳が外れないよう、折り返し位置が違ってもハッシュは一致しなければならない',
  );
});

test('本来ハイフンを含む複合語は、文書内に非行末の用例があれば表示テキストでも保たれる', () => {
  const chunks: TextChunk[] = [
    { page: 1, text: 'A state-of-the-art model is used here.', x: 50, y: 100, w: 200, h: 10 },
    { page: 1, text: 'We compare with the state-of-the-', x: 50, y: 112, w: 190, h: 10 },
    { page: 1, text: 'art baseline directly.', x: 50, y: 124, w: 120, h: 10 },
  ];
  const { sentences } = buildSentencesFromChunks(chunks, []);
  assert.equal(sentences.length, 2);
  assert.equal(sentences[1]!.text, 'We compare with the state-of-the-art baseline directly.');
});

test('真のハイフネーションは結合する', () => {
  const chunks: TextChunk[] = [
    { page: 1, text: 'We use informa-', x: 50, y: 100, w: 90, h: 10 },
    { page: 1, text: 'tion retrieval here.', x: 50, y: 112, w: 110, h: 10 },
  ];
  const { sentences } = buildSentencesFromChunks(chunks, []);
  assert.equal(sentences[0]!.text, 'We use information retrieval here.');
});

test('数式のマイナスを行末ハイフンとして食べない', () => {
  const chunks: TextChunk[] = [
    { page: 1, text: 'The value is 5 -', x: 50, y: 100, w: 80, h: 10 },
    { page: 1, text: '3 units in total.', x: 50, y: 112, w: 90, h: 10 },
  ];
  const { sentences } = buildSentencesFromChunks(chunks, []);
  assert.ok(sentences[0]!.text.includes('5 -'), `マイナスが消えた: ${sentences[0]!.text}`);
});

test('空の文字片が二重スペースを作らない', () => {
  const chunks: TextChunk[] = [
    { page: 1, text: 'Hello', x: 50, y: 100, w: 30, h: 10 },
    { page: 1, text: '', x: 80, y: 100, w: 0, h: 10 },
    { page: 1, text: 'world', x: 90, y: 100, w: 30, h: 10 },
    { page: 1, text: 'now.', x: 130, y: 100, w: 25, h: 10 },
  ];
  const { sentences } = buildSentencesFromChunks(chunks, []);
  assert.equal(sentences[0]!.text, 'Hello world now.');
});

test('同一行の矩形は丸め境界をまたいでも 1 つにまとまる', () => {
  const chunks: TextChunk[] = [
    { page: 1, text: 'Left part', x: 50, y: 100.4, w: 30, h: 10 },
    { page: 1, text: 'middle', x: 90, y: 100.6, w: 30, h: 10 },
    { page: 1, text: 'and right end.', x: 130, y: 100.5, w: 40, h: 10.1 },
  ];
  const { sentences } = buildSentencesFromChunks(chunks, []);
  assert.equal(sentences[0]!.rects.length, 1, '視覚的に 1 行なら矩形も 1 つ');
});

// --- 正規化とハッシュ衝突 ------------------------------------------------

test('NFC 正規化なので上付き文字・℃・µ が別の文と衝突しない', () => {
  assert.notEqual(sentenceHash('We set x² = 2.'), sentenceHash('We set x2 = 2.'));
  assert.notEqual(sentenceHash('The rate is 10⁻³ per step.'), sentenceHash('The rate is 10-3 per step.'));
  assert.notEqual(sentenceHash('Temperature is 25℃ here.'), sentenceHash('Temperature is 25°C here.'));
  assert.notEqual(sentenceHash('Range A–B is wide.'), sentenceHash('Range A-B is wide.'));
});

test('em dash が語を融合させない', () => {
  assert.equal(normalizeSentence('the model— however it fails'), 'the model— however it fails');
});

// --- XML パーサ ---------------------------------------------------------

test('範囲外の数値文字参照で例外を投げない', () => {
  assert.equal(decodeEntities('&#x110000;'), '&#x110000;');
  assert.equal(decodeEntities('&#99999999999;'), '&#99999999999;');
  assert.equal(decodeEntities('&#xD800;'), '&#xD800;');
  assert.equal(decodeEntities('&#65;'), 'A');
  assert.doesNotThrow(() => parseTei('<TEI><text><body><p>&#x110000;</p></body></text></TEI>'));
});

test('閉じタグの無い深い入力でもスタックを溢れさせない', () => {
  const deep = parseXml('<a>'.repeat(20000));
  assert.doesNotThrow(() => textContent(deep));
  assert.doesNotThrow(() => [...descendants(deep, 'a')].length);
});

test('名前空間つき属性が同名のローカル属性を消さない', () => {
  const root = firstChild(parseXml('<r xml:id="A" id="B" xlink:href="h" href="z"/>'), 'r')!;
  assert.equal(root.attrs['xml:id'], 'A');
  assert.equal(root.attrs['id'], 'A', '先に現れた綴りを優先する');
  assert.equal(root.attrs['xlink:href'], 'h');
});

// --- TEI ---------------------------------------------------------------

const TEI_WITH_FURNITURE = `<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><fileDesc><titleStmt><title>T</title></titleStmt></fileDesc></teiHeader>
  <text><body>
    <div><head n="1.">Introduction</head>
      <p><s coords="1,10,10,100,10">Body sentence one.</s></p>
      <figure><figDesc><s>Overview of the pipeline.</s></figDesc>
        <table><row><cell><s>0.91</s></cell><cell><s>Baseline accuracy value.</s></cell></row></table>
      </figure>
      <note place="foot"><s coords="1,10,50,100,10">Code is available at our repo.</s></note>
      <formula><s>y = Wx + b</s></formula>
      <p><s coords="1,10,70,100,10">Body sentence two.</s></p>
    </div>
    <div><head n="2.">Method</head><p><s coords="2,10,10,100,10">Method sentence.</s></p></div>
  </body></text>
</TEI>`;

test('図表・脚注・数式の文は本文に混ざらない', () => {
  const structure = parseTei(TEI_WITH_FURNITURE);
  const texts = structure.sentences.map((s) => s.text);
  assert.deepEqual(texts, ['Body sentence one.', 'Body sentence two.', 'Method sentence.']);
  assert.match(structure.parserNote, /本文から除外/);
  // 除外後は全文に座標があるので、座標の警告は出ない。
  assert.doesNotMatch(structure.parserNote, /teiCoordinates/);
});

test('節 ID は抄録の有無で変わらない', () => {
  const withAbstract = parseTei(TEI_WITH_FURNITURE, { includeAbstract: true });
  const withoutAbstract = parseTei(TEI_WITH_FURNITURE, { includeAbstract: false });
  assert.deepEqual(
    withAbstract.sentences.map((s) => s.sectionId),
    withoutAbstract.sentences.map((s) => s.sectionId),
  );
});

test('構造バージョンが現行値で出る', () => {
  assert.equal(parseTei(TEI_WITH_FURNITURE).version, STRUCTURE_VERSION);
});

// --- マージ -------------------------------------------------------------

function translation(text: string, opts: Partial<Translation> = {}): Translation {
  return {
    sentenceHash: opts.sentenceHash ?? 'h1',
    text,
    revisedByHuman: opts.revisedByHuman ?? false,
    source: opts.source ?? 'claude',
    updatedAt: opts.updatedAt ?? '2026-01-01T00:00:00.000Z',
  };
}

test('updatedAt が壊れた既存訳は更新不能にならない', () => {
  const broken = translation('壊れた日付の訳', { updatedAt: 'not a date' });
  const fresh = translation('新しい訳', { updatedAt: '2030-01-01T00:00:00.000Z' });
  assert.equal(incomingWins(broken, fresh), true);
  assert.equal(incomingWins(fresh, broken), false);
});

// --- 注釈の検証 ---------------------------------------------------------

test('壊れた document を取り込んでも型が保たれる', () => {
  const { document, report } = sanitizeDocument(
    {
      title: 'poisoned',
      structure: { sentences: [{ hash: 'h1', text: null, rects: 'oops' }, { text: 'Valid sentence.' }] },
      annotations: {
        translations: { h1: { text: { nested: 'not a string' }, revisedByHuman: 'yes' } },
        notes: 'not an array',
        glossary: [{ term: 1 }],
      },
    },
    { id: 'doc_test' },
  );
  assert.equal(document.structure.sentences.length, 1);
  assert.equal(document.structure.sentences[0]!.text, 'Valid sentence.');
  assert.deepEqual(document.structure.sentences[0]!.rects, []);
  assert.deepEqual(document.annotations.translations, {});
  assert.deepEqual(document.annotations.notes, []);
  assert.deepEqual(document.annotations.glossary, []);
  assert.ok(report.droppedSentences >= 1);
  assert.ok(report.droppedTranslations >= 1);
});

test('annotations が null でも空注釈になる（一覧 API を落とさない）', () => {
  const { document } = sanitizeDocument({ structure: { sentences: [] }, annotations: null }, { id: 'doc_x' });
  assert.deepEqual(document.annotations, { translations: {}, notes: [], glossary: [], skipped: {} });
});

test('文のハッシュは受け取った値ではなく原文から計算し直す', () => {
  const report = emptySanitizeReport();
  const structure = sanitizeStructure(
    { sentences: [{ hash: 'ffffffffffffffff', text: 'Hello world.' }] },
    report,
  );
  assert.equal(structure.sentences[0]!.hash, sentenceHash('Hello world.'));
  assert.ok(report.repaired >= 1);
});

// --- 取り込み -----------------------------------------------------------

function exportOf(document: PaperDocument): string {
  return buildExportHtml({ document, pdfBase64: 'JVBERi0xLjQK', viewerScript: '', viewerStyle: '' });
}

function sampleDocument(): PaperDocument {
  return createDocument({ structure: parseTei(TEI_WITH_FURNITURE), sourceFileName: 'paper.pdf' });
}

test('データ script が複数あったら、黙って先頭を採らずエラーにする', () => {
  const html = exportOf(sampleDocument());
  const spoofed = html.replace(
    '<div id="lx-root"></div>',
    '<div id="lx-root"></div><script type="application/json" id="logixiv-data">{"format":"logixiv-export","formatVersion":1,"document":{"title":"SPOOF"}}</script>',
  );
  assert.throws(() => parseExportHtml(spoofed), /2 個見つかりました/);
});

test('属性値に > を含む script タグでも見つけられる', () => {
  const html = '<script data-x="a>b" type="application/json" id="logixiv-data">{"format":"logixiv-export","formatVersion":1,"document":{"structure":{"sentences":[{"text":"Hi."}]}}}</script>';
  assert.equal(parseExportHtml(html).sentenceHashes.length, 1);
});

test('LogiXiv 製でない大きな HTML でも取り込み判定が線形時間で終わる', () => {
  const noise = '<script src="https://example.com/a.js" data-pad="x">var a=1;</script>\n'.repeat(4000);
  const started = Date.now();
  assert.throws(() => parseExportHtml(noise), ImportError);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, `取り込み判定に ${elapsed}ms かかった（バックトラックしている疑い）`);
});

test('往復で訳・メモが戻り、document は検証済みで返る', () => {
  let document = sampleDocument();
  const hash = document.structure.sentences[0]!.hash;
  document = setTranslation(document, hash, '本文1の訳', { source: 'human' }).document;
  document = addNote(document, hash, 'ここが主張の核').document;

  const parsed = parseExportHtml(exportOf(document));
  assert.equal(parsed.annotations.notes.length, 1);
  assert.equal(parsed.annotations.translations[hash]!.revisedByHuman, true);
  assert.ok(parsed.document);
  assert.equal(parsed.document!.structure.sentences.length, 3);
  assert.notEqual(parsed.document!.id, document.id, '取り込み時は新しい ID を振る');
});

// --- メモの hash 検証 ---------------------------------------------------

test('存在しない hash へのメモは拒否する', () => {
  const document = sampleDocument();
  const result = addNote(document, 'deadbeefdeadbeef', 'どこにも出ないメモ');
  assert.equal(result.applied, false);
  assert.equal(result.note, null);
  assert.equal(document.annotations.notes.length, 0);
});

test('空のメモは拒否する', () => {
  const document = sampleDocument();
  assert.equal(addNote(document, document.structure.sentences[0]!.hash, '   ').applied, false);
});

// --- 検索 ---------------------------------------------------------------

test('検索結果に訳文と一致したメモが入る', () => {
  let document = sampleDocument();
  const hash = document.structure.sentences[0]!.hash;
  document = setTranslation(document, hash, 'ブロック疎カーネルを使う', { source: 'claude' }).document;
  document = addNote(document, hash, '要確認: 根拠').document;

  const byTranslation = searchDocument(document, 'カーネル');
  assert.equal(byTranslation.length, 1);
  assert.equal(byTranslation[0]!.translation, 'ブロック疎カーネルを使う');

  const byNote = searchDocument(document, '要確認');
  assert.deepEqual(byNote[0]!.notes, ['要確認: 根拠']);
});

// --- 移行 ---------------------------------------------------------------

test('旧バージョンの文書は訳を保ったままハッシュが張り替わる', () => {
  const document = sampleDocument();
  const hash = document.structure.sentences[0]!.hash;
  const translated = setTranslation(document, hash, '訳', { source: 'human' }).document;

  // v1 相当（旧ハッシュ）の文書を模す。
  const legacy: PaperDocument = {
    ...translated,
    structure: {
      ...translated.structure,
      version: 1,
      sentences: translated.structure.sentences.map((s) => ({ ...s, hash: `old${s.hash.slice(3)}` })),
    },
    annotations: {
      ...translated.annotations,
      translations: { [`old${hash.slice(3)}`]: translated.annotations.translations[hash]! },
      notes: [
        {
          id: 'n1',
          sentenceHash: `old${hash.slice(3)}`,
          body: 'メモ',
          author: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
  };

  const result = migrateDocument(legacy);
  assert.equal(result.migrated, true);
  assert.equal(result.document.structure.version, STRUCTURE_VERSION);
  assert.equal(result.document.annotations.translations[hash]!.text, '訳');
  assert.equal(result.document.annotations.notes[0]!.sentenceHash, hash);
  assert.equal(result.remappedTranslations, 1);
  assert.equal(result.remappedNotes, 1);

  // 移行済みの文書を再度通しても何も起きない。
  assert.equal(migrateDocument(result.document).migrated, false);
});
