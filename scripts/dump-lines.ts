/**
 * 簡易解析の 1 ページ目（既定）の行と、その分類（本文・見出し・付物の種類）を並べる。
 * 題名や見出しの取り違えを調べるときに使う。
 *
 *   node --experimental-strip-types scripts/dump-lines.ts <pdf> [ページ]
 */
import { readFileSync } from 'node:fs';
import { buildLines, classifyLines, guessTitleFromChunks } from '../packages/core/src/index.ts';
import { extract } from '../packages/server/src/fallback-worker.ts';

const [file, pageArg] = process.argv.slice(2);
if (!file) {
  console.error('usage: dump-lines.ts <pdf> [page]');
  process.exit(2);
}
const page = Number(pageArg ?? 1);
const out = await extract({ pdf: new Uint8Array(readFileSync(file)), maxPages: 50, maxChunks: 2_000_000 });
const chunks = out.chunks.filter((c) => c.rotated !== true);
const lines = classifyLines(buildLines(chunks), out.pageSizes);
console.log('metadataTitle:', JSON.stringify(out.metadataTitle));
console.log('guessedTitle :', JSON.stringify(guessTitleFromChunks(out.chunks)));
for (const l of lines) {
  if (l.page !== page) continue;
  const role = l.role === 'furniture' ? `drop:${l.kind}` : l.role;
  console.log(`${String(l.index).padStart(4)} c${l.column} y=${l.y.toFixed(1).padStart(6)} h=${l.height.toFixed(1).padStart(5)} x=${l.left.toFixed(0)}-${l.right.toFixed(0)} ${role.padEnd(18)} ${l.text.slice(0, 90)}`);
}
