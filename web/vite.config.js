import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),   // not .pathname: a space in the folder name would arrive as %20
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787', '/auth': 'http://localhost:8787' },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
});
