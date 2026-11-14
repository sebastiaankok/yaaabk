import { createDependencies } from './adapters';
import { loadAgentConfig } from './config';
import { runAgent } from './run-agent';

/**
 * Entry point for the per-issue agent Job.
 *
 * Validates configuration, runs one implementation attempt, and exits non-zero
 * when the attempt failed so the Job reports the failure and the Agent Manager
 * can schedule a retry.
 */
export async function main(env: Record<string, string | undefined> = process.env): Promise<number> {
  const config = loadAgentConfig(env);
  const outcome = await runAgent(config, createDependencies(config));
  if (outcome.ok) {
    console.log(`agent finished issue #${config.issueNumber}: ${outcome.prUrl}`);
    return 0;
  }
  console.error(`agent failed issue #${config.issueNumber}: ${outcome.reason}`);
  console.error(outcome.output);
  return 1;
}

if (import.meta.main) {
  process.exit(await main());
}

export { loadAgentConfig } from './config';
export * from './ports';
export * from './prompt';
export * from './run-agent';
