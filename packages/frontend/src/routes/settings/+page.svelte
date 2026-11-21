<script lang="ts">
  import { page } from '$app/state';
  import { toast } from 'svelte-sonner';
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
  import { Button } from '#lib/components/ui/button/index.js';
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from '#lib/components/ui/card/index.js';
  import { Input } from '#lib/components/ui/input/index.js';
  import PageHeader from '#lib/components/page-header.svelte';
  import { Textarea } from '#lib/components/ui/textarea/index.js';
  import { affordabilityWarning, formatUsd } from '#lib/openrouter-balance.js';
  import { resolveShell } from '#lib/shell.js';
  import {
    hasUnsavedChanges,
    saveBarStatus,
    toSettingsUpdate,
    validateBudgetDollars,
    type GitHubCredentialMode,
    type SettingsFormInput,
    type SettingsFormSnapshot,
    type SettingsSavePhase,
  } from '#lib/settings-form.js';
  import type { SettingsView } from '@yaaabk/settings';

  const shell = $derived(resolveShell(page.url.pathname));
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
  let savePhase = $state<SettingsSavePhase>('idle');
  let saveError = $state<string | null>(null);
  let snapshot = $state<SettingsFormSnapshot>({
    githubMode: 'app',
    defaultIssueBudgetDollars: '',
  });
  let githubVerification = $state<GitHubVerifyOk | null>(null);
  let githubVerifyError = $state<string | null>(null);
  let githubVerifying = $state(false);
  let openrouterVerification = $state<OpenRouterVerifyOk | null>(null);
  let openrouterVerifyError = $state<string | null>(null);
  let openrouterVerifying = $state(false);
  let credits = $state<OpenRouterCreditsView | null>(null);
  let creditsLoading = $state(false);
  let creditsFailure = $state<string | null>(null);
  const creditsWarning = $derived(credits === null ? null : affordabilityWarning(credits));

  const formInput = $derived<SettingsFormInput>({
    githubMode,
    githubAppId,
    githubPrivateKey,
    githubInstallationId,
    githubPat,
    openrouterManagementKey,
    defaultIssueBudgetDollars,
  });
  const dirty = $derived(hasUnsavedChanges(formInput, snapshot));
  const status = $derived(saveBarStatus({ dirty, phase: savePhase }));
  const saveStatusLabel = $derived(
    status === 'saving'
      ? 'Saving…'
      : status === 'saved'
        ? 'All changes saved'
        : status === 'unsaved'
          ? 'Unsaved changes'
          : status === 'failed'
            ? 'Save failed'
            : 'No unsaved changes',
  );

  $effect(() => {
    getSettings()
      .then((view) => {
        const mode: GitHubCredentialMode =
          view.githubPat !== undefined && view.githubAppId === undefined ? 'pat' : 'app';
        const budget =
          view.defaultIssueBudgetCents === undefined
            ? ''
            : (view.defaultIssueBudgetCents / 100).toFixed(2);
        settings = view;
        githubMode = mode;
        defaultIssueBudgetDollars = budget;
        snapshot = { githubMode: mode, defaultIssueBudgetDollars: budget };
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

  function validateBudget(): void {
    const budget = defaultIssueBudgetDollars.trim();
    budgetError = budget === '' ? null : (validateBudgetDollars(budget) ?? null);
  }

  // Clear a resolved error while typing, but do not scold mid-word.
  function clearResolvedBudgetError(): void {
    if (budgetError === null) return;
    const budget = defaultIssueBudgetDollars.trim();
    if (budget === '' || validateBudgetDollars(budget) === undefined) {
      budgetError = null;
    }
  }

  async function save(): Promise<void> {
    if (settings === null) return;
    validateBudget();
    // Blank means "leave the stored value unchanged", like every other field on
    // this page, so only validate what was actually typed.
    if (budgetError !== null) return;

    savePhase = 'saving';
    saveError = null;
    try {
      settings = await updateSettings(toSettingsUpdate(formInput, settings));
      githubAppId = '';
      githubPrivateKey = '';
      githubInstallationId = '';
      githubPat = '';
      openrouterManagementKey = '';
      snapshot = {
        githubMode,
        defaultIssueBudgetDollars: defaultIssueBudgetDollars.trim(),
      };
      savePhase = 'saved';
      // The bar reports the state; the toast carries it past the scroll position.
      toast.success('Settings saved');
      void loadCredits();
    } catch (cause) {
      saveError = describe(cause);
      savePhase = 'failed';
    }
  }

  async function verifyGitHub(): Promise<void> {
    githubVerification = null;
    githubVerifyError = null;
    githubVerifying = true;
    try {
      githubVerification = await verifyGithubSettings();
    } catch (cause) {
      githubVerifyError = describe(cause);
    } finally {
      githubVerifying = false;
    }
  }

  async function verifyOpenrouter(): Promise<void> {
    openrouterVerification = null;
    openrouterVerifyError = null;
    openrouterVerifying = true;
    try {
      openrouterVerification = await verifyOpenrouterSettings();
    } catch (cause) {
      openrouterVerifyError = describe(cause);
    } finally {
      openrouterVerifying = false;
    }
  }
</script>

<svelte:head>
  <title>Settings · YAAABK</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-2xl flex-col gap-6">
  <PageHeader
    title="Settings"
    purpose="Connect GitHub and OpenRouter, and set the default budget every Issue starts with."
    breadcrumbs={shell.breadcrumbs}
  />

  {#if loadFailure !== null}
    <p class="text-sm text-red-600">{loadFailure}</p>
  {:else if settings === null}
    <p class="text-sm text-neutral-500">Loading…</p>
  {:else}
    <p class="text-sm text-muted-foreground">
      Credentials are stored encrypted and never shown again — only a masked hint.
    </p>

    <Card data-testid="github-card" aria-labelledby="github-heading">
      <CardHeader>
        <CardTitle><h2 id="github-heading">GitHub</h2></CardTitle>
        <CardDescription>
          YAAABK uses these credentials to create the Project repository and mirror its Issues.
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-4">
        <fieldset class="flex flex-col gap-2">
          <legend class="text-sm font-medium">Authentication</legend>
          <div class="flex flex-wrap gap-x-4 gap-y-2 text-sm">
            <label class="flex min-h-11 items-center gap-2 sm:min-h-0">
              <input type="radio" bind:group={githubMode} value="app" name="github-mode" />
              GitHub App
            </label>
            <label class="flex min-h-11 items-center gap-2 sm:min-h-0">
              <input type="radio" bind:group={githubMode} value="pat" name="github-mode" />
              Personal access token
            </label>
          </div>
        </fieldset>

        {#if githubMode === 'app'}
          <p class="text-xs text-muted-foreground">
            The App needs <strong>Administration: read/write</strong>, plus read/write on Contents,
            Issues, Pull requests, Workflows and Metadata. Workflows is required because every
            Project ships a CI workflow — without it GitHub rejects the first push.
          </p>

          <div class="flex flex-col gap-1">
            <label class="text-sm font-medium" for="github-app-id">App ID</label>
            <Input
              id="github-app-id"
              bind:value={githubAppId}
              type="text"
              placeholder={settings.githubAppId ?? '12345'}
            />
            {#if settings.githubAppId !== undefined && githubAppId === ''}
              <p class="text-xs text-muted-foreground" data-testid="github-app-id-hint">
                Configured: {settings.githubAppId}
              </p>
            {/if}
          </div>

          <div class="flex flex-col gap-1">
            <label class="text-sm font-medium" for="github-private-key">Private key</label>
            <Textarea
              id="github-private-key"
              bind:value={githubPrivateKey}
              rows={3}
              autocomplete="off"
              spellcheck={false}
              class="font-mono text-xs"
              placeholder={settings.githubPrivateKey !== undefined
                ? 'Configured — type to replace'
                : '-----BEGIN RSA PRIVATE KEY-----'}
            />
            <p class="text-xs text-muted-foreground">
              Paste the downloaded <code>.pem</code> file as-is — PKCS#1 and PKCS#8 are both accepted.
            </p>
            {#if settings.githubPrivateKey !== undefined && githubPrivateKey === ''}
              <p class="text-xs text-muted-foreground" data-testid="github-private-key-hint">
                Configured: {settings.githubPrivateKey}
              </p>
            {/if}
          </div>

          <div class="flex flex-col gap-1">
            <label class="text-sm font-medium" for="github-installation-id">Installation ID</label>
            <Input
              id="github-installation-id"
              bind:value={githubInstallationId}
              type="text"
              placeholder={settings.githubInstallationId ?? '67890'}
            />
            <p class="text-xs text-muted-foreground">
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
              <p class="text-xs text-muted-foreground" data-testid="github-installation-id-hint">
                Configured: {settings.githubInstallationId}
              </p>
            {/if}
          </div>
        {:else}
          <div class="flex flex-col gap-1">
            <label class="text-sm font-medium" for="github-pat">Personal access token</label>
            <Input
              id="github-pat"
              bind:value={githubPat}
              type="password"
              autocomplete="off"
              placeholder={settings.githubPat !== undefined
                ? 'Configured — type to replace'
                : 'ghp_…'}
            />
            {#if settings.githubPat !== undefined && githubPat === ''}
              <p class="text-xs text-muted-foreground" data-testid="github-pat-hint">
                Configured: {settings.githubPat}
              </p>
            {/if}
          </div>
        {/if}

        <div class="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            class="h-11 sm:h-9"
            disabled={githubVerifying}
            onclick={verifyGitHub}
          >
            {githubVerifying ? 'Verifying GitHub…' : 'Verify GitHub'}
          </Button>
          <p
            role="status"
            aria-live="polite"
            class="min-w-0 text-sm"
            data-testid="github-verify-result"
          >
            {#if githubVerification !== null}
              <span class="text-green-700">
                Verified: {githubVerification.kind === 'app' ? 'GitHub App' : 'account'}
                {githubVerification.account}
              </span>
            {:else if githubVerifyError !== null}
              <span class="text-red-600">{githubVerifyError}</span>
            {/if}
          </p>
        </div>
      </CardContent>
    </Card>

    <Card data-testid="openrouter-card" aria-labelledby="openrouter-heading">
      <CardHeader>
        <CardTitle><h2 id="openrouter-heading">OpenRouter</h2></CardTitle>
        <CardDescription>
          The management key lets YAAABK create per-Project keys and read their usage.
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-4">
        <div class="flex flex-col gap-1">
          <label class="text-sm font-medium" for="openrouter-management-key">Management key</label>
          <Input
            id="openrouter-management-key"
            bind:value={openrouterManagementKey}
            type="password"
            autocomplete="off"
            placeholder={settings.openrouterManagementKey !== undefined
              ? 'Configured — type to replace'
              : 'sk-or-mgmt-…'}
          />
          {#if settings.openrouterManagementKey !== undefined && openrouterManagementKey === ''}
            <p class="text-xs text-muted-foreground" data-testid="openrouter-key-hint">
              Configured: {settings.openrouterManagementKey}
            </p>
          {/if}
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            class="h-11 sm:h-9"
            disabled={openrouterVerifying}
            onclick={verifyOpenrouter}
          >
            {openrouterVerifying ? 'Verifying OpenRouter…' : 'Verify OpenRouter'}
          </Button>
          <p
            role="status"
            aria-live="polite"
            class="min-w-0 text-sm"
            data-testid="openrouter-verify-result"
          >
            {#if openrouterVerification !== null}
              <span class="text-green-700">
                Verified: {openrouterVerification.keys}
                {openrouterVerification.keys === 1 ? 'key' : 'keys'} managed
              </span>
            {:else if openrouterVerifyError !== null}
              <span class="text-red-600">{openrouterVerifyError}</span>
            {/if}
          </p>
        </div>
      </CardContent>
    </Card>

    <Card data-testid="spending-card" aria-labelledby="spending-heading">
      <CardHeader>
        <CardTitle><h2 id="spending-heading">Spending</h2></CardTitle>
        <CardDescription>
          Each new Issue starts with this budget. Agents stop before exceeding it.
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-4">
        <div class="flex flex-col gap-1">
          <label class="text-sm font-medium" for="default-issue-budget"
            >Default per-issue budget (USD)</label
          >
          <Input
            id="default-issue-budget"
            bind:value={defaultIssueBudgetDollars}
            type="text"
            inputmode="decimal"
            placeholder="1.00"
            aria-invalid={budgetError !== null}
            aria-describedby={budgetError !== null ? 'budget-error' : undefined}
            class="sm:max-w-40"
            oninput={clearResolvedBudgetError}
            onblur={validateBudget}
          />
          {#if budgetError !== null}
            <p id="budget-error" class="text-sm text-red-600" data-testid="budget-error">
              {budgetError}
            </p>
          {/if}
        </div>

        <div
          class="flex flex-col gap-1 rounded-lg border border-border-subtle bg-muted/40 p-3"
          data-testid="balance-status"
        >
          <h3 class="text-sm font-medium">OpenRouter account balance</h3>
          {#if creditsLoading}
            <p class="text-sm text-muted-foreground" role="status" aria-live="polite">
              Loading balance…
            </p>
          {:else if creditsFailure !== null}
            <p class="text-sm text-muted-foreground" role="status" aria-live="polite">
              {creditsFailure}
            </p>
          {:else if credits !== null}
            <p class="text-sm" role="status" aria-live="polite">
              Remaining <strong>{formatUsd(credits.remainingUsd)}</strong> of
              {formatUsd(credits.totalCreditsUsd)} ({formatUsd(credits.totalUsageUsd)} used)
            </p>
            {#if creditsWarning !== null}
              <p
                class="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
                data-testid="balance-warning"
              >
                {creditsWarning}
              </p>
            {/if}
          {/if}
        </div>
      </CardContent>
    </Card>

    <div
      data-testid="save-bar"
      data-status={status}
      class="bg-card/95 sticky bottom-0 z-20 -mx-4 mt-2 flex flex-col gap-3 border-t border-border-subtle px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-elevation-1 backdrop-blur sm:mx-0 sm:flex-row sm:items-center sm:justify-between sm:rounded-xl sm:border"
    >
      <p class="min-w-0 text-sm" role="status" aria-live="polite" data-testid="save-status">
        <span
          class:text-green-700={status === 'saved'}
          class:text-red-600={status === 'failed'}
          class:text-muted-foreground={status === 'clean' || status === 'unsaved'}
        >
          {saveStatusLabel}
        </span>
        {#if status === 'failed' && saveError !== null}
          <span class="text-red-600"> — {saveError}</span>
        {/if}
      </p>
      <Button
        type="button"
        class="h-11 w-full sm:h-9 sm:w-auto"
        disabled={status === 'clean' || status === 'saving' || status === 'saved'}
        onclick={save}
      >
        {status === 'saving' ? 'Saving…' : 'Save settings'}
      </Button>
    </div>
  {/if}
</div>
