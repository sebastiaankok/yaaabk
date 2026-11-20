<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { ApiError, login, verifyTwoFactor } from '#lib/api.js';
  import BrandLockup from '#lib/components/brand/brand-lockup.svelte';
  import { Alert, AlertDescription } from '#lib/components/ui/alert/index.js';
  import { Button } from '#lib/components/ui/button/index.js';
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from '#lib/components/ui/card/index.js';
  import { Input } from '#lib/components/ui/input/index.js';

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

<svelte:head>
  <title>Sign in · YAAABK</title>
</svelte:head>

<main class="flex min-h-dvh items-center justify-center bg-surface-tint p-4 sm:p-6">
  <Card
    data-testid="auth-card"
    class="w-full max-w-md shadow-elevation-2 [--card-spacing:--spacing(6)] sm:[--card-spacing:--spacing(8)]"
  >
    <CardHeader class="items-center gap-4 text-center">
      <BrandLockup />
      <div class="space-y-1">
        <CardTitle
          ><h1 class="text-2xl font-semibold tracking-tight">Sign in to YAAABK</h1></CardTitle
        >
        <CardDescription>
          {pendingToken === null
            ? 'Enter your username and password.'
            : 'Enter the 6-digit code from your authenticator app.'}
        </CardDescription>
      </div>
    </CardHeader>

    <CardContent>
      {#if error !== null}
        <Alert variant="destructive" class="mb-4 border-destructive/30 bg-destructive-subtle">
          <AlertDescription class="text-destructive">{error}</AlertDescription>
        </Alert>
      {/if}

      {#if pendingToken === null}
        <form class="flex flex-col gap-5" onsubmit={submitCredentials}>
          <label class="grid gap-2 text-sm font-medium" for="username">
            Username
            <Input
              id="username"
              class="h-12 px-4 text-base"
              name="username"
              autocomplete="username"
              bind:value={username}
              required
            />
          </label>
          <label class="grid gap-2 text-sm font-medium" for="password">
            Password
            <Input
              id="password"
              class="h-12 px-4 text-base"
              name="password"
              type="password"
              autocomplete="current-password"
              bind:value={password}
              required
            />
          </label>
          <Button class="h-12 w-full text-base" type="submit" disabled={busy}>
            {busy ? 'Checking…' : 'Continue'}
          </Button>
        </form>
      {:else}
        <form class="flex flex-col gap-5" onsubmit={submitCode}>
          <label class="grid gap-2 text-sm font-medium" for="code">
            Verification code
            <Input
              id="code"
              class="h-12 px-4 text-center font-mono text-lg tracking-[0.3em]"
              name="code"
              inputmode="numeric"
              autocomplete="one-time-code"
              pattern="[0-9]*"
              maxlength={6}
              bind:value={code}
              required
            />
          </label>
          <Button class="h-12 w-full text-base" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
          <Button
            class="h-11 w-full"
            type="button"
            variant="ghost"
            disabled={busy}
            onclick={() => {
              pendingToken = null;
              error = null;
              code = '';
            }}
          >
            Use a different account
          </Button>
        </form>
      {/if}
    </CardContent>
  </Card>
</main>
