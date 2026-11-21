<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ArrowUpDown, SlidersHorizontal, X } from '@lucide/svelte';
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import type { AgentRun } from '@yaaabk/agents';
  import type { Issue, IssueGraph, IssueLabel } from '@yaaabk/issues';
  import type { Plan } from '@yaaabk/plans';
  import type { Project } from '@yaaabk/projects';
  import {
    ApiError,
    deleteIssue,
    getActivePlan,
    getIssueBudget,
    getIssueGraph,
    getProject,
    listIssues,
    listModels,
    listProjectRuns,
    spawnAgent,
    streamAgentRunLogs,
    updateIssue,
    type IssueBudget,
    type ModelCatalogueView,
  } from '#lib/api.js';
  import {
    compactTokens,
    formatTokens,
    issueTokenSummary,
    runLabel,
    runTokenTotal,
  } from '#lib/agent-run.js';
  import Markdown from '#lib/markdown.svelte';
  import { isAtBottom } from '#lib/scroll.js';
  import PageHeader from '#lib/components/page-header.svelte';
  import ProjectTabs from '#lib/components/project-tabs.svelte';
  import { Badge } from '#lib/components/ui/badge/index.js';
  import { Button } from '#lib/components/ui/button/index.js';
  import { Input } from '#lib/components/ui/input/index.js';
  import { Sheet } from '#lib/components/ui/sheet/index.js';
  import { Skeleton } from '#lib/components/ui/skeleton/index.js';
  import { dollarsToCents, validateBudgetDollars } from '#lib/settings-form.js';
  import { resolveShell } from '#lib/shell.js';
  import { SUMMARY_MAX_LENGTH, summaryForIssue, validateSummary } from '#lib/summary.js';
  import {
    BOARD_COLUMNS,
    BOARD_COLUMN_LABELS,
    BOARD_LABELS,
    boardView,
    budgetRemaining,
    dependencyEdges,
    issueIdFromParam,
    pullRequestNumber,
    resolveLaneTab,
    spendByIssue,
    withoutChip,
    type BoardColumn,
    type BoardFilterChip,
    type BoardLane,
    type BoardSort,
    type BoardViewFilters,
  } from '#lib/issue-board.js';

  const projectId = $derived(page.params.id);

  let project = $state<Project | null>(null);
  const shell = $derived(resolveShell(page.url.pathname, project?.name));
  let plan = $state<Plan | null>(null);
  let issues = $state<Issue[]>([]);
  let graph = $state<IssueGraph | null>(null);
  let runs = $state<AgentRun[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let busy = $state(false);

  let searchText = $state('');
  let labelFilter = $state<IssueLabel | ''>('');
  let laneFilter = $state<BoardColumn | ''>('');
  let waveFilter = $state('');
  let sort = $state<BoardSort>('wave');
  /** Whether the closed lane is shown; history is off by default. */
  let showClosed = $state(false);
  /** Whether earlier Plans are shown; the board follows the active Plan. */
  let showEarlierPlans = $state(false);
  /** Whether the Filters popover is open. */
  let filtersOpen = $state(false);
  let filterButton = $state<HTMLButtonElement | null>(null);
  let filtersPanel = $state<HTMLElement | null>(null);
  let selectedId = $state<string | null>(null);
  let editing = $state(false);
  let draftTitle = $state('');
  let draftBody = $state('');
  let draftSummary = $state('');
  let draftBudget = $state('');
  let confirmingDelete = $state(false);
  /** The current Issue's budget summary, as Cost Control computes it. */
  let issueBudget = $state<IssueBudget | null>(null);
  /** A refusal or validation failure for the open card, shown in the panel. */
  let actionError = $state<string | null>(null);
  /** The accepted Plan version to acknowledge, while the banner is on screen. */
  let acceptedNotice = $state<number | null>(null);

  let catalogue = $state<ModelCatalogueView | null>(null);
  let catalogueError = $state<string | null>(null);
  let modelChoice = $state('');
  let modelSaving = $state(false);
  let modelStatus = $state<string | null>(null);
  let modelError = $state<string | null>(null);

  /** The board container, used to position the dependency arrows. */
  let boardEl = $state<HTMLElement | null>(null);
  let boardWidth = $state(0);
  let boardHeight = $state(0);

  /** Whether the board is wide enough to show its lanes side by side. */
  let wide = $state(false);
  /** The lane a phone is looking at, projected from the same board view. */
  let activeLane = $state<BoardColumn>('ready');
  /** The lane filter already followed into {@link activeLane}. */
  let followedLaneFilter = $state<BoardColumn | ''>('');

  /** One SVG path per dependency arrow, in board-relative coordinates. */
  interface Arrow {
    key: string;
    d: string;
  }
  let arrows = $state<Arrow[]>([]);

  /** The narrowing filters, in the shape the board view model consumes. */
  const filters = $derived<BoardViewFilters>({
    text: searchText,
    ...(labelFilter === '' ? {} : { label: labelFilter }),
    ...(laneFilter === '' ? {} : { column: laneFilter }),
    ...(waveFilter === '' ? {} : { wave: waveFilter === 'null' ? null : Number(waveFilter) }),
  });

  /**
   * One model for the whole board: scope, filters, lanes, counts, chips and the
   * earlier-Plan work the active Plan is hiding. The desktop columns and the
   * later phone tabs are projections of this.
   */
  const view = $derived(
    graph === null
      ? null
      : boardView(issues, graph, {
          filters,
          sort,
          showClosed,
          showEarlierPlans,
          activePlan: plan,
        }),
  );

  /** The lanes the page draws; the closed lane only while history is on. */
  const lanes = $derived((view?.lanes ?? []).filter((lane) => lane.visible));

  /** The lane a phone renders behind its selected tab. */
  const activeLaneView = $derived(lanes.find((lane) => lane.column === activeLane) ?? null);

  const spend = $derived(spendByIssue(runs));

  /** The issue whose detail panel is open, taken from the unfiltered list. */
  const selected = $derived(issues.find((candidate) => candidate.id === selectedId) ?? null);

  /**
   * The open Issue's budget. The authoritative summary comes from Cost Control
   * and includes a key that is still open; while it loads, or when OpenRouter
   * is unreachable, the totals the runs reported stand in.
   */
  const selectedBudget = $derived.by<IssueBudget | null>(() => {
    if (selected === null) return null;
    if (issueBudget !== null && issueBudget.issueId === selected.id) return issueBudget;
    const spentCents = spend.get(selected.id) ?? 0;
    const remainingCents = budgetRemaining(selected, spentCents);
    return {
      issueId: selected.id,
      budgetCents: selected.budgetCents,
      spentCents,
      remainingCents,
      keyOpen: false,
      exhausted: remainingCents <= 0,
    };
  });

  /** Formats cents as the dollars the Developer reads everywhere else. */
  function usd(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
  }

  /** Loads the open Issue's budget; a failure leaves the run totals in place. */
  async function loadBudget(issueId: string): Promise<void> {
    if (projectId === undefined) return;
    try {
      const next = await getIssueBudget(projectId, issueId);
      if (selectedId === issueId) issueBudget = next;
    } catch {
      if (selectedId === issueId) issueBudget = null;
    }
  }

  /** The model an issue with no override of its own runs on. */
  const effectiveDefault = $derived(
    project?.agentModel ?? catalogue?.defaultModel ?? 'the environment default',
  );

  /** The runs for the open issue, oldest attempt first. */
  const selectedRuns = $derived(
    runs
      .filter((run) => run.issueId === selectedId)
      .slice()
      .sort((a, b) => a.attemptNumber - b.attemptNumber),
  );

  /** The open Issue's measured token usage across its model runs. */
  const tokenSummary = $derived(issueTokenSummary(selectedRuns));

  /** The total shown in the drawer, marked partial when a run is unmeasured. */
  const tokenTotalLabel = $derived(
    tokenSummary.total === null
      ? '—'
      : `${tokenSummary.partial ? '≥ ' : ''}${formatTokens(tokenSummary.total)}`,
  );

  /** The in/out/cached split, or `null` when nothing was measured. */
  const tokenBreakdownLabel = $derived(
    tokenSummary.breakdown === null
      ? null
      : `in ${formatTokens(tokenSummary.breakdown.input)} · out ${formatTokens(tokenSummary.breakdown.output)} · cached ${formatTokens(tokenSummary.breakdown.cached)}`,
  );

  /** Applies a filter state back to the toolbar, field by field. */
  function applyFilters(next: BoardViewFilters): void {
    searchText = next.text ?? '';
    labelFilter = next.label ?? '';
    laneFilter = next.column ?? '';
    waveFilter = next.wave === undefined ? '' : next.wave === null ? 'null' : String(next.wave);
  }

  /** Removes one chip and leaves every other filter exactly as it was. */
  function removeChip(chip: BoardFilterChip): void {
    applyFilters(withoutChip(filters, chip));
  }

  function clearFilters(): void {
    applyFilters({});
  }

  async function openFilters(): Promise<void> {
    filtersOpen = true;
    await tick();
    filtersPanel?.querySelector<HTMLElement>('select, input')?.focus();
  }

  async function closeFilters(restoreFocus = true): Promise<void> {
    filtersOpen = false;
    if (!restoreFocus) return;
    await tick();
    filterButton?.focus();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && filtersOpen) {
      event.preventDefault();
      void closeFilters();
    }
  }

  /** Schedules a fresh agent attempt, then reloads the run history. */
  async function rerun(issueId: string): Promise<void> {
    if (projectId === undefined || busy) return;
    busy = true;
    error = null;
    actionError = null;
    try {
      await spawnAgent(projectId, issueId);
      runs = await listProjectRuns(projectId);
      await loadBudget(issueId);
    } catch (cause) {
      // Keep the backend's refusal in the panel: it names the amounts and what
      // the Developer must change, unlike a generic failure banner.
      actionError = describe(cause);
    } finally {
      busy = false;
    }
  }

  /** Opens the detail panel for a card, resetting any in-progress edit. */
  function open(issueId: string): void {
    selectedId = issueId;
    editing = false;
    confirmingDelete = false;
    issueBudget = null;
    actionError = null;
    modelChoice = issues.find((candidate) => candidate.id === issueId)?.agentModel ?? '';
    modelStatus = null;
    modelError = null;
    void loadBudget(issueId);
  }

  /** Saves the issue-level model override; the empty option inherits. */
  async function saveModel(): Promise<void> {
    if (projectId === undefined || selected === null || modelSaving) return;
    const previous = selected.agentModel;
    modelSaving = true;
    modelStatus = null;
    modelError = null;
    try {
      const updated = await updateIssue(projectId, selected.id, {
        agentModel: modelChoice.trim() === '' ? null : modelChoice.trim(),
      });
      issues = issues.map((issue) => (issue.id === updated.id ? updated : issue));
      modelChoice = updated.agentModel ?? '';
      modelStatus = 'Saved';
    } catch (cause) {
      modelChoice = previous ?? '';
      modelError = describe(cause);
    } finally {
      modelSaving = false;
    }
  }

  function startEdit(issue: Issue): void {
    editing = true;
    confirmingDelete = false;
    actionError = null;
    draftTitle = issue.title;
    draftBody = issue.body;
    draftSummary = summaryForIssue(issue);
    draftBudget = (issue.budgetCents / 100).toFixed(2);
  }

  /** Saves the edited title, body and budget, then reloads the graph (titles moved). */
  async function saveEdit(): Promise<void> {
    if (projectId === undefined || selected === null || busy) return;
    const summary = validateSummary(draftSummary);
    if ('error' in summary) {
      actionError = summary.error;
      return;
    }
    const budgetReason = validateBudgetDollars(draftBudget);
    if (budgetReason !== undefined) {
      actionError = budgetReason;
      return;
    }
    const budgetCents = dollarsToCents(draftBudget);
    if (budgetCents === undefined) {
      actionError = 'Enter the budget in dollars, e.g. 0.50';
      return;
    }
    busy = true;
    error = null;
    actionError = null;
    try {
      const updated = await updateIssue(projectId, selected.id, {
        title: draftTitle.trim(),
        body: draftBody,
        summary: summary.value,
        budgetCents,
      });
      issues = issues.map((issue) => (issue.id === updated.id ? updated : issue));
      graph = await getIssueGraph(projectId);
      await loadBudget(updated.id);
      editing = false;
    } catch (cause) {
      actionError = describe(cause);
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
      close();
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
    // Below `md` the lanes stack, so an arrow between them would point across
    // a break rather than between side-by-side columns.
    if (boardEl === null || graph === null || !window.matchMedia('(min-width: 768px)').matches) {
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

      const fromX = from.left - base.left;
      const fromY = from.top - base.top;
      const toX = to.left - base.left;
      const toY = to.top - base.top;
      const sideBySide = Math.abs(toX - fromX) >= 8;

      // Anchor on the facing edges so a line never runs through a card. Cards
      // in different lanes join side to side; cards stacked in one lane join
      // bottom to top.
      const x1 = sideBySide ? (toX > fromX ? fromX + from.width : fromX) : fromX + from.width / 2;
      const y1 = sideBySide ? fromY + from.height / 2 : toY > fromY ? fromY + from.height : fromY;
      const x2 = sideBySide ? (toX > fromX ? toX : toX + to.width) : toX + to.width / 2;
      const y2 = sideBySide ? toY + to.height / 2 : toY > fromY ? toY : toY + to.height;

      const reach = sideBySide
        ? Math.min(48, Math.max(12, Math.abs(x2 - x1) / 2))
        : Math.min(48, Math.max(12, Math.abs(y2 - y1) / 2));
      const d = sideBySide
        ? `M ${x1} ${y1} C ${x1 + (x2 > x1 ? reach : -reach)} ${y1}, ${x2 - (x2 > x1 ? reach : -reach)} ${y2}, ${x2} ${y2}`
        : `M ${x1} ${y1} C ${x1} ${y1 + (y2 > y1 ? reach : -reach)}, ${x2} ${y2 - (y2 > y1 ? reach : -reach)}, ${x2} ${y2}`;

      return [{ key: `${edge.from}->${edge.to}`, d }];
    });
  }

  function describe(cause: unknown): string {
    return cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.';
  }

  /**
   * Drops query parameters from the URL without navigating, so a reload does
   * not repeat the banner or reopen a closed drawer.
   */
  function clearParams(...names: string[]): void {
    const url = new URL(page.url.href);
    let changed = false;
    for (const name of names) {
      if (url.searchParams.has(name)) {
        url.searchParams.delete(name);
        changed = true;
      }
    }
    if (!changed) return;
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- only the query string changes
    void goto(url, { replace: true, shallow: true, reset: false });
  }

  /** Closes the detail panel and drops the deep link that opened it. */
  function close(): void {
    if (selectedId === null) return;
    selectedId = null;
    clearParams('issue');
  }

  /** Moves between phone lane tabs with the arrow, Home and End keys. */
  function handleLaneTabKeydown(event: KeyboardEvent, index: number): void {
    const last = lanes.length - 1;
    if (last < 0) return;
    let next: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = index === last ? 0 : index + 1;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = index === 0 ? last : index - 1;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = last;
    } else {
      return;
    }
    event.preventDefault();
    const column = lanes[next]?.column;
    if (column === undefined) return;
    activeLane = column;
    void tick().then(() => document.getElementById(`lane-tab-${column}`)?.focus());
  }

  // Keep the phone's lane tab valid when filters hide a lane or the Developer
  // picks one in the Filters popover. Every other change preserves the tab.
  $effect(() => {
    const current = untrack(() => activeLane);
    const next = resolveLaneTab(lanes, current);
    if (next !== current) activeLane = next;
  });

  $effect(() => {
    const filter = laneFilter;
    if (filter === '') {
      followedLaneFilter = '';
      return;
    }
    if (filter === followedLaneFilter || !lanes.some((lane) => lane.column === filter)) return;
    followedLaneFilter = filter;
    activeLane = filter;
  });

  // Re-measure after anything that can move a card: the visible set or layout.
  $effect(() => {
    void view;
    void selectedId;
    void boardEl;
    void graph;
    const handle = requestAnimationFrame(() => measure());
    return () => cancelAnimationFrame(handle);
  });

  onMount(() => {
    const wideQuery = window.matchMedia('(min-width: 768px)');
    const updateWide = () => {
      wide = wideQuery.matches;
    };
    updateWide();
    wideQuery.addEventListener('change', updateWide);
    const handler = () => measure();
    window.addEventListener('resize', handler);
    return () => {
      wideQuery.removeEventListener('change', updateWide);
      window.removeEventListener('resize', handler);
    };
  });

  // Load the project and everything the board renders once the route is known.
  $effect(() => {
    const id = projectId;
    if (id === undefined) return;
    // Read without subscribing: clearing the parameter must not reload the board.
    const acceptedParam = untrack(() => page.url.searchParams.get('accepted'));
    const issueParam = untrack(() => page.url.searchParams.get('issue'));
    let cancelled = false;
    loading = true;
    error = null;
    Promise.all([
      getProject(id),
      listIssues(id),
      getIssueGraph(id),
      listProjectRuns(id),
      getActivePlan(id),
    ])
      .then(([nextProject, nextIssues, nextGraph, nextRuns, nextPlan]) => {
        if (cancelled) return;
        project = nextProject;
        issues = nextIssues;
        graph = nextGraph;
        runs = nextRuns;
        plan = nextPlan;
        if (
          acceptedParam !== null &&
          nextPlan !== null &&
          nextPlan.isActive &&
          nextPlan.acceptedAt !== null &&
          String(nextPlan.version) === acceptedParam
        ) {
          acceptedNotice = nextPlan.version;
        }
        const requestedIssue = issueIdFromParam(issueParam, nextIssues);
        if (requestedIssue !== null) open(requestedIssue);
        const staleParams: string[] = [];
        if (acceptedParam !== null) staleParams.push('accepted');
        if (issueParam !== null && requestedIssue === null) staleParams.push('issue');
        clearParams(...staleParams);
      })
      .catch((cause) => {
        if (!cancelled) error = describe(cause);
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });
    listModels()
      .then((models) => {
        if (!cancelled) catalogue = models;
      })
      .catch(() => {
        if (!cancelled) catalogueError = 'Could not load the model catalogue.';
      });
    return () => {
      cancelled = true;
    };
  });

  /** The newest attempt for the open issue that is still in flight. */
  const activeRun = $derived(selectedRuns.filter((run) => run.status === 'running').at(-1) ?? null);

  /** Output received for the run being watched, appended as it arrives. */
  let liveRunId = $state<string | null>(null);
  let liveLog = $state('');
  let liveError = $state<string | null>(null);
  /** The live output box, scrolled only while the Developer is following it. */
  let liveLogEl = $state<HTMLElement | null>(null);
  /** Whether new output scrolls into view; paused while the reader is scrolled up. */
  let following = $state(true);

  // Plain locals, outside the reactive graph: an effect that both reads and
  // writes this would tear the subscription down on its own re-run.
  let watchedRunId: string | null = null;
  let watchController: AbortController | null = null;

  /** How many times to re-open a dropped log stream before showing the error. */
  const LOG_STREAM_RETRIES = 5;

  /** Subscribes to a running attempt's log and starts or stops cleanly. */
  function watchRun(run: AgentRun | null): void {
    watchController?.abort();
    watchController = null;
    watchedRunId = run?.id ?? null;
    liveRunId = run?.id ?? null;
    liveLog = '';
    liveError = null;
    // Opening the drawer, or moving to another run, starts at the newest line
    // rather than inheriting a pause from the output that was on screen before.
    following = true;
    const project = projectId;
    if (run === null || project === undefined) return;

    const controller = new AbortController();
    watchController = controller;
    const refresh = () => {
      void listProjectRuns(project)
        .then((next) => {
          runs = next;
        })
        .catch(() => undefined);
    };
    void (async () => {
      for (let attempt = 0; !controller.signal.aborted; attempt += 1) {
        try {
          await streamAgentRunLogs(
            project,
            run.id,
            (chunk) => {
              if (watchedRunId === run.id) liveLog += chunk;
            },
            controller.signal,
          );
          return;
        } catch (cause) {
          if (controller.signal.aborted) return;
          if (attempt >= LOG_STREAM_RETRIES - 1) {
            liveError = describe(cause);
            return;
          }
          // A long silence (a model thinking, a proxy idle timeout) can drop
          // the stream while the Job keeps writing. The endpoint replays the
          // Pod log from the start, so clear what is shown and re-open rather
          // than leave the panel frozen.
          liveLog = '';
          await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
        }
      }
    })().finally(() => {
      // After an abort (issue switched, panel closed) the list is refreshed
      // by whoever caused it; a stale fetch here would race that.
      if (!controller.signal.aborted) refresh();
    });
  }

  // Follow the running attempt for whichever issue is open; switching issues or
  // closing the panel aborts the stream instead of holding a Job's log open.
  $effect(() => {
    const run = activeRun;
    if ((run?.id ?? null) !== watchedRunId) watchRun(run);
  });

  // Scroll the newest line into view after Svelte has written the chunk, but
  // only while the Developer is following. Output that arrives while they are
  // reading back through the log leaves their place alone.
  $effect(() => {
    const element = liveLogEl;
    void liveLog;
    if (element === null || !following || liveRunId === null) return;
    element.scrollTop = element.scrollHeight;
  });

  /** Pauses following as soon as the reader leaves the bottom. */
  function handleLiveLogScroll(): void {
    if (liveLogEl === null) return;
    following = isAtBottom(liveLogEl);
  }

  /** Returns to the newest output and resumes following it. */
  function jumpToLatest(): void {
    if (liveLogEl === null) return;
    liveLogEl.scrollTop = liveLogEl.scrollHeight;
    following = true;
  }

  onDestroy(() => {
    watchController?.abort();
  });

  // Poll while any attempt is in flight so its status — and the stored log a
  // finished attempt leaves behind — show up without a manual refresh.
  $effect(() => {
    const id = projectId;
    if (id === undefined) return;
    if (!runs.some((run) => run.status === 'queued' || run.status === 'running')) return;
    const timer = setInterval(() => {
      void listProjectRuns(id)
        .then((next) => {
          runs = next;
        })
        .catch(() => undefined);
    }, 5_000);
    return () => clearInterval(timer);
  });
