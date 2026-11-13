<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import type { GeneratedIssue } from '@yaaabk/grill-me';
  import type { Plan } from '@yaaabk/plans';
  import type { Project } from '@yaaabk/projects';
  import {
    ApiError,
    activatePlan,
    cancelGrill,
    getActivePlan,
    getProject,
    listPlans,
    openGrillStream,
    startGrill,
    submitAnswer,
    type GrillEndedEvent,
    type GrillErrorEvent,
    type GrillIssuesEvent,
    type GrillPlanReadyEvent,
    type GrillQuestionEvent,
    type GrillTokenEvent,
  } from '#lib/api.js';
  import { renderMarkdown } from '#lib/markdown.js';

  interface ChatMessage {
    role: 'ai' | 'user' | 'system';
    text: string;
  }

  const projectId = $derived(page.params.id);

  let project = $state<Project | null>(null);
  let plans = $state<Plan[]>([]);
  let activePlan = $state<Plan | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  let idea = $state('');
  let answerText = $state('');
  let sessionId = $state<string | null>(null);
  let messages = $state<ChatMessage[]>([]);
  let streaming = $state('');
  let typing = $state(false);
  let reconnecting = $state(false);
  let ended = $state(false);
  let plan = $state<string | null>(null);
  let issues = $state<GeneratedIssue[]>([]);
  let busy = $state(false);

  let chatRef = $state<HTMLDivElement | null>(null);
  let source: EventSource | null = null;

  function describe(cause: unknown): string {
    return cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.';
  }

  async function refreshPlans(): Promise<void> {
    if (projectId === undefined) return;
    try {
      const [nextPlans, nextActive] = await Promise.all([
        listPlans(projectId),
        getActivePlan(projectId),
      ]);
      plans = nextPlans;
      activePlan = nextActive;
    } catch (cause) {
      error = describe(cause);
    }
  }

  // Load the project and its plan history once the route is known.
  $effect(() => {
    const id = projectId;
    if (id === undefined) return;
    let cancelled = false;
    loading = true;
    error = null;
    Promise.all([getProject(id), listPlans(id), getActivePlan(id)])
      .then(([nextProject, nextPlans, nextActive]) => {
        if (cancelled) return;
        project = nextProject;
        plans = nextPlans;
        activePlan = nextActive;
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

  // Close the SSE stream when the page goes away.
  $effect(() => {
    return () => {
      source?.close();
      source = null;
    };
  });

  // Keep the newest message in view.
  $effect(() => {
    if (chatRef === null) return;
    void messages.length;
    void streaming;
    void typing;
    chatRef.scrollTop = chatRef.scrollHeight;
  });

  function openStream(): void {
    if (projectId === undefined || sessionId === null) return;
    source?.close();
    const next = openGrillStream(projectId, sessionId);
    source = next;

    next.onopen = () => {
      reconnecting = false;
    };
    next.onerror = () => {
      reconnecting = true;
    };
    next.addEventListener('token', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as GrillTokenEvent;
      typing = true;
      streaming += payload.text;
    });
    next.addEventListener('question', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as GrillQuestionEvent;
      messages = [...messages, { role: 'ai', text: payload.question }];
      typing = false;
      streaming = '';
    });
    next.addEventListener('plan_ready', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as GrillPlanReadyEvent;
      plan = payload.plan;
    });
    next.addEventListener('issues_generated', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as GrillIssuesEvent;
      issues = payload.issues;
    });
    next.addEventListener('error', (event) => {
      // `EventSource` also fires its native `error` event on transport failures;
      // that event has no `data`, so only the backend's named `error` frame is
      // parsed as a domain error.
      const data = (event as MessageEvent).data;
      if (typeof data !== 'string') return;
      try {
        const payload = JSON.parse(data) as GrillErrorEvent;
        messages = [...messages, { role: 'system', text: payload.error.message }];
        typing = false;
      } catch {
        // A malformed frame is not a session failure; the transport handles it.
      }
    });
    next.addEventListener('ended', (event) => {
      const data = (event as MessageEvent).data;
      if (typeof data !== 'string') return;
      try {
        const payload = JSON.parse(data) as GrillEndedEvent;
        ended = true;
        sessionId = null;
        typing = false;
        reconnecting = false;
        next.close();
        source = null;
        if (payload.reason === 'completed') {
          void refreshPlans();
        }
      } catch {
        // Ignore malformed frames; the stream is still closed.
      }
    });
  }

  async function start(): Promise<void> {
    if (projectId === undefined || busy || idea.trim() === '') return;
    error = null;
    busy = true;
    try {
      const { sessionId: next } = await startGrill(projectId, idea.trim());
      sessionId = next;
      idea = '';
      messages = [];
      streaming = '';
      plan = null;
      issues = [];
      ended = false;
      typing = true;
      openStream();
    } catch (cause) {
      error = describe(cause);
    } finally {
      busy = false;
    }
  }

  async function sendAnswer(): Promise<void> {
    if (projectId === undefined || sessionId === null || busy || answerText.trim() === '') return;
    const text = answerText.trim();
    answerText = '';
    error = null;
    busy = true;
    try {
      await submitAnswer(projectId, sessionId, text);
      messages = [...messages, { role: 'user', text }];
      typing = true;
    } catch (cause) {
      error = describe(cause);
    } finally {
      busy = false;
    }
  }

  async function cancel(): Promise<void> {
    if (projectId === undefined || sessionId === null || busy) return;
    error = null;
    busy = true;
    try {
      await cancelGrill(projectId, sessionId);
      source?.close();
      source = null;
      sessionId = null;
      ended = true;
      typing = false;
      reconnecting = false;
      messages = [...messages, { role: 'system', text: 'Session cancelled.' }];
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
      activePlan = await activatePlan(projectId, planId);
      await refreshPlans();
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
          {project.skillLevel}
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
          <dt class="font-medium">ArgoCD</dt>
          <dd><code>{project.argoAppName}</code></dd>
        </div>
      </dl>
    </header>

    {#if error !== null}
      <p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>
    {/if}

    {#if activePlan !== null}
      <section
        class="rounded-lg border border-neutral-200 p-4"
        aria-labelledby="active-plan-heading"
      >
        <div class="mb-2 flex items-center justify-between gap-2">
          <h2 id="active-plan-heading" class="text-sm font-semibold">Active plan</h2>
          <span class="text-xs text-neutral-500">v{activePlan.version}</span>
        </div>
        <div class="prose prose-neutral max-w-none text-sm">
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          {@html renderMarkdown(activePlan.contentMarkdown)}
        </div>
      </section>
    {/if}

    <section class="rounded-lg border border-neutral-200 p-4" aria-labelledby="grill-heading">
      <div class="mb-3 flex items-center justify-between gap-2">
        <h2 id="grill-heading" class="text-sm font-semibold">Grill-Me session</h2>
        {#if reconnecting}
          <span class="text-xs text-amber-600" role="status">Reconnecting…</span>
        {/if}
      </div>

      {#if messages.length > 0 || streaming !== '' || typing || plan !== null || issues.length > 0}
        <div class="flex flex-col gap-3">
          <div
            bind:this={chatRef}
            class="flex max-h-80 flex-col gap-2 overflow-y-auto rounded-md bg-neutral-50 p-3"
            role="log"
            aria-live="polite"
          >
            {#each messages as message, index (index)}
              {#if message.role === 'user'}
                <div class="self-end rounded-lg bg-neutral-900 px-3 py-2 text-sm text-white">
                  {message.text}
                </div>
              {:else if message.role === 'system'}
                <div
                  class="self-center rounded-md bg-neutral-100 px-3 py-1 text-xs text-neutral-600"
                >
                  {message.text}
                </div>
              {:else}
                <div
                  class="self-start rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm"
                >
                  {message.text}
                </div>
              {/if}
            {/each}

            {#if streaming !== ''}
              <div
                class="self-start rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-600"
              >
                {streaming}
              </div>
            {/if}

            {#if typing}
              <div
                class="self-start flex items-center gap-2 text-sm text-neutral-500"
                role="status"
              >
                <span class="h-2 w-2 animate-pulse rounded-full bg-neutral-400"></span>
                AI is thinking…
              </div>
            {/if}
          </div>

          {#if sessionId !== null}
            <form
              class="flex gap-2"
              onsubmit={(event) => {
                event.preventDefault();
                void sendAnswer();
              }}
            >
              <label class="sr-only" for="answer">Your answer</label>
              <input
                id="answer"
                bind:value={answerText}
                type="text"
                class="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm"
                placeholder="Answer the question…"
              />
              <button
                type="submit"
                disabled={busy || answerText.trim() === ''}
                class="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                Send
              </button>
            </form>

            <button
              type="button"
              onclick={() => void cancel()}
              disabled={busy}
              class="self-start rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              Cancel session
            </button>
          {/if}
        </div>
      {/if}

      {#if sessionId === null}
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
          <button
            type="submit"
            disabled={busy || idea.trim() === ''}
            class="self-start rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {ended ? 'Start a new session' : 'Start Grill-Me'}
          </button>
        </form>
      {/if}
    </section>

    {#if plan !== null}
      <section class="rounded-lg border border-neutral-200 p-4" aria-labelledby="plan-heading">
        <h2 id="plan-heading" class="mb-2 text-sm font-semibold">Plan preview</h2>
        <div class="prose prose-neutral max-w-none text-sm">
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          {@html renderMarkdown(plan)}
        </div>
      </section>
    {/if}

    {#if issues.length > 0}
      <section class="rounded-lg border border-neutral-200 p-4" aria-labelledby="issues-heading">
        <h2 id="issues-heading" class="mb-2 text-sm font-semibold">Generated issues</h2>
        <ul class="flex flex-col gap-2">
          {#each issues as issue (issue.title)}
            <li class="rounded-md border border-neutral-200 p-3 text-sm">
              <p class="font-medium">{issue.title}</p>
              {#if issue.body !== ''}
                <p class="mt-1 text-neutral-600">{issue.body}</p>
              {/if}
              {#if issue.labels.length > 0}
                <p class="mt-1 text-xs text-neutral-500">{issue.labels.join(', ')}</p>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if plans.length > 0}
      <section class="rounded-lg border border-neutral-200 p-4" aria-labelledby="versions-heading">
        <h2 id="versions-heading" class="mb-2 text-sm font-semibold">Plan versions</h2>
        <ul class="flex flex-col gap-2">
          {#each plans as version (version.id)}
            <li
              class="flex items-center justify-between gap-2 rounded-md border border-neutral-200 p-3 text-sm"
            >
              <div>
                <p class="font-medium">v{version.version}</p>
                <p class="text-xs text-neutral-500">
                  {version.createdAt} · {version.source}
                  {#if version.isActive}
                    · active{/if}
                </p>
              </div>
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
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</main>
