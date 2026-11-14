import type { AgentManager } from '@yaaabk/agents';
import type { GitHubIssues, GitHubMergeMethod, GitHubPulls } from '@yaaabk/github';
import type { Issue, IssuesModule } from '@yaaabk/issues';
import type { Project, ProjectStore } from '@yaaabk/projects';
import { issueNumberFromBranch } from '@yaaabk/shared';
import {
  AUTOMERGE_LABEL,
  DEFAULT_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  isValidInterval,
} from './config';
import { consoleLogger, toCiError, type CiTrackerLogger } from './errors';
import type {
  CiPollSummary,
  CiTracker,
  CiTrackerConfigPatch,
  CiTrackerResult,
  CiTrackerStatus,
  CiTimers,
  PullRequestWatch,
  WatchAction,
} from './types';

export interface CiTrackerOptions {
  /** Resolves every Project and its repository. */
  projects: ProjectStore;
  /** Reads and updates the Issues the watched pull requests implement. */
  issues: IssuesModule;
  /** Spawns fix attempts on a failing pull request. */
  agents: AgentManager;
  /** Lists pull requests, reads their check state and merges them. */
  pulls: GitHubPulls;
  /** Closes the GitHub Issue once its pull request is merged. */
  githubIssues: GitHubIssues;
  /** Milliseconds between passes. Defaults to 30s. */
  intervalMs?: number;
  /** Whether the loop runs. Defaults to `true`. */
  enabled?: boolean;
  /** Merge strategy for a passing pull request. Defaults to the repository's own. */
  mergeMethod?: GitHubMergeMethod;
  /** Injectable clock. Defaults to `Date`. */
  clock?: () => Date;
  /** Injectable scheduler, so tests can drive the loop without real time. */
  timers?: CiTimers;
  logger?: CiTrackerLogger;
}

const DEFAULT_TIMERS: CiTimers = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Builds the CI Tracker.
 *
 * Each pass walks every Project, lists the pull requests labelled `automerge`,
 * and reacts to the check state of each head commit exactly once: a passing pull
 * request is merged and its Issue closed; a failing one spawns a fix attempt on
 * the same branch until the Issue's attempt budget is spent, after which it is
 * labelled `needs-human`. The head commit is remembered, so a still-failing pull
 * request is not fixed twice.
 */
