import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { loadConfig, type Config } from './config.ts';
import { PaperLensApi } from './api.ts';
import { createHttpServer } from './http.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** apps/web のビルド成果物を、明示指定が無ければリポジトリ内から探す。 */
function resolveWebDir(config: Config): string | null {
  if (config.webDir) return config.webDir;
  for (const candidate of [resolve(here, '../../../apps/web/dist'), resolve(here, '../../apps/web/dist')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface StartResult {
  server: Server;
  api: PaperLensApi;
  config: Config;
  url: string;
  close(): Promise<void>;
}

export async function start(overrides: Partial<Config> = {}): Promise<StartResult> {
  const base = loadConfig(overrides);
  const config: Config = { ...base, webDir: resolveWebDir(base) };

  const api = new PaperLensApi(config);
  await api.init();

  const server = createHttpServer(config, api);
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(config.port, config.host, () => {
        server.off('error', rejectListen);
        resolveListen();
      });
    });
  } catch (error) {
    // 待ち受けに失敗したらロックも返す。返さないまま生き続けると、
    // ポートを直して起動し直したときに自分の残骸に締め出される。
    api.bus.close();
    await api.store.releaseLock().catch(() => undefined);
    throw error;
  }

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const url = `http://${config.host}:${port}`;
  // 実際に開いた番号で上書きする。port 0（自動割り当て）で起動したときに、
  // 画面へ出す設定例が http://127.0.0.1:0 になってしまう。
  config.publicUrl = url;

  return {
    server,
    api,
    config,
    url,
    async close() {
      api.bus.close();
      // ロックは server.close() より先に返す。読みかけの本文を抱えたソケットが
      // 1 本残っていると close のコールバックは呼ばれず、そのまま終了すると
      // ロックだけが置き去りになる（413 を返した直後がまさにそれ）。
      await api.store.releaseLock().catch(() => undefined);
      await new Promise<void>((done) => {
        const timer = setTimeout(done, 2000);
        timer.unref();
        server.close(() => {
          clearTimeout(timer);
          done();
        });
      });
      server.closeAllConnections?.();
    },
  };
}
