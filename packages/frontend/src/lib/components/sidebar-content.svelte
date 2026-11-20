<script lang="ts">
  import { FolderKanban, Settings } from '@lucide/svelte';
  import type { SidebarDestinationId } from '#lib/shell.js';
  import { SIDEBAR_DESTINATIONS } from '#lib/shell.js';
  import BrandLockup from './brand/brand-lockup.svelte';
  import BrandMark from './brand/brand-mark.svelte';

  let {
    destination,
    username,
    collapsed = false,
    onSignOut,
  }: {
    destination: SidebarDestinationId | null;
    username: string;
    collapsed?: boolean;
    onSignOut: () => void;
  } = $props();

  const initial = $derived(username.trim().charAt(0).toUpperCase() || '?');
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- the shell model owns these destination hrefs -->
<div class="flex min-h-0 flex-1 flex-col gap-4 p-2">
  <div class="flex h-14 items-center px-2" class:justify-center={collapsed}>
    {#if collapsed}
      <BrandMark class="size-8 shrink-0" />
    {:else}
      <BrandLockup compact />
    {/if}
  </div>

  <nav aria-label="Primary">
    <ul class="flex flex-col gap-1">
      {#each SIDEBAR_DESTINATIONS as item (item.id)}
        {@const active = item.id === destination}
        <li>
          <a
            href={item.href}
            aria-current={active ? 'page' : undefined}
            title={collapsed ? item.label : undefined}
            class="flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors {active
              ? 'bg-sidebar-accent text-sidebar-accent-foreground'
              : 'text-sidebar-foreground hover:bg-sidebar-accent/60'} {collapsed
              ? 'justify-center px-0'
              : ''}"
          >
            {#if item.id === 'projects'}
              <FolderKanban class="size-5 shrink-0" aria-hidden="true" />
            {:else}
              <Settings class="size-5 shrink-0" aria-hidden="true" />
            {/if}
            <span class={collapsed ? 'sr-only' : ''}>{item.label}</span>
          </a>
        </li>
      {/each}
    </ul>
  </nav>

  <div class="mt-auto border-t border-sidebar-border pt-2">
    <div
      class="flex items-center gap-2 rounded-lg px-2 py-2"
      class:justify-center={collapsed}
      data-testid="user-card"
    >
      <span
        class="grid size-9 shrink-0 place-items-center rounded-full bg-sidebar-accent text-sm font-semibold text-sidebar-accent-foreground"
        aria-hidden="true"
      >
        {initial}
      </span>
      {#if !collapsed}
        <span class="min-w-0 flex-1 truncate text-sm" title={username}>{username}</span>
      {/if}
      <button
        type="button"
        onclick={onSignOut}
        class="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60 {collapsed
          ? ''
          : 'px-2'}"
        aria-label="Sign out"
        title="Sign out"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="size-5"
          aria-hidden="true"
        >
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" x2="9" y1="12" y2="12" />
        </svg>
        {#if !collapsed}<span>Sign out</span>{/if}
      </button>
    </div>
  </div>
</div>
