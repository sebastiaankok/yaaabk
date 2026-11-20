<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import type { Issue, IssueGraph, IssueLabel } from '@yaaabk/issues';
  import type { Plan } from '@yaaabk/plans';
  import type { Project } from '@yaaabk/projects';
  import {
    ApiError,
    acceptPlan,
    getIssueGraph,
    getProject,
    listIssues,
    listPlans,
    pushIssues,
  } from '#lib/api.js';
  import { groupByWave, reviewItems, type WaveGroup } from '#lib/issue-review.js';
  import { describePush } from '#lib/issue-sync.js';
  import Markdown from '#lib/markdown.svelte';
  import {
    pendingGithubSync,
    planProgress,
    planStatusLabel,
    type PlanLifecycleStatus,
  } from '#lib/plan-lifecycle.js';
  import { summaryForIssue, summaryForPlan } from '#lib/summary.js';

  const projectId = $derived(page.params.id);

  let project = $state<Project | null>(null);
  let plans = $state<Plan[]>([]);
  let issues = $state<Issue[]>([]);
  let graph = $state<IssueGraph | null>(null);
  let selectedId = $state<string | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let confirmOpen = $state(false);
  let acceptError = $state<string | null>(null);
  let notice = $state<string | null>(null);

  const selectedPlan = $derived(plans.find((plan) => plan.id === selectedId) ?? null);

  /** Every Issue of the selected Plan, closed history included. */
  const reviewList = $derived(
    graph === null
      ? []
      : reviewItems(issues, graph, { planId: selectedId ?? undefined, includeClosed: true }),
  );

  const groups = $derived<WaveGroup[]>(groupByWave(reviewList));

  /** A previous Plan is history; only the active version can change. */
  const readOnly = $derived(selectedPlan !== null && !selectedPlan.isActive);

  /** An active, unaccepted Plan that has nothing to accept. */
  const zeroIssuePlan = $derived(
    selectedPlan !== null &&
      selectedPlan.isActive &&
      selectedPlan.acceptedAt === null &&
      reviewList.length === 0,
  );

  /** Only the active, not yet accepted Plan with at least one Issue can be accepted. */
  const canAccept = $derived(
    selectedPlan !== null &&
      selectedPlan.isActive &&
      selectedPlan.acceptedAt === null &&
      reviewList.length > 0,
  );

  const needsSync = $derived(selectedPlan !== null && pendingGithubSync(selectedPlan, issues));

  const selectedStatus = $derived(
    selectedPlan === null ? null : planProgress(selectedPlan, issues).status,
  );

  const labelClass: Record<IssueLabel, string> = {
    ready: 'bg-emerald-100 text-emerald-800',
    'refinement-needed': 'bg-amber-100 text-amber-800',
    blocked: 'bg-neutral-200 text-neutral-700',
    'needs-human': 'bg-red-100 text-red-800',
  };

  const statusClass: Record<PlanLifecycleStatus, string> = {
    'not-accepted': 'bg-neutral-100 text-neutral-600',
    'in-progress': 'bg-amber-100 text-amber-800',
    completed: 'bg-emerald-100 text-emerald-800',
  };

  function describe(cause: unknown): string {
    return cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.';
  }

  function progressOf(plan: Plan) {
    return planProgress(plan, issues);
  }

  function acceptedDate(plan: Plan): string {
    return plan.acceptedAt === null ? '' : new Date(plan.acceptedAt).toLocaleDateString();
  }

  async function refresh(id: string, preferred: string | null = selectedId): Promise<void> {
    const [nextProject, nextPlans, nextIssues, nextGraph] = await Promise.all([
      getProject(id),
      listPlans(id),
      listIssues(id),
      getIssueGraph(id),
    ]);
    project = nextProject;
    plans = nextPlans;
    issues = nextIssues;
    graph = nextGraph;

    const exists = preferred !== null && nextPlans.some((plan) => plan.id === preferred);
    selectedId = exists
      ? preferred
      : (nextPlans.find((plan) => plan.isActive)?.id ?? nextPlans[0]?.id ?? null);
  }

  // Load the project, its Plan versions and all of their Issues once the route is known.
  $effect(() => {
    const id = projectId;
    if (id === undefined) return;
    let cancelled = false;
    loading = true;
    error = null;
    acceptError = null;
    notice = null;
    confirmOpen = false;
    const requested = page.url.searchParams.get('plan');
    refresh(id, requested)
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

  function select(planId: string): void {
    selectedId = planId;
    acceptError = null;
    notice = null;
  }

  async function accept(): Promise<void> {
    if (projectId === undefined || selectedPlan === null || busy) return;
    error = null;
    acceptError = null;
    busy = true;
    try {
      const accepted = await acceptPlan(projectId, selectedPlan.id);
      confirmOpen = false;
      await refresh(projectId, accepted.id);
      notice = `Plan v${accepted.version} accepted and synced to GitHub.`;
    } catch (cause) {
      confirmOpen = false;
      acceptError = describe(cause);
    } finally {
      busy = false;
    }
  }

  async function retrySync(): Promise<void> {
    if (projectId === undefined || selectedPlan === null || busy) return;
    error = null;
    notice = null;
    busy = true;
    try {
      const pushed = await pushIssues(projectId, selectedPlan.id);
      await refresh(projectId, selectedPlan.id);
      notice = describePush(pushed);
    } catch (cause) {
      error = describe(cause);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head>
  <title>{project ? `${project.name} · Review plan` : 'Review plan'} · YAAABK</title>
</svelte:head>

<main class="mx-auto flex min-h-dvh max-w-4xl flex-col gap-6 p-6">
  <a
    href={projectId === undefined ? resolve('/') : resolve('/projects/[id]', { id: projectId })}
    class="text-sm text-neutral-500 hover:underline"
  >
    ← Back to project
  </a>

  {#if loading}
    <p class="text-sm text-neutral-500">Loading plans…</p>
  {:else if error !== null && project === null}
    <p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>
  {:else if project !== null}
    <header class="space-y-2">
      <h1 class="text-2xl font-bold tracking-tight">Review plan</h1>
      <p class="text-neutral-600">
        Review the Plan versions of <span class="font-medium">{project.name}</span>. Accept the
        active Plan to record it, create or update its Issues on GitHub, and let agents start on its
        <span class="font-medium">ready</span> Issues. To change a Plan or its Issues, start another agent
        session.
      </p>
    </header>

    {#if error !== null}
      <p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>
    {/if}
    {#if notice !== null}
      <p class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">
        {notice}
      </p>
    {/if}

    {#if plans.length > 0}
      <section
        class="rounded-lg border border-neutral-200 p-4"
        aria-labelledby="plan-versions-heading"
      >
        <h2 id="plan-versions-heading" class="mb-2 text-sm font-semibold">Plan versions</h2>
        <ul class="flex flex-col gap-2">
          {#each plans as version (version.id)}
            {@const progress = progressOf(version)}
            <li>
              <button
                type="button"
                onclick={() => select(version.id)}
                aria-pressed={version.id === selectedId}
                class="flex w-full flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-left text-sm hover:bg-neutral-50 {version.id ===
                selectedId
                  ? 'border-neutral-900'
                  : 'border-neutral-200'}"
              >
                <span class="flex flex-wrap items-center gap-2">
                  <span class="font-medium">v{version.version}</span>
                  <span class="text-xs text-neutral-500">
                    {version.isActive ? 'Active' : 'Previous'}
                  </span>
                  <span class="rounded-full px-2 py-0.5 text-xs {statusClass[progress.status]}">
                    {planStatusLabel(progress.status)}
                  </span>
                  {#if version.acceptedAt !== null}
                    <span class="text-xs text-neutral-500">
                      Accepted {acceptedDate(version)}
                    </span>
                  {/if}
                </span>
                <span class="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                  <span>{progress.closed}/{progress.total} closed</span>
                  {#if progress.failed > 0}
                    <span class="text-red-700">{progress.failed} failed</span>
                  {/if}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if selectedPlan !== null}
      <section class="rounded-lg border border-neutral-200 p-4" aria-labelledby="plan-heading">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <h2 id="plan-heading" class="text-sm font-semibold">Plan v{selectedPlan.version}</h2>
            <span class="text-xs text-neutral-500">
              {selectedPlan.isActive ? 'Active' : 'Previous'}
            </span>
            {#if selectedStatus !== null}
              <span class="rounded-full px-2 py-0.5 text-xs {statusClass[selectedStatus]}">
                {planStatusLabel(selectedStatus)}
              </span>
            {/if}
          </div>
          {#if selectedPlan.acceptedAt !== null}
            <span class="text-xs text-neutral-500">
              Accepted {acceptedDate(selectedPlan)}
            </span>
          {/if}
        </div>
        <p class="text-sm text-neutral-700">{summaryForPlan(selectedPlan)}</p>
        <details class="mt-2">
          <summary class="cursor-pointer text-sm text-neutral-600">Show full plan</summary>
          <div class="mt-2"><Markdown markdown={selectedPlan.contentMarkdown} /></div>
        </details>
        {#if readOnly}
          <p
            class="mt-3 rounded-md bg-neutral-100 px-3 py-2 text-sm text-neutral-600"
            role="status"
          >
            This is a previous Plan. It is shown read-only; activate it on the Plan page to change
            it.
          </p>
        {/if}
      </section>
    {:else}
      <p class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
        This project has no active plan yet.
        <a href={resolve('/projects/[id]/plan', { id: project.id })} class="font-medium underline">
          Start a new agent session</a
        >
        first.
      </p>
    {/if}

    {#if graph !== null && graph.cycles.length > 0}
      <section
        class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        aria-labelledby="cycles-heading"
      >
        <h2 id="cycles-heading" class="mb-1 font-semibold">Circular dependencies</h2>
        <p class="mb-2">
          Break these before accepting, or the issues cannot be ordered into waves.
        </p>
        <ul class="list-inside list-disc">
          {#each graph.cycles as cycle (cycle.join('-'))}
            <li>{cycle.join(' → ')} → {cycle[0]}</li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if selectedPlan !== null}
      <section class="rounded-lg border border-neutral-200 p-4" aria-labelledby="issues-heading">
        <div class="mb-3 flex items-center justify-between gap-2">
          <h2 id="issues-heading" class="text-sm font-semibold">Issues ({reviewList.length})</h2>
        </div>

        {#if zeroIssuePlan}
          <p class="text-sm text-neutral-500">
            This Plan was published without Issues, so it cannot be accepted. A new agent session is
            needed to publish a revised Plan.
            <a
              href={resolve('/projects/[id]/plan', { id: project.id })}
              class="font-medium underline"
            >
              Start a new agent session</a
            >.
          </p>
        {:else if reviewList.length === 0}
          <p class="text-sm text-neutral-500">
            No issues yet. Finish an agent session to publish a Plan and its Issues.
            <a
              href={resolve('/projects/[id]/plan', { id: project.id })}
              class="font-medium underline"
            >
              Start a new agent session</a
            >.
          </p>
        {:else}
          <div class="flex flex-col gap-4">
            {#each groups as group (group.wave)}
              <div>
                <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  {group.wave === null ? 'Unordered (cycle)' : `Wave ${group.wave}`}
                </h3>
                <ul class="flex flex-col gap-2">
                  {#each group.items as item (item.issue.id)}
                    <li class="rounded-md border border-neutral-200 p-3 text-sm">
                      <div class="flex flex-wrap items-center gap-2">
                        <p class="font-medium">{item.issue.title}</p>
                        {#if item.issue.status === 'closed'}
                          <span
                            class="rounded-full bg-neutral-200 px-2 py-0.5 text-xs text-neutral-700"
                          >
                            closed
                          </span>
                        {:else if item.issue.status === 'failed'}
                          <span class="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800">
                            failed
                          </span>
                        {:else}
                          <span
                            class="rounded-full px-2 py-0.5 text-xs {labelClass[item.issue.label]}"
                          >
                            {item.issue.label}
                          </span>
                        {/if}
                        {#if item.issue.githubNumber !== null}
                          <span class="text-xs text-neutral-500">
                            GitHub #{item.issue.githubNumber}
                          </span>
                        {/if}
                      </div>
                      {#if item.issue.body !== ''}
                        <p class="mt-1 text-sm text-neutral-700">{summaryForIssue(item.issue)}</p>
                        <details class="mt-1">
                          <summary class="cursor-pointer text-xs text-neutral-600">
                            Show full issue
                          </summary>
                          <Markdown markdown={item.issue.body} class="mt-1" />
                        </details>
                      {:else}
                        <p class="mt-1 text-sm text-neutral-700">{summaryForIssue(item.issue)}</p>
                      {/if}
                      {#if item.issue.dependsOn.length > 0}
                        <p class="mt-1 text-xs text-neutral-500">
                          Depends on: {item.issue.dependsOn.join(', ')}
                        </p>
                      {/if}
                      {#if item.missing.length > 0}
                        <p class="mt-1 text-xs text-red-700">
                          Missing dependency: {item.missing.join(', ')}
                        </p>
                      {/if}
                    </li>
                  {/each}
                </ul>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/if}

    {#if acceptError !== null}
      <div class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
        <p>{acceptError}</p>
        <p class="mt-1">The Plan was not accepted. Its Issues are safe to sync again.</p>
        <button
          type="button"
          onclick={() => void accept()}
          disabled={busy}
          class="mt-2 rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          Retry accept
        </button>
      </div>
    {/if}

    {#if canAccept && selectedPlan !== null}
      <section
        class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 p-4"
        aria-labelledby="accept-heading"
      >
        <div>
          <h2 id="accept-heading" class="text-sm font-semibold">Accept this plan</h2>
          <p class="text-xs text-neutral-500">
            Accepting records the Plan, creates or updates its Issues on GitHub, and lets agents
            start on its ready Issues.
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            onclick={() => {
              acceptError = null;
              confirmOpen = true;
            }}
            disabled={busy}
            class="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            Accept plan
          </button>
          <a
            href={resolve('/projects/[id]/plan', { id: project.id })}
            class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100"
          >
            Start a new agent session
          </a>
        </div>
      </section>
    {/if}

    {#if needsSync && selectedPlan !== null}
      <div class="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p class="text-xs text-neutral-500">
          Some Issues of the accepted Plan are not on GitHub yet.
        </p>
        <button
          type="button"
          onclick={() => void retrySync()}
          disabled={busy}
          class="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50"
        >
          Retry GitHub sync
        </button>
      </div>
    {/if}

    {#if confirmOpen && selectedPlan !== null}
      <div
        class="fixed inset-0 z-10 flex items-center justify-center bg-black/30 p-4"
        role="presentation"
        onclick={(event) => {
          if (event.target === event.currentTarget) confirmOpen = false;
        }}
        onkeydown={(event) => {
          if (event.key === 'Escape') confirmOpen = false;
        }}
      >
        <div
          class="flex w-full max-w-md flex-col gap-3 rounded-lg bg-white p-5 shadow-xl"
          role="dialog"
          aria-modal="true"
          aria-labelledby="accept-dialog-heading"
          tabindex="-1"
        >
          <h2 id="accept-dialog-heading" class="text-lg font-bold tracking-tight">
            Accept Plan v{selectedPlan.version}?
          </h2>
          <p class="text-sm text-neutral-700">
            Accepting records this Plan and creates or updates its Issues on GitHub. It also lets
            agents start on the Issues labelled <span class="font-medium">ready</span>.
          </p>
          <p class="text-sm text-neutral-700">
            Issues labelled <span class="font-medium">needs-human</span> stay as they are for you to handle.
            Issue labels do not change.
          </p>
          <div class="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onclick={() => (confirmOpen = false)}
              disabled={busy}
              class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onclick={() => void accept()}
              disabled={busy}
              class="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              Accept Plan v{selectedPlan.version}
            </button>
          </div>
        </div>
      </div>
    {/if}
  {/if}
</main>
