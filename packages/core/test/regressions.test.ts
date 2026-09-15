import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSentence, sentenceHash, STRUCTURE_VERSION } from '../src/hash.ts';
import { parseXml, textContent, descendants, firstChild, decodeEntities } from '../src/xml.ts';
import { parseTei } from '../src/tei.ts';
import { splitIntoSentences, buildSentencesFromChunks, type TextChunk } from '../src/sentences.ts';
import { incomingWins, mergeAnnotations } from '../src/merge.ts';
import {
  createDocument,
  addNote,
  setTranslation,
  searchDocument,
  progress,
  skipSentences,
} from '../src/document.ts';
import { buildExportHtml } from '../src/export.ts';
import { extractPayloadJson, parseExportHtml, ImportError } from '../src/import.ts';
import {
  describeSanitizeReport,
  sanitizeAnnotations,
  sanitizeDocument,
  emptySanitizeReport,
  sanitizeStructure,
} from '../src/validate.ts';
import { migrateDocument } from '../src/migrate.ts';
import { emptyAnnotations, type Annotations, type PaperDocument, type Rect, type Translation } from '../src/types.ts';
import { createHash } from 'node:crypto';

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

test('文書内に 1 回しか出ない複合語は行末で割れてもハイフンが残り、音節で割れた 1 語は繋がる', () => {
  // 実測で壊れていた形。2 段組の論文で `long-range` が文書内に 1 回だけ出て行末で割れ、
  // `longrange` になっていた（同じ論文の `straight-through` は、たまたま行中に用例が
  // あったので無事だった＝論文ごとに当たり外れが変わる）。
  // 同じ文書に真のハイフネーションも混ぜてある。どちらか片側に倒すだけの規則では通らない。
  const chunks: TextChunk[] = [
    { page: 1, text: 'We study the dependency structure of very long-', x: 50, y: 100, w: 235, h: 10 },
    { page: 1, text: 'range interactions in the encoder of the model.', x: 50, y: 112, w: 230, h: 10 },
    { page: 1, text: 'The encoder keeps the amount of mutual informa-', x: 50, y: 124, w: 235, h: 10 },
    { page: 1, text: 'tion between the two views as high as it can be.', x: 50, y: 136, w: 232, h: 10 },
  ];
  const { sentences } = buildSentencesFromChunks(chunks, []);
  assert.deepEqual(sentences.map((s) => s.text), [
    'We study the dependency structure of very long-range interactions in the encoder of the model.',
    'The encoder keeps the amount of mutual information between the two views as high as it can be.',
  ]);
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

/** 点 (page, x, y) に当たる文の通し番号を全部返す。1 つだけなら、その点で迷いなく選べる。 */
function hitTest(sentences: readonly { order: number; rects: readonly Rect[] }[], page: number, x: number, y: number) {
  return sentences
    .filter((sentence) =>
      sentence.rects.some(
        (rect) => rect.page === page && x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h,
      ),
    )
    .map((sentence) => sentence.order);
}

test('1 行を 2 文が共有しても、それぞれの矩形が重ならない', () => {
  // pdf.js は 1 行まるごとを 1 個の文字片で返すことがある。行の途中で文が終わると、
  // 以前はその行が前後どちらの文にも行いっぱいの幅で入り、押した位置と関係なく
  // 隣の文が選ばれていた（後の文に完全に覆われて二度と選べない文まで出た）。
  const chunks: TextChunk[] = [
    { page: 1, text: 'We evaluate on the test. We then report results.', x: 50, y: 100, w: 240, h: 10 },
  ];
  const { sentences } = buildSentencesFromChunks(chunks, []);
  assert.equal(sentences.length, 2);

  const [first, second] = sentences as [(typeof sentences)[number], (typeof sentences)[number]];
  assert.equal(first.rects.length, 1);
  assert.equal(second.rects.length, 1);
  const left = first.rects[0]!;
  const right = second.rects[0]!;
  assert.ok(left.w > 0 && right.w > 0, '幅ゼロの矩形は押せない');
  assert.ok(
    left.x + left.w <= right.x,
    `同じ行の 2 文が重なっている: ${JSON.stringify(left)} / ${JSON.stringify(right)}`,
  );
  // 行の左端は前の文、右端は次の文。ここが入れ替わると PDF の連動が壊れる。
  assert.deepEqual(hitTest(sentences, 1, left.x + 1, 105), [0]);
  assert.deepEqual(hitTest(sentences, 1, right.x + right.w - 1, 105), [1]);
});

test('行の途中で終わった文は、次の文に覆われずクリックで選べる', () => {
  // 2 行目の途中で 1 文目が終わり、同じ行から 2 文目が始まる形。
  const chunks: TextChunk[] = [
    { page: 1, text: 'Sparse attention reduces the quadratic', x: 50, y: 100, w: 190, h: 10 },
    { page: 1, text: 'cost of self-attention. We evaluate the', x: 50, y: 112, w: 190, h: 10 },
    { page: 1, text: 'kernel on academic documents.', x: 50, y: 124, w: 150, h: 10 },
  ];
  const { sentences } = buildSentencesFromChunks(chunks, []);
  assert.equal(sentences.length, 2);

  for (const sentence of sentences) {
    // どの文にも「自分だけが当たる点」が要る。無ければ画面上で永久に選べない。
    const exclusive = sentence.rects.some((rect) =>
      [0.02, 0.5, 0.98].some((ratio) => {
        const hits = hitTest(sentences, rect.page, rect.x + rect.w * ratio, rect.y + rect.h / 2);
        return hits.length === 1 && hits[0] === sentence.order;
      }),
    );
    assert.ok(exclusive, `他の文に覆われて選べない: ${sentence.text}`);
  }

  // 共有した行（y=112）では、左が 1 文目・右が 2 文目。
  const shared = (order: number) => sentences[order]!.rects.find((rect) => Math.abs(rect.y - 112) < 1)!;
  assert.ok(shared(0).x + shared(0).w <= shared(1).x, '共有行で矩形が重なっている');
  assert.deepEqual(hitTest(sentences, 1, shared(0).x + 1, 117), [0]);
  assert.deepEqual(hitTest(sentences, 1, shared(1).x + shared(1).w - 1, 117), [1]);
});

test('文字片をまるごと使う文の矩形は、文字片の外接矩形から変わらない', () => {
  // 按分は「文字片の一部だけを使ったとき」の話。全部使う普通の文で枠が縮むと、
  // ハイライトが本文より狭くなって読みにくくなる。
  const chunks: TextChunk[] = [
    { page: 1, text: 'We release the code.', x: 50, y: 100, w: 120, h: 10 },
  ];
  const { sentences } = buildSentencesFromChunks(chunks, []);
  assert.deepEqual(sentences[0]!.rects, [{ page: 1, x: 50, y: 100, w: 120, h: 10 }]);
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
  assert.deepEqual(document.annotations, {
    translations: {},
    notes: [],
    glossary: [],
    skipped: {},
    sentenceEdits: [],
  });
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

// --- サイクル6：書き出し HTML の受け取り側 ------------------------------

test('大文字や引用符なしで書かれた script も見つける（取り込みとブラウザで別物を読ませない）', () => {
  // HTML は要素名も属性名も大小を区別せず、属性値の引用符も省ける。
  // XML の規則で読むと、こちらには見えずブラウザには見える script を仕込める。
  const payload = '{"format":"logixiv-export","formatVersion":1}';
  for (const tag of [
    '<SCRIPT type="application/json" id="logixiv-data">',
    '<script type=application/json id=logixiv-data>',
    '<script type="application/json" ID="logixiv-data">',
  ]) {
    assert.equal(extractPayloadJson(`<html><body>${tag}${payload}</script></body></html>`), payload, tag);
  }
});

test('綴りの違う 2 つ目のデータ script も重複として断る', () => {
  const html =
    '<html><body>' +
    '<SCRIPT type=application/json id=logixiv-data>{"a":1}</script>' +
    '<script type="application/json" id="logixiv-data">{"b":2}</script>' +
    '</body></html>';
  assert.throws(() => extractPayloadJson(html), /2 個見つかりました/);
});

test('ビューアのスクリプトに </script が入っても書き出しが壊れない', () => {
  const document = createDocument({
    structure: sanitizeStructure({ sentences: [{ text: 'Hello world.' }] }, emptySanitizeReport()),
    sourceFileName: 'a.pdf',
  });
  const html = buildExportHtml({
    document,
    pdfBase64: '',
    viewerScript: 'var X = "</script>"; var Y = 1;',
    viewerStyle: '/* </style> */ body { color: red; }',
  });
  // 閉じタグは、データ script とビューア script の 2 つ、style は 2 つだけ。
  assert.equal(html.split('</script').length - 1, 2);
  assert.equal(html.split('</style').length - 1, 2);
  assert.ok(html.includes('<\\/script>'), 'スクリプト内の </script が無害化されていない');
});

test('形が壊れた注釈は、落とした件数まで報告する', () => {
  const report = emptySanitizeReport();
  sanitizeAnnotations(
    {
      translations: {},
      notes: [],
      glossary: [],
      skipped: { 'not-a-hash': { reason: 'x' }, abcdef12: 'nope' },
      sentenceEdits: [{ type: 'merge', hashes: ['abcdef12'] }, { type: 'nope' }, 'x'],
    },
    report,
  );
  assert.equal(report.droppedSkipped, 2);
  assert.equal(report.droppedEdits, 3);
  assert.match(describeSanitizeReport(report) ?? '', /訳さない/);
  assert.match(describeSanitizeReport(report) ?? '', /区切りの直し/);
});


// --- サイクル7：取り込み経路が構造バージョンの差を橋渡しする -------------

/**
 * v1 の正規化規則（NFKC・空白を潰すだけ）。
 *
 * 本物の v1 の書き出しを再現するために要る。今の規則との違いは NFKC が
 * 上付き文字・℃ を潰すことと、letter 間のハイフンを落とさないこと。
 */
function v1Hash(text: string): string {
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

const V1_TEXTS = [
  'We study block-sparse attention for long documents.',
  'The temperature is 25 ℃ and x² = 2 in every run.',
];

/** v1 の書き出し HTML を、本物と同じ経路（buildExportHtml）で作る。 */
function legacyExportHtml(): string {
  const legacy = {
    id: 'doc_legacy',
    title: 'Legacy paper',
    sourceFileName: 'legacy.pdf',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    structure: {
      version: 1,
      parser: 'grobid' as const,
      parserNote: 'GROBID',
      parsedAt: '2026-01-01T00:00:00.000Z',
      title: 'Legacy paper',
      abstract: null,
      pageSizes: [],
      sections: [],
      sentences: V1_TEXTS.map((text, index) => ({
        id: `s_${v1Hash(text)}`,
        hash: v1Hash(text),
        order: index,
        page: 1,
        text,
        rects: [],
        sectionId: null,
      })),
    },
    annotations: {
      translations: Object.fromEntries(
        V1_TEXTS.map((text, index) => [
          v1Hash(text),
          {
            sentenceHash: v1Hash(text),
            text: `訳${index}`,
            revisedByHuman: true,
            source: 'human' as const,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
      ),
      notes: V1_TEXTS.map((text, index) => ({
        id: `note_legacy${index}`,
        sentenceHash: v1Hash(text),
        body: `メモ${index}`,
        author: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })),
      glossary: [],
      skipped: {
        [v1Hash(V1_TEXTS[1]!)]: {
          sentenceHash: v1Hash(V1_TEXTS[1]!),
          reason: 'formula',
          at: '2026-01-01T00:00:00.000Z',
        },
      },
      sentenceEdits: [],
    },
  } as unknown as PaperDocument;
  return buildExportHtml({ document: legacy, pdfBase64: 'JVBERi0xLjQK', viewerScript: '', viewerStyle: '' });
}

test('v1 の書き出しを取り込み経路に通すと、訳とメモが新しいハッシュに付け替わる', () => {
  // 前提: v1 と v2 でハッシュが実際に変わる文を使っている。
  for (const text of V1_TEXTS) {
    assert.notEqual(v1Hash(text), sentenceHash(text), `前提: ${text} は新旧で別のハッシュにならないと意味がない`);
  }

  // 人工データを作らず、本物の取り込み経路（parseExportHtml → sanitizeDocument）を通す。
  // 「構造側に旧ハッシュを残した文書」を手で作って migrate に渡すと、
  // 取り込み経路が壊している前提をそのまま素通ししてしまう。
  const parsed = parseExportHtml(legacyExportHtml());
  assert.equal(parsed.declaredStructureVersion, 1, '名乗っていた版が失われている');
  const document = parsed.document!;

  // 構造は今の規則。だから注釈のキーも今の規則でなければ噛み合わない。
  assert.equal(document.structure.version, STRUCTURE_VERSION);
  const hashes = new Set(document.structure.sentences.map((s) => s.hash));
  assert.deepEqual([...hashes], V1_TEXTS.map((t) => sentenceHash(t)));

  for (const [index, text] of V1_TEXTS.entries()) {
    const hash = sentenceHash(text);
    assert.equal(document.annotations.translations[hash]?.text, `訳${index}`, `訳${index} が付け替わっていない`);
    assert.equal(document.annotations.translations[hash]?.revisedByHuman, true, '人手修正済みの印が落ちている');
  }
  assert.deepEqual(
    document.annotations.notes.map((note) => note.sentenceHash).sort(),
    V1_TEXTS.map((t) => sentenceHash(t)).sort(),
    'メモが旧ハッシュのまま残っている',
  );
  assert.deepEqual(Object.keys(document.annotations.skipped ?? {}), [sentenceHash(V1_TEXTS[1]!)]);
  assert.equal(
    Object.keys(document.annotations.translations).filter((h) => !hashes.has(h)).length,
    0,
    '構造に当たらない訳が残っている',
  );
  assert.ok(parsed.sanitizeReport.rekeyedAnnotations >= 4, '張り替えた件数が報告されていない');

  // 取り込んだ時点で今の規則に揃っているので、読み出し時の migrate はもう何もしない。
  // （以前はここで version だけ 2 に押し上がり、訳は浮いたまま二度と直らなかった）
  const migration = migrateDocument(document);
  assert.equal(migration.migrated, false);
  assert.equal(migration.document.structure.version, STRUCTURE_VERSION);

  // 既存文書へのマージ経路でも同じ。全件 orphaned として黙って捨てられてはいけない。
  const target = createDocument({
    structure: sanitizeStructure({ sentences: V1_TEXTS.map((text) => ({ text })) }, emptySanitizeReport()),
    sourceFileName: 'mine.pdf',
  });
  const merged = mergeAnnotations(
    target.annotations,
    parsed.annotations,
    new Set(target.structure.sentences.map((s) => s.hash)),
  );
  assert.equal(merged.report.orphaned, 0, 'マージ経路で v1 の注釈が捨てられている');
  assert.equal(merged.report.translationsAdded, V1_TEXTS.length);
  assert.equal(merged.report.notesAdded, V1_TEXTS.length);
});

test('取り込んだ「訳さない」は、自分の残件を減らした数を必ず報告する', () => {
  const structure = sanitizeStructure(
    { sentences: [{ text: 'First sentence here.' }, { text: 'Second sentence here.' }, { text: 'Third one here.' }] },
    emptySanitizeReport(),
  );
  const [a, b, c] = structure.sentences;
  let mine = createDocument({ structure, sourceFileName: 'mine.pdf' });
  mine = setTranslation(mine, a!.hash, '自分の訳').document;
  assert.equal(progress(mine).remaining, 2);

  // 同僚が 3 文とも「訳さない」にしてから書き出した、という状況。
  const incoming: Annotations = {
    ...emptyAnnotations(),
    skipped: Object.fromEntries(
      [a, b, c].map((sentence) => [
        sentence!.hash,
        { sentenceHash: sentence!.hash, reason: 'reference', at: '2026-01-01T00:00:00.000Z' },
      ]),
    ),
  };
  // こちらの文書に無い文の「訳さない」は受け取らない。
  incoming.skipped!['ffffffffffffffff'] = {
    sentenceHash: 'ffffffffffffffff',
    reason: 'other',
    at: '2026-01-01T00:00:00.000Z',
  };

  const merged = mergeAnnotations(
    mine.annotations,
    incoming,
    new Set(structure.sentences.map((s) => s.hash)),
  );
  const after = { ...mine, annotations: merged.annotations };

  // 既に訳してある a は「訳さない」に移らない（移しても残件は減らず、報告だけが嘘になる）。
  assert.equal(merged.annotations.skipped?.[a!.hash], undefined, '既訳の文が他人の判断で対象外にされた');
  // 減った残件の数がそのまま報告に出る。b と c の 2 件。
  assert.equal(merged.report.skippedAdded, 2);
  assert.equal(progress(after).remaining, 0);
  assert.equal(progress(mine).remaining - progress(after).remaining, merged.report.skippedAdded);
  // 当てられなかったもの（該当文なし＋既訳）も黙って消えない。
  assert.equal(merged.report.skippedIgnored, 2);
  assert.ok(merged.report.orphaned >= 1);
  assert.equal(merged.annotations.skipped?.['ffffffffffffffff'], undefined, '存在しない文の判断まで取り込んでいる');

  // 自分で付けた「訳さない」の理由と日付は、取り込みで上書きされない。
  const own = skipSentences(mine, [b!.hash], 'mine').document;
  const again = mergeAnnotations(own.annotations, incoming, new Set(structure.sentences.map((s) => s.hash)));
  assert.equal(again.annotations.skipped?.[b!.hash]?.reason, 'mine');
  assert.equal(again.report.skippedAdded, 1, 'c の 1 件だけが新しく移るはず');
});
