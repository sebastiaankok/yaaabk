import { defineConfig } from 'vitest/config';

/** The CI Tracker is pure logic; the whole suite runs under Node. */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
});
