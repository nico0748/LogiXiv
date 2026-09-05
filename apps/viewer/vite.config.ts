import { defineConfig } from 'vite';

/**
 * 書き出し HTML に丸ごと埋め込む単一ファイルビューアのビルド。
 *
 * IIFE 1 本 + CSS 1 本だけを出す。動的 import もチャンク分割もしない
 * （書き出しは 1 ファイルで完結していないと意味がない）。
 * pdf.js のワーカーは ?raw で文字列として取り込み、実行時に Blob URL にする。
 */
export default defineConfig({
  build: {
    target: 'es2020',
    cssCodeSplit: false,
    minify: 'oxc',
    lib: {
      entry: 'src/main.ts',
      formats: ['iife'],
      name: 'LogiXivViewer',
      fileName: () => 'viewer.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: (asset) => (asset.names?.[0]?.endsWith('.css') ? 'viewer.css' : '[name][extname]'),
      },
    },
  },
});