</script>

<svelte:head>
  <title>{project ? `${project.name} · Issues` : 'Issues'} · YAAABK</title>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

{#if loading}
  <div class="flex flex-col gap-4" aria-busy="true" aria-label="Loading the issue board">
    <Skeleton class="h-9 w-64" />
    <Skeleton class="h-5 w-96 max-w-full" />
    <Skeleton class="h-14 w-full rounded-xl" />
    <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {#each [0, 1, 2, 3] as lane (lane)}
        <Skeleton class="h-72 w-full rounded-xl" />
      {/each}
    </div>
  </div>
{:else if error !== null && project === null}
  <p class="rounded-md bg-destructive-subtle px-3 py-2 text-sm text-destructive" role="alert">
    {error}
  </p>
{:else if project !== null}
  {@const currentProjectId = project.id}
  <PageHeader
    title="Issue board"
    purpose={`The work for ${project.name}, grouped by lane and ordered by wave.`}
    breadcrumbs={shell.breadcrumbs}
  >
    {#snippet tabs()}
      <ProjectTabs projectId={currentProjectId} activeTab={shell.activeProjectTab} />
    {/snippet}
  </PageHeader>

  <p class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
    {#if plan !== null && !showEarlierPlans}
      Showing <span class="font-medium text-foreground">Plan v{plan.version}</span>.
    {/if}
    {#if plan !== null && plan.isActive && plan.acceptedAt === null}
      <a
        href={resolve('/projects/[id]/issues/review', { id: project.id })}
        class="inline-block rounded-full bg-warning-subtle px-2 py-0.5 text-xs font-medium text-warning hover:underline"
      >
        {#if showEarlierPlans}Plan v{plan.version} not accepted{:else}not accepted{/if}
      </a>
    {/if}
  </p>

  {#if error !== null}
    <p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>
  {/if}

  {#if acceptedNotice !== null}
    <div
      class="flex flex-wrap items-center justify-between gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
      role="status"
    >
      <p>Plan v{acceptedNotice} accepted and synced to GitHub</p>
      <button
        type="button"
        onclick={() => (acceptedNotice = null)}
        class="rounded-md px-2 py-0.5 text-xs font-medium hover:bg-emerald-100"
      >
        Dismiss
      </button>
    </div>
  {/if}

  {#if view !== null && view.earlierWork.length > 0}
    <p class="rounded-lg bg-warning-subtle px-3 py-2 text-sm text-warning" role="status">
      {view.earlierWork.length} open
      {view.earlierWork.length === 1 ? 'issue belongs' : 'issues belong'} to an earlier Plan and
      {view.earlierWork.length === 1 ? 'is' : 'are'} still being worked.
    </p>
  {/if}

  <div
    class="sticky top-14 z-20 -mx-2 flex flex-col gap-2 rounded-xl border border-border-subtle bg-background/95 px-2 py-2 shadow-elevation-1 backdrop-blur lg:top-0"
    data-testid="board-toolbar"
  >
    <div class="flex flex-wrap items-center gap-2">
      <Input
        type="search"
        aria-label="Search issues"
        bind:value={searchText}
        placeholder="Search issues"
        class="h-9 flex-1 basis-full sm:max-w-sm sm:basis-auto"
      />

      <div class="relative">
        <Button
          variant="outline"
          size="lg"
          bind:ref={filterButton}
          aria-expanded={filtersOpen}
          aria-controls="board-filters"
          onclick={() => (filtersOpen ? void closeFilters(false) : void openFilters())}
        >
          <SlidersHorizontal aria-hidden="true" />
          Filters
          {#if view !== null && view.chips.length > 0}
            <Badge variant="secondary">{view.chips.length}</Badge>
          {/if}
        </Button>

        {#if filtersOpen}
          <button
            type="button"
            tabindex="-1"
            aria-label="Close filters"
            class="fixed inset-0 z-20 cursor-default"
            onclick={() => void closeFilters(false)}
          ></button>
          <div
            id="board-filters"
            bind:this={filtersPanel}
            role="group"
            aria-label="Filters"
            class="absolute left-0 z-30 mt-2 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-xl border border-border-subtle bg-popover p-3 shadow-elevation-overlay max-md:fixed max-md:left-2 max-md:right-2 max-md:mt-2 max-md:max-h-[calc(100dvh-7rem)] max-md:w-auto max-md:max-w-none max-md:overflow-y-auto"
          >
            <label class="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Label
              <select
                aria-label="Filter by label"
                bind:value={labelFilter}
                class="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <option value="">All labels</option>
                {#each BOARD_LABELS as label (label)}
                  <option value={label}>{label}</option>
                {/each}
              </select>
            </label>

            <label class="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Lane
              <select
                aria-label="Filter by lane"
                bind:value={laneFilter}
                class="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <option value="">All lanes</option>
                {#each BOARD_COLUMNS as column (column)}
                  <option value={column}>{BOARD_COLUMN_LABELS[column]}</option>
                {/each}
              </select>
            </label>

            <label class="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Wave
              <select
                aria-label="Filter by wave"
                bind:value={waveFilter}
                class="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <option value="">All waves</option>
                {#each view?.waves ?? [] as wave (wave)}
                  <option value={String(wave)}>Wave {wave}</option>
                {/each}
                {#if view?.hasUnordered}
                  <option value="null">Unordered</option>
                {/if}
              </select>
            </label>

            <label class="flex min-h-11 items-center gap-2 text-sm text-foreground">
              <input type="checkbox" aria-label="Show closed issues" bind:checked={showClosed} />
              Show closed
            </label>

            <label class="flex min-h-11 items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                aria-label="Show earlier plans"
                bind:checked={showEarlierPlans}
                disabled={plan === null}
              />
              Show earlier plans
            </label>
          </div>
        {/if}
      </div>

      <div class="flex items-center gap-1.5">
        <ArrowUpDown class="size-4 text-muted-foreground" aria-hidden="true" />
        <select
          aria-label="Sort issues"
          bind:value={sort}
          class="h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <option value="wave">Wave</option>
          <option value="created">Creation date</option>
          <option value="title">Title</option>
        </select>
      </div>

      <p class="ml-auto text-sm text-muted-foreground" data-testid="board-count" aria-live="polite">
        Showing {view?.count ?? 0} of {view?.total ?? 0} issues
      </p>
    </div>

    {#if view !== null && view.chips.length > 0}
      <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Active filters">
        {#each view.chips as chip (chip.kind)}
          <span
            class="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground"
          >
            {chip.label}
            <button
              type="button"
              aria-label={`Remove filter ${chip.label}`}
              onclick={() => removeChip(chip)}
              class="rounded-full p-0.5 hover:bg-secondary-foreground/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <X class="size-3" aria-hidden="true" />
            </button>
          </span>
        {/each}
        <Button variant="ghost" size="xs" onclick={clearFilters}>Clear all</Button>
      </div>
    {/if}
  </div>

  {#snippet laneSection(lane: BoardLane)}
    <section
      class="flex min-h-40 flex-col gap-3 rounded-xl border border-border-subtle bg-surface p-3"
      aria-labelledby={`lane-${lane.column}-heading`}
    >
      <h2
        id={`lane-${lane.column}-heading`}
        class="flex items-center justify-between gap-2 text-sm font-semibold text-foreground"
      >
        {lane.label}
        <Badge variant="outline" class="bg-background">{lane.count}</Badge>
      </h2>

      {#if lane.items.length === 0}
        <p
          class="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border-subtle px-3 py-6 text-center text-xs text-muted-foreground"
        >
          {view !== null && view.total === 0
            ? 'No Issues in this Plan yet.'
            : 'No Issues match the current filters.'}
        </p>
      {:else}
        <ul class="flex flex-col gap-2">
          {#each lane.items as item (item.issue.id)}
            <li>
              <button
                type="button"
                data-issue-id={item.issue.id}
                onclick={() => open(item.issue.id)}
                class="relative z-10 flex w-full flex-col gap-2 rounded-lg border border-border-subtle bg-card p-3 text-left text-sm shadow-elevation-1 transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <span class="flex flex-wrap items-center gap-2">
                  <span class="font-medium text-foreground">{item.issue.title}</span>
                  <span class="rounded-full px-2 py-0.5 text-xs {labelClass[item.issue.label]}">
                    {item.issue.label}
                  </span>
                </span>
                <span class="line-clamp-2 text-xs text-muted-foreground">
                  {summaryForIssue(item.issue)}
                </span>
                <span class="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span>{item.wave === null ? 'Unordered' : `Wave ${item.wave}`}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {(budgetRemaining(item.issue, spend.get(item.issue.id) ?? 0) / 100).toFixed(2)} left
                  </span>
                </span>
                {#if item.issue.dependsOn.length > 0}
                  <span class="text-xs text-muted-foreground">
                    Depends on: {item.issue.dependsOn.join(', ')}
                  </span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/snippet}

  <div
    class="relative"
    bind:this={boardEl}
    bind:clientWidth={boardWidth}
    bind:clientHeight={boardHeight}
  >
    {#if wide}
      <div
        class="grid items-start gap-4 md:grid-cols-2 {lanes.length > 4
          ? 'xl:grid-cols-5'
          : 'xl:grid-cols-4'}"
      >
        {#each lanes as lane (lane.column)}
          {@render laneSection(lane)}
        {/each}
      </div>
    {:else}
      <div class="flex flex-col gap-3">
        <div
          class="grid grid-cols-2 gap-2"
          role="tablist"
          aria-label="Issue lanes"
          data-testid="lane-tabs"
        >
          {#each lanes as lane, index (lane.column)}
            <button
              type="button"
              role="tab"
              id={`lane-tab-${lane.column}`}
              aria-selected={activeLane === lane.column}
              aria-controls={`lane-panel-${lane.column}`}
              tabindex={activeLane === lane.column ? 0 : -1}
              onclick={() => (activeLane = lane.column)}
              onkeydown={(event) => handleLaneTabKeydown(event, index)}
              class="flex min-h-11 w-full items-center justify-between gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none {activeLane ===
              lane.column
                ? 'border-foreground bg-foreground text-background'
                : 'border-border-subtle bg-surface text-muted-foreground hover:text-foreground'}"
            >
              {lane.label}
              <Badge variant="outline" class="bg-background">{lane.count}</Badge>
            </button>
          {/each}
        </div>

        {#if activeLaneView !== null}
          <div
            role="tabpanel"
            id={`lane-panel-${activeLaneView.column}`}
            aria-labelledby={`lane-tab-${activeLaneView.column}`}
          >
            {@render laneSection(activeLaneView)}
          </div>
        {/if}
      </div>
    {/if}

    <svg
      class="pointer-events-none absolute inset-0 z-0 hidden text-muted-foreground md:block"
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

  <Sheet
    open={selected !== null}
    onOpenChange={(next) => {
      if (!next) close();
    }}
    title={selected?.title ?? 'Issue details'}
    class="gap-4"
  >
    {#if selected !== null}
      <span class="w-fit rounded-full px-2 py-0.5 text-xs {labelClass[selected.label]}">
        {selected.label}
      </span>

      {#if selected.githubNumber !== null}
        <p class="text-xs text-neutral-500">GitHub #{selected.githubNumber}</p>
      {/if}

      <dl class="grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt class="text-neutral-500">Attempts</dt>
          <dd>{selected.attemptCount} / {selected.maxAttempts}</dd>
        </div>
        <div>
          <dt class="text-neutral-500">Budget</dt>
          <dd>{usd(selectedBudget?.budgetCents ?? selected.budgetCents)}</dd>
        </div>
        <div>
          <dt class="text-neutral-500">Spent</dt>
          <dd>{usd(selectedBudget?.spentCents ?? spend.get(selected.id) ?? 0)}</dd>
        </div>
        <div>
          <dt class="text-neutral-500">Left</dt>
          <dd>{usd(selectedBudget?.remainingCents ?? selected.budgetCents)}</dd>
        </div>
      </dl>

      {#if selectedBudget?.exhausted}
        <p class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
          This Issue’s budget is spent. Raise it to allow another attempt.
        </p>
      {/if}

      <section aria-label="Token usage" class="space-y-1">
        <h3 class="text-sm font-semibold">Tokens</h3>
        {#if selectedRuns.length === 0}
          <p class="text-sm text-neutral-500">No agent runs yet.</p>
        {:else}
          <p class="text-sm" data-testid="issue-tokens">Total: {tokenTotalLabel}</p>
          {#if tokenBreakdownLabel !== null}
            <p class="text-xs text-neutral-500" data-testid="issue-token-breakdown">
              {tokenBreakdownLabel}
            </p>
          {/if}
          {#if tokenSummary.partial}
            <p class="text-xs text-neutral-500">Some model runs did not report token usage.</p>
          {/if}
        {/if}
      </section>

      <div class="flex flex-col gap-1">
        <label class="text-xs text-neutral-500" for="issue-agent-model">Agent model</label>
        <select
          id="issue-agent-model"
          bind:value={modelChoice}
          onchange={() => void saveModel()}
          class="rounded-md border border-neutral-300 px-2 py-1 text-sm text-neutral-900"
        >
          <option value="">Use project default ({effectiveDefault})</option>
          {#each catalogue?.models ?? [] as option (option.id)}
            <option value={option.id}>{option.name}</option>
          {/each}
          {#if modelChoice !== '' && !(catalogue?.models ?? []).some((m) => m.id === modelChoice)}
            <option value={modelChoice}>{modelChoice}</option>
          {/if}
        </select>
        <p class="text-xs text-neutral-500">
          Runs use {selected.agentModel ?? effectiveDefault}.
        </p>
        {#if modelSaving}
          <p class="text-xs text-neutral-500" role="status">Saving…</p>
        {:else if modelStatus !== null}
          <p class="text-xs text-emerald-700" role="status">{modelStatus}</p>
        {/if}
        {#if modelError !== null}
          <p class="text-xs text-red-700" role="alert">{modelError}</p>
        {/if}
        {#if catalogueError !== null}
          <p class="text-xs text-amber-700">{catalogueError}</p>
        {/if}
      </div>

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
            Summary
            <textarea
              aria-label="Issue summary"
              rows="2"
              maxlength={SUMMARY_MAX_LENGTH}
              bind:value={draftSummary}
              class="w-full rounded-md border border-neutral-300 px-2 py-1 text-sm text-neutral-900"
            ></textarea>
            <span class="text-neutral-400">
              One or two plain sentences, at most {SUMMARY_MAX_LENGTH} characters.
            </span>
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
          <label class="flex flex-col gap-1 text-xs text-neutral-500">
            Issue budget (USD)
            <input
              aria-label="Issue budget (USD)"
              inputmode="decimal"
              bind:value={draftBudget}
              class="rounded-md border border-neutral-300 px-2 py-1 text-sm text-neutral-900"
            />
            <span class="text-neutral-400">
              Between $0.01 and $5.00. Raising it lets the next attempt spend the difference.
            </span>
          </label>
        </div>
      {:else if selected.body !== ''}
        <Markdown markdown={selected.body} class="mt-1" />
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
                <span class="font-medium">{runLabel(run)}</span>
                <span class="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700">
                  {run.status}
                </span>
                {#if run.reviewVerdict != null}
                  <span
                    class="rounded-full px-2 py-0.5 text-xs {run.reviewVerdict === 'approve'
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-amber-100 text-amber-800'}"
                  >
                    {run.reviewVerdict === 'approve' ? 'approved' : 'changes requested'}
                  </span>
                {/if}
                <span class="text-xs text-neutral-500">
                  {(run.costCents / 100).toFixed(2)}
                </span>
                <span class="text-xs text-neutral-500" data-testid="run-tokens">
                  Tokens: {compactTokens(runTokenTotal(run.tokens))}
                </span>
                {#if run.reviewBody != null && run.reviewBody.trim() !== ''}
                  <Markdown
                    markdown={run.reviewBody}
                    class="mt-1 max-h-64 w-full overflow-auto rounded bg-neutral-50 p-2"
                  />
                {/if}
                {#if run.model !== null && run.model !== undefined}
                  <span class="w-full text-xs text-neutral-500">Model: {run.model}</span>
                {/if}
                {#if run.prUrl !== null}
                  <!-- eslint-disable svelte/no-navigation-without-resolve -->
                  <a href={run.prUrl} target="_blank" rel="noreferrer" class="text-xs underline">
                    PR #{pullRequestNumber(run.prUrl)}
                  </a>
                  <!-- eslint-enable svelte/no-navigation-without-resolve -->
                {/if}
                {#if run.logs !== null && run.logs.trim() !== ''}
                  <details class="w-full">
                    <summary class="cursor-pointer text-xs text-neutral-500">Logs</summary>
                    <pre
                      class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-2 text-xs text-neutral-700">{run.logs}</pre>
                  </details>
                {/if}
                {#if liveRunId === run.id}
                  <div class="w-full">
                    <div class="flex items-center justify-between gap-2">
                      <p class="text-xs text-neutral-500">Live output</p>
                      {#if !following}
                        <button
                          type="button"
                          onclick={jumpToLatest}
                          class="rounded-md border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100"
                        >
                          Jump to latest
                        </button>
                      {/if}
                    </div>
                    <pre
                      bind:this={liveLogEl}
                      onscroll={handleLiveLogScroll}
                      class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-neutral-900 p-2 text-xs text-neutral-100"
                      data-testid="live-agent-log">{liveLog === ''
                        ? 'Waiting for output…'
                        : liveLog}</pre>
                    {#if liveError !== null}
                      <p class="mt-1 text-xs text-red-700" role="alert">{liveError}</p>
                    {/if}
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      {#if actionError !== null}
        <p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {actionError}
        </p>
      {/if}

      <div class="mt-auto flex flex-wrap gap-2">
        {#if editing}
          <button
            type="button"
            onclick={() => void saveEdit()}
            disabled={busy || draftTitle.trim() === '' || draftSummary.trim() === ''}
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
    {/if}
  </Sheet>
{/if}
