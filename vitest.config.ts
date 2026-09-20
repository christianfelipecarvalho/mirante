import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Tests run against source, not against a build artifact, so a failing test
      // points at the line that caused it and `pnpm test` needs no build first.
      '@mirante/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
      '@mirante/daemon': fileURLToPath(new URL('./apps/daemon/src/index.ts', import.meta.url)),
    },
  },
  test: {
    globals: false,
    include: ['{packages,apps}/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**', 'apps/*/src/**'],
    },
  },
});
