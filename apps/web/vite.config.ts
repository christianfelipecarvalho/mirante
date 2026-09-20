import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const DAEMON_PORT = process.env.MIRANTE_PORT ?? '7788';

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
    port: Number(process.env.MIRANTE_WEB_PORT ?? 7789),
    // The board is served by Vite but the API lives in the daemon, so both are
    // proxied across. Read from the environment so `pnpm dev` can move both
    // ports together — a hardcoded target silently 500s when either moves.
    proxy: {
      '/api': `http://127.0.0.1:${DAEMON_PORT}`,
      '/ws': { target: `ws://127.0.0.1:${DAEMON_PORT}`, ws: true },
    },
  },
});
