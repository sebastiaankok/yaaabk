<script lang="ts">
  import { browser } from '$app/env';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { getStatus, logout, type AuthStatus } from '#lib/api.js';
  import { isAuthRoute, redirectTarget } from '#lib/auth-guard.js';
  import favicon from '#lib/assets/favicon.svg';
  import './layout.css';

  let { children } = $props();

  let status = $state<AuthStatus | null>(null);
  const onAuthRoute = $derived(isAuthRoute(page.url.pathname));

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

{#if status?.authenticated && !onAuthRoute}
  <header class="flex items-center justify-end gap-3 px-6 py-4">
    <span class="text-sm text-neutral-500">{status.user?.username}</span>
    <button
      type="button"
      class="rounded-md border border-neutral-300 px-3 py-1 text-sm transition-colors hover:bg-neutral-100"
      onclick={signOut}
    >
      Log out
    </button>
  </header>
{/if}

{@render children()}
