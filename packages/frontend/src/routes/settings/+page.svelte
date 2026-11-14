<script lang="ts">
  import { resolve } from '$app/paths';
  import {
    ApiError,
    getSettings,
    updateSettings,
    verifyGithubSettings,
    verifyOpenrouterSettings,
    type GitHubVerifyOk,
    type OpenRouterVerifyOk,
  } from '#lib/api.js';
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
      })
      .catch(() => {
        loadFailure = 'Could not load settings. Please try again.';
      });
  });

  function describe(cause: unknown): string {
    return cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.';
  }

  async function save(): Promise<void> {
    if (settings === null) return;
    budgetError = validateBudgetDollars(defaultIssueBudgetDollars) ?? null;
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
            placeholder={settings.githubPrivateKey !== undefined ? 'Configured — type to replace' : '-----BEGIN PRIVATE KEY-----'}
          ></textarea>
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-sm font-medium" for="github-installation-id">Installation ID (optional)</label>
          <input
            id="github-installation-id"
            bind:value={githubInstallationId}
            type="text"
            class="rounded-md border border-neutral-300 px-3 py-2 text-sm"
            placeholder={settings.githubInstallationId ?? '67890'}
          />
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
            placeholder={settings.githubPat !== undefined ? 'Configured — type to replace' : 'ghp_…'}
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
            Verified: {githubVerification.kind === 'app' ? 'GitHub App' : 'account'} {githubVerification.account}
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
        <label class="text-sm font-medium" for="default-issue-budget">Default per-issue budget (USD)</label>
        <input
          id="default-issue-budget"
          bind:value={defaultIssueBudgetDollars}
          type="text"
          inputmode="decimal"
          class="rounded-md border border-neutral-300 px-3 py-2 text-sm"
          placeholder="0.50"
          aria-invalid={budgetError !== null}
          aria-describedby={budgetError !== null ? 'budget-error' : undefined}
        />
        {#if budgetError !== null}
          <p id="budget-error" class="text-sm text-red-600">{budgetError}</p>
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
