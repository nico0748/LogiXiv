import { defineConfig } from "vite";

// ローカルサーバーと MCP サーバーを Node.js 向けにまとめる。
// 依存パッケージ（pdfjs-dist など）は node_modules から読むため、まとめに含めない。
// @paperlens/* はワークスペースのリンクなので、何も言わないとまとめに取り込まれる。
// 取り込むと @paperlens/server の簡易解析ワーカー（dist/fallback-worker.js を import.meta.url から探す）と、
// それが使う pdfjs-dist 6 系が見つからなくなるため、外に出したまま node_modules から読ませる。
export default defineConfig({
  ssr: { external: ["@paperlens/core", "@paperlens/server"] },
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
