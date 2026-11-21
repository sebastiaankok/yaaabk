<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import type { ProjectOverview } from '@yaaabk/stats';
  import {
    ApiError,
    deleteProject,
    exportProject,
    getProjectOverview,
    listModels,
    updateProject,
    type ModelCatalogueView,
  } from '#lib/api.js';
  import { runLabel } from '#lib/agent-run.js';
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
    Trigger as DialogTrigger,
  } from '#lib/components/ui/dialog/index.js';
  import { Input } from '#lib/components/ui/input/index.js';
  import { hasErrors, validateExportTarget, type ExportTargetErrors } from '#lib/export-project.js';
  import { pollWhileVisible } from '#lib/polling.js';
  import { projectModeLabel } from '#lib/project-mode.js';
  import { nextAction } from '#lib/project-overview.js';
  import { resolveShell } from '#lib/shell.js';

  const projectId = $derived(page.params.id);

  let overview = $state<ProjectOverview | null>(null);
  const project = $derived(overview?.project ?? null);
  const shell = $derived(resolveShell(page.url.pathname, project?.name));
  const action = $derived(overview === null ? null : nextAction(overview.activePlan));
  let error = $state<string | null>(null);
  let confirming = $state(false);
  let busy = $state(false);

  let catalogue = $state<ModelCatalogueView | null>(null);
  let catalogueError = $state<string | null>(null);
  let agentModel = $state('');
  let modelSaving = $state(false);
  let modelStatus = $state<string | null>(null);
  let modelError = $state<string | null>(null);

  /** The model issues use when they have no override of their own. */
  const effectiveAgentModel = $derived(
    project?.agentModel ?? catalogue?.defaultModel ?? 'the environment default',
  );

  let exportOwner = $state('');
  let exportRepoName = $state('');
  let exportErrors = $state<ExportTargetErrors>({});
  let exporting = $state(false);
  let exportSuccess = $state<string | null>(null);

  function describe(cause: unknown): string {
    return cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.';
  }

  /** The date and time of a run, trimmed to the minute, in the API's UTC form. */
  function clock(at: string): string {
    return at.slice(0, 16).replace('T', ' ');
  }

  // Load the Project whenever the route id changes, plus the catalogue the
  // agent-model selector offers.
  $effect(() => {
    const id = projectId;
    if (id === undefined) return;
    let cancelled = false;
    error = null;
    Promise.all([getProjectOverview(id), listModels().catch(() => null)])
      .then(([next, models]) => {
        if (cancelled) return;
        overview = next;
        agentModel = next.project.agentModel ?? '';
        catalogue = models;
        catalogueError =
          models === null
            ? 'Could not load the model catalogue. You can still clear the choice.'
            : null;
      })
      .catch((cause) => {
        if (!cancelled) error = describe(cause);
      });
    return () => {
      cancelled = true;
    };
  });

  // Keep the in-flight work and the Plan banner fresh while the page is on
  // screen. Only the overview is replaced: the agent-model input and the export
  // form hold their own state, so a poll must not write over what the Developer
  // has typed but not saved.
  $effect(() => {
    const id = projectId;
    if (id === undefined) return;
    let cancelled = false;
    const stop = pollWhileVisible({
      intervalMs: 10_000,
      isVisible: () => document.visibilityState === 'visible',
      onVisibilityChange: (listener) => {
        document.addEventListener('visibilitychange', listener);
        return () => document.removeEventListener('visibilitychange', listener);
      },
      poll: () =>
        getProjectOverview(id)
          .then((next) => {
            if (!cancelled) overview = next;
          })
          .catch(() => undefined),
    });
    return () => {
      cancelled = true;
      stop();
    };
  });

  /** Saves the project-wide model for issue agents; an empty choice clears it. */
  async function saveAgentModel(): Promise<void> {
    if (projectId === undefined || project === null || modelSaving) return;
    modelSaving = true;
    modelStatus = null;
    modelError = null;
    try {
      const updated = await updateProject(projectId, {
        agentModel: agentModel.trim() === '' ? null : agentModel.trim(),
      });
      if (overview !== null) overview = { ...overview, project: updated };
      agentModel = updated.agentModel ?? '';
      modelStatus = 'Saved';
    } catch (cause) {
      agentModel = project.agentModel ?? '';
      modelError = describe(cause);
    } finally {
      modelSaving = false;
    }
  }

  async function transferProject(): Promise<void> {
    if (projectId === undefined || exporting) return;
    const target = { owner: exportOwner, repoName: exportRepoName };
    exportErrors = validateExportTarget(target);
    if (hasErrors(exportErrors)) return;
    exporting = true;
    error = null;
    exportSuccess = null;
    try {
      const updated = await exportProject(projectId, target);
      if (overview !== null) overview = { ...overview, project: updated };
      exportSuccess = `Project exported to ${updated.repoFullName}`;
      exportOwner = '';
      exportRepoName = '';
    } catch (cause) {
      error = describe(cause);
    } finally {
      exporting = false;
    }
  }

  async function remove(): Promise<void> {
    if (projectId === undefined || busy) return;
    busy = true;
    error = null;
    try {
      await deleteProject(projectId);
      await goto(resolve('/'));
    } catch (cause) {
      error = describe(cause);
      busy = false;
      confirming = false;
    }
  }