export function createCiTracker(options: CiTrackerOptions): CiTracker {
  const { projects, issues, agents, pulls, githubIssues } = options;
  const logger = options.logger ?? consoleLogger;
  const now = options.clock ?? (() => new Date());
  const timers = options.timers ?? DEFAULT_TIMERS;

  let enabled = options.enabled ?? true;
  let intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let lastCheckedAt: string | null = null;
  let handle: unknown = null;
  let inFlight = false;
  const watches = new Map<string, PullRequestWatch>();

  function nowIso(): string {
    return now().toISOString();
  }

  function watchKey(projectId: string, pullNumber: number): string {
    return `${projectId}#${pullNumber}`;
  }

  /** The Issue a pull request implements, resolved from its head branch. */
  async function resolveIssue(projectId: string, headRef: string): Promise<Issue | undefined> {
    const number = issueNumberFromBranch(headRef);
    if (number === null) return undefined;
    const listed = await issues.list(projectId);
    if (!listed.ok) return undefined;
    return listed.value.find((issue) => issue.githubNumber === number);
  }

  /** Merges a pull request and closes its Issue, locally and on GitHub. */
  async function mergeAndClose(
    project: Project,
    issue: Issue,
    pullNumber: number,
  ): Promise<boolean> {
    const input = options.mergeMethod === undefined ? {} : { method: options.mergeMethod };
    const merged = await pulls.mergePullRequest(project.repoFullName, pullNumber, input);
    if (!merged.ok) {
      logger.error('ci merge failed', {
        projectId: project.id,
        pull: pullNumber,
        kind: merged.error.kind,
      });
      return false;
    }
    const updated = await issues.update(project.id, issue.id, {
      status: 'closed',
      closedAt: nowIso(),
    });
    if (!updated.ok) {
      logger.error('ci close failed', { projectId: project.id, issueId: issue.id });
      return false;
    }
    if (issue.githubNumber !== null) {
      const closed = await githubIssues.updateIssue(project.repoFullName, issue.githubNumber, {
        state: 'closed',
      });
      if (!closed.ok) {
        logger.error('ci github close failed', {
          projectId: project.id,
          issue: issue.githubNumber,
          kind: closed.error.kind,
        });
      }
    }
    return true;
  }

  /** Spawns a fix attempt, or escalates once the Issue's budget is spent. */
  async function fixOrEscalate(
    project: Project,
    issue: Issue,
    headRef: string,
  ): Promise<WatchAction | null> {
    if (issue.attemptCount >= issue.maxAttempts) {
      await issues.update(project.id, issue.id, { label: 'needs-human' });
      logger.info('ci escalated to human', { projectId: project.id, issueId: issue.id });
      return 'needs-human';
    }
    const spawned = await agents.spawn(project.id, issue.id, { branch: headRef });
    if (!spawned.ok) {
      logger.error('ci spawn fix failed', {
        projectId: project.id,
        issueId: issue.id,
        kind: spawned.error.kind,
      });
      return null;
    }
    logger.info('ci spawned fix', { projectId: project.id, issueId: issue.id, branch: headRef });
    return 'fix-spawned';
  }

  async function poll(): Promise<CiTrackerResult<CiPollSummary>> {
    try {
      const summary: CiPollSummary = {
        projects: 0,
        pulls: 0,
        pending: 0,
        merged: 0,
        fixSpawned: 0,
        needsHuman: 0,
      };
      if (!enabled) return { ok: true, value: summary };

      for (const project of projects.list()) {
        summary.projects += 1;
        const listed = await pulls.listPullRequests(project.repoFullName, [AUTOMERGE_LABEL]);
        if (!listed.ok) {
          logger.error('ci list-pulls failed', {
            projectId: project.id,
            kind: listed.error.kind,
          });
          continue;
        }

        for (const pull of listed.value) {
          summary.pulls += 1;
          const issue = await resolveIssue(project.id, pull.headRef);
          if (issue === undefined) {
            logger.info('ci skip unmatched pull', {
              projectId: project.id,
              pull: pull.number,
              headRef: pull.headRef,
            });
            continue;
          }
          const checked = await pulls.checkState(project.repoFullName, pull.headSha);
          if (!checked.ok) {
            logger.error('ci check-state failed', {
              projectId: project.id,
              pull: pull.number,
              kind: checked.error.kind,
            });
            continue;
          }

          const key = watchKey(project.id, pull.number);
          const previous = watches.get(key);
          const sameHead = previous !== undefined && previous.headSha === pull.headSha;
          const action: WatchAction | null = sameHead ? previous.action : null;
          const watch: PullRequestWatch = {
            projectId: project.id,
            repoFullName: project.repoFullName,
            pullNumber: pull.number,
            headRef: pull.headRef,
            headSha: pull.headSha,
            issueId: issue.id,
            state: checked.value.state,
            action,
            lastCheckedAt: nowIso(),
          };
          watches.set(key, watch);

          if (checked.value.state === 'pending') {
            summary.pending += 1;
            continue;
          }
          if (action !== null) continue;
          if (pull.draft) continue;

          if (checked.value.state === 'success') {
            if (await mergeAndClose(project, issue, pull.number)) {
              watches.set(key, { ...watch, action: 'merged' });
              summary.merged += 1;
            }
          } else {
            const action = await fixOrEscalate(project, issue, pull.headRef);
            if (action === 'fix-spawned') {
              watches.set(key, { ...watch, action });
              summary.fixSpawned += 1;
            } else if (action === 'needs-human') {
              watches.set(key, { ...watch, action });
              summary.needsHuman += 1;
            }
          }
        }
      }

      lastCheckedAt = nowIso();
      return { ok: true, value: summary };
    } catch (error) {
      const mapped = toCiError('poll', error);
      logger.error('ci poll failed', { kind: mapped.kind });
      return { ok: false, error: mapped };
    }
  }

  function status(): CiTrackerStatus {
    return {
      enabled,
      intervalMs,
      lastCheckedAt,
      watches: [...watches.values()],
    };
  }

  function start(): void {
    if (!enabled || handle !== null) return;
    handle = timers.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void poll().finally(() => {
        inFlight = false;
      });
    }, intervalMs);
  }

  function stop(): void {
    if (handle === null) return;
    timers.clearInterval(handle);
    handle = null;
  }

  return {
    poll,

    status,

    configure(patch: CiTrackerConfigPatch): CiTrackerResult<CiTrackerStatus> {
      if (patch.intervalMs !== undefined && !isValidInterval(patch.intervalMs)) {
        return {
          ok: false,
          error: {
            kind: 'invalid-input',
            operation: 'configure',
            message: `intervalMs must be an integer between ${MIN_POLL_INTERVAL_MS} and ${MAX_POLL_INTERVAL_MS}`,
          },
        };
      }
      stop();
      if (patch.enabled !== undefined) enabled = patch.enabled;
      if (patch.intervalMs !== undefined) intervalMs = patch.intervalMs;
      start();
      return { ok: true, value: status() };
    },

    start,
    stop,
  };
}
