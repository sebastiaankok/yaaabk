import type { AgentRun } from '@yaaabk/agents';
import type { Issue } from '@yaaabk/issues';
import { tokenUsageTotal } from '@yaaabk/shared';

/** How an Issue's statuses are distributed across a Project. */
export interface IssueStats {
  total: number;
  open: number;
  inProgress: number;
  closed: number;
  failed: number;
  /** Mean Agent attempts across every Issue, `0` when there are none. */
  averageAttempts: number;
}

/** Aggregate statistics for a Project's Agent runs. */
export interface RunStats {
  total: number;
  succeeded: number;
  failed: number;
  /** Runs still queued or running. */
  active: number;
  /** Successful runs divided by finished runs, or `null` before one finishes. */
  successRate: number | null;
  /** Cost of every run, in cents. */
  totalCostCents: number;
  /**
   * Tokens measured across the window's model runs, or `null` when none could
   * be measured. Unmeasured runs contribute nothing rather than zero.
   */
  totalTokens: number | null;
  /** Model runs whose token usage was measured. */
  measuredRuns: number;
  /** Runs that invoked a model; deploy runs are excluded. */
  modelRuns: number;
  /** Duration of completed runs; every field is `null` before one finishes. */
  duration: RunDuration;
}

/** How long completed Agent runs took. */
export interface RunDuration {
  averageSeconds: number | null;
  minSeconds: number | null;
  maxSeconds: number | null;
}

/** One row of the Agent run history table. */
export interface RunHistoryEntry {
  id: string;
  issueId: string;
  issueTitle: string;
  attemptNumber: number;
  status: AgentRun['status'];
  durationSeconds: number | null;
  costCents: number;
  /** Tokens measured for this run, or `null` when it was not measured. */
  tokens: number | null;
  prUrl: string | null;
  createdAt: string;
}

/** One Issue's share of the Agent spend and token usage. */
export interface IssueUsage {
  issueId: string;
  title: string;
  costCents: number;
  /** Measured tokens, or `null` when none of its model runs were measured. */
  tokens: number | null;
  /** Model runs whose token usage was measured. */
  measuredRuns: number;
  /** Runs that invoked a model; deploy runs are excluded. */
  modelRuns: number;
}

/** How many Issues closed in a rolling window. */
export interface VelocityWindow {
  closed: number;
  perDay: number;
}

/** One day's Issue closures. */
export interface ClosedPerDay {
  /** UTC date, `YYYY-MM-DD`. */
  date: string;
  count: number;
}

/** Issue close velocity over the windows the dashboard offers. */
export interface VelocityStats {
  last7Days: VelocityWindow;
  last14Days: VelocityWindow;
  last30Days: VelocityWindow;
}

/** The options a stats computation accepts. */
export interface StatsOptions {
  /** The instant "last 7/14/30 days" is measured from. Defaults to `new Date()`. */
  now?: Date;
  /** Start of the selected window. Defaults to 30 UTC days before `to`. */
  from?: Date;
  /** End of the selected window. Defaults to `now`. */
  to?: Date;
}

/** Everything the dashboard shows for one Project. */
export interface ProjectStats {
  issues: IssueStats;
  agents: RunStats;
  /**
   * Agent spend and token usage per Issue, most expensive first. Issues with
   * neither spend nor measured tokens are omitted, as are pure deploy runs.
   */
  usageByIssue: IssueUsage[];
  /** Issues closed per day over the last 7, 14 and 30 days. */
  velocity: VelocityStats;
  /** Issues closed per UTC day across the selected window, gaps included. */
  closedPerDay: ClosedPerDay[];
  /** Every Agent run in the selected window, newest first. */
  runs: RunHistoryEntry[];
}

