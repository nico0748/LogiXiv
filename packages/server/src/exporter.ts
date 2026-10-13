import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExportHtml, type PaperDocument } from '@paperlens/core';
import type { Config } from './config.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** ビューアの成果物を探す。開発時（リポジトリ内）とインストール時の両方で当たるように順に見る。 */
function candidateViewerDirs(config: Config): string[] {
  const dirs: string[] = [];
  if (config.viewerDir) dirs.push(resolve(config.viewerDir));
  dirs.push(resolve(here, '../../../apps/viewer/dist'));
  dirs.push(resolve(here, '../../apps/viewer/dist'));
  return dirs;
}

export class ViewerNotBuiltError extends Error {}

let cached: { script: string; style: string } | null = null;

export async function loadViewerAssets(config: Config): Promise<{ script: string; style: string }> {
  if (cached) return cached;
  const tried: string[] = [];
  for (const dir of candidateViewerDirs(config)) {
    try {
      const script = await readFile(join(dir, 'viewer.js'), 'utf8');
      const style = await readFile(join(dir, 'viewer.css'), 'utf8').catch(() => '');
      cached = { script, style };
      return cached;
    } catch {
      tried.push(dir);
    }
  }
  throw new ViewerNotBuiltError(
    `書き出し用ビューアが見つかりません。npm run build -w @paperlens/viewer を実行してください。探した場所: ${tried.join(', ')}`,
  );
}

export async function exportDocumentHtml(
  config: Config,
  document: PaperDocument,
  pdf: Buffer,
): Promise<string> {
  const { script, style } = await loadViewerAssets(config);
  return buildExportHtml({
    document,
    pdfBase64: pdf.toString('base64'),
    viewerScript: script,
    viewerStyle: style,
  });
}
