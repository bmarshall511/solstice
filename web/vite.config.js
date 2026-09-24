import { defineConfig } from 'vite';

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787', '/auth': 'http://localhost:8787' },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
});
