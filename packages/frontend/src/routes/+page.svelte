<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import type { ProjectOverview } from '@yaaabk/stats';
  import { ApiError, getOverview } from '#lib/api.js';
  import PageHeader from '#lib/components/page-header.svelte';
  import { Alert, AlertDescription, AlertTitle } from '#lib/components/ui/alert/index.js';
  import { Badge } from '#lib/components/ui/badge/index.js';
  import { Button } from '#lib/components/ui/button/index.js';
  import {
    Card,
    CardAction,
    CardContent,
    CardFooter,
    CardHeader,
    CardTitle,
  } from '#lib/components/ui/card/index.js';
  import { Skeleton } from '#lib/components/ui/skeleton/index.js';
  import { projectModeLabel } from '#lib/project-mode.js';
  import { resolveShell } from '#lib/shell.js';

  const shell = $derived(resolveShell(page.url.pathname));
  let overviews = $state<ProjectOverview[] | null>(null);
  let error = $state<string | null>(null);
  // Every request gets a sequence number so a stale response from an earlier
  // attempt cannot overwrite the result of a retry.
  let requestId = 0;
  const SKELETON_CARDS = [0, 1, 2, 3, 4, 5];

  // One request loads every card's Project, active Plan, Issue counts and
  // in-flight work. A failure leaves the whole page in its error state.
  async function load(): Promise<void> {
    const id = (requestId += 1);
    overviews = null;
    error = null;
    try {
      const next = await getOverview();
      if (id === requestId) overviews = next;
    } catch (cause) {
      if (id === requestId) {
        error = cause instanceof ApiError ? cause.message : 'Could not load projects.';
      }
    }
  }

  $effect(() => {
    load();
  });

  /** The calendar day of an ISO timestamp, which is all a card needs. */
  function day(at: string): string {
    return at.slice(0, 10);
  }
</script>

<svelte:head>
  <title>Projects · YAAABK</title>
</svelte:head>

