import type { Issue, IssueGraph, IssueLabel } from '@yaaabk/issues';

/** The kanban lanes an Issue can sit in on the board. */
export type BoardColumn = 'ready' | 'blocked' | 'in_progress' | 'closed' | 'failed';

/** The lanes in board order, left to right. */
export const BOARD_COLUMNS: readonly BoardColumn[] = [
  'ready',
  'blocked',
  'in_progress',
  'closed',
  'failed',
];

/**
 * The Issue labels in the order the filter offers them. Declared here rather
 * than imported from `@yaaabk/issues` so the browser bundle stays free of the
 * module's Node-only code.
 */
export const BOARD_LABELS: readonly IssueLabel[] = [
  'ready',
  'refinement-needed',
  'blocked',
  'needs-human',
];

/** Human-readable heading for each lane. */
export const BOARD_COLUMN_LABELS: Record<BoardColumn, string> = {
  ready: 'Ready',
  blocked: 'Blocked',
  in_progress: 'In Progress',
  closed: 'Closed',
  failed: 'Failed',
};

/**
 * The lane an Issue belongs in.
 *
 * Status drives the lane: closed, failed and in-progress issues always land in
 * their own lane. Everything else is still open, and there the `blocked` label
 * pushes the Issue into the Blocked lane; the remaining open Issues are Ready,
 * carrying their `refinement-needed` or `needs-human` label as a pill only.
 */
export function boardColumn(issue: Issue): BoardColumn {
  if (issue.status === 'closed') return 'closed';
  if (issue.status === 'failed') return 'failed';
  if (issue.status === 'in_progress') return 'in_progress';
  if (issue.label === 'blocked') return 'blocked';
  return 'ready';
}

/** A dependency arrow between two cards: `to` depends on `from`. */
export interface DependencyEdge {
  /** Id of the Issue that must be implemented first. */
  from: string;
  /** Id of the Issue that depends on {@link from}. */
  to: string;
}

/**
 * The arrows to draw between cards, one per resolved dependency. Dependencies
 * that match no Issue (`missing`) have no target to point at and are skipped.
 */
export function dependencyEdges(graph: IssueGraph): DependencyEdge[] {
  return graph.nodes.flatMap((node) => node.dependsOn.map((from) => ({ from, to: node.id })));
}

/** An Issue paired with its lane and place in the dependency graph. */
export interface BoardItem {
  issue: Issue;
  column: BoardColumn;
  /** 0-based wave, or `null` when the Issue is missing from the graph or on a cycle. */
  wave: number | null;
}

/** The filters the board applies to its cards. Omitted fields match everything. */
export interface BoardFilters {
  /** Only cards in this lane. */
  column?: BoardColumn;
  /** Only cards carrying this label. */
  label?: IssueLabel;
  /** Only cards in this wave; `null` selects the cycle/missing cards. */
  wave?: number | null;
  /** Case-insensitive substring matched against the title or body. */
  text?: string;
}

/** How the board orders its cards. */
export type BoardSort = 'wave' | 'created' | 'title';

/** What the board is currently showing. */
export interface BoardQuery {
  filters?: BoardFilters;
  /** Defaults to `wave`. */
  sort?: BoardSort;
}

function matchesFilters(item: BoardItem, filters: BoardFilters): boolean {
  if (filters.column !== undefined && item.column !== filters.column) return false;
  if (filters.label !== undefined && item.issue.label !== filters.label) return false;
  if (filters.wave !== undefined && item.wave !== filters.wave) return false;
  if (filters.text !== undefined) {
    const needle = filters.text.trim().toLowerCase();
    if (needle !== '') {
      const haystack = `${item.issue.title}\n${item.issue.body}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
  }
  return true;
}

function compareItems(a: BoardItem, b: BoardItem, sort: BoardSort): number {
  if (sort === 'title') return a.issue.title.localeCompare(b.issue.title);
  if (sort === 'created') return a.issue.createdAt.localeCompare(b.issue.createdAt);

  // Wave ordering keeps creation order within a wave and pushes the unordered
  // (cycle/missing) cards last.
  if (a.wave === b.wave) return a.issue.createdAt.localeCompare(b.issue.createdAt);
  if (a.wave === null) return 1;
  if (b.wave === null) return -1;
  return a.wave - b.wave;
}

/**
 * Pairs every Issue with its lane and wave, filters it, then orders the cards.
 * Defaults to the wave sort, which is the order an Agent would implement them.
 */
export function boardItems(
  issues: Issue[],
  graph: IssueGraph,
  query: BoardQuery = {},
): BoardItem[] {
  const waveById = new Map(graph.nodes.map((node) => [node.id, node.wave]));
  const filters = query.filters ?? {};

  return issues
    .map((issue) => ({
      issue,
      column: boardColumn(issue),
      wave: waveById.get(issue.id) ?? null,
    }))
    .filter((item) => matchesFilters(item, filters))
    .sort((a, b) => compareItems(a, b, query.sort ?? 'wave'));
}

/** Just enough of an Agent run for the board to total an Issue's spend. */
export interface RunCost {
  issueId: string;
  costCents: number;
}

/**
 * Totals the cost of every run per Issue, so a card can show what is left of
 * its budget. Issues with no runs are absent from the map.
 */
export function spendByIssue(runs: RunCost[]): Map<string, number> {
  const spend = new Map<string, number>();
  for (const run of runs) {
    spend.set(run.issueId, (spend.get(run.issueId) ?? 0) + run.costCents);
  }
  return spend;
}

/** The cents left of an Issue's budget after the runs that have reported cost. */
export function budgetRemaining(issue: Issue, spentCents: number): number {
  return Math.max(0, issue.budgetCents - spentCents);
}

/**
 * The pull request number in a GitHub PR URL, or `null` when there is no URL or
 * it does not point at a pull request.
 */
export function pullRequestNumber(prUrl: string | null): number | null {
  if (prUrl === null) return null;
  const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(prUrl);
  return match === null ? null : Number(match[1]);
}
