import type { Issue, IssueGraph, IssueGraphNode } from './types';

/**
 * Resolves each Issue's `dependsOn` titles to Issue ids within one Project.
 *
 * Returns, per Issue id, the resolved dependency ids and the titles that match
 * no Issue (which the UI surfaces as a broken reference rather than a cycle).
 */
function resolveDependencies(issues: Issue[]): {
  resolved: Map<string, string[]>;
  missing: Map<string, string[]>;
} {
  const idByTitle = new Map<string, string>();
  for (const issue of issues) {
    idByTitle.set(issue.title, issue.id);
  }

  const resolved = new Map<string, string[]>();
  const missing = new Map<string, string[]>();
  for (const issue of issues) {
    const ids: string[] = [];
    const unresolved: string[] = [];
    for (const title of issue.dependsOn) {
      const id = idByTitle.get(title);
      if (id === undefined) {
        unresolved.push(title);
      } else {
        ids.push(id);
      }
    }
    resolved.set(issue.id, ids);
    missing.set(issue.id, unresolved);
  }

  return { resolved, missing };
}

/**
 * Finds every cycle in the dependency graph using Tarjan's strongly connected
 * components. A component is a cycle when it has more than one member, or a
 * single member that depends on itself.
 */
function findCycles(issues: Issue[], resolved: Map<string, string[]>): string[][] {
  const order = new Map<string, number>();
  issues.forEach((issue, index) => order.set(issue.id, index));

  const selfLoops = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const issue of issues) {
    const deps = resolved.get(issue.id) ?? [];
    if (deps.includes(issue.id)) {
      selfLoops.add(issue.id);
    }
    adjacency.set(
      issue.id,
      deps.filter((id) => id !== issue.id),
    );
  }

  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  function strongConnect(node: string): void {
    indices.set(node, index);
    lowlink.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of adjacency.get(node) ?? []) {
      if (!indices.has(next)) {
        strongConnect(next);
        lowlink.set(node, Math.min(lowlink.get(node) ?? 0, lowlink.get(next) ?? 0));
      } else if (onStack.has(next)) {
        lowlink.set(node, Math.min(lowlink.get(node) ?? 0, indices.get(next) ?? 0));
      }
    }

    if (lowlink.get(node) === indices.get(node)) {
      const component: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member === undefined) break;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);

      if (component.length > 1 || (component.length === 1 && selfLoops.has(component[0] ?? ''))) {
        cycles.push(component);
      }
    }
  }

  for (const issue of issues) {
    if (!indices.has(issue.id)) {
      strongConnect(issue.id);
    }
  }

  // Tarjan pops components in reverse discovery order; sort each cycle (and the
  // list of cycles) by the Issues' creation order so the result is stable.
  for (const component of cycles) {
    component.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }
  cycles.sort((a, b) => (order.get(a[0] ?? '') ?? 0) - (order.get(b[0] ?? '') ?? 0));

  return cycles;
}

/**
 * Builds the dependency graph the UI renders: every Issue with its resolved
 * dependencies, its wave, and any cycles.
 *
 * Wave 0 holds Issues with no dependencies; an Issue's wave is one past the
 * highest wave among its dependencies. An Issue on a cycle — or one that
 * transitively depends on a cycle — has a `null` wave, because its position is
 * undefined until the cycle is broken.
 */
export function buildIssueGraph(issues: Issue[]): IssueGraph {
  const { resolved, missing } = resolveDependencies(issues);
  const cycles = findCycles(issues, resolved);
  const onCycle = new Set(cycles.flat());

  const waveCache = new Map<string, number | null>();
  function waveOf(id: string): number | null {
    if (onCycle.has(id)) {
      return null;
    }
    const cached = waveCache.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const deps = resolved.get(id) ?? [];
    if (deps.length === 0) {
      waveCache.set(id, 0);
      return 0;
    }
    let highest = -1;
    for (const dep of deps) {
      const depWave = waveOf(dep);
      if (depWave === null) {
        waveCache.set(id, null);
        return null;
      }
      highest = Math.max(highest, depWave);
    }
    const wave = highest + 1;
    waveCache.set(id, wave);
    return wave;
  }

  const nodes: IssueGraphNode[] = issues.map((issue) => ({
    id: issue.id,
    title: issue.title,
    dependsOn: resolved.get(issue.id) ?? [],
    missing: missing.get(issue.id) ?? [],
    wave: waveOf(issue.id),
  }));

  return { nodes, cycles };
}
