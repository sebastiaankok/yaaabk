import { defineConfig } from 'vitest/config';

/**
 * Unit tests run under Node. The REST adapter is exercised against an injected
 * `fetch`, so no network access is required.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
});