</script>

<svelte:head>
  <title>{project ? `${project.name} · Project` : 'Project'} · YAAABK</title>
</svelte:head>

{#if error !== null && project === null}
  <p class="rounded-md bg-destructive-subtle px-3 py-2 text-sm text-destructive" role="alert">
    {error}
  </p>
{:else if project === null}
  <p class="text-sm text-muted-foreground">Loading project…</p>
{:else}
  <PageHeader title={project.name} purpose={project.description} breadcrumbs={shell.breadcrumbs}>
    {#snippet actions()}
      <div class="flex w-full min-w-0 flex-col gap-3 sm:w-auto sm:items-end">
        <ul class="flex flex-wrap gap-2" aria-label="Project status">
          <li>
            <Badge variant="secondary">{projectModeLabel(project.mode)} mode</Badge>
          </li>
          <li>
            {#if project.lastDeployStatus === null}
              <Badge variant="outline" class="text-muted-foreground">Never deployed</Badge>
            {:else}
              <Badge
                variant="secondary"
                class={project.lastDeployStatus === 'failed'
                  ? 'bg-destructive-subtle text-destructive'
                  : 'bg-success-subtle text-success'}
              >
                {project.lastDeployStatus === 'failed' ? 'Deploy failed' : 'Deploy succeeded'}
                {#if project.lastDeployAt}
                  <span class="text-muted-foreground">
                    · <time datetime={project.lastDeployAt}
                      >{project.lastDeployAt.slice(0, 10)}</time
                    >
                  </span>
                {/if}
              </Badge>
            {/if}
          </li>
          <li>
            <Badge variant="outline" class="font-mono">
              <span class="sr-only">Namespace </span>{project.namespace}
            </Badge>
          </li>
        </ul>
        {#if action !== null}
          <div class="flex w-full min-w-0 flex-col gap-1 sm:w-auto sm:items-end">
            <Button
              href={action.id === 'start-plan'
                ? resolve('/projects/[id]/plan', { id: project.id })
                : action.id === 'review-plan'
                  ? resolve('/projects/[id]/issues/review', { id: project.id })
                  : resolve('/projects/[id]/issues', { id: project.id })}
              class="h-11 w-full px-5 text-base sm:w-auto"
              data-testid="primary-action"
            >
              {action.label}
            </Button>
            <p class="text-xs text-muted-foreground sm:max-w-72 sm:text-right">{action.detail}</p>
          </div>
        {/if}
      </div>
    {/snippet}
    {#snippet tabs()}
      <ProjectTabs projectId={project.id} activeTab={shell.activeProjectTab} />
    {/snippet}
  </PageHeader>

  {#if overview !== null}
    <Card aria-labelledby="active-work-heading">
      <CardHeader>
        <h2 id="active-work-heading" class="text-lg font-medium tracking-tight">Active work</h2>
        <p class="text-sm text-muted-foreground">
          Agent runs that are queued or running right now.
        </p>
      </CardHeader>
      <CardContent>
        {#if overview.activeWork.length === 0}
          <p class="text-sm text-muted-foreground">Idle — no agent runs in flight.</p>
        {:else}
          <ul class="flex flex-col gap-2">
            {#each overview.activeWork as run (run.id)}
              <li>
                <!-- eslint-disable svelte/no-navigation-without-resolve -- the issue id belongs in the query string -->
                <a
                  href={`${resolve('/projects/[id]/issues', { id: project.id })}?issue=${encodeURIComponent(run.issueId)}`}
                  class="hover:bg-muted/60 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border-subtle px-3 py-2.5 text-sm transition-colors"
                >
                  <span class="font-medium text-foreground">{run.issueTitle}</span>
                  <span class="text-muted-foreground">{runLabel(run)}</span>
                  <Badge
                    variant="secondary"
                    class={run.status === 'running'
                      ? 'bg-info-subtle text-info'
                      : 'bg-muted text-muted-foreground'}
                  >
                    {run.status}
                  </Badge>
                  <span class="text-xs text-muted-foreground">
                    {run.startedAt === null ? 'Queued' : 'Started'}
                    <time datetime={run.startedAt ?? run.createdAt}>
                      {clock(run.startedAt ?? run.createdAt)}
                    </time>
                  </span>
                </a>
                <!-- eslint-enable svelte/no-navigation-without-resolve -->
              </li>
            {/each}
          </ul>
        {/if}
      </CardContent>
    </Card>
  {/if}

  {#if error !== null}
    <p class="bg-destructive-subtle text-destructive rounded-lg px-3 py-2 text-sm" role="alert">
      {error}
    </p>
  {/if}

  <div class="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2" data-testid="project-details">
    <Card aria-labelledby="details-heading" data-testid="provisioned-resources">
      <CardHeader>
        <h2 id="details-heading" class="text-lg font-medium tracking-tight">
          Provisioned resources
        </h2>
        <p class="text-sm text-muted-foreground">What YAAABK created for this Project.</p>
      </CardHeader>
      <CardContent>
        <dl class="grid gap-4 text-sm sm:grid-cols-2">
          <div class="min-w-0">
            <dt class="text-muted-foreground">Repository</dt>
            <dd class="min-w-0 break-words">
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
          <div class="min-w-0">
            <dt class="text-muted-foreground">Namespace</dt>
            <dd class="font-mono break-all"><code>{project.namespace}</code></dd>
          </div>
          <div class="min-w-0">
            <dt class="text-muted-foreground">Deployed commit</dt>
            <dd class="font-mono break-all">
              {#if project.deployedCommitSha}<code>{project.deployedCommitSha}</code>{:else}<span
                  class="font-sans text-muted-foreground">Not yet deployed</span
                >{/if}
            </dd>
          </div>
          <div class="min-w-0">
            <dt class="text-muted-foreground">Last deploy</dt>
            <dd>
              {#if project.lastDeployStatus === null}
                <span class="text-muted-foreground">Never deployed</span>
              {:else}
                <span
                  class={project.lastDeployStatus === 'failed'
                    ? 'text-destructive'
                    : 'text-success'}
                >
                  {project.lastDeployStatus === 'failed' ? 'Failed' : 'Succeeded'}
                </span>
                {#if project.lastDeployAt}
                  <span class="text-muted-foreground">
                    · <time datetime={project.lastDeployAt}
                      >{project.lastDeployAt.slice(0, 10)}</time
                    >
                  </span>
                {/if}
              {/if}
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>

    <Card aria-labelledby="agent-model-heading" data-testid="agent-model-card">
      <CardHeader>
        <h2 id="agent-model-heading" class="text-lg font-medium tracking-tight">
          Issue agent model
        </h2>
        <p class="text-sm text-muted-foreground">
          Issues use their own model first, then this default, then the environment default.
        </p>
      </CardHeader>
      <CardContent>
        <label class="flex flex-col gap-2 text-sm font-medium text-foreground" for="agent-model">
          Default agent model
          <Input
            id="agent-model"
            list="agent-model-options"
            bind:value={agentModel}
            onchange={() => void saveAgentModel()}
            placeholder={catalogue?.defaultModel ?? 'Environment default'}
            class="h-11 max-w-md px-3 text-base md:text-sm"
          />
        </label>
        <datalist id="agent-model-options">
          {#each catalogue?.models ?? [] as option (option.id)}
            <option value={option.id}>{option.name}</option>
          {/each}
        </datalist>
        <p class="mt-2 text-xs text-muted-foreground">
          Used by issues without an override: <code>{effectiveAgentModel}</code>
        </p>
        <div aria-live="polite" class="mt-1 min-h-5">
          {#if modelSaving}
            <p class="text-xs text-muted-foreground">Saving…</p>
          {:else if modelStatus !== null}
            <p class="text-success text-xs">{modelStatus}</p>
          {/if}
        </div>
        {#if modelError !== null}
          <p class="text-destructive mt-1 text-xs" role="alert">{modelError}</p>
        {/if}
        {#if catalogueError !== null}
          <p class="text-warning mt-1 text-xs">{catalogueError}</p>
        {/if}
      </CardContent>
    </Card>
  </div>

  <details class="group bg-card rounded-xl border border-border-subtle" data-testid="advanced">
    <summary
      class="hover:bg-muted/60 flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-4 py-3 text-sm font-medium transition-colors [&::-webkit-details-marker]:hidden"
    >
      Advanced
      <ChevronDown class="size-4 transition-transform group-open:rotate-180" aria-hidden="true" />
    </summary>
    <div class="flex flex-col gap-6 border-t border-border-subtle p-4">
      <section class="min-w-0" aria-labelledby="export-heading">
        <h2 id="export-heading" class="text-sm font-semibold text-foreground">Export project</h2>
        <p class="mt-1 mb-3 text-sm text-muted-foreground">
          Transfer this repository to your own GitHub account. YAAABK grants you access and moves
          the repository.
        </p>
        {#if exportSuccess !== null}
          <p class="bg-success-subtle text-success mb-3 rounded-lg px-3 py-2 text-sm" role="status">
            {exportSuccess}
          </p>
        {/if}
        <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
          <label class="flex min-w-0 flex-col gap-1 text-sm">
            <span class="text-muted-foreground">GitHub username</span>
            <Input
              type="text"
              bind:value={exportOwner}
              aria-label="GitHub username"
              class="h-11 px-3 text-base sm:w-48 md:text-sm"
            />
            {#if exportErrors.owner !== undefined}
              <span class="text-destructive text-xs">{exportErrors.owner}</span>
            {/if}
          </label>
          <label class="flex min-w-0 flex-col gap-1 text-sm">
            <span class="text-muted-foreground">Repository name (optional)</span>
            <Input
              type="text"
              bind:value={exportRepoName}
              aria-label="Repository name"
              placeholder={project.name}
              class="h-11 px-3 text-base sm:w-48 md:text-sm"
            />
            {#if exportErrors.repoName !== undefined}
              <span class="text-destructive text-xs">{exportErrors.repoName}</span>
            {/if}
          </label>
          <Button
            type="button"
            onclick={() => void transferProject()}
            disabled={exporting}
            class="h-11 sm:mt-5"
          >
            {exporting ? 'Transferring…' : 'Transfer'}
          </Button>
        </div>
      </section>

      <section
        class="min-w-0 rounded-lg border border-destructive/30 p-4"
        aria-labelledby="danger-heading"
      >
        <h2 id="danger-heading" class="text-sm font-semibold text-destructive">Delete project</h2>
        <p class="mt-1 mb-3 text-sm text-muted-foreground">
          Deleting this Project removes its GitHub repository, its namespace and its deployment.
        </p>
        <DialogRoot bind:open={confirming}>
          <DialogTrigger>
            {#snippet child({ props })}
              <Button
                {...props}
                variant="outline"
                class="border-destructive/40 text-destructive hover:bg-destructive-subtle h-11"
              >
                Delete project
              </Button>
            {/snippet}
          </DialogTrigger>
          <DialogContent>
            <DialogTitle>Delete {project.name}?</DialogTitle>
            <DialogDescription>
              This permanently deletes the GitHub repository <strong>{project.repoFullName}</strong
              >, the namespace <code>{project.namespace}</code> and everything YAAABK provisioned for
              this Project. Deployments stop immediately. This cannot be undone.
            </DialogDescription>
            <div class="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <DialogClose>
                {#snippet child({ props })}
                  <Button {...props} variant="outline" class="h-11">Cancel</Button>
                {/snippet}
              </DialogClose>
              <Button
                variant="destructive"
                class="bg-destructive text-destructive-foreground hover:bg-destructive/90 h-11"
                disabled={busy}
                onclick={() => void remove()}
              >
                {busy ? 'Deleting…' : 'Confirm delete'}
              </Button>
            </div>
          </DialogContent>
        </DialogRoot>
      </section>
    </div>
  </details>
{/if}
