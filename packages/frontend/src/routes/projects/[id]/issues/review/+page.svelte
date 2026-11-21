<script lang="ts">
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { AlertTriangle, RefreshCw } from '@lucide/svelte';
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
  import PageHeader from '#lib/components/page-header.svelte';
  import ProjectTabs from '#lib/components/project-tabs.svelte';
  import { Alert, AlertDescription, AlertTitle } from '#lib/components/ui/alert/index.js';
  import { Badge } from '#lib/components/ui/badge/index.js';
  import { Button } from '#lib/components/ui/button/index.js';
  import { Card, CardContent, CardHeader } from '#lib/components/ui/card/index.js';
  import {
    Close as DialogClose,
    Content as DialogContent,
    Description as DialogDescription,
    Root as DialogRoot,
    Title as DialogTitle,
  } from '#lib/components/ui/dialog/index.js';
  import { Skeleton } from '#lib/components/ui/skeleton/index.js';
  import { resolveShell } from '#lib/shell.js';
  import {
    pendingGithubSync,
    planProgress,
    planStatusLabel,
    type PlanLifecycleStatus,
  } from '#lib/plan-lifecycle.js';
  import { summaryForIssue, summaryForPlan } from '#lib/summary.js';

  const projectId = $derived(page.params.id);

  let project = $state<Project | null>(null);
  const shell = $derived(resolveShell(page.url.pathname, project?.name));
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
    ready: 'bg-success-subtle text-success',
    'refinement-needed': 'bg-warning-subtle text-warning',
    blocked: 'bg-muted text-muted-foreground',
    'needs-human': 'bg-destructive-subtle text-destructive',
  };

  const statusClass: Record<PlanLifecycleStatus, string> = {
    'not-accepted': 'bg-muted text-muted-foreground',
    'in-progress': 'bg-warning-subtle text-warning',
    completed: 'bg-success-subtle text-success',
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
      // Land on the board, replacing the review entry so Back does not return
      // to a stale accept form.
      await goto(
        // eslint-disable-next-line svelte/no-navigation-without-resolve -- the accepted version belongs in the query string
        `${resolve('/projects/[id]/issues', { id: projectId })}?accepted=${accepted.version}`,
        { replace: true },
      );
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

<div class="mx-auto flex w-full max-w-6xl flex-col gap-6">
  {#if loading}
    <div class="flex flex-col gap-4" aria-busy="true" aria-label="Loading plan review">
      <Skeleton class="h-9 w-64" />
      <Skeleton class="h-5 w-96 max-w-full" />
      <div class="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <Skeleton class="h-64 w-full rounded-xl" />
        <Skeleton class="h-96 w-full rounded-xl" />
      </div>
    </div>
  {:else if error !== null && project === null}
    <Alert variant="destructive">
      <AlertTitle>Could not load the Plan review</AlertTitle>
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  {:else if project !== null}
    {@const currentProjectId = project.id}
    <PageHeader
      title="Review plan"
      purpose={`Read the Plan versions of ${project.name}, then accept the active one to record it and sync its Issues to GitHub.`}
      breadcrumbs={shell.breadcrumbs}
    >
      {#snippet tabs()}
        <ProjectTabs projectId={currentProjectId} activeTab={shell.activeProjectTab} />
      {/snippet}
    </PageHeader>

    {#if error !== null}
      <Alert variant="destructive">
        <AlertTitle>Something went wrong</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    {/if}
    {#if notice !== null}
      <p class="bg-success-subtle text-success rounded-lg px-3 py-2 text-sm" role="status">
        {notice}
      </p>
    {/if}

    {#if plans.length === 0}
      <Card aria-labelledby="no-plans-heading">
        <CardHeader>
          <h2 id="no-plans-heading" class="text-lg font-medium tracking-tight">
            No Plan has been published yet
          </h2>
          <p class="text-sm text-muted-foreground">
            Finish an agent session to publish the first Plan and its Issues.
          </p>
        </CardHeader>
        <CardContent>
          <Button href={resolve('/projects/[id]/plan', { id: project.id })}>
            Start an agent session
          </Button>
        </CardContent>
      </Card>
    {:else}
      <div class="grid min-w-0 items-start gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <div class="min-w-0">
          <div class="mb-3 flex items-center justify-between gap-2">
            <h2 id="versions-heading" class="text-lg font-medium tracking-tight">Plan versions</h2>
            <Badge variant="outline">{plans.length}</Badge>
          </div>

          <div class="lg:hidden">
            <label for="plan-version-select" class="mb-1 block text-sm font-medium">
              Plan version
            </label>
            <select
              id="plan-version-select"
              value={selectedId ?? ''}
              onchange={(event) => select(event.currentTarget.value)}
              class="border-input bg-background focus-visible:ring-ring/50 h-11 w-full rounded-lg border px-3 text-sm focus-visible:ring-3 focus-visible:outline-none"
            >
              {#each plans as version (version.id)}
                <option value={version.id}>
                  v{version.version} · {version.isActive ? 'Active' : 'Previous'} · {planStatusLabel(
                    progressOf(version).status,
                  )}
                </option>
              {/each}
            </select>
          </div>

          <nav aria-labelledby="versions-heading" class="hidden min-w-0 lg:block">
            <ul class="flex flex-col gap-2">
              {#each plans as version (version.id)}
                {@const progress = progressOf(version)}
                {@const current = version.id === selectedId}
                <li>
                  <button
                    type="button"
                    onclick={() => select(version.id)}
                    aria-current={current ? 'true' : undefined}
                    class="flex w-full flex-col gap-2 rounded-xl border p-3 text-left text-sm transition-colors focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none {current
                      ? 'border-primary bg-secondary'
                      : 'border-border-subtle bg-card hover:bg-muted/60'}"
                  >
                    <span class="flex flex-wrap items-center gap-2">
                      <span class="font-medium">v{version.version}</span>
                      <span class="text-muted-foreground text-xs">
                        {version.isActive ? 'Active' : 'Previous'}
                      </span>
                      <span class="rounded-full px-2 py-0.5 text-xs {statusClass[progress.status]}">
                        {planStatusLabel(progress.status)}
                      </span>
                      {#if version.acceptedAt !== null}
                        <span class="text-muted-foreground text-xs">
                          Accepted {acceptedDate(version)}
                        </span>
                      {/if}
                    </span>
                    <span class="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                      <span>{progress.closed}/{progress.total} closed</span>
                      {#if progress.failed > 0}
                        <span class="text-destructive">{progress.failed} failed</span>
                      {/if}
                    </span>
                  </button>
                </li>
              {/each}
            </ul>
          </nav>
        </div>

        <div class="flex min-w-0 flex-col gap-6">
          {#if selectedPlan !== null}
            <section
              data-testid="plan-detail"
              aria-labelledby="plan-detail-heading"
              class="bg-card min-w-0 rounded-xl p-4 ring-1 ring-border-subtle sm:p-6"
            >
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="flex flex-wrap items-center gap-2">
                  <h2 id="plan-detail-heading" class="text-lg font-medium tracking-tight">
                    Plan v{selectedPlan.version}
                  </h2>
                  <Badge variant="outline">
                    {selectedPlan.isActive ? 'Active' : 'Previous'}
                  </Badge>
                  {#if selectedStatus !== null}
                    <span class="rounded-full px-2 py-0.5 text-xs {statusClass[selectedStatus]}">
                      {planStatusLabel(selectedStatus)}
                    </span>
                  {/if}
                </div>
                {#if selectedPlan.acceptedAt !== null}
                  <span class="text-muted-foreground text-xs">
                    Accepted {acceptedDate(selectedPlan)}
                  </span>
                {/if}
              </div>

              <p class="mt-3 text-sm text-foreground">{summaryForPlan(selectedPlan)}</p>
              <details class="mt-3">
                <summary class="text-muted-foreground hover:text-foreground cursor-pointer text-sm">
                  Show full plan
                </summary>
                <div class="mt-2"><Markdown markdown={selectedPlan.contentMarkdown} /></div>
              </details>

              {#if readOnly}
                <div class="bg-muted mt-4 rounded-lg px-3 py-2 text-sm" role="status">
                  <p class="text-foreground font-medium">This previous Plan is read-only.</p>
                  <p class="text-muted-foreground mt-0.5">
                    Its Issues and labels cannot be changed here.
                    <a
                      href={resolve('/projects/[id]/plan', { id: project.id })}
                      class="text-link font-medium hover:underline"
                    >
                      Reactivate it on the Plan page</a
                    >
                    to continue this version.
                  </p>
                </div>
              {/if}
            </section>

            {#if graph !== null && graph.cycles.length > 0}
              <Alert variant="destructive" data-testid="cycles">
                <AlertTriangle aria-hidden="true" />
                <AlertTitle>Circular dependencies</AlertTitle>
                <AlertDescription>
                  <p>Break these before accepting, or the Issues cannot be ordered into waves.</p>
                  <ul class="mt-2 list-inside list-disc">
                    {#each graph.cycles as cycle (cycle.join('-'))}
                      <li>{cycle.join(' → ')} → {cycle[0]}</li>
                    {/each}
                  </ul>
                </AlertDescription>
              </Alert>
            {/if}

            <section
              data-testid="issue-list"
              aria-labelledby="issues-heading"
              class="bg-card min-w-0 rounded-xl p-4 ring-1 ring-border-subtle sm:p-6"
            >
              <h3 id="issues-heading" class="text-lg font-medium tracking-tight">
                Issues ({reviewList.length})
              </h3>

              {#if zeroIssuePlan}
                <p class="text-muted-foreground mt-2 text-sm">
                  This Plan was published without Issues, so it cannot be accepted. A new agent
                  session is needed to publish a revised Plan.
                  <a
                    href={resolve('/projects/[id]/plan', { id: project.id })}
                    class="text-link font-medium hover:underline"
                  >
                    Start a new agent session</a
                  >.
                </p>
              {:else if reviewList.length === 0}
                <p class="text-muted-foreground mt-2 text-sm">
                  No issues yet. Finish an agent session to publish a Plan and its Issues.
                  <a
                    href={resolve('/projects/[id]/plan', { id: project.id })}
                    class="text-link font-medium hover:underline"
                  >
                    Start a new agent session</a
                  >.
                </p>
              {:else}
                <div class="mt-3 flex flex-col gap-5">
                  {#each groups as group (group.wave)}
                    <div>
                      <h4
                        class="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase"
                      >
                        {group.wave === null ? 'Unordered (cycle)' : `Wave ${group.wave}`}
                      </h4>
                      <ul class="flex flex-col gap-2">
                        {#each group.items as item (item.issue.id)}
                          <li class="rounded-lg border border-border-subtle p-3 text-sm">
                            <div class="flex flex-wrap items-center gap-2">
                              <p class="font-medium">{item.issue.title}</p>
                              {#if item.issue.status === 'closed'}
                                <span
                                  class="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs"
                                >
                                  closed
                                </span>
                              {:else if item.issue.status === 'failed'}
                                <span
                                  class="bg-destructive-subtle text-destructive rounded-full px-2 py-0.5 text-xs"
                                >
                                  failed
                                </span>
                              {:else}
                                <span
                                  class="rounded-full px-2 py-0.5 text-xs {labelClass[
                                    item.issue.label
                                  ]}"
                                >
                                  {item.issue.label}
                                </span>
                              {/if}
                              {#if item.issue.githubNumber !== null}
                                <span class="text-muted-foreground text-xs">
                                  GitHub #{item.issue.githubNumber}
                                </span>
                              {/if}
                            </div>
                            {#if item.issue.body !== ''}
                              <p class="mt-1 text-sm text-foreground">
                                {summaryForIssue(item.issue)}
                              </p>
                              <details class="mt-1">
                                <summary
                                  class="text-muted-foreground hover:text-foreground cursor-pointer text-xs"
                                >
                                  Show full issue
                                </summary>
                                <Markdown markdown={item.issue.body} class="mt-1" />
                              </details>
                            {:else}
                              <p class="mt-1 text-sm text-foreground">
                                {summaryForIssue(item.issue)}
                              </p>
                            {/if}
                            {#if item.issue.dependsOn.length > 0}
                              <p class="text-muted-foreground mt-1 text-xs">
                                Depends on: {item.issue.dependsOn.join(', ')}
                              </p>
                            {/if}
                            {#if item.missing.length > 0}
                              <p class="text-destructive mt-1 text-xs">
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

            {#if needsSync && selectedPlan !== null}
              <Alert data-testid="sync-retry">
                <RefreshCw aria-hidden="true" />
                <AlertTitle>GitHub sync incomplete</AlertTitle>
                <AlertDescription>
                  <p>Some Issues of the accepted Plan are not on GitHub yet.</p>
                  <Button
                    variant="outline"
                    size="sm"
                    class="mt-2"
                    onclick={() => void retrySync()}
                    disabled={busy}
                  >
                    Retry GitHub sync
                  </Button>
                </AlertDescription>
              </Alert>
            {/if}

            {#if acceptError !== null}
              <Alert variant="destructive" data-testid="accept-error">
                <AlertTitle>The Plan was not accepted</AlertTitle>
                <AlertDescription>
                  <p>{acceptError}</p>
                  <p>The Plan was not accepted. Its Issues are safe to sync again.</p>
                  <Button
                    variant="outline"
                    size="sm"
                    class="mt-2"
                    onclick={() => void accept()}
                    disabled={busy}
                  >
                    Retry accept
                  </Button>
                </AlertDescription>
              </Alert>
            {/if}
          {:else}
            <Card aria-labelledby="no-active-plan-heading">
              <CardHeader>
                <h2 id="no-active-plan-heading" class="text-lg font-medium tracking-tight">
                  This project has no active Plan yet
                </h2>
                <p class="text-sm text-muted-foreground">
                  Start a new agent session to draft and publish a Plan.
                </p>
              </CardHeader>
              <CardContent>
                <Button href={resolve('/projects/[id]/plan', { id: project.id })}>
                  Start an agent session
                </Button>
              </CardContent>
            </Card>
          {/if}
        </div>
      </div>

      {#if canAccept && selectedPlan !== null}
        <section
          data-testid="accept-bar"
          aria-labelledby="accept-heading"
          class="bg-card/95 sticky bottom-0 z-20 flex flex-col gap-3 rounded-xl border border-border-subtle p-4 shadow-elevation-1 backdrop-blur sm:flex-row sm:items-center sm:justify-between"
        >
          <div class="min-w-0">
            <h2 id="accept-heading" class="text-base font-medium tracking-tight">
              Accept Plan v{selectedPlan.version}
            </h2>
            <p class="text-muted-foreground mt-0.5 text-xs">
              Accepting records this version, creates or updates its Issues on GitHub, and lets
              agents start on its ready Issues.
            </p>
          </div>
          <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button
              variant="outline"
              href={resolve('/projects/[id]/plan', { id: project.id })}
              class="h-11 sm:h-9"
            >
              Start a new agent session
            </Button>
            <Button
              class="h-11 w-full px-4 sm:h-9 sm:w-auto"
              data-testid="open-accept-dialog"
              onclick={() => {
                acceptError = null;
                confirmOpen = true;
              }}
              disabled={busy}
            >
              Accept plan
            </Button>
          </div>
        </section>
      {/if}
    {/if}

    <DialogRoot bind:open={confirmOpen}>
      <DialogContent>
        <DialogTitle>Accept Plan v{selectedPlan?.version ?? ''}?</DialogTitle>
        <DialogDescription>
          Accepting records this Plan and creates or updates its Issues on GitHub. It also lets
          agents start on the Issues labelled <span class="font-medium">ready</span>.
        </DialogDescription>
        <p class="text-sm text-foreground">
          Issues labelled <span class="font-medium">needs-human</span> stay as they are for you to handle.
          Issue labels do not change.
        </p>
        <div class="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DialogClose>
            {#snippet child({ props })}
              <Button {...props} variant="outline" class="h-11">Cancel</Button>
            {/snippet}
          </DialogClose>
          <Button
            class="h-11"
            disabled={busy}
            onclick={() => void accept()}
            data-testid="confirm-accept"
          >
            Accept Plan v{selectedPlan?.version ?? ''}
          </Button>
        </div>
      </DialogContent>
    </DialogRoot>
  {/if}
</div>
