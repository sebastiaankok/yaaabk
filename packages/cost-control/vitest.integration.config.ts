import { defineConfig } from 'vitest/config';

/**
 * Runs the suite that talks to the real OpenRouter Management API. Requires a
 * management key in `OPENROUTER_MANAGEMENT_KEY` and the
 * `YAAABK_OPENROUTER_INTEGRATION=1` flag, set by `bun run test:integration`.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
