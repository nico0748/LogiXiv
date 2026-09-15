import type {
  Annotations,
  DocumentStructure,
  GlossaryEntry,
  NonBodySentence,
  Note,
  PageSize,
  PaperDocument,
  Rect,
  Section,
  Sentence,
  SentenceEdit,
  StructureQuality,
  SkippedSentence,
  Translation,
} from './types.ts';
import { STRUCTURE_VERSION, newId, sentenceHash, sentenceId } from './hash.ts';
import { sanitizeJoiner } from './edits.ts';
import { incomingWins } from './merge.ts';

/**
 * 外から来た JSON を、型どおりだと保証できる値に落とす。
 *
 * 書き出し HTML は人づてに回るファイルで、中身は誰でも書き換えられる。
 * 型アサーションで通してしまうと `text: null` や `notes: "…"` がそのまま
 * ストアに書かれ、以降 progress / search / export が実行時に落ちる
 * （しかもディスクに残るので再起動しても直らない）。
 *
 * 方針は「捨てて続ける」。不正な要素は落とし、何件落としたかを呼び出し元へ返す。
 * 例外は投げない — 1 つの壊れた文で論文 1 本を読めなくする方が損が大きい。
 */

export interface SanitizeReport {
  droppedSentences: number;
  droppedTranslations: number;
  droppedNotes: number;
  droppedGlossary: number;
  /** 「訳さない」の記録のうち、形が壊れていて落としたもの。 */
  droppedSkipped: number;
  /** 文の区切りの直しのうち、形が壊れていて落としたもの。 */
  droppedEdits: number;
  /** 節・用紙サイズ・座標のうち落としたもの。 */
  droppedStructure: number;
  /** 直した点（ハッシュ再計算など）。 */
  repaired: number;
  /**
   * payload が名乗っていた構造バージョン（書かれていなければ null）。
   *
   * sanitize を通った構造は必ず今の規則で作り直されるので `structure.version` は
   * 現行値になる。「新しい版で書かれたものは断る」の判断材料はここにしか残らない。
   */
  declaredStructureVersion: number | null;
  /** 旧規則のキーを今の規則に張り替えた注釈の数（訳・メモ・「訳さない」の合計）。 */
  rekeyedAnnotations: number;
  /** 張り替えた結果ぶつかって片方を捨てた訳の数。 */
  rekeyCollisions: number;
}

