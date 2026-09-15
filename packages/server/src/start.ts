import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { loadConfig, type Config } from './config.ts';
import { LogiXivApi } from './api.ts';
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
  api: LogiXivApi;
  config: Config;
  url: string;
  close(): Promise<void>;
}

export async function start(overrides: Partial<Config> = {}): Promise<StartResult> {
  const base = loadConfig(overrides);
  const config: Config = { ...base, webDir: resolveWebDir(base) };

  const api = new LogiXivApi(config);
  await api.init();

  const server = createHttpServer(config, api);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(config.port, config.host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const url = `http://${config.host}:${port}`;

  return {
    server,
    api,
    config,
    url,
    async close() {
      api.bus.close();
      await new Promise<void>((done) => server.close(() => done()));
      // 置き場のロックを返す。返さないと、次の起動が「別のプロセスが使っている」
      // と誤判定する余地を残す（PID の生死で救えはするが、余地は作らない）。
      await api.store.releaseLock().catch(() => undefined);
    },
  };
}
