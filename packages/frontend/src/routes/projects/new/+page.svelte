<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import Check from '@lucide/svelte/icons/check';
  import Circle from '@lucide/svelte/icons/circle';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import X from '@lucide/svelte/icons/x';
  import { PROJECT_MODES, type ProjectMode } from '@yaaabk/shared';
  import { tick } from 'svelte';
  import { ApiError, createProjectStream } from '#lib/api.js';
  import PageHeader from '#lib/components/page-header.svelte';
  import { Alert, AlertDescription, AlertTitle } from '#lib/components/ui/alert/index.js';
  import { Button } from '#lib/components/ui/button/index.js';
  import { Card, CardContent, CardDescription, CardHeader } from '#lib/components/ui/card/index.js';
  import { Input } from '#lib/components/ui/input/index.js';
  import { Textarea } from '#lib/components/ui/textarea/index.js';
  import WizardStepper from '#lib/components/wizard-stepper.svelte';
  import {
    applyProvisioningEvent,
    completeCreation,
    failCreation,
    startCreation,
    type CreationState,
    type ProvisioningEvent,
    type StepStatus,
  } from '#lib/creation-progress.js';
  import { projectModeLabel } from '#lib/project-mode.js';
  import {
    hasErrors,
    validateProjectDetails,
    type ProjectDetailsErrors,
  } from '#lib/project-form.js';
  import { resolveShell } from '#lib/shell.js';
  import { projectWizardSteps, type WizardStepId } from '#lib/wizard-steps.js';

  type Step = 'details' | 'mode' | 'creating';

  const MODE_HINTS: Record<ProjectMode, string> = {
    guided:
      'The agent interviews you one question at a time, then checks the module sketch and issue breakdown with you.',
    autonomous:
      'The agent decides everything itself and only shows you the finished Plan and Issues.',
  };

  const STATUS_TEXT: Record<StepStatus, string> = {
    pending: 'Pending',
    active: 'Running',
    done: 'Done',
    failed: 'Failed',
  };

  const shell = $derived(resolveShell(page.url.pathname));

  let step = $state<Step>('details');
  const activeStep = $derived<WizardStepId | null>(step === 'creating' ? null : step);
  const steps = $derived(projectWizardSteps(activeStep));
  let name = $state('');
  let description = $state('');
  let mode = $state<ProjectMode>('guided');
  let errors = $state<ProjectDetailsErrors>({});
  let creation = $state<CreationState | null>(null);
  let failure = $state<string | null>(null);

  async function continueToMode(): Promise<void> {
    errors = validateProjectDetails({ name, description });
    if (hasErrors(errors)) {
      await tick();
      document.getElementById(errors.name !== undefined ? 'name' : 'description')?.focus();
      return;
    }
    step = 'mode';
  }

  function backToDetails(): void {
    step = 'details';
  }

  function describe(cause: unknown): string {
    return cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.';
  }

  async function create(): Promise<void> {
    failure = null;
    creation = startCreation();
    step = 'creating';

    try {
      const project = await createProjectStream(
        {
          name: name.trim(),
          description: description.trim(),
          mode,
        },
        (event: ProvisioningEvent) => {
          if (creation !== null) creation = applyProvisioningEvent(creation, event);
        },
      );
      creation = completeCreation(creation ?? startCreation());
      await goto(resolve('/projects/[id]', { id: project.id }));
    } catch (cause) {
      const message = describe(cause);
      failure = message;
      if (creation !== null) creation = failCreation(creation, message);
    }
  }

  async function tryAgain(): Promise<void> {
    creation = null;
    failure = null;
    step = 'details';
    await tick();
    document.getElementById('name')?.focus();
  }
</script>

<svelte:head>
  <title>New project · YAAABK</title>
</svelte:head>

