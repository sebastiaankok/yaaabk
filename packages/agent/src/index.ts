import { loadAgentConfig } from './config';

/**
 * Entry point for the per-issue agent Job.
 *
 * The full implementation flow (clone, analyze, code, open a PR) lives in the
 * agent work tracked separately; this scaffold validates configuration and
 * reports what it was asked to do.
 */
export function main(env: Record<string, string | undefined> = process.env): void {
  const config = loadAgentConfig(env);
  console.log(
    `agent ready: issue #${config.issueNumber} of ${config.repoUrl} (max ${config.maxAttempts} attempts)`,
  );
}

if (import.meta.main) {
  main();
}
