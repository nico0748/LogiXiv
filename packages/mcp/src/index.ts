#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.ts';

/**
 * stdio で待ち受ける MCP エントリポイント。
 *
 * 標準出力は JSON-RPC 専用なので、ログは必ず stderr に出す。
 * console.log を 1 行足すだけで Claude 側の接続が壊れる。
 */

const baseUrl = (process.env['LOGIXIV_URL'] ?? 'http://127.0.0.1:4173').replace(/\/$/, '');

const server = createMcpServer(baseUrl);
const transport = new StdioServerTransport();

await server.connect(transport);
process.stderr.write(`logixiv-mcp: ${baseUrl} に接続する設定で起動しました\n`);

const shutdown = async (): Promise<void> => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

export { createMcpServer };
