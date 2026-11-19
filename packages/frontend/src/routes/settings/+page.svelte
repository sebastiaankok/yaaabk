<script lang="ts">
  import { resolve } from '$app/paths';
  import {
    ApiError,
    getOpenRouterCredits,
    getSettings,
    updateSettings,
    verifyGithubSettings,
    verifyOpenrouterSettings,
    type GitHubVerifyOk,
    type OpenRouterCreditsView,
    type OpenRouterVerifyOk,
  } from '#lib/api.js';
  import { affordabilityWarning, formatUsd } from '#lib/openrouter-balance.js';
  import {
    toSettingsUpdate,
    validateBudgetDollars,
    type GitHubCredentialMode,
  } from '#lib/settings-form.js';
  import type { SettingsView } from '@yaaabk/settings';

  let settings = $state<SettingsView | null>(null);
  let loadFailure = $state<string | null>(null);

  let githubMode = $state<GitHubCredentialMode>('app');
  let githubAppId = $state('');
  let githubPrivateKey = $state('');
  let githubInstallationId = $state('');
  let githubPat = $state('');
  let openrouterManagementKey = $state('');
  let defaultIssueBudgetDollars = $state('');

  let budgetError = $state<string | null>(null);
  let saveState = $state<'idle' | 'saving' | 'saved'>('idle');
  let saveError = $state<string | null>(null);
  let githubVerification = $state<GitHubVerifyOk | null>(null);
  let githubVerifyError = $state<string | null>(null);
  let openrouterVerification = $state<OpenRouterVerifyOk | null>(null);
  let openrouterVerifyError = $state<string | null>(null);
  let credits = $state<OpenRouterCreditsView | null>(null);
  let creditsLoading = $state(false);
  let creditsFailure = $state<string | null>(null);
  let creditsWarning = $derived(credits === null ? null : affordabilityWarning(credits));

  $effect(() => {
    getSettings()
      .then((view) => {
        settings = view;
        if (view.defaultIssueBudgetCents !== undefined) {
          defaultIssueBudgetDollars = (view.defaultIssueBudgetCents / 100).toFixed(2);
        }
        if (view.githubPat !== undefined && view.githubAppId === undefined) {
          githubMode = 'pat';
        }
        void loadCredits();
      })
      .catch(() => {
        loadFailure = 'Could not load settings. Please try again.';
      });
  });

  function describe(cause: unknown): string {
    return cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.';
  }

  async function loadCredits(): Promise<void> {
    credits = null;
    creditsFailure = null;
    // A missing credential is an expected setup step, not a failed lookup: say
    // what to do instead of asking OpenRouter and showing a transport error.
    if (settings?.openrouterManagementKey === undefined) {
      creditsFailure = 'Add an OpenRouter management key to see the account balance.';
      return;
    }
    creditsLoading = true;
    try {
      credits = await getOpenRouterCredits();
    } catch (cause) {
      creditsFailure = `Could not read the OpenRouter balance: ${describe(cause)}`;
    } finally {
      creditsLoading = false;
    }
  }

  async function save(): Promise<void> {
    if (settings === null) return;
    // Blank means "leave the stored budget unchanged", like every other field
    // on this page, so only validate what was actually typed.
    const budget = defaultIssueBudgetDollars.trim();
    budgetError = budget === '' ? null : (validateBudgetDollars(budget) ?? null);
    if (budgetError !== null) return;

    saveState = 'saving';
    saveError = null;
    try {
      settings = await updateSettings(
        toSettingsUpdate(
          {
            githubMode,
            githubAppId,
            githubPrivateKey,
            githubInstallationId,
            githubPat,
            openrouterManagementKey,
            defaultIssueBudgetDollars,
          },
          settings,
        ),
      );
      githubAppId = '';
      githubPrivateKey = '';
      githubInstallationId = '';
      githubPat = '';
      openrouterManagementKey = '';
      saveState = 'saved';
      void loadCredits();
    } catch (cause) {
      saveError = describe(cause);
      saveState = 'idle';
    }
  }

  async function verifyGitHub(): Promise<void> {
    githubVerification = null;
    githubVerifyError = null;
    try {
      githubVerification = await verifyGithubSettings();
    } catch (cause) {
      githubVerifyError = describe(cause);
    }
  }

  async function verifyOpenrouter(): Promise<void> {
    openrouterVerification = null;
    openrouterVerifyError = null;
    try {
      openrouterVerification = await verifyOpenrouterSettings();
    } catch (cause) {
      openrouterVerifyError = describe(cause);
    }
  }
