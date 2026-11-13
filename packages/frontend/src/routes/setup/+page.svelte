<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { renderSVG } from 'uqr';
  import { ApiError, beginSetup, verifySetup, type SetupChallenge } from '#lib/api.js';

  let username = $state('');
  let password = $state('');
  let code = $state('');
  let challenge = $state<SetupChallenge | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);

  const qr = $derived(challenge === null ? '' : renderSVG(challenge.otpauthUri, { border: 2 }));

  function describe(cause: unknown): string {
    return cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.';
  }

  async function createAccount(event: SubmitEvent) {
    event.preventDefault();
    error = null;
    busy = true;
    try {
      challenge = await beginSetup({ username, password });
      code = '';
    } catch (cause) {
      error = describe(cause);
    } finally {
      busy = false;
    }
  }

  async function confirmCode(event: SubmitEvent) {
    event.preventDefault();
    if (challenge === null) return;
    error = null;
    busy = true;
    try {
      await verifySetup({ setupToken: challenge.setupToken, token: code });
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
    <h1 class="text-2xl font-bold tracking-tight">Set up YAAABK</h1>
    <p class="text-sm text-neutral-500">
      {challenge === null
        ? 'Create the admin account for this instance.'
        : 'Scan the QR code, then enter the code it shows.'}
    </p>
  </div>

  {#if error !== null}
    <p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>
  {/if}

  {#if challenge === null}
    <form class="flex flex-col gap-4" onsubmit={createAccount}>
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
          autocomplete="new-password"
          bind:value={password}
          required
        />
        <span class="text-xs text-neutral-500">
          At least 12 characters with upper and lower case, a digit and a symbol.
        </span>
      </label>
      <button
        class="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        type="submit"
        disabled={busy}
      >
        {busy ? 'Creating…' : 'Create account'}
      </button>
    </form>
  {:else}
    <div class="flex flex-col items-center gap-4">
      <div class="h-48 w-48 [&>svg]:h-full [&>svg]:w-full" aria-label="TOTP QR code">
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        {@html qr}
      </div>
      <p class="text-center text-xs text-neutral-500">
        Can’t scan? Enter this secret manually:
        <code class="break-all font-mono">{challenge.secret}</code>
      </p>
      <form class="flex w-full flex-col gap-4" onsubmit={confirmCode}>
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
          {busy ? 'Verifying…' : 'Finish setup'}
        </button>
      </form>
    </div>
  {/if}
</main>