export function emptySanitizeReport(): SanitizeReport {
  return {
    droppedSentences: 0,
    droppedTranslations: 0,
    droppedNotes: 0,
    droppedGlossary: 0,
    droppedSkipped: 0,
    droppedEdits: 0,
    droppedStructure: 0,
    repaired: 0,
    declaredStructureVersion: null,
    rekeyedAnnotations: 0,
    rekeyCollisions: 0,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, maxLength = 100_000): string | null {
  if (typeof value !== 'string') return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isoDate(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value : '';
  return Number.isFinite(Date.parse(text)) ? text : fallback;
}

const EPOCH = new Date(0).toISOString();

function sanitizeRect(value: unknown): Rect | null {
  if (!isRecord(value)) return null;
  const page = finiteNumber(value['page']);
  const x = finiteNumber(value['x']);
  const y = finiteNumber(value['y']);
  const w = finiteNumber(value['w']);
  const h = finiteNumber(value['h']);
  if (page === null || x === null || y === null || w === null || h === null) return null;
  if (page < 1 || page > 100_000) return null;
  return { page: Math.floor(page), x, y, w, h };
}

function sanitizeSection(value: unknown, order: number): Section | null {
  if (!isRecord(value)) return null;
  const id = str(value['id'], 200);
  const title = str(value['title'], 2000);
  if (!id || title === null) return null;
  const level = finiteNumber(value['level']);
  return { id, title, level: level === null ? 1 : Math.max(1, Math.min(9, Math.floor(level))), order };
}

function sanitizePageSize(value: unknown): PageSize | null {
  if (!isRecord(value)) return null;
  const page = finiteNumber(value['page']);
  const width = finiteNumber(value['width']);
  const height = finiteNumber(value['height']);
  if (page === null || width === null || height === null) return null;
  return { page: Math.floor(page), width, height };
}

/**
 * 旧規則の鍵 → 今の規則の鍵。
 *
 * `sanitizeSentences` が構造側のハッシュを作り直すので、payload が名乗っていた
 * ハッシュ（＝注釈のキー）と対応が付かなくなる。その橋渡しをここで作る。
 */
export type HashRemap = Map<string, string>;

/**
 * 文のハッシュは受け取った値を信用せず、原文から**必ず計算し直す**。
 * 注釈の結合キーなので、ここを外部入力に委ねると「別の文の訳が付く」を作り込める。
 *
 * ただし計算し直した瞬間、payload に入っていた訳・メモのキー（旧規則で作られた値）は
 * どの文にも当たらなくなる。**張り替えの材料になるのは、この時点の「名乗っていた
 * ハッシュ → 作り直したハッシュ」だけ**なので、remap に控えておく。
 * ここを控えないと、取り込んだ文書は「構造は新規則・注釈は旧規則」という、
 * migrate では絶対に直せない組み合わせで保存される（対応表が恒等写像にしかならない）。
 */
function sanitizeSentences(value: unknown, report: SanitizeReport, remap?: HashRemap): Sentence[] {
  if (!Array.isArray(value)) return [];
  const sentences: Sentence[] = [];
  const occurrences = new Map<string, number>();
  for (const raw of value) {
    if (!isRecord(raw)) {
      report.droppedSentences++;
      continue;
    }
    const text = str(raw['text'], 20_000);
    if (text === null || text.trim().length === 0) {
      report.droppedSentences++;
      continue;
    }
    const rawRects = Array.isArray(raw['rects']) ? raw['rects'] : [];
    const rects = rawRects.map(sanitizeRect).filter((r): r is Rect => r !== null);
    report.droppedStructure += rawRects.length - rects.length;
    const hash = sentenceHash(text);
    const declared = raw['hash'];
    if (declared !== hash) {
      report.repaired++;
      // 名乗っていた値が「ハッシュとして有り得る形」のときだけ橋を架ける。
      // 形が壊れた値まで拾うと、注釈のキーを任意の文へ寄せる経路になる。
      // 先勝ちにするのは、同じ旧ハッシュが 2 つの文に名乗られたときに
      // 「先に出てくる文（＝原文の並び順で先）」へ寄せる方が読み手の直感に合うため。
      if (remap && typeof declared === 'string' && /^[0-9a-f]{4,64}$/.test(declared) && !remap.has(declared)) {
        remap.set(declared, hash);
      }
    }
    const occurrence = occurrences.get(hash) ?? 0;
    occurrences.set(hash, occurrence + 1);
    const page = finiteNumber(raw['page']);
    sentences.push({
      id: sentenceId(hash, occurrence),
      hash,
      order: sentences.length,
      page: rects[0]?.page ?? (page !== null && page >= 1 ? Math.floor(page) : 1),
      text,
      rects,
      sectionId: str(raw['sectionId'], 200),
    });
  }
  return sentences;
}

/**
 * 構造を安全な形に落とす。`remap` を渡すと、旧規則の注釈キーを張り替えるための
 * 対応表がそこに書き込まれる（`sanitizeDocument` / `sanitizeAnnotations` と組で使う）。
 */
export function sanitizeStructure(value: unknown, report: SanitizeReport, remap?: HashRemap): DocumentStructure {
  const source = isRecord(value) ? value : {};
  const parser = source['parser'] === 'grobid' ? 'grobid' : 'fallback';
  const sentences = sanitizeSentences(source['sentences'], report, remap);
  const rawSections = Array.isArray(source['sections']) ? source['sections'] : [];
  const sections = rawSections.map(sanitizeSection).filter((s): s is Section => s !== null);
  report.droppedStructure += rawSections.length - sections.length;
  const knownSections = new Set(sections.map((s) => s.id));
  for (const sentence of sentences) {
    if (sentence.sectionId !== null && !knownSections.has(sentence.sectionId)) sentence.sectionId = null;
  }

  // 名乗っていた版は報告にだけ残し、構造そのものは必ず現行版にする。
  //
  // ここで payload の値（例: 1）をそのまま持たせていたのが、v1 の書き出しから
  // 訳が消える原因だった。構造側のハッシュは上で新規則に作り直されているのに
  // 版だけ 1 のままなので、読み出し時の migrate は「今の構造の hash → 再計算した
  // hash」＝恒等写像しか作れず、1 件も付け替えないまま版を 2 に押し上げて終わる。
  // 以後 migrate は二度と走らないので、旧規則のキーを持つ訳は永久に浮いたままになる。
  //
  // 正しい状態は「構造も注釈も今の規則」。注釈キーの張り替えは呼び出し側が
  // remap を使って行い、版はここで現行値に揃える。
  // 新しい版で書かれたものを断る判断は declaredStructureVersion で行う。
  const version = finiteNumber(source['version']);
  report.declaredStructureVersion = version === null ? null : Math.floor(version);
  return {
    version: STRUCTURE_VERSION,
    parser,
    parserNote: str(source['parserNote'], 2000) ?? '（取り込んだ文書。解析方式の記録なし）',
    parsedAt: isoDate(source['parsedAt'], EPOCH),
    title: str(source['title'], 2000),
    abstract: str(source['abstract'], 50_000),
    pageSizes: sanitizePageSizes(source['pageSizes'], report),
    sections,
    sentences,
    nonBody: sanitizeNonBody(source['nonBody'], report, knownSections),
    // 解析の確からしさは、取り込んだ側にも要る。
    // 「この書き出しの原文は読み順が崩れているかもしれない」は、
    // 受け取った人が訳を信用してよいかの判断材料そのもの。
    // こちらで測り直した値ではないので、そのまま持ち越す。
    quality: sanitizeQuality(source['quality']),
  };
}

function sanitizeQuality(value: unknown): StructureQuality | undefined {
  if (!isRecord(value)) return undefined;
  const reason = str(value['reason'], 500);
  if (reason === null) return undefined;
  const coverage = finiteNumber(value['coverage']);
  const coverageReason = str(value['coverageReason'], 500);
  return {
    readingOrderRisk: value['readingOrderRisk'] === 'high' ? 'high' : 'low',
    reason,
    ...(coverage === null ? {} : { coverage: Math.min(1, Math.max(0, coverage)) }),
    ...(value['coverageRisk'] === 'high' || value['coverageRisk'] === 'low'
      ? { coverageRisk: value['coverageRisk'] }
      : {}),
    ...(coverageReason === null ? {} : { coverageReason }),
  };
}

/**
 * 本文として扱わなかった行（参考文献・表・柱など）。
 *
 * 訳の対象ではないので hash は結合キーとして使われないが、
 * ここを組み直さないと書き出し → 取り込みの往復で落ち、
 * 「PDF には見えているのに右に無い」が取り込んだ側でだけ復活する。
 */
function sanitizeNonBody(
  value: unknown,
  report: SanitizeReport,
  knownSections: ReadonlySet<string>,
): NonBodySentence[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kinds: ReadonlySet<string> = new Set([
    'frontMatter',
    'runningHead',
    'pageNumber',
    'caption',
    'reference',
    'footnote',
    'formula',
    'table',
    'other',
  ]);
  const out: NonBodySentence[] = [];
  const occurrences = new Map<string, number>();
  for (const raw of value) {
    if (!isRecord(raw)) {
      report.droppedStructure++;
      continue;
    }
    const text = str(raw['text'], 20_000);
    if (text === null || text.trim().length === 0) {
      report.droppedStructure++;
      continue;
    }
    const rawRects = Array.isArray(raw['rects']) ? raw['rects'] : [];
    const rects = rawRects.map(sanitizeRect).filter((r): r is Rect => r !== null);
    const hash = sentenceHash(text);
    const occurrence = occurrences.get(hash) ?? 0;
    occurrences.set(hash, occurrence + 1);
    const sectionId = str(raw['sectionId'], 200);
    const afterHash = str(raw['afterHash'], 64);
    const afterOrder = finiteNumber(raw['afterOrder']);
    out.push({
      id: occurrence === 0 ? `nb_${hash}` : `nb_${hash}_${occurrence}`,
      hash,
      order: out.length,
      page: Math.max(1, Math.floor(finiteNumber(raw['page']) ?? 1)),
      text,
      rects,
      sectionId: sectionId !== null && knownSections.has(sectionId) ? sectionId : null,
      kind: (typeof raw['kind'] === 'string' && kinds.has(raw['kind']) ? raw['kind'] : 'other') as NonBodySentence['kind'],
      afterOrder: afterOrder === null ? -1 : Math.floor(afterOrder),
      afterHash: afterHash !== null && /^[0-9a-f]{4,64}$/.test(afterHash) ? afterHash : null,
    });
  }
  return out;
}

function sanitizePageSizes(value: unknown, report: SanitizeReport): PageSize[] {
  const raw = Array.isArray(value) ? value : [];
  const sizes = raw.map(sanitizePageSize).filter((p): p is PageSize => p !== null);
  report.droppedStructure += raw.length - sizes.length;
  return sizes;
}

/**
 * 注釈のキーを、構造と同じ規則に揃える。
 *
 * `remap` は「payload が名乗っていたハッシュ → 原文から作り直したハッシュ」。
 * 既に今の規則のキー（＝作り直した側に実在する）はそのまま通す。
 * 混在した payload（一部だけ規則が変わっていない文書）でも安全に通るように、
 * 「当たっているものは触らない、当たっていないものだけ橋を渡す」の順で見る。
 */
function rekey(hash: string, context: RekeyContext): string {
  if (context.current.has(hash)) return hash;
  const mapped = context.remap.get(hash);
  if (mapped === undefined || mapped === hash) return hash;
  context.report.rekeyedAnnotations++;
  return mapped;
}

interface RekeyContext {
  remap: HashRemap;
  /** 作り直した側に実在するハッシュ。ここに在るキーは触らない。 */
  current: ReadonlySet<string>;
  report: SanitizeReport;
}

const NO_REKEY: RekeyContext = {
  remap: new Map(),
  current: new Set(),
  report: emptySanitizeReport(),
};

export function sanitizeAnnotations(
  value: unknown,
  report: SanitizeReport,
  context?: { remap: HashRemap; current: ReadonlySet<string> },
): Annotations {
  const source = isRecord(value) ? value : {};
  const rk: RekeyContext = context ? { ...context, report } : NO_REKEY;

  const translations: Record<string, Translation> = {};
  if (isRecord(source['translations'])) {
    for (const [rawHash, raw] of Object.entries(source['translations'])) {
      if (!/^[0-9a-f]{4,64}$/.test(rawHash) || !isRecord(raw)) {
        report.droppedTranslations++;
        continue;
      }
      const text = str(raw['text'], 20_000);
      if (text === null) {
        report.droppedTranslations++;
        continue;
      }
      const origin = raw['source'];
      const hash = rekey(rawHash, rk);
      const entry: Translation = {
        sentenceHash: hash,
        text,
        revisedByHuman: raw['revisedByHuman'] === true,
        source: origin === 'human' || origin === 'claude' ? origin : 'import',
        updatedAt: isoDate(raw['updatedAt'], EPOCH),
      };
      // 張り替えで 2 つの旧ハッシュが 1 つに合流することがある（v1 は上付き文字を
      // 潰していたので、別の文が同じ鍵を共有しうる）。人手修正済みを優先し、
      // 同条件なら新しい方を残す — migrate の衝突解決と同じ規則にしておく。
      const existing = translations[hash];
      if (existing) {
        report.rekeyCollisions++;
        if (!incomingWins(existing, entry)) continue;
      }
      translations[hash] = entry;
    }
  }

  const notes: Note[] = [];
  if (Array.isArray(source['notes'])) {
    for (const raw of source['notes']) {
      if (!isRecord(raw)) {
        report.droppedNotes++;
        continue;
      }
      const body = str(raw['body'], 50_000);
      const sentenceHashValue = str(raw['sentenceHash'], 64);
      if (body === null || sentenceHashValue === null || !/^[0-9a-f]{4,64}$/.test(sentenceHashValue)) {
        report.droppedNotes++;
        continue;
      }
      const createdAt = isoDate(raw['createdAt'], EPOCH);
      const id = str(raw['id'], 64);
      notes.push({
        id: id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : newId('note'),
        sentenceHash: rekey(sentenceHashValue, rk),
        body,
        author: str(raw['author'], 200),
        createdAt,
        updatedAt: isoDate(raw['updatedAt'], createdAt),
      });
    }
  }

  const glossary: GlossaryEntry[] = [];
  if (Array.isArray(source['glossary'])) {
    for (const raw of source['glossary']) {
      if (!isRecord(raw)) {
        report.droppedGlossary++;
        continue;
      }
      const term = str(raw['term'], 500);
      const translation = str(raw['translation'], 500);
      if (term === null || translation === null || term.trim().length === 0) {
        report.droppedGlossary++;
        continue;
      }
      glossary.push({ term, translation, note: str(raw['note'], 2000) });
    }
  }

  const skipped: Record<string, SkippedSentence> = {};
  if (isRecord(source['skipped'])) {
    for (const [rawHash, raw] of Object.entries(source['skipped'])) {
      if (!/^[0-9a-f]{4,64}$/.test(rawHash) || !isRecord(raw)) {
        report.droppedSkipped++;
        continue;
      }
      const hash = rekey(rawHash, rk);
      skipped[hash] = {
        sentenceHash: hash,
        reason: str(raw['reason'], 200) ?? 'other',
        at: isoDate(raw['at'], EPOCH),
      };
    }
  }

  // 区切りの直しは「手順」なので、当てられるかどうかは適用時に分かればよい。
  // ここでは形だけ見て、hash として有り得ない値や桁の壊れた位置を落とす。
  const sentenceEdits: SentenceEdit[] = [];
  if (Array.isArray(source['sentenceEdits'])) {
    for (const raw of source['sentenceEdits']) {
      if (!isRecord(raw)) {
        report.droppedEdits++;
        continue;
      }
      const type = raw['type'];
      if (type !== 'merge' && type !== 'split') {
        report.droppedEdits++;
        continue;
      }
      const hashes = sanitizeHashList(raw['hashes']).map((hash) => rekey(hash, rk));
      if (type === 'merge' ? hashes.length < 2 : hashes.length !== 1) {
        report.droppedEdits++;
        continue;
      }
      const id = str(raw['id'], 64);
      const edit: SentenceEdit = {
        id: id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : newId('edit'),
        type,
        hashes,
        createdAt: isoDate(raw['createdAt'], EPOCH),
      };
      if (type === 'split') edit.offsets = sanitizeOffsets(raw['offsets']);
      const sourceTexts = Array.isArray(raw['sourceTexts'])
        ? raw['sourceTexts']
            .map((item) => str(item, 20_000))
            .filter((item): item is string => item !== null)
            .slice(0, 64)
        : [];
      if (sourceTexts.length > 0) edit.sourceTexts = sourceTexts;
      if (type === 'merge' && Array.isArray(raw['joiners'])) {
        edit.joiners = raw['joiners'].slice(0, 64).map((item) => sanitizeJoiner(typeof item === 'string' ? item : ' '));
      }
      const undo = raw['undo'];
      if (isRecord(undo)) {
        const undoHashes = sanitizeHashList(undo['hashes']).map((hash) => rekey(hash, rk));
        if (undoHashes.length > 0) {
          const occurrences = finiteNumber(undo['occurrences']);
          edit.undo = {
            hashes: undoHashes,
            offsets: sanitizeOffsets(undo['offsets']),
            // 繋ぎ文字は空白類だけ通す。外から来た任意の文字列で本文を作らせない。
            joiners: Array.isArray(undo['joiners'])
              ? undo['joiners'].slice(0, 64).map((item) => sanitizeJoiner(typeof item === 'string' ? item : ' '))
              : [],
            ...(occurrences !== null && occurrences > 0 ? { occurrences: Math.floor(occurrences) } : {}),
            ...(Array.isArray(undo['at'])
              ? {
                  at: undo['at']
                    .map(finiteNumber)
                    .filter((n): n is number => n !== null && n >= 0)
                    .map((n) => Math.floor(n))
                    .slice(0, 1000),
                }
              : {}),
          };
        }
      }
      sentenceEdits.push(edit);
    }
  }

  return { translations, notes, glossary, skipped, sentenceEdits };
}

function sanitizeHashList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && /^[0-9a-f]{4,64}$/.test(item))
    .slice(0, 64);
}

