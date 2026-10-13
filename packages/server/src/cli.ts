#!/usr/bin/env node
import { start } from './start.ts';
import { isGrobidAlive } from './grobid.ts';
import { DataDirectoryLockedError } from './store.ts';

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`PaperLens — 論文を1文単位で読む対訳リーダー

  paperlens-server [options]

  --port <number>    待ち受けポート (既定 4173)
  --host <addr>      bind するアドレス (既定 127.0.0.1)
  --data <dir>       データ置き場 (既定 ~/.paperlens-server。それが無く ~/.logixiv があればそちら)
  --grobid <url>     GROBID の URL (既定 http://localhost:8070)

環境変数 PAPERLENS_SERVER_PORT / PAPERLENS_SERVER_HOST / PAPERLENS_SERVER_DATA_DIR / PAPERLENS_GROBID_URL でも同じ指定ができます
（改名前の LOGIXIV_PORT / LOGIXIV_HOST / LOGIXIV_DATA_DIR / LOGIXIV_GROBID_URL も読みます）。`);
  process.exit(0);
}

const portArg = flag('port');
if (portArg !== undefined && !/^\d{1,5}$/.test(portArg)) {
  console.error(`ポート番号が数字ではありません: ${portArg}`);
  process.exit(2);
}
const overrides = {
  ...(portArg ? { port: Number.parseInt(portArg, 10) } : {}),
  ...(flag('host') ? { host: flag('host')! } : {}),
  ...(flag('data') ? { dataDir: flag('data')! } : {}),
  ...(flag('grobid') ? { grobidUrl: flag('grobid')! } : {}),
};

/**
 * 起動の失敗は、生のスタックトレースではなく 1 行で伝える。
 * いちばん起きやすい 3 つ（ポートが使用中・置き場が別プロセスに掴まれている・
 * UI が未ビルド）は、原因も対処もはっきりしているので言葉で書く。
 */
function explainStartupFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'EADDRINUSE') {
    return `ポート ${overrides.port ?? '(既定)'} は既に使われています。--port で別の番号を指定してください。`;
  }
  if (code === 'EACCES') {
    return `ポート ${overrides.port ?? '(既定)'} を開く権限がありません。1024 以上の番号を指定してください。`;
  }
  if (error instanceof DataDirectoryLockedError) return message;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    return `ビルド成果物が見つかりません。先に npm run build を実行してください。\n  ${message}`;
  }
  return message;
}

let started: Awaited<ReturnType<typeof start>>;
try {
  started = await start(overrides);
} catch (error) {
  console.error(`PaperLens を起動できませんでした: ${explainStartupFailure(error)}`);
  process.exit(1);
}
const { url, config, close } = started;

console.log(`PaperLens を起動しました: ${url}`);
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
