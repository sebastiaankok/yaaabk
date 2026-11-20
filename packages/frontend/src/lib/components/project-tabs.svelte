<script lang="ts">
  import { PROJECT_TABS, projectTabPath, type ProjectTabId } from '#lib/shell.js';

  let { projectId, activeTab }: { projectId: string; activeTab: ProjectTabId | null } = $props();
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- the shell model owns project tab paths -->
<nav aria-label="Project sections" data-testid="project-tabs">
  <ul class="flex flex-wrap gap-1">
    {#each PROJECT_TABS as tab (tab.id)}
      {@const active = tab.id === activeTab}
      <li>
        <a
          href={projectTabPath(projectId, tab.id)}
          aria-current={active ? 'page' : undefined}
          class="flex min-h-11 items-center rounded-lg px-3 text-sm font-medium transition-colors {active
            ? 'bg-secondary text-secondary-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'}"
        >
          {tab.label}
        </a>
      </li>
    {/each}
  </ul>
</nav>
