<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import type { Plan } from '@yaaabk/plans';
  import type { Issue } from '@yaaabk/issues';
  import type { Project } from '@yaaabk/projects';
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
  import { planFilePath, planFileUrl } from '#lib/plan-file.js';
  import { planProgress, planStatusLabel, type PlanLifecycleStatus } from '#lib/plan-lifecycle.js';
  import { projectModeLabel } from '#lib/project-mode.js';
  import Terminal from '#lib/terminal.svelte';
  import { terminalStatusLabel, type TerminalConnectionStatus } from '#lib/terminal-client.js';

  const projectId = $derived(page.params.id);

  let project = $state<Project | null>(null);
  let plans = $state<Plan[]>([]);
  let issues = $state<Issue[]>([]);
  let session = $state<GrillSessionView | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
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

  const draftLabel = $derived(
    session === null
      ? ''
      : `${session.draft.hasPrd ? 'Plan drafted' : 'No Plan yet'} · ${session.draft.issueCount} ${session.draft.issueCount === 1 ? 'issue' : 'issues'} drafted`,
  );

  const statusLabel = $derived(terminalStatusLabel(terminalStatus));

  const statusClass: Record<PlanLifecycleStatus, string> = {
    'not-accepted': 'bg-neutral-100 text-neutral-600',
    'in-progress': 'bg-amber-100 text-amber-800',
    completed: 'bg-emerald-100 text-emerald-800',
  };

  function progressOf(version: Plan) {
    return planProgress(version, issues);
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
    notice = null;
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
    notice = null;
    finishConflict = null;
    confirmingCancel = false;
    busy = true;
    try {
      const published = await finishGrill(projectId, session.id, { force });
      session = null;
      terminalStatus = 'closed';
      terminalError = null;
      await refreshPlans(projectId);
      notice = `Published Plan v${published.plan.version} and ${published.issues.length} ${published.issues.length === 1 ? 'issue' : 'issues'}.`;
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

  function dismissCancel(): void {
    confirmingCancel = false;
  }

  async function cancel(): Promise<void> {
    if (projectId === undefined || session === null || busy) return;
    error = null;
    notice = null;
    finishConflict = null;
    busy = true;
    try {
      await cancelGrill(projectId, session.id);
      session = null;
      confirmingCancel = false;
      notice = 'Session cancelled.';
      terminalStatus = 'closed';
      terminalError = null;
    } catch (cause) {
      error = describe(cause);
    } finally {
      busy = false;
    }
  }

  async function activate(planId: string): Promise<void> {
    if (projectId === undefined || busy) return;
    error = null;
    busy = true;
    try {
      await activatePlan(projectId, planId);
      await refreshPlans(projectId);
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

<main class="mx-auto flex min-h-dvh max-w-4xl flex-col gap-6 p-6">
  <a href={resolve('/')} class="text-sm text-neutral-500 hover:underline">← Back to projects</a>

  {#if loading}
    <p class="text-sm text-neutral-500">Loading project…</p>
  {:else if error !== null && project === null}
    <p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>
  {:else if project !== null}
    <header class="space-y-2">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h1 class="text-2xl font-bold tracking-tight">{project.name}</h1>
        <span class="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">
          {projectModeLabel(project.mode)}
        </span>
      </div>
      <p class="text-neutral-600">{project.description}</p>
      <dl class="flex flex-wrap gap-x-6 gap-y-1 text-sm text-neutral-500">
        <div class="flex gap-1">
          <dt class="font-medium">Repository</dt>
          <dd>
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
            <a href={project.repoUrl} target="_blank" rel="noreferrer" class="hover:underline">
              {project.repoFullName}
            </a>
          </dd>
        </div>
        <div class="flex gap-1">
          <dt class="font-medium">Namespace</dt>
          <dd><code>{project.namespace}</code></dd>
        </div>
        <div class="flex gap-1">
          <dt class="font-medium">Deployed</dt>
          <dd>
            {#if project.deployedCommitSha}<code>{project.deployedCommitSha}</code>{:else}<span
                >Not yet deployed</span
              >{/if}
          </dd>
        </div>
      </dl>
    </header>

    {#if error !== null}
      <p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>
    {/if}
    {#if notice !== null}
      <p class="rounded-md bg-neutral-100 px-3 py-2 text-sm text-neutral-700" role="status">
        {notice}
      </p>
    {/if}

    <section class="rounded-lg border border-neutral-200 p-4" aria-labelledby="grill-heading">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="grill-heading" class="text-sm font-semibold">Agent session</h2>
        {#if session !== null}
          <div class="flex items-center gap-2 text-xs text-neutral-500">
            <span>{session.model}</span>
            <span
              class="rounded-full px-2 py-0.5"
              class:bg-emerald-100={terminalStatus === 'live'}
              class:text-emerald-700={terminalStatus === 'live'}
              class:bg-amber-100={terminalStatus === 'connecting' ||
                terminalStatus === 'reconnecting'}
              class:text-amber-700={terminalStatus === 'connecting' ||
                terminalStatus === 'reconnecting'}
              class:bg-neutral-100={terminalStatus === 'closed'}
              role="status"
            >
              {statusLabel}
            </span>
          </div>
        {/if}
      </div>

      {#if session !== null}
        <div class="flex flex-col gap-2">
          {#if terminalError !== null}
            <p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {terminalError}
            </p>
          {/if}
          <p class="text-xs text-neutral-500" role="status">{draftLabel}</p>
          {#if finishConflict !== null}
            <div class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">
              <p>{finishConflict.message}</p>
              {#if finishHint(finishConflict.missing) !== null}
                <p class="mt-1 text-xs">{finishHint(finishConflict.missing)}</p>
              {/if}
            </div>
          {/if}
          <Terminal url={terminalUrl} status={terminalStatus} onStatus={handleTerminalStatus} />
          <div class="flex flex-wrap gap-2">
            {#if confirmingCancel}
              <p class="w-full rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                Cancel this session? Its draft Plan and Issues will be discarded.
              </p>
              <button
                type="button"
                onclick={() => void cancel()}
                disabled={busy}
                class="rounded-md bg-red-700 px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                Discard and cancel
              </button>
              <button
                type="button"
                onclick={dismissCancel}
                disabled={busy}
                class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50"
              >
                Keep session
              </button>
            {:else}
              {#if finishConflict === null}
                <button
                  type="button"
                  onclick={() => void finish()}
                  disabled={busy}
                  class="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                >
                  Finish
                </button>
              {:else}
                <button
                  type="button"
                  onclick={() => void finish()}
                  disabled={busy}
                  class="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                >
                  Finish again
                </button>
                {#if canForceFinish(finishConflict.missing)}
                  <button
                    type="button"
                    onclick={() => void finish(true)}
                    disabled={busy}
                    class="rounded-md bg-amber-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                  >
                    Publish anyway
                  </button>
                {/if}
              {/if}
              <button
                type="button"
                onclick={requestCancel}
                disabled={busy}
                class="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                Cancel session
              </button>
            {/if}
          </div>
        </div>
      {:else}
        <form
          class="flex flex-col gap-2"
          onsubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <label class="text-sm font-medium" for="idea">Your idea</label>
          <textarea
            id="idea"
            bind:value={idea}
            rows="3"
            class="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            placeholder="Describe the app you want to build…"></textarea>
          <div class="flex flex-col gap-1">
            <label class="text-sm font-medium" for="model">Model</label>
            <input
              id="model"
              list="model-options"
              bind:value={modelChoice}
              class="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
              placeholder={catalogue?.defaultModel ?? 'Provider/model'}
            />
            <datalist id="model-options">
              {#each catalogue?.models ?? [] as option (option.id)}
                <option value={option.id}>{option.name}</option>
              {/each}
            </datalist>
            {#if modelError !== null}
              <p class="text-xs text-amber-700">{modelError}</p>
            {:else}
              <p class="text-xs text-neutral-500">
                Search tool-capable models. The Project remembers your choice.
              </p>
            {/if}
          </div>
          <button
            type="submit"
            disabled={busy || idea.trim() === ''}
            class="self-start rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            Start agent
          </button>
        </form>
      {/if}
    </section>

    {#if plans.length > 0}
      <section class="rounded-lg border border-neutral-200 p-4" aria-labelledby="versions-heading">
        <h2 id="versions-heading" class="mb-2 text-sm font-semibold">Plan versions</h2>
        <ul class="flex flex-col gap-2">
          {#each plans as version (version.id)}
            {@const progress = progressOf(version)}
            <li
              class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-neutral-200 p-3 text-sm"
            >
              <div>
                <div class="flex flex-wrap items-center gap-2">
                  <p class="font-medium">v{version.version}</p>
                  <span class="rounded-full px-2 py-0.5 text-xs {statusClass[progress.status]}">
                    {planStatusLabel(progress.status)}
                  </span>
                </div>
                <p class="text-xs text-neutral-500">
                  {version.createdAt} · {version.source}
                  {#if version.isActive}
                    · active{/if}
                  · {progress.closed}/{progress.total} closed
                  {#if progress.failed > 0}
                    · {progress.failed} failed
                  {/if}
                </p>
                {#if version.acceptedAt !== null}
                  <p class="text-xs text-neutral-500">
                    Record:
                    <!-- eslint-disable svelte/no-navigation-without-resolve -->
                    <a
                      href={planFileUrl(project.repoFullName, version.version)}
                      target="_blank"
                      rel="noreferrer"
                      class="hover:underline"
                    >
                      {planFilePath(version.version)}
                    </a>
                    <!-- eslint-enable svelte/no-navigation-without-resolve -->
                  </p>
                {/if}
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <!-- eslint-disable svelte/no-navigation-without-resolve -->
                <a
                  href={`${resolve('/projects/[id]/issues/review', { id: version.projectId })}?plan=${encodeURIComponent(version.id)}`}
                  class="rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100"
                >
                  Review
                </a>
                <!-- eslint-enable svelte/no-navigation-without-resolve -->
                {#if !version.isActive}
                  <button
                    type="button"
                    onclick={() => void activate(version.id)}
                    disabled={busy}
                    class="rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50"
                  >
                    Activate
                  </button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</main>
