#!/usr/bin/env node
import { start } from './start.ts';
import { isGrobidAlive } from './grobid.ts';

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`LogiXiv — 論文を1文単位で読む対訳リーダー

  logixiv [options]

  --port <number>    待ち受けポート (既定 4173)
  --host <addr>      bind するアドレス (既定 127.0.0.1)
  --data <dir>       データ置き場 (既定 ~/.logixiv)
  --grobid <url>     GROBID の URL (既定 http://localhost:8070)

環境変数 LOGIXIV_PORT / LOGIXIV_HOST / LOGIXIV_DATA_DIR / LOGIXIV_GROBID_URL でも同じ指定ができます。`);
  process.exit(0);
}

const portArg = flag('port');
const overrides = {
  ...(portArg ? { port: Number.parseInt(portArg, 10) } : {}),
  ...(flag('host') ? { host: flag('host')! } : {}),
  ...(flag('data') ? { dataDir: flag('data')! } : {}),
  ...(flag('grobid') ? { grobidUrl: flag('grobid')! } : {}),
};

const { url, config, close } = await start(overrides);

console.log(`LogiXiv を起動しました: ${url}`);
console.log(`  データ: ${config.dataDir}`);
console.log(`  UI:     ${config.webDir ?? '(未ビルド — npm run build を実行してください)'}`);

if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
  console.warn(`  警告: ${config.host} で待ち受けています。未公開の PDF が同一ネットワークから読める状態です。`);
}

const grobid = await isGrobidAlive(config.grobidUrl);
console.log(
  grobid
    ? `  GROBID: 接続できました (${config.grobidUrl})`
    : `  GROBID: 接続できません (${config.grobidUrl}) — 簡易解析にフォールバックします`,
);

const shutdown = async (): Promise<void> => {
  await close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
