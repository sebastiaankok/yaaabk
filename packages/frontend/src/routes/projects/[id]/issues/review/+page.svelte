<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import type { IssueSyncStatus } from '@yaaabk/github';
  import type { Issue, IssueGraph, IssueLabel } from '@yaaabk/issues';
  import type { Plan } from '@yaaabk/plans';
  import type { Project } from '@yaaabk/projects';
  import {
    ApiError,
    approveIssues,
    generateIssues,
    getActivePlan,
    getIssueGraph,
    getIssueSyncStatus,
    getProject,
    listIssues,
    pushIssues,
    refineIssues,
    syncIssues,
  } from '#lib/api.js';
  import { groupByWave, reviewItems, type WaveGroup } from '#lib/issue-review.js';
  import { describePush, describeSyncStatus } from '#lib/issue-sync.js';
  import { renderMarkdown } from '#lib/markdown.js';

  const projectId = $derived(page.params.id);

  let project = $state<Project | null>(null);
  let plan = $state<Plan | null>(null);
  let issues = $state<Issue[]>([]);
  let graph = $state<IssueGraph | null>(null);
  let syncStatus = $state<IssueSyncStatus | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let feedback = $state('');
  let approved = $state(false);
  let syncMessage = $state<string | null>(null);

  const groups = $derived<WaveGroup[]>(
    graph === null ? [] : groupByWave(reviewItems(issues, graph)),
  );

  const labelClass: Record<IssueLabel, string> = {
    ready: 'bg-emerald-100 text-emerald-800',
    'refinement-needed': 'bg-amber-100 text-amber-800',
    blocked: 'bg-neutral-200 text-neutral-700',
    'needs-human': 'bg-red-100 text-red-800',
  };

  function describe(cause: unknown): string {
    return cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.';
  }

  async function refresh(id: string): Promise<void> {
    const [nextProject, nextPlan, nextIssues, nextGraph, nextSyncStatus] = await Promise.all([
      getProject(id),
      getActivePlan(id),
      listIssues(id),
      getIssueGraph(id),
      getIssueSyncStatus(id),
    ]);
    project = nextProject;
    plan = nextPlan;
    issues = nextIssues;
    graph = nextGraph;
    syncStatus = nextSyncStatus;
  }

  // Load the project, its active plan and the generated issues once the route is known.
  $effect(() => {
    const id = projectId;
    if (id === undefined) return;
    let cancelled = false;
    loading = true;
    error = null;
    approved = false;
    syncMessage = null;
    refresh(id)
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

  async function generate(): Promise<void> {
    if (projectId === undefined || busy) return;
    error = null;
    busy = true;
    try {
      await generateIssues(projectId);
      await refresh(projectId);
    } catch (cause) {
      error = describe(cause);
    } finally {
      busy = false;
    }
  }

  async function refine(): Promise<void> {
    if (projectId === undefined || busy || feedback.trim() === '') return;
    error = null;
    busy = true;
    try {
      await refineIssues(projectId, feedback.trim());
      feedback = '';
      await refresh(projectId);
    } catch (cause) {
      error = describe(cause);
    } finally {
      busy = false;
    }
  }

  async function approve(): Promise<void> {
    if (projectId === undefined || busy) return;
    error = null;
    busy = true;
    try {
      await approveIssues(projectId);
      const push = await pushIssues(projectId);
      await refresh(projectId);
      approved = true;
      syncMessage = describePush(push);
    } catch (cause) {
      error = describe(cause);
    } finally {
      busy = false;
    }
  }

  async function syncWithGitHub(): Promise<void> {
    if (projectId === undefined || busy) return;
    error = null;
    busy = true;
    try {
      const result = await syncIssues(projectId);
      await refresh(projectId);
      syncMessage = describePush(result.push);
    } catch (cause) {
      error = describe(cause);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head>
  <title>{project ? `${project.name} · Issues` : 'Issues'} · YAAABK</title>
</svelte:head>

<main class="mx-auto flex min-h-dvh max-w-4xl flex-col gap-6 p-6">
  <a
    href={projectId === undefined ? resolve('/') : resolve('/projects/[id]', { id: projectId })}
    class="text-sm text-neutral-500 hover:underline"
  >
    ← Back to project
  </a>

  {#if loading}
    <p class="text-sm text-neutral-500">Loading issues…</p>
  {:else if error !== null && project === null}
    <p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>
  {:else if project !== null}
    <header class="space-y-2">
      <h1 class="text-2xl font-bold tracking-tight">Review issues</h1>
      <p class="text-neutral-600">
        Review the issues generated for <span class="font-medium">{project.name}</span>, refine them
        with a prompt, then approve them to make them ready for agents.
      </p>
    </header>

    {#if error !== null}
      <p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>
    {/if}

    {#if approved}
      <p class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">
        Issues approved.
        <a
          href={resolve('/projects/[id]/issues', { id: project.id })}
          class="font-medium underline"
        >
          Open the issue board</a
        >.
      </p>
    {/if}

    {#if syncStatus !== null}
      <section
        class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 p-4"
        aria-labelledby="sync-heading"
      >
        <div>
          <h2 id="sync-heading" class="text-sm font-semibold">GitHub sync</h2>
          <p class="text-xs text-neutral-500">
            {describeSyncStatus(syncStatus)}{#if syncStatus.lastSyncedAt !== null}<span>
                · last synced {new Date(syncStatus.lastSyncedAt).toLocaleString()}</span
              >{/if}
          </p>
          {#if syncMessage !== null}
            <p class="mt-1 text-xs text-emerald-700" role="status">{syncMessage}</p>
          {/if}
        </div>
        <button
          type="button"
          onclick={() => void syncWithGitHub()}
          disabled={busy || issues.length === 0}
          class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50"
        >
          Sync with GitHub
        </button>
      </section>
    {/if}

    {#if plan !== null}
      <section class="rounded-lg border border-neutral-200 p-4" aria-labelledby="plan-heading">
        <div class="mb-2 flex items-center justify-between gap-2">
          <h2 id="plan-heading" class="text-sm font-semibold">Active plan</h2>
          <span class="text-xs text-neutral-500">v{plan.version}</span>
        </div>
        <div class="prose prose-neutral max-w-none text-sm">
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          {@html renderMarkdown(plan.contentMarkdown)}
        </div>
      </section>
    {:else}
      <p class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
        This project has no active plan yet.
        <a href={resolve('/projects/[id]/plan', { id: project.id })} class="font-medium underline">
          Start a Grill-Me session</a
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
          Break these before approving, or the issues cannot be ordered into waves.
        </p>
        <ul class="list-inside list-disc">
          {#each graph.cycles as cycle (cycle.join('-'))}
            <li>{cycle.join(' → ')} → {cycle[0]}</li>
          {/each}
        </ul>
      </section>
    {/if}

    <section class="rounded-lg border border-neutral-200 p-4" aria-labelledby="issues-heading">
      <div class="mb-3 flex items-center justify-between gap-2">
        <h2 id="issues-heading" class="text-sm font-semibold">
          Generated issues ({issues.length})
        </h2>
        {#if issues.length === 0 && plan !== null}
          <button
            type="button"
            onclick={() => void generate()}
            disabled={busy}
            class="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            Generate from plan
          </button>
        {/if}
      </div>

      {#if issues.length === 0}
        <p class="text-sm text-neutral-500">
          No issues yet. Run a Grill-Me session, or generate them from the active plan.
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
                      <span class="rounded-full px-2 py-0.5 text-xs {labelClass[item.issue.label]}">
                        {item.issue.label}
                      </span>
                    </div>
                    {#if item.issue.body !== ''}
                      <p class="mt-1 whitespace-pre-wrap text-neutral-600">{item.issue.body}</p>
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

    {#if plan !== null}
      <section class="rounded-lg border border-neutral-200 p-4" aria-labelledby="refine-heading">
        <h2 id="refine-heading" class="mb-2 text-sm font-semibold">Refine with prompt</h2>
        <form
          class="flex flex-col gap-2"
          onsubmit={(event) => {
            event.preventDefault();
            void refine();
          }}
        >
          <label class="sr-only" for="feedback">Refinement feedback</label>
          <textarea
            id="feedback"
            bind:value={feedback}
            rows="3"
            class="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            placeholder="e.g. Split the auth issue into login and signup"></textarea>
          <div class="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={busy || feedback.trim() === ''}
              class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50"
            >
              Refine
            </button>
            <button
              type="button"
              onclick={() => void approve()}
              disabled={busy || issues.length === 0}
              class="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              Approve &amp; Create
            </button>
            <a
              href={resolve('/projects/[id]/plan', { id: project.id })}
              class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100"
            >
              Back to grill-me
            </a>
          </div>
        </form>
      </section>
    {/if}
  {/if}
</main>
