import type { AgentRun, AgentRunKind } from '@yaaabk/agents';
import type { Issue } from '@yaaabk/issues';
import type { Plan } from '@yaaabk/plans';
import type { Project } from '@yaaabk/projects';
import { countIssues, type IssueStats } from './stats';

/** The statuses of a run that is still in flight. */
type ActiveRunStatus = 'queued' | 'running';

/** The active Plan's identity and acceptance state, for the overview. */
export interface OverviewPlan {
  id: string;
  version: number;
  /** When the Developer accepted the Plan; `null` while it is unaccepted. */
  acceptedAt: string | null;
}

/** One Agent run that is still queued or running. */
export interface ActiveWork {
  id: string;
  issueId: string;
  issueTitle: string;
  kind: AgentRunKind;
  attemptNumber: number;
  status: ActiveRunStatus;
  createdAt: string;
  startedAt: string | null;
}

/** Everything the home list and the project page show about one Project. */
export interface ProjectOverview {
  project: Project;
  /** The active Plan, or `null` when the Project has none yet. */
  activePlan: OverviewPlan | null;
  /** Queued and running Agent runs, newest first. */
  activeWork: ActiveWork[];
  /** How the Project's Issues are distributed by status. */
  issues: IssueStats;
  /** When the newest Agent run was created, or `null` before the first one. */
  lastRunAt: string | null;
}

/** Narrows a run to the ones still in flight. */
function isActiveRun(run: AgentRun): run is AgentRun & { status: ActiveRunStatus } {
  return run.status === 'queued' || run.status === 'running';
}

/** Composes a Project's overview from its Project, active Plan, Issues and runs. */
export function composeProjectOverview(
  project: Project,
  activePlan: Plan | null,
  issues: readonly Issue[],
  runs: readonly AgentRun[],
): ProjectOverview {
  const issueTitles = new Map(issues.map((issue) => [issue.id, issue.title]));
  const activeWork = runs.filter(isActiveRun).map((run): ActiveWork => ({
    id: run.id,
    issueId: run.issueId,
    issueTitle: issueTitles.get(run.issueId) ?? run.issueId,
    kind: run.kind,
    attemptNumber: run.attemptNumber,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
  }));
  activeWork.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const lastRunAt = runs.reduce<string | null>(
    (latest, run) => (latest === null || run.createdAt > latest ? run.createdAt : latest),
    null,
  );

  return {
    project,
    activePlan:
      activePlan === null
        ? null
        : {
            id: activePlan.id,
            version: activePlan.version,
            acceptedAt: activePlan.acceptedAt,
          },
    activeWork,
    issues: countIssues(issues),
    lastRunAt,
  };
}
