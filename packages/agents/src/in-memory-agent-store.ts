import { agentsError } from './errors';
import { isActiveRun, type AgentStore, type StoredAgentRun } from './types';

/** Oldest first, with id breaking ties within the same creation instant. */
function byOldestFirst(a: StoredAgentRun, b: StoredAgentRun): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/**
 * A dependency-free {@link AgentStore} for tests and for other modules that
 * need the Agent Manager without a database file.
 */
export function createInMemoryAgentStore(): AgentStore {
  const runs = new Map<string, StoredAgentRun>();

  return {
    create(run) {
      runs.set(run.id, { ...run });
    },

    get(runId) {
      const run = runs.get(runId);
      return run === undefined ? undefined : { ...run };
    },

    listForProject(projectId) {
      return [...runs.values()]
        .filter((run) => run.projectId === projectId)
        .map((run) => ({ ...run }))
        .sort((a, b) => byOldestFirst(b, a));
    },

    listForIssue(projectId, issueId) {
      return [...runs.values()]
        .filter((run) => run.projectId === projectId && run.issueId === issueId)
        .map((run) => ({ ...run }))
        .sort(byOldestFirst);
    },

    listActive() {
      return [...runs.values()]
        .filter((run) => isActiveRun(run.status))
        .map((run) => ({ ...run }))
        .sort(byOldestFirst);
    },

    update(run) {
      if (!runs.has(run.id)) {
        throw agentsError('not-found', `No agent run with id "${run.id}"`);
      }
      runs.set(run.id, { ...run });
    },
  };
}
