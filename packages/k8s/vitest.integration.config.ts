import { defineConfig } from 'vitest/config';

/**
 * Runs the suite that talks to a real cluster. Requires a reachable kubeconfig
 * (kind or minikube) and the `YAAABK_K8S_INTEGRATION=1` flag, set by
 * `bun run test:integration`.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