function sanitizeOffsets(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(finiteNumber)
    .filter((n): n is number => n !== null && n > 0 && n < 20_000)
    .map((n) => Math.floor(n))
    .slice(0, 64)
    .sort((a, b) => a - b);
}

/**
 * 外から来た document を丸ごと安全な PaperDocument に落とす。id は呼び出し側が付け直す前提。
 *
 * **構造と注釈は必ず同じ規則に揃えて返す。** 構造だけ新規則で作り直して注釈を
 * 旧規則のまま残すと、以後どの経路でも直せない（migrate は構造の原文から対応表を
 * 作るので、構造が既に新規則なら恒等写像にしかならない）。
 * そこで、構造を作り直すときに得た「名乗っていた鍵 → 作り直した鍵」で注釈も張り替える。
 */
export function sanitizeDocument(
  value: unknown,
  overrides: { id: string; sourceFileName?: string },
): { document: PaperDocument; report: SanitizeReport } {
  const report = emptySanitizeReport();
  const source = isRecord(value) ? value : {};
  const remap: HashRemap = new Map();
  const structure = sanitizeStructure(source['structure'], report, remap);
  const current = new Set(structure.sentences.map((sentence) => sentence.hash));
  const annotations = sanitizeAnnotations(source['annotations'], report, { remap, current });
  const now = new Date().toISOString();

  return {
    document: {
      id: overrides.id,
      title: str(source['title'], 2000) ?? structure.title ?? '(無題)',
      sourceFileName: overrides.sourceFileName ?? str(source['sourceFileName'], 500) ?? 'imported.pdf',
      createdAt: isoDate(source['createdAt'], now),
      updatedAt: now,
      structure,
      annotations,
    },
    report,
  };
}

export function describeSanitizeReport(report: SanitizeReport): string | null {
  const parts: string[] = [];
  if (report.droppedSentences > 0) parts.push(`文 ${report.droppedSentences} 件`);
  if (report.droppedTranslations > 0) parts.push(`訳 ${report.droppedTranslations} 件`);
  if (report.droppedNotes > 0) parts.push(`メモ ${report.droppedNotes} 件`);
  if (report.droppedGlossary > 0) parts.push(`用語 ${report.droppedGlossary} 件`);
  if (report.droppedSkipped > 0) parts.push(`「訳さない」の記録 ${report.droppedSkipped} 件`);
  if (report.droppedEdits > 0) parts.push(`文の区切りの直し ${report.droppedEdits} 件`);
  if (report.droppedStructure > 0) parts.push(`節・座標 ${report.droppedStructure} 件`);
  if (parts.length === 0) return null;
  return `形式が不正だったため ${parts.join(' / ')} を取り込みませんでした`;
}
