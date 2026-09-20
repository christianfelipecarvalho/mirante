import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@mirante/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 7789,
    proxy: {
      '/api': 'http://127.0.0.1:7788',
      '/ws': { target: 'ws://127.0.0.1:7788', ws: true },
    },
  },
});
