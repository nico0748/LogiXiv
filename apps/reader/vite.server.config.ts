import { defineConfig } from "vite";

// ローカルサーバーと MCP サーバーを Node.js 向けにまとめる。
// 依存パッケージ（pdfjs-dist など）は node_modules から読むため、まとめに含めない。
export default defineConfig({
  build: {
    ssr: true,
    target: "node22",
    outDir: "dist-server",
    emptyOutDir: true,
    rollupOptions: {
      input: { server: "server/main.ts", app: "server/app.ts", mcp: "mcp/main.ts" },
      output: { format: "es", entryFileNames: "[name].js", chunkFileNames: "[name]-[hash].js" },
    },
  },
});
