import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 開発時は Vite が UI を出し、API はローカルの LogiXiv 本体へプロキシする。
 * 本番（npm run build）では成果物をサーバーが直接配る。
 */
export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022', outDir: 'dist' },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env['LOGIXIV_URL'] ?? 'http://127.0.0.1:4173',
        changeOrigin: false,
      },
    },
  },
});
