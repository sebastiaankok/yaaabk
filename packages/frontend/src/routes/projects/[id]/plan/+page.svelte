<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import type { Plan } from '@yaaabk/plans';
  import type { Issue } from '@yaaabk/issues';
  import type { Project } from '@yaaabk/projects';
  import { toast } from 'svelte-sonner';
  import {
    ApiError,
    activatePlan,
    cancelGrill,
    finishGrill,
    getActiveGrillSession,
    getProject,
    listIssues,
    listModels,
    listPlans,
    startGrill,
    terminalWebSocketUrl,
    type GrillSessionView,
    type ModelCatalogueView,
  } from '#lib/api.js';
  import { canForceFinish, finishHint } from '#lib/grill-finish.js';
  import ModelCombobox from '#lib/components/model-combobox.svelte';
  import PageHeader from '#lib/components/page-header.svelte';
  import ProjectTabs from '#lib/components/project-tabs.svelte';
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
  import { Textarea } from '#lib/components/ui/textarea/index.js';
  import { planFilePath, planFileUrl } from '#lib/plan-file.js';
  import { planProgress, planStatusLabel, type PlanLifecycleStatus } from '#lib/plan-lifecycle.js';
  import { projectModeLabel } from '#lib/project-mode.js';
  import { resolveShell } from '#lib/shell.js';
  import Terminal from '#lib/terminal.svelte';
  import { terminalStatusLabel, type TerminalConnectionStatus } from '#lib/terminal-client.js';

  const projectId = $derived(page.params.id);

  let project = $state<Project | null>(null);
  const shell = $derived(resolveShell(page.url.pathname, project?.name));
  let plans = $state<Plan[]>([]);
  let issues = $state<Issue[]>([]);
  let session = $state<GrillSessionView | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let finishConflict = $state<{ message: string; missing: string[] } | null>(null);
  let confirmingCancel = $state(false);

  let idea = $state('');
  let catalogue = $state<ModelCatalogueView | null>(null);
  let modelChoice = $state('');
  let modelError = $state<string | null>(null);
  let busy = $state(false);
  let terminalStatus = $state<TerminalConnectionStatus>('connecting');
  let terminalError = $state<string | null>(null);

  const terminalUrl = $derived(
    session === null || projectId === undefined ? '' : terminalWebSocketUrl(projectId, session.id),
  );

  const draftPlanLabel = $derived(session?.draft.hasPrd === true ? 'Plan drafted' : 'No Plan yet');
  const draftIssuesLabel = $derived(
    `${session?.draft.issueCount ?? 0} ${session?.draft.issueCount === 1 ? 'Issue' : 'Issues'} drafted`,
  );

  const statusLabel = $derived(terminalStatusLabel(terminalStatus));

  const statusClass: Record<PlanLifecycleStatus, string> = {
    'not-accepted': 'bg-muted text-muted-foreground',
    'in-progress': 'bg-warning-subtle text-warning',
    completed: 'bg-success-subtle text-success',
  };

  const connectionClass: Record<TerminalConnectionStatus, string> = {
    live: 'bg-success-subtle text-success',
    connecting: 'bg-warning-subtle text-warning',
    reconnecting: 'bg-warning-subtle text-warning',
    closed: 'bg-muted text-muted-foreground',
  };

  function progressOf(version: Plan) {
    return planProgress(version, issues);
  }

  /** The percentage an issue progress bar should fill, rounded to whole steps. */
  function progressPercent(closed: number, total: number): number {
    return total === 0 ? 0 : Math.round((closed / total) * 100);
  }

  function sourceLabel(source: string): string {
    return source === 'grill-me' ? 'Grill-Me Session' : source;
  }

  function describe(cause: unknown): string {
    return cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.';
  }

  async function refreshPlans(id: string): Promise<void> {
    const [nextPlans, nextIssues] = await Promise.all([listPlans(id), listIssues(id)]);
    plans = nextPlans;
    issues = nextIssues;
  }

  // Load the project, its plan history and any session that survived a refresh.
  $effect(() => {
    const id = projectId;
    if (id === undefined) return;
    let cancelled = false;
    loading = true;
    error = null;
    Promise.all([
      getProject(id),
      listPlans(id),
      listIssues(id),
      getActiveGrillSession(id),
      listModels().catch(() => null),
    ])
      .then(([nextProject, nextPlans, nextIssues, nextSession, nextCatalogue]) => {
        if (cancelled) return;
        project = nextProject;
        plans = nextPlans;
        issues = nextIssues;
        session = nextSession;
        catalogue = nextCatalogue;
        modelError =
          nextCatalogue === null
            ? 'Could not load the model catalogue. The default model will be used.'
            : null;
        // Only preselect a model the catalogue actually offers. An empty choice
        // lets the backend apply its configured default without model validation.
        const remembered = nextProject.lastModel;
        const offered = (id: string): boolean =>
          nextCatalogue?.models.some((entry) => entry.id === id) ?? false;
        modelChoice =
          nextCatalogue === null
            ? ''
            : remembered !== null && offered(remembered)
              ? remembered
              : offered(nextCatalogue.defaultModel)
                ? nextCatalogue.defaultModel
                : '';
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

  function handleTerminalStatus(status: TerminalConnectionStatus, reason?: string): void {
    terminalStatus = status;
    terminalError = reason ?? null;
  }

  async function start(): Promise<void> {
    if (projectId === undefined || busy || idea.trim() === '') return;
    error = null;
    finishConflict = null;
    confirmingCancel = false;
    busy = true;
    try {
      session = await startGrill(projectId, idea.trim(), modelChoice.trim());
      if (project !== null) project = { ...project, lastModel: session.model };
      idea = '';
      terminalStatus = 'connecting';
      terminalError = null;
    } catch (cause) {
      error = describe(cause);
    } finally {
      busy = false;
    }
  }

  async function finish(force = false): Promise<void> {
    if (projectId === undefined || session === null || busy) return;
    error = null;
    finishConflict = null;
    confirmingCancel = false;
    busy = true;
    try {
      const published = await finishGrill(projectId, session.id, { force });
      session = null;
      terminalStatus = 'closed';
      terminalError = null;
      await refreshPlans(projectId);
      const issueCount = published.issues.length;
      toast.success(
        `Published Plan v${published.plan.version} with ${issueCount} ${issueCount === 1 ? 'Issue' : 'Issues'}.`,
      );
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        finishConflict = { message: cause.message, missing: cause.missing };
      } else {
        error = describe(cause);
      }
    } finally {
      busy = false;
    }
  }

  function requestCancel(): void {
    if (session === null || busy) return;
    finishConflict = null;
    confirmingCancel = true;
  }

  async function cancel(): Promise<void> {
    if (projectId === undefined || session === null || busy) return;
    error = null;
    finishConflict = null;
    busy = true;
    try {
      await cancelGrill(projectId, session.id);
      session = null;
      confirmingCancel = false;
      toast.info('Session cancelled.');
      terminalStatus = 'closed';
      terminalError = null;
    } catch (cause) {
      error = describe(cause);
    } finally {
      busy = false;
    }
  }

  async function activate(version: Plan): Promise<void> {
    if (projectId === undefined || busy) return;
    error = null;
    busy = true;
    try {
      await activatePlan(projectId, version.id);
      await refreshPlans(projectId);
      toast.success(`Plan v${version.version} is now active.`);
    } catch (cause) {
      error = describe(cause);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head>
  <title>{project ? `${project.name} · Plan` : 'Plan'} · YAAABK</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-7xl flex-col gap-6">
  {#if loading}
    <div class="flex flex-col gap-4" aria-busy="true" aria-label="Loading project">
      <Skeleton class="h-9 w-64" />
      <Skeleton class="h-5 w-96 max-w-full" />
      <Skeleton class="h-40 w-full rounded-xl" />
    </div>
  {:else if error !== null && project === null}
    <p class="bg-destructive-subtle text-destructive rounded-lg px-3 py-2 text-sm" role="alert">
      {error}
    </p>
  {:else if project !== null}
    {@const currentProjectId = project.id}
    {@const currentMode = projectModeLabel(project.mode)}
    <PageHeader
      title={project.name}
      purpose="Interview the agent in the terminal, then publish one Plan with its Issues."
      breadcrumbs={shell.breadcrumbs}
    >
      {#snippet actions()}
        <Badge variant="secondary">{currentMode} mode</Badge>
      {/snippet}
      {#snippet tabs()}
        <ProjectTabs projectId={currentProjectId} activeTab={shell.activeProjectTab} />
      {/snippet}
    </PageHeader>

    <dl class="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
      <div class="flex min-w-0 gap-1">
        <dt class="font-medium">Repository</dt>
        <dd class="min-w-0 break-all">
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
          <a
            href={project.repoUrl}
            target="_blank"
            rel="external noreferrer"
            class="text-link hover:underline"
          >
            {project.repoFullName}
          </a>
        </dd>
      </div>
      <div class="flex gap-1">
        <dt class="font-medium">Namespace</dt>
        <dd><code class="font-mono break-all">{project.namespace}</code></dd>
      </div>
      <div class="flex gap-1">
        <dt class="font-medium">Deployed</dt>
        <dd>
          {#if project.deployedCommitSha}<code class="font-mono break-all"
              >{project.deployedCommitSha}</code
            >{:else}<span>Not yet deployed</span>{/if}
        </dd>
      </div>
    </dl>

    {#if error !== null}
      <p class="bg-destructive-subtle text-destructive rounded-lg px-3 py-2 text-sm" role="alert">
        {error}
      </p>
    {/if}

    <div class="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div class="flex min-w-0 flex-col gap-6">
        {#if session !== null}
          <Card
            class="overflow-visible"
            aria-labelledby="grill-heading"
            data-testid="terminal-card"
          >
            <CardHeader class="gap-3">
              <div role="toolbar" aria-label="Session controls" class="flex min-w-0 flex-col gap-3">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="min-w-0">
                    <h2 id="grill-heading" class="text-lg font-medium tracking-tight">
                      Grill-Me Session
                    </h2>
                    <p class="text-sm text-muted-foreground">
                      Answer the agent here. Nothing is published until you finish.
                    </p>
                  </div>
                  <div class="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge variant="outline" class="max-w-[14rem] font-mono">
                      <span class="truncate">{session.model}</span>
                    </Badge>
                    <span
                      class="inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-xs font-medium {connectionClass[
                        terminalStatus
                      ]}"
                      role="status"
                      aria-label={statusLabel}
                    >
                      <span class="size-1.5 rounded-full bg-current" aria-hidden="true"></span>
                      {statusLabel}
                    </span>
                  </div>
                </div>

                <div class="flex min-w-0 flex-wrap items-center justify-between gap-3">
                  <ul class="flex min-w-0 flex-wrap gap-2" aria-label="Draft progress">
                    <li>
                      <Badge
                        variant="secondary"
                        class={session.draft.hasPrd
                          ? 'bg-success-subtle text-success'
                          : 'bg-muted text-muted-foreground'}
                      >
                        {draftPlanLabel}
                      </Badge>
                    </li>
                    <li>
                      <Badge variant="secondary" class="bg-muted text-muted-foreground">
                        {draftIssuesLabel}
                      </Badge>
                    </li>
                  </ul>
                  <div class="flex flex-wrap gap-2">
                    <Button onclick={() => void finish()} disabled={busy}>Finish</Button>
                    <Button
                      variant="outline"
                      class="border-destructive/40 text-destructive hover:bg-destructive-subtle"
                      onclick={requestCancel}
                      disabled={busy}
                    >
                      Cancel session
                    </Button>
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent class="flex min-w-0 flex-col gap-3">
              {#if terminalError !== null}
                <p
                  class="bg-destructive-subtle text-destructive rounded-lg px-3 py-2 text-sm"
                  role="alert"
                >
                  {terminalError}
                </p>
              {/if}

              {#if finishConflict !== null}
                <div class="bg-warning-subtle text-warning rounded-lg p-3 text-sm" role="alert">
                  <p class="font-medium">Finish is blocked</p>
                  <p class="mt-1">{finishConflict.message}</p>
                  {#if finishHint(finishConflict.missing) !== null}
                    <p class="mt-1 text-xs">{finishHint(finishConflict.missing)}</p>
                  {/if}
                  <div class="mt-3 flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onclick={() => void finish()}
                      disabled={busy}
                    >
                      Try Finish again
                    </Button>
                    {#if canForceFinish(finishConflict.missing)}
                      <Button
                        size="sm"
                        class="bg-warning text-warning-foreground hover:bg-warning/90"
                        onclick={() => void finish(true)}
                        disabled={busy}
                      >
                        Publish anyway
                      </Button>
                    {/if}
                  </div>
                </div>
              {/if}

              <Terminal url={terminalUrl} status={terminalStatus} onStatus={handleTerminalStatus} />
            </CardContent>
          </Card>
        {:else}
          <Card aria-labelledby="start-heading">
            <CardHeader>
              <h2 id="start-heading" class="text-lg font-medium tracking-tight">
                Start a Grill-Me Session
              </h2>
              <p class="text-sm text-muted-foreground">
                Describe your idea and pick the model the agent should interview you with.
              </p>
            </CardHeader>
            <CardContent>
              <form
                class="flex flex-col gap-4"
                onsubmit={(event) => {
                  event.preventDefault();
                  void start();
                }}
              >
                <div class="flex flex-col gap-2">
                  <label class="text-sm font-medium" for="idea">Your idea</label>
                  <Textarea
                    id="idea"
                    bind:value={idea}
                    rows={4}
                    class="min-h-28 px-3 text-base"
                    placeholder="Describe the app you want to build…"
                  />
                </div>
                <div class="flex flex-col gap-1">
                  <label class="text-sm font-medium" for="model">Model</label>
                  <ModelCombobox
                    id="model"
                    bind:value={modelChoice}
                    options={catalogue?.models ?? []}
                    placeholder={catalogue?.defaultModel ?? 'Provider/model'}
                    aria-describedby="model-help"
                  />
                  {#if modelError !== null}
                    <p id="model-help" class="text-warning text-xs">{modelError}</p>
                  {:else}
                    <p id="model-help" class="text-muted-foreground text-xs">
                      Search tool-capable models. The Project remembers your choice.
                    </p>
                  {/if}
                </div>
                <Button
                  type="submit"
                  size="lg"
                  class="h-11 self-start px-5"
                  disabled={busy || idea.trim() === ''}
                >
                  {busy ? 'Starting…' : 'Start agent'}
                </Button>
              </form>
            </CardContent>
          </Card>
        {/if}
      </div>

      <section class="min-w-0" aria-labelledby="versions-heading">
        <div class="mb-3 flex items-center justify-between gap-2">
          <h2 id="versions-heading" class="text-lg font-medium tracking-tight">Plan versions</h2>
          {#if plans.length > 0}
            <Badge variant="outline">{plans.length}</Badge>
          {/if}
        </div>

        {#if plans.length === 0}
          <p
            class="text-muted-foreground rounded-xl border border-dashed border-border-subtle px-4 py-6 text-sm"
          >
            No Plan has been published yet. Finish a session to create version 1.
          </p>
        {:else}
          <ol class="flex flex-col gap-3">
            {#each plans as version (version.id)}
              {@const progress = progressOf(version)}
              <li
                class="bg-card flex min-w-0 flex-col gap-3 rounded-xl p-4 ring-1 ring-border-subtle"
                data-testid="plan-version"
              >
                <div class="flex flex-wrap items-center gap-2">
                  <p class="font-medium">v{version.version}</p>
                  <span class="rounded-full px-2 py-0.5 text-xs {statusClass[progress.status]}">
                    {planStatusLabel(progress.status)}
                  </span>
                  {#if version.isActive}
                    <Badge variant="outline">Active</Badge>
                  {/if}
                </div>

                <div class="flex flex-col gap-1">
                  <div
                    class="text-muted-foreground flex items-center justify-between gap-2 text-xs"
                  >
                    <span>{progress.closed}/{progress.total} Issues closed</span>
                    {#if progress.failed > 0}
                      <span class="text-destructive">{progress.failed} failed</span>
                    {/if}
                  </div>
                  <div
                    class="bg-muted h-1.5 overflow-hidden rounded-full"
                    role="progressbar"
                    aria-label="Issues closed"
                    aria-valuemin="0"
                    aria-valuemax={Math.max(progress.total, 1)}
                    aria-valuenow={progress.closed}
                  >
                    <div
                      class="bg-primary h-full rounded-full"
                      style={`width: ${progressPercent(progress.closed, progress.total)}%`}
                    ></div>
                  </div>
                </div>

                <dl class="text-muted-foreground flex flex-col gap-1 text-xs">
                  <div class="flex min-w-0 gap-1">
                    <dt>Source</dt>
                    <dd class="text-foreground min-w-0 break-words">
                      {sourceLabel(version.source)}
                    </dd>
                  </div>
                  <div class="flex gap-1">
                    <dt>Created</dt>
                    <dd>
                      <time datetime={version.createdAt}>{version.createdAt.slice(0, 10)}</time>
                    </dd>
                  </div>
                  <div class="flex min-w-0 gap-1">
                    <dt>Decision record</dt>
                    <dd class="min-w-0 break-all">
                      {#if version.acceptedAt !== null}
                        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- repository document, not an app route -->
                        <a
                          href={planFileUrl(project.repoFullName, version.version)}
                          target="_blank"
                          rel="external noreferrer"
                          class="text-link hover:underline"
                        >
                          {planFilePath(version.version)}
                        </a>
                      {:else}
                        <span>Available after acceptance</span>
                      {/if}
                    </dd>
                  </div>
                </dl>

                <div class="flex flex-wrap items-center gap-2">
                  <!-- eslint-disable svelte/no-navigation-without-resolve -- the plan id belongs in the query string -->
                  <a
                    href={`${resolve('/projects/[id]/issues/review', { id: version.projectId })}?plan=${encodeURIComponent(version.id)}`}
                    class="border-border hover:bg-muted inline-flex h-9 items-center rounded-lg border px-3 text-sm font-medium transition-colors"
                  >
                    Review
                  </a>
                  <!-- eslint-enable svelte/no-navigation-without-resolve -->
                  {#if !version.isActive}
                    <Button
                      variant="outline"
                      onclick={() => void activate(version)}
                      disabled={busy}
                    >
                      Activate
                    </Button>
                  {/if}
                </div>
              </li>
            {/each}
          </ol>
        {/if}
      </section>
    </div>

    <DialogRoot bind:open={confirmingCancel}>
      <DialogContent>
        <DialogTitle>Cancel this session?</DialogTitle>
        <DialogDescription>
          Its draft Plan and Issues will be discarded. This cannot be undone.
        </DialogDescription>
        <div class="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DialogClose>
            {#snippet child({ props })}
              <Button {...props} variant="outline" class="h-11">Keep session</Button>
            {/snippet}
          </DialogClose>
          <Button
            variant="destructive"
            class="bg-destructive text-destructive-foreground hover:bg-destructive/90 h-11"
            disabled={busy}
            onclick={() => void cancel()}
          >
            {busy ? 'Cancelling…' : 'Discard and cancel'}
          </Button>
        </div>
      </DialogContent>
    </DialogRoot>
  {/if}
</div>
