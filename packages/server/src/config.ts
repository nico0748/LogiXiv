import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Config {
  /** 既定は 127.0.0.1。未公開原稿を扱う前提なので 0.0.0.0 は明示的な指定でしか選べない。 */
  host: string;
  port: number;
  dataDir: string;
  grobidUrl: string;
  /** apps/web のビルド成果物。無ければ API だけで起動する。 */
  webDir: string | null;
  /** apps/viewer のビルド成果物（書き出し HTML に埋め込む）。 */
  viewerDir: string | null;
}

function envString(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = overrides.dataDir ?? envString('LOGIXIV_DATA_DIR') ?? join(homedir(), '.logixiv');
  return {
    host: overrides.host ?? envString('LOGIXIV_HOST') ?? '127.0.0.1',
    port: overrides.port ?? Number.parseInt(envString('LOGIXIV_PORT') ?? '4173', 10),
    dataDir: resolve(dataDir),
    grobidUrl: (overrides.grobidUrl ?? envString('LOGIXIV_GROBID_URL') ?? 'http://localhost:8070').replace(/\/$/, ''),
    webDir: overrides.webDir ?? envString('LOGIXIV_WEB_DIR') ?? null,
    viewerDir: overrides.viewerDir ?? envString('LOGIXIV_VIEWER_DIR') ?? null,
  };
}

export function documentsDir(config: Config): string {
  return join(config.dataDir, 'documents');
}

export function documentDir(config: Config, id: string): string {
  return join(documentsDir(config), id);
}
