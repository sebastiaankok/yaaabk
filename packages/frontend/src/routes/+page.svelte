<script lang="ts">
  import { resolve } from '$app/paths';
  import type { Project } from '@yaaabk/projects';
  import type { ProjectStats } from '@yaaabk/stats';
  import { ApiError, getProjectStats, listProjects } from '#lib/api.js';

  let projects = $state<Project[] | null>(null);
  let statsById = $state<Record<string, ProjectStats>>({});
  let error = $state<string | null>(null);

  // Load the Project list once when the page mounts, then enrich each card with
  // its stats. A stats failure only leaves that card's summary blank.
  $effect(() => {
    let cancelled = false;
    listProjects()
      .then(async (next) => {
        if (cancelled) return;
        projects = next;
        const results = await Promise.allSettled(
          next.map(async (project) => ({
            id: project.id,
            stats: await getProjectStats(project.id),
          })),
        );
        if (cancelled) return;
        const loaded: Record<string, ProjectStats> = {};
        for (const result of results) {
          if (result.status === 'fulfilled') loaded[result.value.id] = result.value.stats;
        }
        statsById = loaded;
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
  {:else if projects === null}
    <p class="text-sm text-neutral-500">Loading projects…</p>
  {:else if projects.length === 0}
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
      {#each projects as project (project.id)}
        {@const stats = statsById[project.id]}
        {@const active = (stats?.agents.active ?? 0) > 0}
        {@const lastRun = stats?.runs[0]}
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
              {active ? 'Active' : 'Idle'}
            </span>
          </div>
          <p class="mt-1 text-sm text-neutral-600">{project.description}</p>
          <dl class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500">
            <div class="flex gap-1">
              <dt class="font-medium">Issues</dt>
              <dd>
                {#if stats}
                  {stats.issues.open} open · {stats.issues.closed} closed
                {:else}
                  —
                {/if}
              </dd>
            </div>
            <div class="flex gap-1">
              <dt class="font-medium">Last run</dt>
              <dd>
                {#if lastRun}
                  <time datetime={lastRun.createdAt}>{lastRun.createdAt.slice(0, 10)}</time>
                {:else}
                  —
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
              Grill-Me
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
