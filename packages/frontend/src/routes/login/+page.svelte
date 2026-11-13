<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { ApiError, login, verifyTwoFactor } from '#lib/api.js';

  let username = $state('');
  let password = $state('');
  let code = $state('');
  let pendingToken = $state<string | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);

  function describe(cause: unknown): string {
    return cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.';
  }

  async function submitCredentials(event: SubmitEvent) {
    event.preventDefault();
    error = null;
    busy = true;
    try {
      const challenge = await login({ username, password });
      pendingToken = challenge.pendingToken;
      code = '';
    } catch (cause) {
      error = describe(cause);
    } finally {
      busy = false;
    }
  }

  async function submitCode(event: SubmitEvent) {
    event.preventDefault();
    if (pendingToken === null) return;
    error = null;
    busy = true;
    try {
      await verifyTwoFactor({ pendingToken, token: code });
      await goto(resolve('/'));
    } catch (cause) {
      error = describe(cause);
    } finally {
      busy = false;
    }
  }
</script>

<main class="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-8">
  <div class="space-y-1 text-center">
    <h1 class="text-2xl font-bold tracking-tight">Sign in to YAAABK</h1>
    <p class="text-sm text-neutral-500">
      {pendingToken === null
        ? 'Enter your username and password.'
        : 'Enter the code from your authenticator app.'}
    </p>
  </div>

  {#if error !== null}
    <p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>
  {/if}

  {#if pendingToken === null}
    <form class="flex flex-col gap-4" onsubmit={submitCredentials}>
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Username</span>
        <input
          class="rounded-md border border-neutral-300 px-3 py-2"
          name="username"
          autocomplete="username"
          bind:value={username}
          required
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Password</span>
        <input
          class="rounded-md border border-neutral-300 px-3 py-2"
          name="password"
          type="password"
          autocomplete="current-password"
          bind:value={password}
          required
        />
      </label>
      <button
        class="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        type="submit"
        disabled={busy}
      >
        {busy ? 'Checking…' : 'Continue'}
      </button>
    </form>
  {:else}
    <form class="flex flex-col gap-4" onsubmit={submitCode}>
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Verification code</span>
        <input
          class="rounded-md border border-neutral-300 px-3 py-2 tracking-widest"
          name="code"
          inputmode="numeric"
          autocomplete="one-time-code"
          pattern="[0-9]*"
          maxlength="6"
          bind:value={code}
          required
        />
      </label>
      <button
        class="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        type="submit"
        disabled={busy}
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  {/if}
</main>
