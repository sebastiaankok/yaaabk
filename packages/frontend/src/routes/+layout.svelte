<script lang="ts">
  import { browser } from '$app/env';
  import { afterNavigate, goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { Menu, PanelLeftClose, PanelLeftOpen, X } from '@lucide/svelte';
  import { onMount, tick } from 'svelte';
  import { getStatus, logout, type AuthStatus } from '#lib/api.js';
  import { redirectTarget } from '#lib/auth-guard.js';
  import favicon from '#lib/assets/favicon.svg';
  import BrandLockup from '#lib/components/brand/brand-lockup.svelte';
  import SidebarContent from '#lib/components/sidebar-content.svelte';
  import { Toaster } from '#lib/components/ui/sonner/index.js';
  import { resolveShell } from '#lib/shell.js';
  import './layout.css';

  let { children } = $props();

  const SIDEBAR_COLLAPSED_KEY = 'yaaabk.sidebar.collapsed';
  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  let status = $state<AuthStatus | null>(null);
  let collapsed = $state(false);
  let collapsedReady = $state(false);
  let drawerOpen = $state(false);
  let drawerElement = $state<HTMLDivElement | undefined>(undefined);
  let menuButton = $state<HTMLButtonElement | undefined>(undefined);
  let returnFocus: HTMLElement | null = null;

  const shell = $derived(resolveShell(page.url.pathname));

  // Re-check the session on every navigation and bounce the Developer to the
  // right step of the auth flow when they are not where they should be.
  $effect(() => {
    const pathname = page.url.pathname;
    if (!browser) return;

    let cancelled = false;
    getStatus()
      .then((next) => {
        if (cancelled) return;
        status = next;
        const target = redirectTarget(next, pathname);
        if (target !== null) void goto(resolve(target));
      })
      .catch(() => {
        if (!cancelled) status = null;
      });

    return () => {
      cancelled = true;
    };
  });

  onMount(() => {
    collapsed = window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
    collapsedReady = true;
  });

  // The rail is a preference, not page state: remember it across reloads.
  $effect(() => {
    if (!browser || !collapsedReady) return;
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  });

  afterNavigate(() => {
    if (drawerOpen) void closeDrawer(false);
  });

  function toggleCollapsed() {
    collapsed = !collapsed;
  }

  async function openDrawer(event: MouseEvent) {
    returnFocus = event.currentTarget as HTMLElement;
    drawerOpen = true;
    await tick();
    drawerElement?.querySelector<HTMLElement>('[data-drawer-close]')?.focus();
  }

  async function closeDrawer(restoreFocus = true) {
    const target = returnFocus;
    returnFocus = null;
    drawerOpen = false;
    if (!restoreFocus) return;
    await tick();
    (target ?? menuButton)?.focus();
  }

  /** Keep Tab inside the slide-over and let Escape dismiss it. */
  function handleDrawerKeydown(event: KeyboardEvent) {
    if (!drawerOpen || drawerElement === undefined) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      void closeDrawer();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = [...drawerElement.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (element) => element.offsetParent !== null,
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) return;

    const active = document.activeElement;
    if (!drawerElement.contains(active)) {
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function skipToMain(event: MouseEvent) {
    event.preventDefault();
    document.getElementById('main-content')?.focus();
  }

  async function signOut() {
    try {
      await logout();
    } catch {
      // Signing out is best-effort; the redirect still clears the UI.
    }
    await goto(resolve('/login'));
  }
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
</svelte:head>

<svelte:window onkeydown={handleDrawerKeydown} />

{#if shell.authRoute}
  {@render children()}
{:else}
  <a
    href="#main-content"
    onclick={skipToMain}
    class="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[60] focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
  >
    Skip to content
  </a>

  <div class="min-h-dvh lg:flex">
    {#if status?.authenticated}
      <aside
        class="sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 lg:flex {collapsed
          ? 'w-[72px]'
          : 'w-64'}"
        data-testid="sidebar"
        data-collapsed={collapsed}
      >
        <SidebarContent
          destination={shell.destination}
          username={status.user?.username ?? ''}
          {collapsed}
          onSignOut={() => void signOut()}
        />
        <div class="border-t border-sidebar-border p-2">
          <button
            type="button"
            onclick={toggleCollapsed}
            class="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg text-sm font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-pressed={collapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {#if collapsed}
              <PanelLeftOpen class="size-5" aria-hidden="true" />
            {:else}
              <PanelLeftClose class="size-5" aria-hidden="true" />
              <span>Collapse</span>
            {/if}
          </button>
        </div>
      </aside>
    {/if}

    <div class="flex min-w-0 flex-1 flex-col">
      {#if status?.authenticated}
        <header
          class="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border-subtle bg-background/95 px-4 backdrop-blur lg:hidden"
        >
          <button
            type="button"
            bind:this={menuButton}
            onclick={openDrawer}
            class="flex size-11 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-muted"
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            aria-controls="mobile-navigation"
          >
            <Menu class="size-5" aria-hidden="true" />
          </button>
          <BrandLockup compact />
        </header>
      {/if}

      <main id="main-content" tabindex="-1" class="flex-1 px-4 py-6 sm:px-6 lg:px-8">
        {@render children()}
      </main>
    </div>
  </div>

  {#if drawerOpen && status?.authenticated}
    <div class="fixed inset-0 z-50 lg:hidden">
      <button
        type="button"
        tabindex="-1"
        class="absolute inset-0 h-full w-full bg-black/40"
        aria-label="Close navigation"
        onclick={() => void closeDrawer()}
      ></button>
      <div
        id="mobile-navigation"
        bind:this={drawerElement}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        tabindex="-1"
        class="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground shadow-elevation-overlay"
      >
        <button
          type="button"
          data-drawer-close
          onclick={() => void closeDrawer()}
          class="absolute top-3 right-3 flex size-11 items-center justify-center rounded-lg text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60"
          aria-label="Close navigation"
        >
          <X class="size-5" aria-hidden="true" />
        </button>
        <SidebarContent
          destination={shell.destination}
          username={status.user?.username ?? ''}
          onSignOut={() => void signOut()}
        />
      </div>
    </div>
  {/if}
{/if}

<Toaster position="bottom-right" richColors closeButton />
