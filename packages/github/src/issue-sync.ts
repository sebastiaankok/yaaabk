import type { Issue, IssuePatch, IssuesModule } from '@yaaabk/issues';
import type { GitHubLogger } from './errors';
import { encodeIssueBody } from './metadata';
import type {
  GitHubError,
  GitHubIssues,
  GitHubResult,
  IssueSyncError,
  IssueSyncModule,
  IssueSyncResult,
  IssueSyncStatus,
  PullSummary,
  PushOptions,
  PushSummary,
  SyncSummary,
} from './types';

export interface IssueSyncModuleOptions {
  /** The local Issues Module the mirror is built on. */
  issues: IssuesModule;
  /** The GitHub port the mirror talks through. */
  github: GitHubIssues;
  /** Injectable clock. Defaults to `Date`. */
  clock?: () => Date;
  /** Injectable delay, for retry back-off. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Total attempts per GitHub call before giving up. Defaults to 3. */
  maxAttempts?: number;
  /** Base back-off between retries, in milliseconds. Defaults to 250. */
  retryDelayMs?: number;
  /**
   * Resolves the repository path of a Plan's decision record, e.g.
   * `docs/plans/v2.md`. `@yaaabk/github` does not own Plans, so the backend
   * injects this. Returning `null` (or omitting the resolver) leaves Issues
   * without a Plan line.
   */
  planPath?: (projectId: string, planId: string) => Promise<string | null>;
  logger?: GitHubLogger;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;

/** Whether a GitHub failure is worth retrying. */
function isRetryable(error: GitHubError): boolean {
  return error.kind === 'rate-limited' || error.kind === 'network';
}

function fromIssueError(
  operation: string,
  error: { kind: string; message: string },
): IssueSyncError {
  const kind = error.kind === 'not-found' ? 'not-found' : 'unknown';
  return { kind, operation, message: error.message };
}

/** Builds the Issue mirror: local Issues pushed to and pulled from GitHub. */
export function createIssueSyncModule(options: IssueSyncModuleOptions): IssueSyncModule {
  const { issues, github } = options;
  const logger = options.logger ?? { info: () => {}, error: () => {} };
  const now = options.clock ?? (() => new Date());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const resolvePlanPath = options.planPath ?? (async () => null);

  function nowIso(): string {
    return now().toISOString();
  }

  /** Runs a GitHub call, retrying the failures that a second attempt can fix. */
  async function withRetry<T>(
    operation: string,
    run: () => Promise<GitHubResult<T>>,
  ): Promise<GitHubResult<T>> {
    let result = await run();
    for (let attempt = 1; attempt < maxAttempts && !result.ok; attempt += 1) {
      if (!isRetryable(result.error)) return result;
      await sleep(retryDelayMs * attempt);
      logger.info('github retry', { operation, attempt, kind: result.error.kind });
      result = await run();
    }
    return result;
  }

  function githubFailure(
    operation: string,
    error: GitHubError,
  ): { ok: false; error: IssueSyncError } {
    return {
      ok: false,
      error: {
        kind: error.kind === 'invalid-input' ? 'invalid-input' : 'github',
        operation,
        message: error.message,
        github: error,
      },
    };
  }

  function statusOf(list: Issue[]): IssueSyncStatus {
    const syncedIssues = list.filter((issue) => issue.githubNumber !== null);
    const timestamps = syncedIssues
      .map((issue) => issue.githubSyncedAt)
      .filter((value): value is string => value !== null);
    return {
      total: list.length,
      synced: syncedIssues.length,
      pending: list.length - syncedIssues.length,
      lastSyncedAt: timestamps.length === 0 ? null : timestamps.sort().at(-1)!,
    };
  }

  /** Records a successful GitHub round trip against a local Issue. */
  async function markSynced(
    projectId: string,
    issueId: string,
    patch: IssuePatch,
  ): Promise<IssueSyncResult<Issue>> {
    const result = await issues.update(projectId, issueId, patch);
    return result.ok ? result : { ok: false, error: fromIssueError('update', result.error) };
  }

  async function push(
    projectId: string,
    repoFullName: string,
    options: PushOptions = {},
  ): Promise<IssueSyncResult<PushSummary>> {
    if (projectId.trim() === '' || repoFullName.trim() === '') {
      return {
        ok: false,
        error: {
          kind: 'invalid-input',
          operation: 'push',
          message: 'A project and repository are required',
        },
      };
    }

    const listed = await issues.list(projectId);
    if (!listed.ok) return { ok: false, error: fromIssueError('push', listed.error) };

    const targets = listed.value.filter(
      (issue) => options.planId === undefined || issue.planId === options.planId,
    );
    const labels = [...new Set(targets.map((issue) => issue.label))];
    if (labels.length > 0) {
      const ensured = await withRetry('ensure-labels', () =>
        github.ensureLabels(repoFullName, labels),
      );
      if (!ensured.ok) return githubFailure('push', ensured.error);
    }

    let created = 0;
    let updated = 0;
    // A Plan's path is resolved once per push, however many Issues it owns.
    const planPaths = new Map<string, string | null>();
    for (const issue of targets) {
      let planPath: string | null = null;
      if (issue.planId !== null) {
        if (!planPaths.has(issue.planId)) {
          planPaths.set(issue.planId, await resolvePlanPath(projectId, issue.planId));
        }
        planPath = planPaths.get(issue.planId) ?? null;
      }
      const body = encodeIssueBody(
        issue.body,
        {
          dependsOn: issue.dependsOn,
          budgetCents: issue.budgetCents,
        },
        planPath,
      );
      if (issue.githubNumber === null) {
        const result = await withRetry('create-issue', () =>
          github.createIssue(repoFullName, { title: issue.title, body, labels: [issue.label] }),
        );
        if (!result.ok) return githubFailure('push', result.error);
        const marked = await markSynced(projectId, issue.id, {
          githubNumber: result.value.number,
          githubSyncedAt: nowIso(),
        });
        if (!marked.ok) return marked;
        created += 1;
      } else {
        const result = await withRetry('update-issue', () =>
          github.updateIssue(repoFullName, issue.githubNumber!, {
            title: issue.title,
            body,
            labels: [issue.label],
          }),
        );
        if (!result.ok) return githubFailure('push', result.error);
        const marked = await markSynced(projectId, issue.id, { githubSyncedAt: nowIso() });
        if (!marked.ok) return marked;
        updated += 1;
      }
    }

    const refreshed = await issues.list(projectId);
    if (!refreshed.ok) return { ok: false, error: fromIssueError('push', refreshed.error) };
    logger.info('issues pushed', { projectId, planId: options.planId, created, updated });
    const scoped =
      options.planId === undefined
        ? refreshed.value
        : refreshed.value.filter((issue) => issue.planId === options.planId);
    return { ok: true, value: { created, updated, status: statusOf(scoped) } };
  }

  async function pull(
    projectId: string,
    repoFullName: string,
  ): Promise<IssueSyncResult<PullSummary>> {
    if (projectId.trim() === '' || repoFullName.trim() === '') {
      return {
        ok: false,
        error: {
          kind: 'invalid-input',
          operation: 'pull',
          message: 'A project and repository are required',
        },
      };
    }

    const listed = await issues.list(projectId);
    if (!listed.ok) return { ok: false, error: fromIssueError('pull', listed.error) };

    let changed = 0;
    for (const issue of listed.value) {
      if (issue.githubNumber === null) continue;
      const result = await withRetry('get-issue', () =>
        github.getIssue(repoFullName, issue.githubNumber!),
      );
      if (!result.ok) return githubFailure('pull', result.error);

      // GitHub owns open/closed; YAAABK stays the source of truth for everything
      // else (title, body, labels, dependencies, budget).
      const patch: IssuePatch = { githubSyncedAt: nowIso() };
      if (result.value.state === 'closed' && issue.status !== 'closed') {
        patch.status = 'closed';
        patch.closedAt = issue.closedAt ?? nowIso();
        changed += 1;
      } else if (result.value.state === 'open' && issue.status === 'closed') {
        patch.status = 'open';
        patch.closedAt = null;
        changed += 1;
      }
      const marked = await markSynced(projectId, issue.id, patch);
      if (!marked.ok) return marked;
    }

    const refreshed = await issues.list(projectId);
    if (!refreshed.ok) return { ok: false, error: fromIssueError('pull', refreshed.error) };
    logger.info('issues pulled', { projectId, changed });
    return { ok: true, value: { changed, status: statusOf(refreshed.value) } };
  }

  return {
    push,
    pull,

    async sync(projectId, repoFullName) {
      const pushed = await push(projectId, repoFullName);
      if (!pushed.ok) return pushed;
      const pulled = await pull(projectId, repoFullName);
      if (!pulled.ok) return pulled;
      return { ok: true, value: { push: pushed.value, pull: pulled.value } satisfies SyncSummary };
    },

    async status(projectId) {
      const listed = await issues.list(projectId);
      if (!listed.ok) return { ok: false, error: fromIssueError('status', listed.error) };
      return { ok: true, value: statusOf(listed.value) };
    },
  };
}
