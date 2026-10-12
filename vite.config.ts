import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// SINGLE=1 のときは、すべてを1つの HTML にまとめる（配布・プレビュー用）
export default defineConfig({
  plugins: [react(), ...(process.env.SINGLE ? [viteSingleFile()] : [])],
  build: { target: "es2022", outDir: process.env.SINGLE ? "dist-single" : "dist" },
  worker: { format: "es" },
  assetsInclude: ["**/*.pdf"],
});
