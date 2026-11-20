<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Breadcrumb } from '#lib/shell.js';

  let {
    title,
    purpose,
    breadcrumbs = [],
    actions,
    tabs,
  }: {
    title: string;
    purpose?: string;
    breadcrumbs?: Breadcrumb[];
    actions?: Snippet;
    tabs?: Snippet;
  } = $props();
</script>

<header class="flex flex-col gap-4 border-b border-border-subtle pb-4" data-testid="page-header">
  {#if breadcrumbs.length > 0}
    <nav aria-label="Breadcrumb">
      <ol class="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        {#each breadcrumbs as crumb, index (index)}
          <li class="flex items-center gap-1">
            {#if index > 0}
              <span aria-hidden="true">/</span>
            {/if}
            {#if crumb.href !== undefined}
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the shell model owns breadcrumb hrefs -->
              <a href={crumb.href} class="rounded-sm hover:text-link hover:underline">
                {crumb.label}
              </a>
            {:else}
              <span aria-current="page" class="font-medium text-foreground">{crumb.label}</span>
            {/if}
          </li>
        {/each}
      </ol>
    </nav>
  {/if}

  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0 space-y-1">
      <h1 class="text-2xl font-bold tracking-tight text-foreground">{title}</h1>
      {#if purpose !== undefined}
        <p class="max-w-3xl text-sm text-muted-foreground">{purpose}</p>
      {/if}
    </div>
    {#if actions !== undefined}
      <div class="flex flex-wrap items-center gap-2">{@render actions()}</div>
    {/if}
  </div>

  {#if tabs !== undefined}
    {@render tabs()}
  {/if}
</header>