/** How many seconds a run took, or `null` while it is unfinished. */
function runDurationSeconds(run: AgentRun): number | null {
  if (run.startedAt === null || run.finishedAt === null) return null;
  return (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000;
}

/** Counts Issues by status and averages their Agent attempts. */
export function countIssues(issues: readonly Issue[]): IssueStats {
  const counts = { open: 0, in_progress: 0, closed: 0, failed: 0 };
  for (const issue of issues) {
    counts[issue.status] += 1;
  }
  const totalAttempts = issues.reduce((sum, issue) => sum + issue.attemptCount, 0);
  return {
    total: issues.length,
    open: counts.open,
    inProgress: counts.in_progress,
    closed: counts.closed,
    failed: counts.failed,
    averageAttempts: issues.length === 0 ? 0 : totalAttempts / issues.length,
  };
}

/** Computes a Project's dashboard statistics from its Issues and Agent runs. */
export function computeProjectStats(
  issues: readonly Issue[],
  runs: readonly AgentRun[],
  options: StatsOptions = {},
): ProjectStats {
  const now = options.now ?? new Date();
  const rangeGiven = options.from !== undefined || options.to !== undefined;
  const rangeFromMs = options.from?.getTime() ?? Number.NEGATIVE_INFINITY;
  const rangeToMs = options.to?.getTime() ?? Number.POSITIVE_INFINITY;
  const selectedRuns = rangeGiven
    ? runs.filter((run) => {
        const createdAt = Date.parse(run.createdAt);
        return createdAt >= rangeFromMs && createdAt <= rangeToMs;
      })
    : runs;

  const succeeded = selectedRuns.filter((run) => run.status === 'success').length;
  const failed = selectedRuns.filter((run) => run.status === 'failed').length;
  const active = selectedRuns.filter(
    (run) => run.status === 'queued' || run.status === 'running',
  ).length;
  const finished = succeeded + failed;
  const totalCostCents = selectedRuns.reduce((sum, run) => sum + run.costCents, 0);
  let totalTokens: number | null = null;
  let measuredRuns = 0;
  let modelRuns = 0;
  for (const run of selectedRuns) {
    if (run.kind === 'deploy') continue;
    modelRuns += 1;
    if (run.tokens === null) continue;
    measuredRuns += 1;
    totalTokens = (totalTokens ?? 0) + tokenUsageTotal(run.tokens);
  }
  const durations = selectedRuns
    .map(runDurationSeconds)
    .filter((seconds): seconds is number => seconds !== null);
  const duration: RunDuration =
    durations.length === 0
      ? { averageSeconds: null, minSeconds: null, maxSeconds: null }
      : {
          averageSeconds: durations.reduce((sum, seconds) => sum + seconds, 0) / durations.length,
          minSeconds: Math.min(...durations),
          maxSeconds: Math.max(...durations),
        };

  const issueTitles = new Map(issues.map((issue) => [issue.id, issue.title]));
  const usagePerIssue = new Map<
    string,
    { costCents: number; tokens: number | null; measuredRuns: number; modelRuns: number }
  >();
  for (const run of selectedRuns) {
    const usage = usagePerIssue.get(run.issueId) ?? {
      costCents: 0,
      tokens: null,
      measuredRuns: 0,
      modelRuns: 0,
    };
    usage.costCents += run.costCents;
    if (run.kind !== 'deploy') {
      usage.modelRuns += 1;
      if (run.tokens !== null) {
        usage.measuredRuns += 1;
        usage.tokens = (usage.tokens ?? 0) + tokenUsageTotal(run.tokens);
      }
    }
    usagePerIssue.set(run.issueId, usage);
  }
  const usageByIssue = [...usagePerIssue.entries()]
    .filter(([, usage]) => usage.costCents > 0 || usage.tokens !== null)
    .map(([issueId, usage]) => ({
      issueId,
      title: issueTitles.get(issueId) ?? issueId,
      ...usage,
    }))
    .sort((a, b) => b.costCents - a.costCents || a.title.localeCompare(b.title));

  const nowMs = now.getTime();
  const closedSince = (days: number): VelocityWindow => {
    const since = nowMs - days * 24 * 60 * 60 * 1000;
    const closed = issues.filter((issue) => {
      if (issue.status !== 'closed' || issue.closedAt === null) return false;
      const closedMs = Date.parse(issue.closedAt);
      return closedMs >= since && closedMs <= nowMs;
    }).length;
    return { closed, perDay: closed / days };
  };
  const velocity: VelocityStats = {
    last7Days: closedSince(7),
    last14Days: closedSince(14),
    last30Days: closedSince(30),
  };

  const to = options.to ?? now;
  const from =
    options.from ??
    new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() - 29, 0, 0, 0, 0));
  if (from.getTime() > to.getTime()) {
    throw new RangeError('stats: `from` must not be after `to`');
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const firstDay = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const lastDay = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  const closuresPerDay = new Map<string, number>();
  for (const issue of issues) {
    if (issue.status !== 'closed' || issue.closedAt === null) continue;
    const date = issue.closedAt.slice(0, 10);
    closuresPerDay.set(date, (closuresPerDay.get(date) ?? 0) + 1);
  }
  const closedPerDay: ClosedPerDay[] = [];
  for (let day = firstDay; day <= lastDay; day += dayMs) {
    const date = new Date(day).toISOString().slice(0, 10);
    closedPerDay.push({ date, count: closuresPerDay.get(date) ?? 0 });
  }

  const runHistory = selectedRuns
    .map((run): RunHistoryEntry => ({
      id: run.id,
      issueId: run.issueId,
      issueTitle: issueTitles.get(run.issueId) ?? run.issueId,
      attemptNumber: run.attemptNumber,
      status: run.status,
      durationSeconds: runDurationSeconds(run),
      costCents: run.costCents,
      tokens: run.tokens === null ? null : tokenUsageTotal(run.tokens),
      prUrl: run.prUrl,
      createdAt: run.createdAt,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));

  return {
    issues: countIssues(issues),
    agents: {
      total: selectedRuns.length,
      succeeded,
      failed,
      active,
      successRate: finished === 0 ? null : succeeded / finished,
      totalCostCents,
      totalTokens,
      measuredRuns,
      modelRuns,
      duration,
    },
    usageByIssue,
    velocity,
    closedPerDay,
    runs: runHistory,
  };
}
