import { Worker } from 'node:worker_threads';
import {
  buildSentencesFromChunks,
  guessTitleFromChunks,
  sanitizeTitle,
  STRUCTURE_VERSION,
  type DocumentStructure,
  type TextChunk,
} from '@logixiv/core';
import type { FallbackWorkerInput, FallbackWorkerOutput } from './fallback-worker.ts';
import { describePdfFailure, type RawPdfFailure } from './pdf-failure.ts';

/**
 * GROBID が無い環境向けのフォールバック解析。
 *
 * pdf.js でテキストを取り出し、core の行組み立て＋文分割にかける。
 * 2 段組では読み順が崩れ、数式や脚注が本文に混ざる。精度は GROBID に明確に劣るので、
 * ここを通ったことは structure.parserNote に必ず書いて UI に出す。
 *
 * pdf.js 本体はワーカースレッドで回す（理由は fallback-worker.ts の先頭に書いた）。
 * そのうえで「ページ数・文字片数・実時間」の 3 つに上限を置く。上限が無いと、
 * アップロード上限の 100MB に対して解析が時間オーダーで伸び、サーバーが実質停止する。
 */

export class FallbackParseError extends Error {}

export interface FallbackLimits {
  maxPages: number;
  maxChunks: number;
  timeoutMs: number;
}

export const DEFAULT_FALLBACK_LIMITS: FallbackLimits = {
  maxPages: 400,
  maxChunks: 400_000,
  timeoutMs: 120_000,
};

/** src から動かしているか dist から動かしているかで、ワーカーの拡張子が変わる。 */
function workerUrl(): URL {
  const here = import.meta.url;
  return new URL(here.endsWith('.ts') ? './fallback-worker.ts' : './fallback-worker.js', here);
}

function runWorker(
  input: FallbackWorkerInput,
  timeoutMs: number,
  /** pdf.js 由来の失敗を日本語に翻訳するための情報（何のファイルか・中身は何か）。 */
  context: { fileName: string | null; pdf: Uint8Array },
): Promise<FallbackWorkerOutput> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl(), { workerData: input });
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new FallbackParseError(
            `PDF の解析が ${Math.round(timeoutMs / 1000)} 秒を超えたため中断しました。ページ数が多い PDF は GROBID を使ってください。`,
          ),
        ),
      );
    }, timeoutMs);
    timer.unref();

    worker.on(
      'message',
      (message: { ok: true; result: FallbackWorkerOutput } | { ok: false; error: RawPdfFailure }) => {
        if (message.ok) finish(() => resolve(message.result));
        // pdf.js の英語をそのまま投げない。ここで「暗号化・途中で切れた・壊れている」
        // に振り分けて、人がやるべきことまで書いた日本語にする。
        else finish(() => reject(describePdfFailure(message.error, context)));
      },
    );
    worker.on('error', (error) => finish(() => reject(error)));
    worker.on('exit', (code) => {
      if (!settled) finish(() => reject(new FallbackParseError(`解析ワーカーが異常終了しました (code ${code})`)));
    });
  });
}

/**
 * 題名を決める。メタデータ → 1 ページ目の最大文字 → 諦める（null）。
 *
 * メタデータの Title は当たれば一番正確だが、`untitled.dvi`・`Microsoft Word - …`・
 * ファイル名そのものが入っていることが多いので、そういうものは捨てる。
 * 捨てたときは版面から推測する。どちらも駄目なら null を返し、
 * 従来どおり本文 1 文目とファイル名へ落ちる。
 */
function pickTitle(metadataTitle: string | null, chunks: TextChunk[]): string | null {
  const meta = metadataTitle === null ? '' : sanitizeTitle(metadataTitle);
  const looksLikeFileName = /\.(pdf|dvi|tex|docx?|ps)$/i.test(meta) || /^Microsoft Word\b/i.test(meta);
  if (meta.length >= 8 && meta.length <= 300 && !looksLikeFileName) return meta;

  const guessed = guessTitleFromChunks(chunks);
  return guessed === null ? null : sanitizeTitle(guessed);
}

export interface FallbackParseOptions {
  /** 取り込もうとしているファイルの名前。失敗を「どのファイルの話か」と一緒に伝えるために要る。 */
  fileName?: string | null;
  limits?: FallbackLimits;
}

export async function parseWithPdfJs(
  pdf: Uint8Array,
  options: FallbackParseOptions = {},
): Promise<DocumentStructure> {
  const limits = options.limits ?? DEFAULT_FALLBACK_LIMITS;
  const output = await runWorker(
    { pdf, maxPages: limits.maxPages, maxChunks: limits.maxChunks },
    limits.timeoutMs,
    { fileName: options.fileName ?? null, pdf },
  );

  // nonBody は「PDF には見えているのに右に出てこない行」（参考文献・表・柱・著者行など）。
  // 落とすこと自体は正しいが、落としたことが見えないと
  // 「まだ訳が来ていないのか、自分が見落としたのか」が区別できない。
  const { sentences, sections, nonBody } = buildSentencesFromChunks(output.chunks, output.pageSizes);

  const warnings: string[] = [];
  if (sections.length > 0) warnings.push(`節 ${sections.length} 件を検出`);
  if (output.truncatedPages > 0) warnings.push(`先頭 ${limits.maxPages} ページだけを解析（残り ${output.truncatedPages} ページは未処理）`);
  if (output.truncatedChunks) warnings.push('文字数の上限に達したため途中で打ち切り');

  return {
    version: STRUCTURE_VERSION,
    parser: 'fallback',
    parserNote: [
      'pdf.js による簡易解析（GROBID 未接続）。段組・柱・図表キャプション・参考文献は自動で切り分けていますが、' +
        '複雑なレイアウトでは文の区切りと読み順が崩れることがあります。',
      ...warnings,
    ].join(' / '),
    parsedAt: new Date().toISOString(),
    title: pickTitle(output.metadataTitle, output.chunks),
    abstract: null,
    pageSizes: output.pageSizes,
    sections,
    sentences,
    nonBody,
  };
}