</script>

<svelte:head>
  <title>Settings · YAAABK</title>
</svelte:head>

<main class="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 p-6">
  <a href={resolve('/')} class="text-sm text-neutral-500 hover:underline">← Back to projects</a>

  <h1 class="text-xl font-semibold tracking-tight">Settings</h1>

  {#if loadFailure !== null}
    <p class="text-sm text-red-600">{loadFailure}</p>
  {:else if settings === null}
    <p class="text-sm text-neutral-500">Loading…</p>
  {:else}
    <p class="text-sm text-neutral-500">
      Credentials are stored encrypted and never shown again — only a masked hint.
    </p>

    <section class="flex flex-col gap-4 rounded-lg border border-neutral-200 p-4">
      <h2 class="font-medium">GitHub</h2>

      <div class="flex gap-4 text-sm">
        <label class="flex items-center gap-2">
          <input type="radio" bind:group={githubMode} value="app" name="github-mode" />
          GitHub App
        </label>
        <label class="flex items-center gap-2">
          <input type="radio" bind:group={githubMode} value="pat" name="github-mode" />
          Personal access token
        </label>
      </div>

      {#if githubMode === 'app'}
        <p class="text-xs text-neutral-500">
          The App needs <strong>Administration: read/write</strong>, plus read/write on Contents,
          Issues, Pull requests, Workflows and Metadata. Workflows is required because every Project
          ships a CI workflow — without it GitHub rejects the first push.
        </p>

        <div class="flex flex-col gap-1">
          <label class="text-sm font-medium" for="github-app-id">App ID</label>
          <input
            id="github-app-id"
            bind:value={githubAppId}
            type="text"
            class="rounded-md border border-neutral-300 px-3 py-2 text-sm"
            placeholder={settings.githubAppId ?? '12345'}
          />
          {#if settings.githubAppId !== undefined && githubAppId === ''}
            <p class="text-xs text-neutral-500">Configured: {settings.githubAppId}</p>
          {/if}
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-sm font-medium" for="github-private-key">Private key</label>
          <textarea
            id="github-private-key"
            bind:value={githubPrivateKey}
            rows="3"
            class="w-full rounded-md border border-neutral-300 px-3 py-2 font-mono text-xs"
            placeholder={settings.githubPrivateKey !== undefined
              ? 'Configured — type to replace'
              : '-----BEGIN RSA PRIVATE KEY-----'}></textarea>
          <p class="text-xs text-neutral-500">
            Paste the downloaded <code>.pem</code> file as-is — PKCS#1 and PKCS#8 are both accepted.
          </p>
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-sm font-medium" for="github-installation-id">Installation ID</label>
          <input
            id="github-installation-id"
            bind:value={githubInstallationId}
            type="text"
            class="rounded-md border border-neutral-300 px-3 py-2 text-sm"
            placeholder={settings.githubInstallationId ?? '67890'}
          />
          <p class="text-xs text-neutral-500">
            Required: an App mints tokens for exactly one installation, so YAAABK cannot create
            repositories without it. Find it in the install confirmation URL, or under
            <a
              class="underline"
              href="https://github.com/settings/installations"
              target="_blank"
              rel="noreferrer">GitHub's installed apps</a
            >.
          </p>
          {#if settings.githubInstallationId !== undefined && githubInstallationId === ''}
            <p class="text-xs text-neutral-500">Configured: {settings.githubInstallationId}</p>
          {/if}
        </div>
      {:else}
        <div class="flex flex-col gap-1">
          <label class="text-sm font-medium" for="github-pat">Personal access token</label>
          <input
            id="github-pat"
            bind:value={githubPat}
            type="password"
            class="rounded-md border border-neutral-300 px-3 py-2 text-sm"
            placeholder={settings.githubPat !== undefined
              ? 'Configured — type to replace'
              : 'ghp_…'}
          />
          {#if settings.githubPat !== undefined && githubPat === ''}
            <p class="text-xs text-neutral-500">Configured: {settings.githubPat}</p>
          {/if}
        </div>
      {/if}

      <div class="flex items-center gap-3">
        <button
          type="button"
          class="rounded-md border border-neutral-300 px-3 py-1 text-sm transition-colors hover:bg-neutral-100"
          onclick={verifyGitHub}
        >
          Verify
        </button>
        {#if githubVerification !== null}
          <p class="text-sm text-green-700">
            Verified: {githubVerification.kind === 'app' ? 'GitHub App' : 'account'}
            {githubVerification.account}
          </p>
        {:else if githubVerifyError !== null}
          <p class="text-sm text-red-600">{githubVerifyError}</p>
        {/if}
      </div>
    </section>

    <section class="flex flex-col gap-4 rounded-lg border border-neutral-200 p-4">
      <h2 class="font-medium">OpenRouter</h2>

      <div class="flex flex-col gap-1">
        <label class="text-sm font-medium" for="openrouter-management-key">Management key</label>
        <input
          id="openrouter-management-key"
          bind:value={openrouterManagementKey}
          type="password"
          class="rounded-md border border-neutral-300 px-3 py-2 text-sm"
          placeholder={settings.openrouterManagementKey !== undefined
            ? 'Configured — type to replace'
            : 'sk-or-mgmt-…'}
        />
        {#if settings.openrouterManagementKey !== undefined && openrouterManagementKey === ''}
          <p class="text-xs text-neutral-500">Configured: {settings.openrouterManagementKey}</p>
        {/if}
      </div>

      <div class="flex flex-col gap-1">
        <label class="text-sm font-medium" for="default-issue-budget"
          >Default per-issue budget (USD)</label
        >
        <input
          id="default-issue-budget"
          bind:value={defaultIssueBudgetDollars}
          type="text"
          inputmode="decimal"
          class="rounded-md border border-neutral-300 px-3 py-2 text-sm"
          placeholder="1.00"
          aria-invalid={budgetError !== null}
          aria-describedby={budgetError !== null ? 'budget-error' : undefined}
        />
        {#if budgetError !== null}
          <p id="budget-error" class="text-sm text-red-600">{budgetError}</p>
        {/if}
      </div>

      <div class="flex flex-col gap-1">
        <h3 class="text-sm font-medium">Account balance</h3>
        {#if creditsLoading}
          <p class="text-sm text-neutral-500">Loading balance…</p>
        {:else if creditsFailure !== null}
          <p class="text-sm text-neutral-500">{creditsFailure}</p>
        {:else if credits !== null}
          <p class="text-sm">
            Remaining <strong>{formatUsd(credits.remainingUsd)}</strong> of
            {formatUsd(credits.totalCreditsUsd)} ({formatUsd(credits.totalUsageUsd)} used)
          </p>
          {#if creditsWarning !== null}
            <p class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              {creditsWarning}
            </p>
          {/if}
        {/if}
      </div>

      <div class="flex items-center gap-3">
        <button
          type="button"
          class="rounded-md border border-neutral-300 px-3 py-1 text-sm transition-colors hover:bg-neutral-100"
          onclick={verifyOpenrouter}
        >
          Verify
        </button>
        {#if openrouterVerification !== null}
          <p class="text-sm text-green-700">
            Verified: {openrouterVerification.keys}
            {openrouterVerification.keys === 1 ? 'key' : 'keys'} managed
          </p>
        {:else if openrouterVerifyError !== null}
          <p class="text-sm text-red-600">{openrouterVerifyError}</p>
        {/if}
      </div>
    </section>

    <div class="flex items-center gap-3">
      <button
        type="button"
        disabled={saveState === 'saving'}
        class="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
        onclick={save}
      >
        {saveState === 'saving' ? 'Saving…' : 'Save settings'}
      </button>
      {#if saveState === 'saved'}
        <p class="text-sm text-green-700">Settings saved</p>
      {:else if saveError !== null}
        <p class="text-sm text-red-600">{saveError}</p>
      {/if}
    </div>
  {/if}
</main>
