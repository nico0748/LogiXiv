// PaperLens の MCP サーバー（stdio）。
// 標準出力は MCP の通信専用なので、ログは標準エラー出力に出す。
//
//   PAPERLENS_CONFIG / PAPERLENS_DATA   保存先（アプリと同じ決め方。server/config.ts を参照）
//   PAPERLENS_MCP_READONLY=1            読み取りのツールだけを公開する

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dataRoot } from "../server/config.ts";
import { createServer } from "./server.ts";

const readOnly = process.env.PAPERLENS_MCP_READONLY === "1";
const server = createServer({ readOnly });
await server.connect(new StdioServerTransport());
process.stderr.write(`paperlens-mcp: 保存先 ${dataRoot()}${readOnly ? "（読み取りのみ）" : ""}\n`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
