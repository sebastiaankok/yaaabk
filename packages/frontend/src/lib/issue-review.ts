import type { Issue, IssueGraph } from '@yaaabk/issues';

/** An Issue paired with its place in the dependency graph, for the review UI. */
export interface ReviewItem {
  issue: Issue;
  /** 0-based wave, or `null` when the Issue sits on a cycle. */
  wave: number | null;
  /** Dependency titles that match no Issue. */
  missing: string[];
}

/** A run of review items that share a wave. */
export interface WaveGroup {
  wave: number | null;
  items: ReviewItem[];
}

/** Which Issues the review list shows. */
export interface ReviewQuery {
  /** Only the Issues of this Plan. Omit to show every Plan. */
  planId?: string;
  /** Whether closed Issues are listed. Defaults to `false`. */
  includeClosed?: boolean;
}

/**
 * Pairs each Issue with its graph placement and orders them by wave, keeping
 * creation order within a wave. Issues on a cycle (no wave) come last, so the
 * Developer reviews the well-defined work before the broken references.
 *
 * The review is about work still to do: closed Issues are hidden unless asked
 * for, and a `planId` narrows the list to one Plan so reviewing a new Plan is
 * not cluttered by the previous one's history.
 */
export function reviewItems(
  issues: Issue[],
  graph: IssueGraph,
  query: ReviewQuery = {},
): ReviewItem[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const includeClosed = query.includeClosed ?? false;

  return issues
    .filter((issue) => includeClosed || issue.status !== 'closed')
    .filter((issue) => query.planId === undefined || issue.planId === query.planId)
    .map((issue) => {
      const node = nodeById.get(issue.id);
      return { issue, wave: node?.wave ?? null, missing: node?.missing ?? [] };
    })
    .sort((a, b) => {
      if (a.wave === b.wave) {
        return a.issue.createdAt.localeCompare(b.issue.createdAt);
      }
      if (a.wave === null) return 1;
      if (b.wave === null) return -1;
      return a.wave - b.wave;
    });
}

/** Groups already-ordered review items into consecutive runs of the same wave. */
export function groupByWave(items: ReviewItem[]): WaveGroup[] {
  const groups: WaveGroup[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last !== undefined && last.wave === item.wave) {
      last.items.push(item);
    } else {
      groups.push({ wave: item.wave, items: [item] });
    }
  }
  return groups;
}
