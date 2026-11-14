<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import type { Project } from '@yaaabk/projects';
  import { ApiError, deleteProject, getProject } from '#lib/api.js';

  const projectId = $derived(page.params.id);

  let project = $state<Project | null>(null);
  let error = $state<string | null>(null);
  let confirming = $state(false);
  let busy = $state(false);

  function describe(cause: unknown): string {
    return cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.';
  }

  // Load the Project whenever the route id changes.
  $effect(() => {
    const id = projectId;
    if (id === undefined) return;
    let cancelled = false;
    error = null;
    getProject(id)
      .then((next) => {
        if (!cancelled) project = next;
      })
      .catch((cause) => {
        if (!cancelled) error = describe(cause);
      });
    return () => {
      cancelled = true;
    };
  });

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
    }
  }
</script>

<svelte:head>
  <title>{project ? `${project.name} · Project` : 'Project'} · YAAABK</title>
</svelte:head>

<main class="mx-auto flex min-h-dvh max-w-4xl flex-col gap-6 p-6">
  <a href={resolve('/')} class="text-sm text-neutral-500 hover:underline">← Back to projects</a>

  {#if error !== null && project === null}
    <p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>
  {:else if project === null}
    <p class="text-sm text-neutral-500">Loading project…</p>
  {:else}
    <header class="space-y-2">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h1 class="text-2xl font-bold tracking-tight">{project.name}</h1>
        <span class="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">
          {project.skillLevel}
        </span>
      </div>
      <p class="text-neutral-600">{project.description}</p>
    </header>

    {#if error !== null}
      <p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>
    {/if}

    <section class="rounded-lg border border-neutral-200 p-4" aria-labelledby="details-heading">
      <h2 id="details-heading" class="mb-3 text-sm font-semibold">Provisioned resources</h2>
      <dl class="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt class="text-neutral-500">Repository</dt>
          <dd>
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
            <a href={project.repoUrl} target="_blank" rel="noreferrer" class="hover:underline">
              {project.repoFullName}
            </a>
          </dd>
        </div>
        <div>
          <dt class="text-neutral-500">Namespace</dt>
          <dd><code>{project.namespace}</code></dd>
        </div>
        <div>
          <dt class="text-neutral-500">ArgoCD application</dt>
          <dd><code>{project.argoAppName}</code></dd>
        </div>
      </dl>
    </section>

    <section class="rounded-lg border border-neutral-200 p-4" aria-labelledby="actions-heading">
      <h2 id="actions-heading" class="mb-3 text-sm font-semibold">Next steps</h2>
      <div class="flex flex-wrap gap-2">
        <a
          href={resolve('/projects/[id]/plan', { id: project.id })}
          class="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700"
        >
          Grill-Me
        </a>
        <a
          href={resolve('/projects/[id]/issues/review', { id: project.id })}
          class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100"
        >
          Review issues
        </a>
        <span
          class="cursor-not-allowed rounded-md border border-neutral-200 px-3 py-1.5 text-sm text-neutral-400"
          title="Coming soon"
        >
          Issue board
        </span>
        <span
          class="cursor-not-allowed rounded-md border border-neutral-200 px-3 py-1.5 text-sm text-neutral-400"
          title="Coming soon"
        >
          Stats
        </span>
      </div>
    </section>

    <section class="rounded-lg border border-red-200 p-4" aria-labelledby="danger-heading">
      <h2 id="danger-heading" class="mb-3 text-sm font-semibold text-red-700">Danger zone</h2>
      {#if confirming}
        <p class="mb-3 text-sm text-neutral-600">
          This deletes the GitHub repository, namespace and ArgoCD application. It cannot be undone.
        </p>
        <div class="flex gap-2">
          <button
            type="button"
            onclick={() => void remove()}
            disabled={busy}
            class="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50"
          >
            Confirm delete
          </button>
          <button
            type="button"
            onclick={() => (confirming = false)}
            class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100"
          >
            Cancel
          </button>
        </div>
      {:else}
        <button
          type="button"
          onclick={() => (confirming = true)}
          class="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
        >
          Delete project
        </button>
      {/if}
    </section>
  {/if}
</main>
