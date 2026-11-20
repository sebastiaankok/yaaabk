<script lang="ts">
  import { resolve } from '$app/paths';
  import type { ProjectOverview } from '@yaaabk/stats';
  import { ApiError, getOverview } from '#lib/api.js';

  let overviews = $state<ProjectOverview[] | null>(null);
  let error = $state<string | null>(null);

  // One request loads every card's Project, active Plan, Issue counts and
  // in-flight work. A failure leaves the whole page in its error state.
  $effect(() => {
    let cancelled = false;
    getOverview()
      .then((next) => {
        if (!cancelled) overviews = next;
      })
      .catch((cause) => {
        if (!cancelled) {
          error = cause instanceof ApiError ? cause.message : 'Could not load projects.';
        }
      });
    return () => {
      cancelled = true;
    };
  });
</script>

<svelte:head>
  <title>Projects · YAAABK</title>
</svelte:head>

<main class="mx-auto flex min-h-dvh max-w-4xl flex-col gap-6 p-6">
  <header class="flex flex-wrap items-center justify-between gap-3">
    <h1 class="text-2xl font-bold tracking-tight">Projects</h1>
    <a
      href={resolve('/projects/new')}
      class="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700"
    >
      New project
    </a>
  </header>

  {#if error !== null}
    <p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>
  {:else if overviews === null}
    <p class="text-sm text-neutral-500">Loading projects…</p>
  {:else if overviews.length === 0}
    <div class="rounded-lg border border-dashed border-neutral-300 p-8 text-center">
      <p class="text-neutral-600">No projects yet</p>
      <a
        href={resolve('/projects/new')}
        class="mt-2 inline-block text-sm font-medium text-neutral-900 underline"
      >
        Create your first project
      </a>
    </div>
  {:else}
    <ul class="grid gap-3 sm:grid-cols-2">
      {#each overviews as overview (overview.project.id)}
        {@const project = overview.project}
        {@const active = overview.activeWork.length > 0}
        <li class="flex flex-col rounded-lg border border-neutral-200 p-4">
          <div class="flex items-start justify-between gap-2">
            <a
              href={resolve('/projects/[id]', { id: project.id })}
              class="text-lg font-semibold hover:underline"
            >
              {project.name}
            </a>
            <span
              class="rounded-full px-2 py-0.5 text-xs {active
                ? 'bg-emerald-100 text-emerald-800'
                : 'bg-neutral-100 text-neutral-600'}"
            >
              {active ? `Active · ${overview.activeWork.length} running` : 'Idle'}
            </span>
          </div>
          <p class="mt-1 text-sm text-neutral-600">{project.description}</p>
          {#if overview.activePlan !== null && overview.activePlan.acceptedAt === null}
            <a
              href={resolve('/projects/[id]/issues/review', { id: project.id })}
              class="mt-2 inline-block text-sm font-medium text-amber-700 hover:underline"
            >
              Plan v{overview.activePlan.version} not accepted
            </a>
          {/if}
          <dl class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500">
            <div class="flex gap-1">
              <dt class="font-medium">Issues</dt>
              <dd>{overview.issues.open} open · {overview.issues.closed} closed</dd>
            </div>
            <div class="flex gap-1">
              <dt class="font-medium">Last run</dt>
              <dd>
                {#if overview.lastRunAt}
                  <time datetime={overview.lastRunAt}>{overview.lastRunAt.slice(0, 10)}</time>
                {:else}
                  —
                {/if}
              </dd>
            </div>
            <div class="flex gap-1">
              <dt class="font-medium">Last deploy</dt>
              <dd>
                {#if project.lastDeployStatus === null}
                  —
                {:else}
                  <span class={project.lastDeployStatus === 'failed' ? 'text-red-700' : ''}>
                    {project.lastDeployStatus === 'failed' ? 'Failed' : 'Succeeded'}
                  </span>
                  {#if project.lastDeployAt}
                    <time datetime={project.lastDeployAt}>{project.lastDeployAt.slice(0, 10)}</time>
                  {/if}
                {/if}
              </dd>
            </div>
            <div class="flex gap-1">
              <dt class="font-medium">Skill</dt>
              <dd>{project.skillLevel}</dd>
            </div>
            <div class="flex gap-1">
              <dt class="font-medium">Namespace</dt>
              <dd><code>{project.namespace}</code></dd>
            </div>
          </dl>
          <div class="mt-4 flex flex-wrap gap-2 text-sm">
            <a
              href={resolve('/projects/[id]/plan', { id: project.id })}
              class="rounded-md border border-neutral-300 px-2.5 py-1 hover:bg-neutral-100"
            >
              Agent
            </a>
            <a
              href={resolve('/projects/[id]/issues', { id: project.id })}
              class="rounded-md border border-neutral-300 px-2.5 py-1 hover:bg-neutral-100"
            >
              Issue board
            </a>
            <a
              href={resolve('/projects/[id]/stats', { id: project.id })}
              class="rounded-md border border-neutral-300 px-2.5 py-1 hover:bg-neutral-100"
            >
              Stats
            </a>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</main>
