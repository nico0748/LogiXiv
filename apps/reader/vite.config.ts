import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// SINGLE=1 のときは、すべてを1つの HTML にまとめる（配布・プレビュー用）
export default defineConfig({
  plugins: [react(), ...(process.env.SINGLE ? [viteSingleFile()] : [])],
  // cssTarget: light-dark() をそのまま残す（es2022 のままだと Lightning CSS が変数に書き換え、要素ごとの color-scheme が効かなくなる）
  build: { target: "es2022", cssTarget: ["chrome123", "edge123", "firefox120", "safari17.5"], outDir: process.env.SINGLE ? "dist-single" : "dist" },
  worker: { format: "iife" },
  assetsInclude: ["**/*.pdf"],
  // npm run dev では、API をローカルサーバー（scripts/dev.mjs が起動する）へ中継する
  server: { proxy: { "/api": "http://127.0.0.1:5175" } },
});