<div class="mx-auto flex w-full min-w-0 max-w-2xl flex-col gap-6">
  <PageHeader
    title="New project"
    purpose="Name the Project, describe what it should do, then choose how the agent works with you."
    breadcrumbs={shell.breadcrumbs}
  />

  <WizardStepper {steps} />

  {#if step === 'details'}
    <Card>
      <CardHeader>
        <h2 class="text-lg font-medium tracking-tight text-foreground">Project details</h2>
        <CardDescription
          >This names the repository and the namespace behind your Project.</CardDescription
        >
      </CardHeader>
      <CardContent>
        <form
          class="flex flex-col gap-5"
          onsubmit={(event) => {
            event.preventDefault();
            void continueToMode();
          }}
        >
          <div class="flex flex-col gap-2">
            <label class="text-sm font-medium text-foreground" for="name">Project name</label>
            <Input
              id="name"
              bind:value={name}
              type="text"
              class="h-11 px-3 text-base md:text-sm"
              placeholder="todo-app"
              aria-invalid={errors.name !== undefined}
              aria-describedby={errors.name !== undefined ? 'name-error' : 'name-hint'}
            />
            <p id="name-hint" class="text-xs text-muted-foreground">
              Lowercase letters, digits and single hyphens. The repository and namespace use this
              name.
            </p>
            {#if errors.name !== undefined}
              <p id="name-error" class="text-sm font-medium text-destructive">{errors.name}</p>
            {/if}
          </div>

          <div class="flex flex-col gap-2">
            <label class="text-sm font-medium text-foreground" for="description">Description</label>
            <Textarea
              id="description"
              bind:value={description}
              rows={3}
              class="min-h-24 px-3 py-2 text-base md:text-sm"
              placeholder="What are you building?"
              aria-invalid={errors.description !== undefined}
              aria-describedby={errors.description !== undefined
                ? 'description-error'
                : 'description-hint'}
            ></Textarea>
            <p id="description-hint" class="text-xs text-muted-foreground">
              One or two sentences the agent can use to understand the Project.
            </p>
            {#if errors.description !== undefined}
              <p id="description-error" class="text-sm font-medium text-destructive">
                {errors.description}
              </p>
            {/if}
          </div>

          <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="submit" class="h-11 w-full text-base sm:w-auto sm:px-6">Continue</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  {:else if step === 'mode'}
    <Card>
      <CardHeader>
        <h2 class="text-lg font-medium tracking-tight text-foreground">
          How should the agent work with you?
        </h2>
        <CardDescription>You can change this later in the Project settings.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          class="flex flex-col gap-5"
          onsubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <fieldset class="flex flex-col gap-3">
            <legend class="sr-only">Project mode</legend>
            {#each PROJECT_MODES as option (option)}
              <label
                class="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-border-subtle p-4 transition-colors has-[:checked]:border-primary has-[:checked]:bg-secondary"
              >
                <input
                  type="radio"
                  name="mode"
                  value={option}
                  aria-label={projectModeLabel(option)}
                  aria-describedby={`mode-${option}-description`}
                  bind:group={mode}
                  class="mt-1 size-4 shrink-0 accent-primary"
                />
                <span class="flex min-w-0 flex-col gap-1">
                  <span class="font-medium text-foreground">{projectModeLabel(option)}</span>
                  <span id={`mode-${option}-description`} class="text-sm text-muted-foreground">
                    {MODE_HINTS[option]}
                  </span>
                </span>
              </label>
            {/each}
          </fieldset>

          <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <Button
              type="button"
              variant="outline"
              class="h-11 w-full text-base sm:w-auto sm:px-6"
              onclick={backToDetails}
            >
              Back
            </Button>
            <Button type="submit" class="h-11 w-full text-base sm:w-auto sm:px-6">
              Create project
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  {:else if creation !== null}
    <Card>
      <CardHeader>
        <h2 class="text-lg font-medium tracking-tight text-foreground">
          {creation.status === 'failed' ? 'Project creation failed' : 'Creating project…'}
        </h2>
        <CardDescription>
          {creation.status === 'failed'
            ? 'Your Project was not created. The steps below show how far provisioning got.'
            : 'Provisioning the repository, namespace and access your Project needs.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol
          class="flex flex-col gap-1"
          aria-live="polite"
          aria-label="Provisioning steps"
          data-testid="provisioning-checklist"
        >
          {#each creation.steps as item (item.id)}
            <li
              data-testid={`provisioning-${item.id}`}
              data-status={item.status}
              class="flex min-h-11 items-center gap-3 rounded-lg px-2 py-2"
            >
              <span
                aria-hidden="true"
                class="flex size-6 shrink-0 items-center justify-center {item.status === 'done'
                  ? 'text-success'
                  : item.status === 'failed'
                    ? 'text-destructive'
                    : item.status === 'active'
                      ? 'text-primary'
                      : 'text-muted-foreground'}"
              >
                {#if item.status === 'done'}
                  <Check class="size-4" />
                {:else if item.status === 'failed'}
                  <X class="size-4" />
                {:else if item.status === 'active'}
                  <LoaderCircle class="size-4 animate-spin" />
                {:else}
                  <Circle class="size-4" />
                {/if}
              </span>
              <span
                class="min-w-0 flex-1 text-sm break-words {item.status === 'pending'
                  ? 'text-muted-foreground'
                  : 'text-foreground'}"
              >
                {item.label}
              </span>
              <span
                class="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium {item.status === 'done'
                  ? 'bg-success-subtle text-success'
                  : item.status === 'failed'
                    ? 'bg-destructive-subtle text-destructive'
                    : item.status === 'active'
                      ? 'bg-info-subtle text-info'
                      : 'bg-muted text-muted-foreground'}"
              >
                {STATUS_TEXT[item.status]}
              </span>
            </li>
          {/each}
        </ol>

        {#if failure !== null}
          <Alert variant="destructive" class="mt-4 border-destructive/30 bg-destructive-subtle">
            <AlertTitle>Could not finish provisioning</AlertTitle>
            <AlertDescription>{failure}</AlertDescription>
            <div class="mt-3">
              <Button
                variant="outline"
                class="h-11 w-full bg-background text-base text-foreground sm:w-auto sm:px-6"
                onclick={() => void tryAgain()}
              >
                Try again
              </Button>
            </div>
          </Alert>
        {/if}
      </CardContent>
    </Card>
  {/if}
</div>
