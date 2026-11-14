<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { SKILL_LEVELS, type SkillLevel } from '@yaaabk/shared';
  import { ApiError, createProjectStream } from '#lib/api.js';
  import {
    applyProvisioningEvent,
    completeCreation,
    failCreation,
    startCreation,
    type CreationState,
  } from '#lib/creation-progress.js';
  import {
    hasErrors,
    validateProjectDetails,
    type ProjectDetailsErrors,
  } from '#lib/project-form.js';

  type Step = 'details' | 'skill' | 'creating';

  const SKILL_LABELS: Record<SkillLevel, string> = { beginner: 'Beginner', expert: 'Expert' };
  const SKILL_HINTS: Record<SkillLevel, string> = {
    beginner: 'Step-by-step questions with sensible defaults',
    expert: 'Deeper architectural questions and opinionated choices',
  };

  let step = $state<Step>('details');
  let name = $state('');
  let description = $state('');
  let skillLevel = $state<SkillLevel>('beginner');
  let errors = $state<ProjectDetailsErrors>({});
  let creation = $state<CreationState | null>(null);
  let failure = $state<string | null>(null);

  function continueToSkill(): void {
    errors = validateProjectDetails({ name, description });
    if (hasErrors(errors)) return;
    step = 'skill';
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
          skillLevel,
        },
        (event) => {
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

  function tryAgain(): void {
    creation = null;
    failure = null;
    step = 'details';
  }
</script>

<svelte:head>
  <title>New project · YAAABK</title>
</svelte:head>

<main class="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 p-6">
  <a href={resolve('/')} class="text-sm text-neutral-500 hover:underline">← Back to projects</a>

  {#if step === 'details'}
    <section class="flex flex-col gap-4">
      <h2 class="text-xl font-semibold tracking-tight">Project details</h2>
      <form
        class="flex flex-col gap-4"
        onsubmit={(event) => {
          event.preventDefault();
          continueToSkill();
        }}
      >
        <div class="flex flex-col gap-1">
          <label class="text-sm font-medium" for="name">Project name</label>
          <input
            id="name"
            bind:value={name}
            type="text"
            class="rounded-md border border-neutral-300 px-3 py-2 text-sm"
            placeholder="todo-app"
            aria-invalid={errors.name !== undefined}
            aria-describedby={errors.name !== undefined ? 'name-error' : undefined}
          />
          {#if errors.name !== undefined}
            <p id="name-error" class="text-sm text-red-600">{errors.name}</p>
          {/if}
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-sm font-medium" for="description">Description</label>
          <textarea
            id="description"
            bind:value={description}
            rows="3"
            class="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            placeholder="What are you building?"
            aria-invalid={errors.description !== undefined}
            aria-describedby={errors.description !== undefined ? 'description-error' : undefined}
          ></textarea>
          {#if errors.description !== undefined}
            <p id="description-error" class="text-sm text-red-600">{errors.description}</p>
          {/if}
        </div>

        <button
          type="submit"
          class="self-start rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700"
        >
          Continue
        </button>
      </form>
    </section>
  {:else if step === 'skill'}
    <section class="flex flex-col gap-4">
      <h2 class="text-xl font-semibold tracking-tight">Skill level</h2>
      <fieldset class="flex flex-col gap-3">
        <legend class="sr-only">Skill level</legend>
        {#each SKILL_LEVELS as level (level)}
          <label
            class="flex cursor-pointer items-start gap-3 rounded-lg border border-neutral-200 p-3 has-[:checked]:border-neutral-900"
          >
            <input
              type="radio"
              name="skill"
              value={level}
              aria-label={SKILL_LABELS[level]}
              bind:group={skillLevel}
              class="mt-1"
            />
            <span>
              <span class="font-medium">{SKILL_LABELS[level]}</span>
              <span class="block text-sm text-neutral-500">{SKILL_HINTS[level]}</span>
            </span>
          </label>
        {/each}
      </fieldset>
      <div class="flex gap-2">
        <button
          type="button"
          onclick={() => (step = 'details')}
          class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100"
        >
          Back
        </button>
        <button
          type="button"
          onclick={() => void create()}
          class="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700"
        >
          Create project
        </button>
      </div>
    </section>
  {:else if creation !== null}
    <section class="flex flex-col gap-4">
      <h2 class="text-xl font-semibold tracking-tight">
        {creation.status === 'failed' ? 'Project creation failed' : 'Creating project…'}
      </h2>
      <ul class="flex flex-col gap-2" aria-live="polite">
        {#each creation.steps as item (item.id)}
          <li class="flex items-center gap-2 text-sm">
            <span
              class="inline-block w-4 text-center"
              class:text-neutral-400={item.status === 'pending'}
              class:text-green-600={item.status === 'done'}
              class:text-red-600={item.status === 'failed'}
            >
              {item.status === 'done' ? '✓' : item.status === 'failed' ? '✗' : '•'}
            </span>
            <span class:text-neutral-500={item.status === 'pending'}>{item.label}</span>
          </li>
        {/each}
      </ul>

      {#if failure !== null}
        <p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{failure}</p>
        <button
          type="button"
          onclick={tryAgain}
          class="self-start rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100"
        >
          Try again
        </button>
      {/if}
    </section>
  {/if}
</main>