<div class="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6">
  <PageHeader
    title="Projects"
    purpose="Every Project, the work in flight and the state of its deployment."
    breadcrumbs={shell.breadcrumbs}
  >
    {#snippet actions()}
      <Button href={resolve('/projects/new')}>New project</Button>
    {/snippet}
  </PageHeader>

  {#if error !== null}
    <Alert variant="destructive" class="border-destructive/30 bg-destructive-subtle">
      <AlertTitle>Could not load projects</AlertTitle>
      <AlertDescription>{error}</AlertDescription>
      <div class="mt-2">
        <Button variant="outline" size="sm" onclick={() => load()}>Retry</Button>
      </div>
    </Alert>
  {:else if overviews === null}
    <div
      data-testid="projects-loading"
      role="region"
      aria-label="Loading projects"
      aria-busy="true"
      class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
    >
      {#each SKELETON_CARDS as index (index)}
        <div data-testid="project-skeleton" aria-hidden="true">
          <Card class="h-full" size="sm">
            <CardHeader>
              <Skeleton class="h-5 w-2/3" />
              <Skeleton class="h-4 w-1/3" />
              <Skeleton class="h-4 w-full" />
            </CardHeader>
            <CardContent class="grid grid-cols-2 gap-3">
              <Skeleton class="h-8 w-full" />
              <Skeleton class="h-8 w-full" />
              <Skeleton class="h-8 w-full" />
              <Skeleton class="h-8 w-full" />
            </CardContent>
          </Card>
        </div>
      {/each}
    </div>
  {:else if overviews.length === 0}
    <div
      class="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-subtle bg-surface px-6 py-12 text-center"
      data-testid="projects-empty"
    >
      <h2 class="text-lg font-medium text-foreground">No projects yet</h2>
      <p class="max-w-md text-sm text-muted-foreground">
        Create a Project to give its Agent a repository, an Issue board and a place to deploy.
      </p>
      <Button href={resolve('/projects/new')} class="mt-2">Create your first project</Button>
    </div>
  {:else}
    <ul class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="project-grid">
      {#each overviews as overview (overview.project.id)}
        {@const project = overview.project}
        {@const active = overview.activeWork.length > 0}
        {@const unaccepted =
          overview.activePlan !== null && overview.activePlan.acceptedAt === null}
        <li class="min-w-0">
          <Card class="h-full" data-testid="project-card">
            <CardHeader>
              <CardTitle>
                <a
                  href={resolve('/projects/[id]', { id: project.id })}
                  class="rounded-sm break-words hover:text-link hover:underline"
                >
                  {project.name}
                </a>
              </CardTitle>
              <CardAction>
                <Badge
                  variant="secondary"
                  class={active
                    ? 'bg-success-subtle text-success'
                    : 'bg-muted text-muted-foreground'}
                >
                  {active ? `Active · ${overview.activeWork.length} running` : 'Idle'}
                </Badge>
              </CardAction>
              <p class="text-muted-foreground text-sm break-words">{project.description}</p>
            </CardHeader>

            <CardContent class="flex flex-1 flex-col gap-3">
              {#if unaccepted}
                <a
                  href={resolve('/projects/[id]/issues/review', { id: project.id })}
                  aria-label={`Plan v${overview.activePlan?.version} not accepted`}
                  data-testid="plan-banner"
                  class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/30 bg-warning-subtle px-3 py-2 text-sm font-medium text-warning hover:underline"
                >
                  <span>Plan v{overview.activePlan?.version} not accepted</span>
                  <span aria-hidden="true">Review plan →</span>
                </a>
              {/if}

              <dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <div class="min-w-0">
                  <dt class="text-muted-foreground">Mode</dt>
                  <dd class="font-medium text-foreground">{projectModeLabel(project.mode)}</dd>
                </div>
                <div class="min-w-0">
                  <dt class="text-muted-foreground">Issues</dt>
                  <dd class="font-medium text-foreground">
                    {overview.issues.open} open · {overview.issues.closed} closed
                  </dd>
                </div>
                <div class="min-w-0">
                  <dt class="text-muted-foreground">Last run</dt>
                  <dd class="font-medium text-foreground">
                    {#if overview.lastRunAt}
                      <time datetime={overview.lastRunAt} class="whitespace-nowrap"
                        >{day(overview.lastRunAt)}</time
                      >
                    {:else}
                      —
                    {/if}
                  </dd>
                </div>
                <div class="min-w-0">
                  <dt class="text-muted-foreground">Last deploy</dt>
                  <dd class="font-medium text-foreground">
                    {#if project.lastDeployStatus === null}
                      —
                    {:else}
                      <span
                        class="whitespace-nowrap {project.lastDeployStatus === 'failed'
                          ? 'text-destructive'
                          : ''}"
                      >
                        {project.lastDeployStatus === 'failed' ? 'Failed' : 'Succeeded'}
                      </span>
                      {#if project.lastDeployAt}
                        ·
                        <time datetime={project.lastDeployAt} class="whitespace-nowrap"
                          >{day(project.lastDeployAt)}</time
                        >
                      {/if}
                    {/if}
                  </dd>
                </div>
                <div class="col-span-2 min-w-0">
                  <dt class="text-muted-foreground">Namespace</dt>
                  <dd class="font-mono font-medium break-all text-foreground">
                    {project.namespace}
                  </dd>
                </div>
              </dl>
            </CardContent>

            <CardFooter class="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                href={resolve('/projects/[id]/plan', { id: project.id })}
              >
                Plan
              </Button>
              <Button
                variant="outline"
                size="sm"
                href={resolve('/projects/[id]/issues', { id: project.id })}
              >
                Issues
              </Button>
              <Button
                variant="outline"
                size="sm"
                href={resolve('/projects/[id]/stats', { id: project.id })}
              >
                Stats
              </Button>
            </CardFooter>
          </Card>
        </li>
      {/each}
    </ul>
  {/if}
</div>
