import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),   // not .pathname: a space in the folder name would arrive as %20
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787', '/auth': 'http://localhost:8787' },
  },
  // three.js in its own chunk (October audit): app updates no longer re-download it, and the app code parses separately
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900,
    rollupOptions: { output: { manualChunks: id => id.includes('node_modules/three/') ? 'three' : undefined } } },
});
