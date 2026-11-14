<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import type { Project } from '@yaaabk/projects';
  import type { ProjectStats } from '@yaaabk/stats';
  import { ApiError, getProject, getProjectStats } from '#lib/api.js';
  import {
    chartPoints,
    donutGradient,
    durationByAttempt,
    formatDollars,
    formatDuration,
    formatPercent,
    rangeForDays,
    sortRuns,
    type RunSort,
  } from '#lib/stats-view.js';

  const projectId = $derived(page.params.id);

  const RANGES = [7, 14, 30] as const;
  const STATUS_FILTERS = ['all', 'success', 'failed', 'running', 'queued'] as const;

  let project = $state<Project | null>(null);
  let stats = $state<ProjectStats | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let days = $state<(typeof RANGES)[number]>(30);
  let sort = $state<RunSort>('newest');
  let statusFilter = $state<(typeof STATUS_FILTERS)[number]>('all');

  const closedPoints = $derived(
    stats === null
      ? []
      : chartPoints(
          stats.closedPerDay.map((day) => day.count),
          600,
          140,
        ),
  );
  const closedPolyline = $derived(closedPoints.map((point) => `${point.x},${point.y}`).join(' '));
  const closedTotal = $derived(
    (stats?.closedPerDay ?? []).reduce((sum, day) => sum + day.count, 0),
  );

  const statusSegments = $derived(
    stats === null
      ? []
      : [
          { label: 'Open', value: stats.issues.open, color: '#737373' },
          { label: 'In progress', value: stats.issues.inProgress, color: '#171717' },
          { label: 'Closed', value: stats.issues.closed, color: '#10b981' },
          { label: 'Failed', value: stats.issues.failed, color: '#ef4444' },
        ],
  );
  const donutStyle = $derived(donutGradient(statusSegments));

  const topCosts = $derived(stats === null ? [] : stats.costByIssue.slice(0, 10));
  const maxCost = $derived(Math.max(1, ...topCosts.map((cost) => cost.costCents)));

  const durationBars = $derived(durationByAttempt(stats?.runs ?? []));
  const maxDuration = $derived(Math.max(1, ...durationBars.map((bar) => bar.averageSeconds)));

  const visibleRuns = $derived(
    sortRuns(stats?.runs ?? [], sort).filter(
      (run) => statusFilter === 'all' || run.status === statusFilter,
    ),
  );

  function describe(cause: unknown): string {
    return cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.';
  }

  // Load the Project and its stats whenever the route or range changes.
  $effect(() => {
    const id = projectId;
    if (id === undefined) return;
    const range = rangeForDays(days);
    let cancelled = false;
    loading = true;
    error = null;
    Promise.all([getProject(id), getProjectStats(id, range)])
      .then(([nextProject, nextStats]) => {
        if (cancelled) return;
        project = nextProject;
        stats = nextStats;
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
  <title>{project ? `${project.name} · Stats` : 'Stats'} · YAAABK</title>
</svelte:head>

<main class="mx-auto flex min-h-dvh max-w-5xl flex-col gap-6 p-6">
  <a
    href={projectId === undefined ? resolve('/') : resolve('/projects/[id]', { id: projectId })}
    class="text-sm text-neutral-500 hover:underline"
  >
    ← Back to project
  </a>

  {#if error !== null}
    <p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>
  {:else if loading && stats === null}
    <p class="text-sm text-neutral-500">Loading stats…</p>
  {:else if project !== null && stats !== null}
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold tracking-tight">{project.name} stats</h1>
        <p class="text-sm text-neutral-600">Issue throughput, agent reliability and spend.</p>
      </div>
      <div class="flex items-center gap-1" role="group" aria-label="Date range">
        {#each RANGES as option (option)}
          <button
            type="button"
            onclick={() => (days = option)}
            aria-pressed={days === option}
            class="rounded-md border px-3 py-1.5 text-sm {days === option
              ? 'border-neutral-900 bg-neutral-900 text-white'
              : 'border-neutral-300 hover:bg-neutral-100'}"
          >
            {option} days
          </button>
        {/each}
      </div>
    </header>

    {#if loading}
      <p class="text-xs text-neutral-500" role="status">Refreshing…</p>
    {/if}

    <section aria-labelledby="summary-heading">
      <h2 id="summary-heading" class="sr-only">Summary</h2>
      <dl class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div class="rounded-lg border border-neutral-200 p-4">
          <dt class="text-xs font-medium uppercase tracking-wide text-neutral-500">Issues</dt>
          <dd class="mt-1 text-2xl font-semibold">{stats.issues.total}</dd>
          <dd class="text-xs text-neutral-500">
            {stats.issues.open} open · {stats.issues.inProgress} in progress · {stats.issues.closed}
            closed · {stats.issues.failed} failed
          </dd>
        </div>
        <div class="rounded-lg border border-neutral-200 p-4">
          <dt class="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Agent success rate
          </dt>
          <dd class="mt-1 text-2xl font-semibold">{formatPercent(stats.agents.successRate)}</dd>
          <dd class="text-xs text-neutral-500">
            {stats.agents.succeeded} succeeded · {stats.agents.failed} failed
          </dd>
        </div>
        <div class="rounded-lg border border-neutral-200 p-4">
          <dt class="text-xs font-medium uppercase tracking-wide text-neutral-500">Total cost</dt>
          <dd class="mt-1 text-2xl font-semibold">{formatDollars(stats.agents.totalCostCents)}</dd>
          <dd class="text-xs text-neutral-500">{stats.agents.total} agent runs</dd>
        </div>
        <div class="rounded-lg border border-neutral-200 p-4">
          <dt class="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Average run duration
          </dt>
          <dd class="mt-1 text-2xl font-semibold">
            {formatDuration(stats.agents.duration.averageSeconds)}
          </dd>
          <dd class="text-xs text-neutral-500">
            min {formatDuration(stats.agents.duration.minSeconds)} · max
            {formatDuration(stats.agents.duration.maxSeconds)}
          </dd>
        </div>
      </dl>
    </section>

    <div class="grid gap-4 lg:grid-cols-2">
      <section class="rounded-lg border border-neutral-200 p-4" aria-labelledby="velocity-heading">
        <h2 id="velocity-heading" class="text-sm font-semibold">Issues closed</h2>
        <p class="mb-2 text-xs text-neutral-500">
          {closedTotal} closed in the last {days} days ·
          {stats.velocity.last7Days.perDay.toFixed(2)}/day over 7 days
        </p>
        <svg
          viewBox="0 0 600 160"
          class="h-40 w-full"
          role="img"
          aria-label={`Issues closed per day over the last ${days} days`}
        >
          <line x1="0" y1="140" x2="600" y2="140" stroke="#e5e5e5" stroke-width="1" />
          <polyline fill="none" stroke="#171717" stroke-width="2" points={closedPolyline}
          ></polyline>
        </svg>
        <div class="flex justify-between text-xs text-neutral-500">
          <span>{stats.closedPerDay[0]?.date ?? ''}</span>
          <span>{stats.closedPerDay.at(-1)?.date ?? ''}</span>
        </div>
      </section>

      <section class="rounded-lg border border-neutral-200 p-4" aria-labelledby="status-heading">
        <h2 id="status-heading" class="text-sm font-semibold">Issue status</h2>
        <div class="mt-3 flex items-center gap-6">
          <div
            class="relative h-28 w-28 shrink-0 rounded-full"
            style:background={donutStyle}
            role="img"
            aria-label="Issue status breakdown"
          >
            <div class="absolute inset-4 rounded-full bg-white"></div>
          </div>
          <ul class="space-y-1 text-sm">
            {#each statusSegments as segment (segment.label)}
              <li class="flex items-center gap-2">
                <span class="h-2.5 w-2.5 rounded-full" style:background={segment.color}></span>
                <span class="text-neutral-600">{segment.label}</span>
                <span class="font-medium">{segment.value}</span>
              </li>
            {/each}
          </ul>
        </div>
      </section>

      <section class="rounded-lg border border-neutral-200 p-4" aria-labelledby="cost-heading">
        <h2 id="cost-heading" class="text-sm font-semibold">Cost per issue</h2>
        {#if topCosts.length === 0}
          <p class="mt-3 text-sm text-neutral-500">No agent spend in this range.</p>
        {:else}
          <ul class="mt-3 space-y-2 text-sm">
            {#each topCosts as cost (cost.issueId)}
              <li class="flex items-center gap-2">
                <span class="w-40 shrink-0 truncate" title={cost.title}>{cost.title}</span>
                <div class="h-2 flex-1 rounded bg-neutral-100">
                  <div
                    class="h-2 rounded bg-neutral-800"
                    style:width={`${(cost.costCents / maxCost) * 100}%`}
                  ></div>
                </div>
                <span class="w-16 text-right tabular-nums">{formatDollars(cost.costCents)}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section class="rounded-lg border border-neutral-200 p-4" aria-labelledby="duration-heading">
        <h2 id="duration-heading" class="text-sm font-semibold">Run duration by attempt</h2>
        {#if durationBars.length === 0}
          <p class="mt-3 text-sm text-neutral-500">No completed runs in this range.</p>
        {:else}
          <div class="mt-3 flex h-36 items-end gap-4">
            {#each durationBars as bar (bar.attemptNumber)}
              <div class="flex h-full flex-1 flex-col items-center justify-end gap-1">
                <span class="text-xs tabular-nums">{formatDuration(bar.averageSeconds)}</span>
                <div
                  class="w-full rounded-t bg-neutral-800"
                  style:height={`${(bar.averageSeconds / maxDuration) * 100}%`}
                  title={`Attempt ${bar.attemptNumber}: ${formatDuration(bar.averageSeconds)} over ${bar.runs} runs`}
                ></div>
                <span class="text-xs text-neutral-500">#{bar.attemptNumber}</span>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    </div>

    <section class="rounded-lg border border-neutral-200" aria-labelledby="history-heading">
      <div
        class="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 p-4"
      >
        <h2 id="history-heading" class="text-sm font-semibold">Agent run history</h2>
        <div class="flex flex-wrap gap-2 text-sm">
          <label class="flex items-center gap-1">
            <span class="text-neutral-500">Sort</span>
            <select
              bind:value={sort}
              aria-label="Sort runs"
              class="rounded-md border border-neutral-300 px-2 py-1"
            >
              <option value="newest">Newest</option>
              <option value="cost">Cost</option>
              <option value="duration">Duration</option>
            </select>
          </label>
          <label class="flex items-center gap-1">
            <span class="text-neutral-500">Status</span>
            <select
              bind:value={statusFilter}
              aria-label="Filter by status"
              class="rounded-md border border-neutral-300 px-2 py-1"
            >
              {#each STATUS_FILTERS as option (option)}
                <option value={option}>{option === 'all' ? 'All' : option}</option>
              {/each}
            </select>
          </label>
        </div>
      </div>
      {#if visibleRuns.length === 0}
        <p class="p-4 text-sm text-neutral-500">No agent runs match this filter.</p>
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead class="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th class="px-4 py-2 font-medium">Issue</th>
                <th class="px-4 py-2 font-medium">Attempt</th>
                <th class="px-4 py-2 font-medium">Status</th>
                <th class="px-4 py-2 font-medium">Duration</th>
                <th class="px-4 py-2 font-medium">Cost</th>
                <th class="px-4 py-2 font-medium">PR</th>
                <th class="px-4 py-2 font-medium">Started</th>
              </tr>
            </thead>
            <tbody>
              {#each visibleRuns as run (run.id)}
                <tr class="border-t border-neutral-100">
                  <td class="px-4 py-2">{run.issueTitle}</td>
                  <td class="px-4 py-2 tabular-nums">{run.attemptNumber}</td>
                  <td class="px-4 py-2">
                    <span
                      class="rounded-full px-2 py-0.5 text-xs {run.status === 'success'
                        ? 'bg-emerald-100 text-emerald-800'
                        : run.status === 'failed'
                          ? 'bg-red-100 text-red-800'
                          : 'bg-neutral-100 text-neutral-700'}"
                    >
                      {run.status}
                    </span>
                  </td>
                  <td class="px-4 py-2 tabular-nums">{formatDuration(run.durationSeconds)}</td>
                  <td class="px-4 py-2 tabular-nums">{formatDollars(run.costCents)}</td>
                  <td class="px-4 py-2">
                    {#if run.prUrl !== null}
                      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
                      <a href={run.prUrl} target="_blank" rel="noreferrer" class="hover:underline">
                        Open PR
                      </a>
                    {:else}
                      —
                    {/if}
                  </td>
                  <td class="px-4 py-2 text-neutral-500">
                    <time datetime={run.createdAt}>{run.createdAt.slice(0, 10)}</time>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  {:else}
    <p class="text-sm text-neutral-500">Project not found.</p>
  {/if}
</main>
