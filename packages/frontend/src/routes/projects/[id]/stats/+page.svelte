<script lang="ts">
  import { page } from '$app/state';
  import type { Project } from '@yaaabk/projects';
  import type { ProjectStats, RunHistoryEntry } from '@yaaabk/stats';
  import { compactTokens } from '#lib/agent-run.js';
  import { ApiError, getProject, getProjectStats } from '#lib/api.js';
  import PageHeader from '#lib/components/page-header.svelte';
  import ProjectTabs from '#lib/components/project-tabs.svelte';
  import { Skeleton } from '#lib/components/ui/skeleton/index.js';
  import { resolveShell } from '#lib/shell.js';
  import {
    chartGeometry,
    donutGradient,
    durationByAttempt,
    formatCoveredTokens,
    formatDollars,
    formatDuration,
    formatPercent,
    nearestChartIndex,
    rangeForDays,
    runHistoryEmptyState,
    type RunSort,
    type RunStatusFilter,
    visibleRuns,
  } from '#lib/stats-view.js';

  const projectId = $derived(page.params.id);

  const RANGES = [7, 14, 30] as const;
  const STATUS_FILTERS: readonly RunStatusFilter[] = [
    'all',
    'success',
    'failed',
    'running',
    'queued',
  ];

  let project = $state<Project | null>(null);
  const shell = $derived(resolveShell(page.url.pathname, project?.name));
  let stats = $state<ProjectStats | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let days = $state<(typeof RANGES)[number]>(30);
  let sort = $state<RunSort>('newest');
  let statusFilter = $state<RunStatusFilter>('all');

  let throughputElement = $state<SVGSVGElement | undefined>(undefined);
  let activeIndex = $state<number | null>(null);

  const closedValues = $derived((stats?.closedPerDay ?? []).map((day) => day.count));
  const throughput = $derived(chartGeometry(closedValues));
  const closedTotal = $derived(closedValues.reduce((sum, count) => sum + count, 0));
  const activeDay = $derived(
    activeIndex === null ? null : (stats?.closedPerDay[activeIndex] ?? null),
  );
  const activePoint = $derived(
    activeIndex === null ? null : (throughput.points[activeIndex] ?? null),
  );

  const statusSegments = $derived(
    stats === null
      ? []
      : [
          { label: 'Open', value: stats.issues.open, color: 'var(--chart-5)' },
          { label: 'In progress', value: stats.issues.inProgress, color: 'var(--chart-1)' },
          { label: 'Closed', value: stats.issues.closed, color: 'var(--chart-2)' },
          { label: 'Failed', value: stats.issues.failed, color: 'var(--chart-4)' },
        ],
  );
  const donutStyle = $derived(donutGradient(statusSegments));
  const donutTotal = $derived(statusSegments.reduce((sum, segment) => sum + segment.value, 0));

  const topUsage = $derived(stats === null ? [] : stats.usageByIssue.slice(0, 10));
  const maxIssueCost = $derived(Math.max(1, ...topUsage.map((usage) => usage.costCents)));

  const durationBars = $derived(durationByAttempt(stats?.runs ?? []));
  const maxDuration = $derived(Math.max(1, ...durationBars.map((bar) => bar.averageSeconds)));

  const displayedRuns = $derived(visibleRuns(stats?.runs ?? [], sort, statusFilter));
  const historyEmptyState = $derived(runHistoryEmptyState(stats?.runs ?? [], statusFilter, days));

  const firstDate = $derived(stats?.closedPerDay[0]?.date ?? '');
  const lastDate = $derived(stats?.closedPerDay.at(-1)?.date ?? '');

  function describe(cause: unknown): string {
    return cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.';
  }

  function statusClass(status: RunHistoryEntry['status']): string {
    if (status === 'success') return 'bg-success-subtle text-success';
    if (status === 'failed') return 'bg-destructive-subtle text-destructive';
    return 'bg-muted text-foreground';
  }

  function inspectAt(event: PointerEvent): void {
    if (throughputElement === undefined || stats === null) return;
    const rect = throughputElement.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * throughput.width;
    activeIndex = nearestChartIndex(throughput.points, x);
  }

  function clearInspection(event: PointerEvent): void {
    // A tap leaves nothing hovered, but it should keep the day it selected.
    if (event.pointerType === 'touch') return;
    activeIndex = null;
  }

  function inspectKey(event: KeyboardEvent): void {
    const count = throughput.points.length;
    if (count === 0) return;
    const current = activeIndex ?? count - 1;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = Math.max(0, current - 1);
    else if (event.key === 'ArrowRight') next = Math.min(count - 1, current + 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    if (next === null) return;
    event.preventDefault();
    activeIndex = next;
  }

  // Load the Project and its stats whenever the route or range changes.
  $effect(() => {
    const id = projectId;
    if (id === undefined) return;
    const range = rangeForDays(days);
    let cancelled = false;
    loading = true;
    error = null;
    activeIndex = null;
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

<div class="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-6">
  {#if error !== null && stats === null}
    <p class="rounded-md bg-destructive-subtle px-3 py-2 text-sm text-destructive" role="alert">
      {error}
    </p>
  {:else if project === null && stats === null && !loading}
    <p class="text-sm text-muted-foreground">Project not found.</p>
  {:else if project === null || stats === null}
    <div
      class="flex flex-col gap-6"
      role="region"
      aria-label="Loading stats"
      aria-busy="true"
      data-testid="stats-loading"
    >
      <Skeleton class="h-9 w-64" />
      <Skeleton class="h-5 w-96 max-w-full" />
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {#each [0, 1, 2, 3] as tile (tile)}
          <Skeleton class="h-28 w-full rounded-xl" />
        {/each}
      </div>
      <div class="grid gap-4 lg:grid-cols-2">
        {#each [0, 1, 2, 3] as chart (chart)}
          <Skeleton class="h-64 w-full rounded-xl" />
        {/each}
      </div>
    </div>
  {:else}
    {@const currentProjectId = project.id}
    <PageHeader
      title={`${project.name} stats`}
      purpose="Issue throughput, agent reliability and spend."
      breadcrumbs={shell.breadcrumbs}
    >
      {#snippet actions()}
        <div class="flex items-center gap-1" role="group" aria-label="Date range">
          {#each RANGES as option (option)}
            <button
              type="button"
              onclick={() => (days = option)}
              aria-pressed={days === option}
              class="rounded-md border px-3 py-1.5 text-sm {days === option
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border-subtle hover:bg-muted'}"
            >
              {option} days
            </button>
          {/each}
        </div>
      {/snippet}
      {#snippet tabs()}
        <ProjectTabs projectId={currentProjectId} activeTab={shell.activeProjectTab} />
      {/snippet}
    </PageHeader>

    {#if error !== null}
      <p class="rounded-md bg-destructive-subtle px-3 py-2 text-sm text-destructive" role="alert">
        {error}
      </p>
    {/if}

    {#if loading}
      <p class="text-xs text-muted-foreground" role="status">Refreshing stats…</p>
    {/if}

    <section aria-labelledby="summary-heading">
      <h2 id="summary-heading" class="sr-only">Summary</h2>
      <dl class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div class="rounded-xl border border-border-subtle bg-card p-4">
          <dt class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Issues</dt>
          <dd class="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {stats.issues.total}
          </dd>
          <dd class="text-xs text-muted-foreground">
            {stats.issues.open} open · {stats.issues.inProgress} in progress · {stats.issues.closed}
            closed · {stats.issues.failed} failed
          </dd>
        </div>
        <div class="rounded-xl border border-border-subtle bg-card p-4">
          <dt class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Agent success rate
          </dt>
          <dd class="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {formatPercent(stats.agents.successRate)}
          </dd>
          <dd class="text-xs text-muted-foreground">
            {stats.agents.succeeded} succeeded · {stats.agents.failed} failed
          </dd>
        </div>
        <div class="rounded-xl border border-border-subtle bg-card p-4">
          <dt class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Total cost
          </dt>
          <dd class="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {formatDollars(stats.agents.totalCostCents)}
          </dd>
          <dd class="text-xs text-muted-foreground">
            {formatCoveredTokens(
              stats.agents.totalTokens,
              stats.agents.measuredRuns,
              stats.agents.modelRuns,
            )} tokens across {stats.agents.modelRuns} runs
          </dd>
        </div>
        <div class="rounded-xl border border-border-subtle bg-card p-4">
          <dt class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Average run duration
          </dt>
          <dd class="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {formatDuration(stats.agents.duration.averageSeconds)}
          </dd>
          <dd class="text-xs text-muted-foreground">
            min {formatDuration(stats.agents.duration.minSeconds)} · max
            {formatDuration(stats.agents.duration.maxSeconds)}
          </dd>
        </div>
      </dl>
    </section>

    <div class="grid min-w-0 gap-4 lg:grid-cols-2">
      <section
        class="min-w-0 rounded-xl border border-border-subtle bg-card p-4"
        aria-labelledby="velocity-heading"
      >
        <h2 id="velocity-heading" class="text-sm font-semibold text-foreground">Issues closed</h2>
        <p class="mb-2 text-xs text-muted-foreground">
          {closedTotal} closed in the last {days} days ·
          {stats.velocity.last7Days.perDay.toFixed(2)}/day over 7 days
        </p>
        {#if closedValues.length === 0 || closedTotal === 0}
          <p class="py-6 text-sm text-muted-foreground">
            No Issues were closed in the last {days} days. An Issue appears here on the day it closes.
          </p>
        {:else}
          <svg
            bind:this={throughputElement}
            viewBox={`0 0 ${throughput.width} ${throughput.height}`}
            class="h-auto w-full touch-none"
            role="slider"
            tabindex="0"
            aria-label={`Issues closed per day over the last ${days} days, ${closedTotal} ${
              closedTotal === 1 ? 'Issue' : 'Issues'
            } closed between ${firstDate} and ${lastDate}`}
            aria-valuemin={1}
            aria-valuemax={throughput.points.length}
            aria-valuenow={(activeIndex ?? 0) + 1}
            aria-valuetext={activeDay === null
              ? 'No day selected'
              : `${activeDay.date}: ${activeDay.count} ${
                  activeDay.count === 1 ? 'Issue closed' : 'Issues closed'
                }`}
            aria-describedby="throughput-instructions"
            onpointermove={inspectAt}
            onpointerdown={inspectAt}
            onpointerleave={clearInspection}
            onkeydown={inspectKey}
            onfocus={() => (activeIndex ??= 0)}
            onblur={() => (activeIndex = null)}
          >
            <defs>
              <linearGradient id="throughput-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="var(--chart-1)" stop-opacity="0.32"></stop>
                <stop offset="100%" stop-color="var(--chart-1)" stop-opacity="0.02"></stop>
              </linearGradient>
            </defs>
            <g aria-hidden="true">
              {#each throughput.yTicks as tick (tick.value)}
                <line
                  x1={throughput.plot.x}
                  y1={tick.offset}
                  x2={throughput.plot.x + throughput.plot.width}
                  y2={tick.offset}
                  stroke="var(--border-subtle)"
                  stroke-width="1"
                ></line>
                <text
                  x={throughput.plot.x - 8}
                  y={tick.offset + 5}
                  text-anchor="end"
                  font-size="16"
                  fill="var(--muted-foreground)"
                >
                  {tick.label}
                </text>
              {/each}
              {#each throughput.xTicks as tick (tick.value)}
                <text
                  x={tick.offset}
                  y={throughput.height - 4}
                  text-anchor={tick.offset === throughput.plot.x
                    ? 'start'
                    : tick.offset === throughput.plot.x + throughput.plot.width
                      ? 'end'
                      : 'middle'}
                  font-size="16"
                  fill="var(--muted-foreground)"
                >
                  {stats.closedPerDay[tick.value]?.date.slice(5) ?? ''}
                </text>
              {/each}
              <path d={throughput.areaPath} fill="url(#throughput-fill)"></path>
              <path
                d={throughput.linePath}
                fill="none"
                stroke="var(--chart-1)"
                stroke-width="2"
                stroke-linejoin="round"
                stroke-linecap="round"
              ></path>
              {#if activePoint !== null && activeDay !== null}
                <line
                  x1={activePoint.x}
                  y1={throughput.plot.y}
                  x2={activePoint.x}
                  y2={throughput.plot.y + throughput.plot.height}
                  stroke="var(--chart-1)"
                  stroke-width="1"
                  stroke-dasharray="3 3"
                ></line>
                <circle
                  cx={activePoint.x}
                  cy={activePoint.y}
                  r="4"
                  fill="var(--chart-1)"
                  stroke="var(--card)"
                  stroke-width="2"
                ></circle>
              {/if}
            </g>
          </svg>
          <p id="throughput-instructions" class="sr-only">
            Use the left and right arrow keys to inspect each day.
          </p>
          <p class="mt-1 text-sm text-muted-foreground" data-testid="throughput-status">
            {#if activeDay !== null}
              <span class="font-medium text-foreground">{activeDay.date}</span>: {activeDay.count}
              {activeDay.count === 1 ? 'Issue closed' : 'Issues closed'}
            {:else}
              Hover or focus the chart to inspect a day.
            {/if}
          </p>
          <details class="mt-2 text-sm">
            <summary class="cursor-pointer rounded-sm text-link hover:underline">
              View data table
            </summary>
            <div class="mt-2 max-h-60 overflow-auto">
              <table class="w-full text-left text-xs">
                <caption class="sr-only">
                  Issues closed per day over the last {days} days
                </caption>
                <thead class="text-muted-foreground">
                  <tr>
                    <th scope="col" class="py-1 pr-2 font-medium">Date</th>
                    <th scope="col" class="py-1 text-right font-medium">Closed</th>
                  </tr>
                </thead>
                <tbody>
                  {#each stats.closedPerDay as day (day.date)}
                    <tr class="border-t border-border-subtle">
                      <th scope="row" class="py-1 pr-2 font-normal">{day.date}</th>
                      <td class="py-1 text-right tabular-nums">{day.count}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </details>
        {/if}
      </section>

      <section
        class="min-w-0 rounded-xl border border-border-subtle bg-card p-4"
        aria-labelledby="status-heading"
      >
        <h2 id="status-heading" class="text-sm font-semibold text-foreground">Issue status</h2>
        {#if donutTotal === 0}
          <p class="py-6 text-sm text-muted-foreground">
            No Issues in this Project yet. Statuses appear here once Issues exist.
          </p>
        {:else}
          <div class="mt-3 flex flex-wrap items-center gap-6">
            <div
              class="relative h-28 w-28 shrink-0 rounded-full"
              style:background={donutStyle}
              role="img"
              aria-label={`Issue status breakdown: ${statusSegments
                .map((segment) => `${segment.value} ${segment.label.toLowerCase()}`)
                .join(', ')}`}
            >
              <div
                class="absolute inset-4 flex flex-col items-center justify-center rounded-full bg-card"
                aria-hidden="true"
              >
                <span class="text-lg font-semibold tabular-nums">{donutTotal}</span>
                <span class="text-xs text-muted-foreground">issues</span>
              </div>
            </div>
            <ul class="min-w-0 flex-1 space-y-1 text-sm">
              {#each statusSegments as segment (segment.label)}
                <li class="flex items-center gap-2">
                  <span
                    class="h-2.5 w-2.5 shrink-0 rounded-full"
                    style:background={segment.color}
                    aria-hidden="true"
                  ></span>
                  <span class="min-w-0 flex-1 truncate text-muted-foreground">{segment.label}</span>
                  <span class="tabular-nums font-medium">{segment.value}</span>
                  <span class="w-10 text-right text-xs tabular-nums text-muted-foreground">
                    {formatPercent(segment.value / donutTotal)}
                  </span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      </section>

      <section
        class="min-w-0 rounded-xl border border-border-subtle bg-card p-4"
        aria-labelledby="cost-heading"
      >
        <h2 id="cost-heading" class="text-sm font-semibold text-foreground">
          Cost and tokens per issue
        </h2>
        {#if topUsage.length === 0}
          <p class="py-6 text-sm text-muted-foreground">
            No agent spend or token usage in the last {days} days. Runs that report cost appear here.
          </p>
        {:else}
          <p class="mt-1 text-xs text-muted-foreground">
            Bars compare each Issue with the most expensive one, {formatDollars(
              topUsage[0].costCents,
            )}.
          </p>
          <ul class="mt-3 space-y-3 text-sm">
            {#each topUsage as usage (usage.issueId)}
              <li class="min-w-0">
                <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span class="min-w-0 break-words text-foreground">{usage.title}</span>
                  <span class="shrink-0 tabular-nums text-muted-foreground">
                    {formatDollars(usage.costCents)} ·
                    {formatCoveredTokens(usage.tokens, usage.measuredRuns, usage.modelRuns)} tokens
                  </span>
                </div>
                <div class="mt-1 h-2 w-full rounded-full bg-muted" aria-hidden="true">
                  <div
                    class="h-2 rounded-full bg-chart-1"
                    style:width={`${(usage.costCents / maxIssueCost) * 100}%`}
                  ></div>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section
        class="min-w-0 rounded-xl border border-border-subtle bg-card p-4"
        aria-labelledby="duration-heading"
      >
        <h2 id="duration-heading" class="text-sm font-semibold text-foreground">
          Run duration by attempt
        </h2>
        {#if durationBars.length === 0}
          <p class="py-6 text-sm text-muted-foreground">
            No completed agent runs in the last {days} days. Durations appear here once a run finishes.
          </p>
        {:else}
          <p class="mt-1 text-xs text-muted-foreground">
            Average duration of completed runs, grouped by attempt number.
          </p>
          <div class="mt-3 flex h-36 items-end gap-2 sm:gap-4">
            {#each durationBars as bar (bar.attemptNumber)}
              <div class="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
                <span class="text-xs tabular-nums">{formatDuration(bar.averageSeconds)}</span>
                <div
                  class="w-full rounded-t bg-chart-1"
                  style:height={`${(bar.averageSeconds / maxDuration) * 100}%`}
                  aria-hidden="true"
                ></div>
                <span class="text-center text-xs text-muted-foreground">
                  #{bar.attemptNumber}
                  <span class="block">{bar.runs} {bar.runs === 1 ? 'run' : 'runs'}</span>
                </span>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    </div>

    <section
      class="min-w-0 rounded-xl border border-border-subtle bg-card"
      aria-labelledby="history-heading"
    >
      <div
        class="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle p-4"
      >
        <h2 id="history-heading" class="text-sm font-semibold text-foreground">
          Agent run history
        </h2>
        <div class="flex flex-wrap gap-2 text-sm">
          <label class="flex items-center gap-1">
            <span class="text-muted-foreground">Sort</span>
            <select
              bind:value={sort}
              aria-label="Sort runs"
              class="rounded-md border border-border-subtle px-2 py-1"
            >
              <option value="newest">Newest</option>
              <option value="cost">Cost</option>
              <option value="duration">Duration</option>
            </select>
          </label>
          <label class="flex items-center gap-1">
            <span class="text-muted-foreground">Status</span>
            <select
              bind:value={statusFilter}
              aria-label="Filter by status"
              class="rounded-md border border-border-subtle px-2 py-1"
            >
              {#each STATUS_FILTERS as option (option)}
                <option value={option}>{option === 'all' ? 'All' : option}</option>
              {/each}
            </select>
          </label>
        </div>
      </div>
      {#if displayedRuns.length === 0}
        <div class="p-4" data-testid="run-history-empty">
          <p class="text-sm font-medium text-foreground">{historyEmptyState.title}</p>
          <p class="mt-1 text-sm text-muted-foreground">{historyEmptyState.hint}</p>
          {#if statusFilter !== 'all' && stats.runs.length > 0}
            <button
              type="button"
              onclick={() => (statusFilter = 'all')}
              class="mt-3 rounded-md border border-border-subtle px-3 py-1.5 text-sm hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              Clear status filter
            </button>
          {/if}
        </div>
      {:else}
        <ul class="divide-y divide-border-subtle min-[720px]:hidden" data-testid="run-cards">
          {#each displayedRuns as run (run.id)}
            <li class="p-4" data-testid="run-card">
              <div class="flex flex-wrap items-start justify-between gap-2">
                <h3 class="min-w-0 break-words text-sm font-medium text-foreground">
                  {run.issueTitle}
                </h3>
                <span class="shrink-0 rounded-full px-2 py-0.5 text-xs {statusClass(run.status)}">
                  {run.status}
                </span>
              </div>
              <dl class="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div>
                  <dt class="text-xs text-muted-foreground">Attempt</dt>
                  <dd class="tabular-nums">{run.attemptNumber}</dd>
                </div>
                <div>
                  <dt class="text-xs text-muted-foreground">Duration</dt>
                  <dd class="tabular-nums">{formatDuration(run.durationSeconds)}</dd>
                </div>
                <div>
                  <dt class="text-xs text-muted-foreground">Cost</dt>
                  <dd class="tabular-nums">{formatDollars(run.costCents)}</dd>
                </div>
                <div>
                  <dt class="text-xs text-muted-foreground">Tokens</dt>
                  <dd class="tabular-nums">{compactTokens(run.tokens)}</dd>
                </div>
                <div>
                  <dt class="text-xs text-muted-foreground">PR</dt>
                  <dd>
                    {#if run.prUrl !== null}
                      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
                      <a href={run.prUrl} target="_blank" rel="noreferrer" class="hover:underline">
                        Open PR
                      </a>
                    {:else}
                      —
                    {/if}
                  </dd>
                </div>
                <div>
                  <dt class="text-xs text-muted-foreground">Started</dt>
                  <dd class="text-muted-foreground">
                    <time datetime={run.createdAt}>{run.createdAt.slice(0, 10)}</time>
                  </dd>
                </div>
              </dl>
            </li>
          {/each}
        </ul>
        <div class="hidden overflow-x-auto min-[720px]:block" data-testid="run-table">
          <table class="w-full text-left text-sm">
            <thead class="bg-surface text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th class="px-4 py-2 font-medium">Issue</th>
                <th class="px-4 py-2 font-medium">Attempt</th>
                <th class="px-4 py-2 font-medium">Status</th>
                <th class="px-4 py-2 font-medium">Duration</th>
                <th class="px-4 py-2 font-medium">Cost</th>
                <th class="px-4 py-2 font-medium">Tokens</th>
                <th class="px-4 py-2 font-medium">PR</th>
                <th class="px-4 py-2 font-medium">Started</th>
              </tr>
            </thead>
            <tbody>
              {#each displayedRuns as run (run.id)}
                <tr class="border-t border-border-subtle">
                  <td class="px-4 py-2">{run.issueTitle}</td>
                  <td class="px-4 py-2 tabular-nums">{run.attemptNumber}</td>
                  <td class="px-4 py-2">
                    <span class="rounded-full px-2 py-0.5 text-xs {statusClass(run.status)}">
                      {run.status}
                    </span>
                  </td>
                  <td class="px-4 py-2 tabular-nums">{formatDuration(run.durationSeconds)}</td>
                  <td class="px-4 py-2 tabular-nums">{formatDollars(run.costCents)}</td>
                  <td class="px-4 py-2 tabular-nums">{compactTokens(run.tokens)}</td>
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
                  <td class="px-4 py-2 text-muted-foreground">
                    <time datetime={run.createdAt}>{run.createdAt.slice(0, 10)}</time>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  {/if}
</div>
