import { defineConfig } from 'vitest/config';

/**
 * Unit tests run under Node. The SQLite store's suite is excluded here because
 * it needs `bun:sqlite`; run it with `bun run test:integration` instead.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', '**/node_modules/**'],
  },
});
