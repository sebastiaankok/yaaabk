<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { renderSVG } from 'uqr';
  import { toast } from 'svelte-sonner';
  import { ApiError, beginSetup, verifySetup, type SetupChallenge } from '#lib/api.js';
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
  let challenge = $state<SetupChallenge | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);

  const qr = $derived(challenge === null ? '' : renderSVG(challenge.otpauthUri, { border: 2 }));
  const step = $derived(challenge === null ? 1 : 2);

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

  async function copySecret() {
    if (challenge === null) return;
    try {
      await navigator.clipboard.writeText(challenge.secret);
      toast.success('Setup secret copied');
    } catch {
      toast.error('Could not copy the secret. Select it and copy manually.');
    }
  }
</script>

<svelte:head>
  <title>Set up · YAAABK</title>
</svelte:head>

<main class="flex min-h-dvh items-center justify-center bg-surface-tint p-4 sm:p-6">
  <Card
    data-testid="auth-card"
    class="w-full max-w-md shadow-elevation-2 [--card-spacing:--spacing(6)] sm:[--card-spacing:--spacing(8)]"
  >
    <CardHeader class="items-center gap-4 text-center">
      <BrandLockup />
      <div class="space-y-1">
        <p class="text-xs font-medium tracking-wide text-link uppercase">Step {step} of 2</p>
        <CardTitle><h1 class="text-2xl font-semibold tracking-tight">Set up YAAABK</h1></CardTitle>
        <CardDescription>
          {challenge === null
            ? 'Create the admin account for this instance.'
            : 'Scan the QR code with your authenticator app, then enter the code it shows.'}
        </CardDescription>
      </div>
    </CardHeader>

    <CardContent>
      {#if error !== null}
        <Alert variant="destructive" class="mb-4 border-destructive/30 bg-destructive-subtle">
          <AlertDescription class="text-destructive">{error}</AlertDescription>
        </Alert>
      {/if}

      {#if challenge === null}
        <form class="flex flex-col gap-5" onsubmit={createAccount}>
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
              autocomplete="new-password"
              bind:value={password}
              aria-describedby="password-requirements"
              required
            />
            <span id="password-requirements" class="text-xs font-normal text-muted-foreground">
              At least 12 characters with upper and lower case, a digit and a symbol.
            </span>
          </label>
          <Button class="h-12 w-full text-base" type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create account'}
          </Button>
        </form>
      {:else}
        <div class="flex flex-col gap-5">
          <div class="flex flex-col items-center gap-3">
            <div
              class="w-fit rounded-lg border border-border-subtle bg-white p-3 [&>svg]:size-44"
              role="img"
              aria-label="TOTP QR code"
            >
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              {@html qr}
            </div>
            <p class="text-center text-xs text-muted-foreground">
              Can’t scan? Enter this secret manually:
            </p>
            <div class="flex w-full items-center gap-2">
              <code
                class="min-w-0 flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-xs"
                title={challenge.secret}>{challenge.secret}</code
              >
              <Button type="button" variant="outline" size="sm" class="h-9" onclick={copySecret}>
                Copy
              </Button>
            </div>
          </div>

          <form class="flex flex-col gap-5" onsubmit={confirmCode}>
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
              {busy ? 'Verifying…' : 'Finish setup'}
            </Button>
          </form>
        </div>
      {/if}
    </CardContent>
  </Card>
</main>
