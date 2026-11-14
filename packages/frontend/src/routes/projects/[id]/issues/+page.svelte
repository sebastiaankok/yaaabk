<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import type { AgentRun } from '@yaaabk/agents';
  import type { Issue, IssueGraph, IssueLabel } from '@yaaabk/issues';
  import type { Project } from '@yaaabk/projects';
  import {
    ApiError,
    deleteIssue,
    getIssueGraph,
    getProject,
    listIssues,
    listProjectRuns,
    spawnAgent,
    updateIssue,
  } from '#lib/api.js';
  import { renderMarkdown } from '#lib/markdown.js';
  import {
    BOARD_COLUMNS,
    BOARD_COLUMN_LABELS,
    BOARD_LABELS,
    boardItems,
    budgetRemaining,
    dependencyEdges,
    pullRequestNumber,
    spendByIssue,
    type BoardColumn,
    type BoardItem,
    type BoardSort,
  } from '#lib/issue-board.js';

  const projectId = $derived(page.params.id);

  let project = $state<Project | null>(null);
  let issues = $state<Issue[]>([]);
  let graph = $state<IssueGraph | null>(null);
  let runs = $state<AgentRun[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let busy = $state(false);

  let searchText = $state('');
  let labelFilter = $state('');
  let laneFilter = $state('');
  let waveFilter = $state('');
  let sort = $state<BoardSort>('wave');
  let selectedId = $state<string | null>(null);
  let editing = $state(false);
  let draftTitle = $state('');
  let draftBody = $state('');
  let confirmingDelete = $state(false);

  /** The board container, used to position the dependency arrows. */
  let boardEl = $state<HTMLElement | null>(null);
  let boardWidth = $state(0);
  let boardHeight = $state(0);

  /** One SVG path per dependency arrow, in board-relative coordinates. */
  interface Arrow {
    key: string;
    d: string;
  }
  let arrows = $state<Arrow[]>([]);

  /** The waves the graph actually contains, ascending, for the filter options. */
  const waves = $derived(
    [
      ...new Set(
        (graph?.nodes ?? [])
          .map((node) => node.wave)
          .filter((wave): wave is number => wave !== null),
      ),
    ].sort((a, b) => a - b),
  );

  const hasUnordered = $derived((graph?.nodes ?? []).some((node) => node.wave === null));

  const items = $derived<BoardItem[]>(
    graph === null
      ? []
      : boardItems(issues, graph, {
          filters: {
            text: searchText,
            label: labelFilter === '' ? undefined : (labelFilter as IssueLabel),
            column: laneFilter === '' ? undefined : (laneFilter as BoardColumn),
            wave: waveFilter === '' ? undefined : waveFilter === 'null' ? null : Number(waveFilter),
          },
          sort,
        }),
  );

  const spend = $derived(spendByIssue(runs));

  /** The issue whose detail panel is open, taken from the unfiltered list. */
  const selected = $derived(issues.find((candidate) => candidate.id === selectedId) ?? null);

  /** The runs for the open issue, oldest attempt first. */
  const selectedRuns = $derived(
    runs
      .filter((run) => run.issueId === selectedId)
      .slice()
      .sort((a, b) => a.attemptNumber - b.attemptNumber),
  );

  function columnItems(column: BoardColumn): BoardItem[] {
    return items.filter((item) => item.column === column);
  }

  /** Schedules a fresh agent attempt, then reloads the run history. */
  async function rerun(issueId: string): Promise<void> {
    if (projectId === undefined || busy) return;
    busy = true;
    error = null;
    try {
      await spawnAgent(projectId, issueId);
      runs = await listProjectRuns(projectId);
    } catch (cause) {
      error = describe(cause);
    } finally {
      busy = false;
    }
  }

  /** Opens the detail panel for a card, resetting any in-progress edit. */
  function open(issueId: string): void {
    selectedId = issueId;
    editing = false;
    confirmingDelete = false;
  }

  function startEdit(issue: Issue): void {
    editing = true;
    confirmingDelete = false;
    draftTitle = issue.title;
    draftBody = issue.body;
  }

  /** Saves the edited title and body, then reloads the graph (titles moved). */
  async function saveEdit(): Promise<void> {
    if (projectId === undefined || selected === null || busy) return;
    busy = true;
    error = null;
    try {
      const updated = await updateIssue(projectId, selected.id, {
        title: draftTitle.trim(),
        body: draftBody,
      });
      issues = issues.map((issue) => (issue.id === updated.id ? updated : issue));
      graph = await getIssueGraph(projectId);
      editing = false;
    } catch (cause) {
      error = describe(cause);
    } finally {
      busy = false;
    }
  }

  /** Removes the open issue from the project. */
  async function removeIssue(): Promise<void> {
    if (projectId === undefined || selected === null || busy) return;
    busy = true;
    error = null;
    try {
      await deleteIssue(projectId, selected.id);
      issues = issues.filter((issue) => issue.id !== selected.id);
      graph = await getIssueGraph(projectId);
      selectedId = null;
      confirmingDelete = false;
    } catch (cause) {
      error = describe(cause);
    } finally {
      busy = false;
    }
  }

  const labelClass: Record<IssueLabel, string> = {
    ready: 'bg-emerald-100 text-emerald-800',
    'refinement-needed': 'bg-amber-100 text-amber-800',
    blocked: 'bg-neutral-200 text-neutral-700',
    'needs-human': 'bg-red-100 text-red-800',
  };

  /**
   * Measures the visible cards and rebuilds one path per dependency edge whose
   * two endpoints are both on screen. Dependencies whose cards are filtered out
   * simply have no arrow.
   */
  function measure(): void {
    if (boardEl === null || graph === null) {
      arrows = [];
      return;
    }
    const base = boardEl.getBoundingClientRect();
    const rects: Record<string, DOMRect> = {};
    for (const el of boardEl.querySelectorAll<HTMLElement>('[data-issue-id]')) {
      const id = el.dataset.issueId;
      if (id !== undefined) rects[id] = el.getBoundingClientRect();
    }

    arrows = dependencyEdges(graph).flatMap((edge) => {
      const from = rects[edge.from] as DOMRect | undefined;
      const to = rects[edge.to] as DOMRect | undefined;
      if (from === undefined || to === undefined) return [];
      const x1 = from.left - base.left + from.width / 2;
      const y1 = from.top - base.top + from.height / 2;
      const x2 = to.left - base.left + to.width / 2;
      const y2 = to.top - base.top + to.height / 2;
      const midY = (y1 + y2) / 2;
      return [
        {
          key: `${edge.from}->${edge.to}`,
          d: `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`,
        },
      ];
    });
  }

  function describe(cause: unknown): string {
    return cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.';
  }

  // Re-measure after anything that can move a card: the visible set or layout.
  $effect(() => {
    void items;
    void selectedId;
    void boardEl;
    void graph;
    const handle = requestAnimationFrame(() => measure());
    return () => cancelAnimationFrame(handle);
  });

  onMount(() => {
    const handler = () => measure();
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  });

  // Load the project and everything the board renders once the route is known.
  $effect(() => {
    const id = projectId;
    if (id === undefined) return;
    let cancelled = false;
    loading = true;
    error = null;
    Promise.all([getProject(id), listIssues(id), getIssueGraph(id), listProjectRuns(id)])
      .then(([nextProject, nextIssues, nextGraph, nextRuns]) => {
        if (cancelled) return;
        project = nextProject;
        issues = nextIssues;
        graph = nextGraph;
        runs = nextRuns;
      })
      .catch((cause) => {
        if (!cancelled) error = describe(cause);
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });
    return () => {
      cancelled = true;
    };
  });
</script>

<svelte:head>
  <title>{project ? `${project.name} · Issues` : 'Issues'} · YAAABK</title>
</svelte:head>

<main class="mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 p-6">
  <a
    href={projectId === undefined ? resolve('/') : resolve('/projects/[id]', { id: projectId })}
    class="text-sm text-neutral-500 hover:underline"
  >
    ← Back to project
  </a>

  {#if loading}
    <p class="text-sm text-neutral-500">Loading the board…</p>
  {:else if error !== null && project === null}
    <p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>
  {:else if project !== null}
    <header class="space-y-2">
      <h1 class="text-2xl font-bold tracking-tight">Issue board</h1>
      <p class="text-neutral-600">
        Every issue for <span class="font-medium">{project.name}</span>, grouped by lane and ordered
        by wave.
      </p>
    </header>

    {#if error !== null}
      <p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>
    {/if}

    <section
      class="grid gap-3 rounded-lg border border-neutral-200 p-3 sm:grid-cols-2 xl:grid-cols-5"
      aria-label="Filters"
    >
      <label class="flex flex-col gap-1 text-xs text-neutral-500">
        Search
        <input
          type="search"
          aria-label="Search issues"
          bind:value={searchText}
          placeholder="Search titles and bodies"
          class="rounded-md border border-neutral-300 px-2 py-1 text-sm text-neutral-900"
        />
      </label>

      <label class="flex flex-col gap-1 text-xs text-neutral-500">
        Label
        <select
          aria-label="Filter by label"
          bind:value={labelFilter}
          class="rounded-md border border-neutral-300 px-2 py-1 text-sm text-neutral-900"
        >
          <option value="">All labels</option>
          {#each BOARD_LABELS as label (label)}
            <option value={label}>{label}</option>
          {/each}
        </select>
      </label>

      <label class="flex flex-col gap-1 text-xs text-neutral-500">
        Lane
        <select
          aria-label="Filter by lane"
          bind:value={laneFilter}
          class="rounded-md border border-neutral-300 px-2 py-1 text-sm text-neutral-900"
        >
          <option value="">All lanes</option>
          {#each BOARD_COLUMNS as column (column)}
            <option value={column}>{BOARD_COLUMN_LABELS[column]}</option>
          {/each}
        </select>
      </label>

      <label class="flex flex-col gap-1 text-xs text-neutral-500">
        Wave
        <select
          aria-label="Filter by wave"
          bind:value={waveFilter}
          class="rounded-md border border-neutral-300 px-2 py-1 text-sm text-neutral-900"
        >
          <option value="">All waves</option>
          {#each waves as wave (wave)}
            <option value={String(wave)}>Wave {wave}</option>
          {/each}
          {#if hasUnordered}
            <option value="null">Unordered</option>
          {/if}
        </select>
      </label>

      <label class="flex flex-col gap-1 text-xs text-neutral-500">
        Sort
        <select
          aria-label="Sort issues"
          bind:value={sort}
          class="rounded-md border border-neutral-300 px-2 py-1 text-sm text-neutral-900"
        >
          <option value="wave">Wave</option>
          <option value="created">Creation date</option>
          <option value="title">Title</option>
        </select>
      </label>
    </section>

    <div
      class="relative"
      bind:this={boardEl}
      bind:clientWidth={boardWidth}
      bind:clientHeight={boardHeight}
    >
      <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {#each BOARD_COLUMNS as column (column)}
          {@const columnList = columnItems(column)}
          <section
            class="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3"
            aria-label={BOARD_COLUMN_LABELS[column]}
          >
            <h2 class="flex items-center justify-between text-sm font-semibold">
              {BOARD_COLUMN_LABELS[column]}
              <span class="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">
                {columnList.length}
              </span>
            </h2>

            {#if columnList.length === 0}
              <p class="text-xs text-neutral-400">Nothing here</p>
            {:else}
              <ul class="flex flex-col gap-2">
                {#each columnList as item (item.issue.id)}
                  <li>
                    <button
                      type="button"
                      data-issue-id={item.issue.id}
                      onclick={() => open(item.issue.id)}
                      class="w-full rounded-md border border-neutral-200 p-3 text-left text-sm hover:bg-neutral-50"
                    >
                      <span class="flex flex-wrap items-center gap-2">
                        <span class="font-medium">{item.issue.title}</span>
                        <span
                          class="rounded-full px-2 py-0.5 text-xs {labelClass[item.issue.label]}"
                        >
                          {item.issue.label}
                        </span>
                      </span>
                      <span class="mt-1 block text-xs text-neutral-500">
                        {item.wave === null ? 'Unordered' : `Wave ${item.wave}`} ·
                        {(budgetRemaining(item.issue, spend.get(item.issue.id) ?? 0) / 100).toFixed(
                          2,
                        )} left
                      </span>
                      {#if item.issue.dependsOn.length > 0}
                        <span class="mt-1 block text-xs text-neutral-500">
                          Depends on: {item.issue.dependsOn.join(', ')}
                        </span>
                      {/if}
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        {/each}
      </div>

      <svg
        class="pointer-events-none absolute inset-0 text-neutral-400"
        width={boardWidth}
        height={boardHeight}
        aria-hidden="true"
      >
        <defs>
          <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="currentColor" />
          </marker>
        </defs>
        {#each arrows as arrow (arrow.key)}
          <path
            d={arrow.d}
            data-edge={arrow.key}
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            marker-end="url(#arrowhead)"
          />
        {/each}
      </svg>
    </div>

    {#if selected !== null}
      <div
        class="fixed inset-0 z-10 flex justify-end bg-black/30"
        role="presentation"
        onclick={(event) => {
          if (event.target === event.currentTarget) selectedId = null;
        }}
        onkeydown={(event) => {
          if (event.key === 'Escape') selectedId = null;
        }}
      >
        <div
          class="flex h-full w-full max-w-lg flex-col gap-4 overflow-y-auto bg-white p-6 shadow-xl"
          role="dialog"
          aria-modal="true"
          aria-label={selected.title}
          tabindex="-1"
        >
          <header class="flex items-start justify-between gap-3">
            <div class="space-y-1">
              <h2 class="text-lg font-bold tracking-tight">{selected.title}</h2>
              <span class="rounded-full px-2 py-0.5 text-xs {labelClass[selected.label]}">
                {selected.label}
              </span>
            </div>
            <button
              type="button"
              aria-label="Close details"
              onclick={() => (selectedId = null)}
              class="rounded-md border border-neutral-300 px-2 py-1 text-sm hover:bg-neutral-100"
            >
              ✕
            </button>
          </header>

          {#if selected.githubNumber !== null}
            <p class="text-xs text-neutral-500">GitHub #{selected.githubNumber}</p>
          {/if}

          <dl class="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt class="text-neutral-500">Attempts</dt>
              <dd>{selected.attemptCount} / {selected.maxAttempts}</dd>
            </div>
            <div>
              <dt class="text-neutral-500">Budget left</dt>
              <dd>
                {(budgetRemaining(selected, spend.get(selected.id) ?? 0) / 100).toFixed(2)}
              </dd>
            </div>
          </dl>

          {#if editing}
            <div class="flex flex-col gap-2">
              <label class="flex flex-col gap-1 text-xs text-neutral-500">
                Title
                <input
                  aria-label="Issue title"
                  bind:value={draftTitle}
                  class="rounded-md border border-neutral-300 px-2 py-1 text-sm text-neutral-900"
                />
              </label>
              <label class="flex flex-col gap-1 text-xs text-neutral-500">
                Body
                <textarea
                  aria-label="Issue body"
                  rows="6"
                  bind:value={draftBody}
                  class="w-full rounded-md border border-neutral-300 px-2 py-1 text-sm text-neutral-900"
                ></textarea>
              </label>
            </div>
          {:else if selected.body !== ''}
            <div class="prose prose-neutral max-w-none text-sm">
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              {@html renderMarkdown(selected.body)}
            </div>
          {/if}

          <section aria-label="Agent runs" class="space-y-2">
            <h3 class="text-sm font-semibold">Agent runs</h3>
            {#if selectedRuns.length === 0}
              <p class="text-sm text-neutral-500">No agent runs yet.</p>
            {:else}
              <ul class="flex flex-col gap-2">
                {#each selectedRuns as run (run.id)}
                  <li
                    class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-neutral-200 p-3 text-sm"
                  >
                    <span class="font-medium">Attempt {run.attemptNumber}</span>
                    <span class="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700">
                      {run.status}
                    </span>
                    <span class="text-xs text-neutral-500">
                      {(run.costCents / 100).toFixed(2)}
                    </span>
                    {#if run.prUrl !== null}
                      <!-- eslint-disable svelte/no-navigation-without-resolve -->
                      <a
                        href={run.prUrl}
                        target="_blank"
                        rel="noreferrer"
                        class="text-xs underline"
                      >
                        PR #{pullRequestNumber(run.prUrl)}
                      </a>
                      <!-- eslint-enable svelte/no-navigation-without-resolve -->
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </section>

          <div class="mt-auto flex flex-wrap gap-2">
            {#if editing}
              <button
                type="button"
                onclick={() => void saveEdit()}
                disabled={busy || draftTitle.trim() === ''}
                class="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onclick={() => (editing = false)}
                class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100"
              >
                Cancel
              </button>
            {:else if confirmingDelete}
              <button
                type="button"
                onclick={() => void removeIssue()}
                disabled={busy}
                class="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50"
              >
                Confirm delete
              </button>
              <button
                type="button"
                onclick={() => (confirmingDelete = false)}
                class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100"
              >
                Cancel
              </button>
            {:else}
              <button
                type="button"
                onclick={() => void rerun(selected.id)}
                disabled={busy}
                class="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                Re-run
              </button>
              <button
                type="button"
                onclick={() => startEdit(selected)}
                class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100"
              >
                Edit
              </button>
              <button
                type="button"
                onclick={() => (confirmingDelete = true)}
                class="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
              >
                Delete
              </button>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  {/if}
</main>
