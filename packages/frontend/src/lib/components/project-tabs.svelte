<script lang="ts">
  import type { ProjectOverview } from '@yaaabk/stats';
  import { getProjectOverview } from '#lib/api.js';
  import { pollWhileVisible } from '#lib/polling.js';
  import { projectTabIndicators } from '#lib/project-tab-indicators.js';
  import { PROJECT_TABS, projectTabPath, type ProjectTabId } from '#lib/shell.js';

  let { projectId, activeTab }: { projectId: string; activeTab: ProjectTabId | null } = $props();

  let overview = $state<ProjectOverview | null>(null);
  const indicators = $derived(projectTabIndicators(overview));

  $effect(() => {
    const id = projectId;
    let cancelled = false;
    overview = null;

    const load = () =>
      getProjectOverview(id)
        .then((next) => {
          if (!cancelled) overview = next;
        })
        .catch(() => {
          // A failed request shows no indicators; the page owns error reporting.
          if (!cancelled) overview = null;
        });

    void load();
    const stop = pollWhileVisible({
      intervalMs: 10_000,
      isVisible: () => document.visibilityState === 'visible',
      onVisibilityChange: (listener) => {
        document.addEventListener('visibilitychange', listener);
        return () => document.removeEventListener('visibilitychange', listener);
      },
      poll: load,
    });

    return () => {
      cancelled = true;
      stop();
    };
  });
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- the shell model owns project tab paths -->
<nav aria-label="Project sections" data-testid="project-tabs">
  <ul class="flex flex-wrap gap-1">
    {#each PROJECT_TABS as tab (tab.id)}
      {@const active = tab.id === activeTab}
      {@const review = tab.id === 'review' ? indicators.review : null}
      {@const issues = tab.id === 'issues' ? indicators.issues : null}
      <li>
        <a
          href={projectTabPath(projectId, tab.id)}
          aria-current={active ? 'page' : undefined}
          class="flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors {active
            ? 'bg-secondary text-secondary-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'}"
        >
          {tab.label}
          {#if review !== null}
            <span
              class="size-2 rounded-full bg-warning"
              aria-hidden="true"
              data-testid="review-indicator"
            ></span>
            <span class="sr-only">{review.label}</span>
          {:else if issues !== null}
            <span
              class="min-w-5 rounded-full bg-warning-subtle px-1.5 text-center text-xs font-semibold text-warning"
              aria-hidden="true"
              data-testid="issues-indicator">{issues.count}</span
            >
            <span class="sr-only">{issues.label}</span>
          {/if}
        </a>
      </li>
    {/each}
  </ul>
</nav>
