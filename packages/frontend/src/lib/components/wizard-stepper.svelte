<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import type { WizardStep } from '#lib/wizard-steps.js';

  let { steps }: { steps: WizardStep[] } = $props();
</script>

<nav aria-label="Project setup" data-testid="wizard-stepper">
  <ol class="flex flex-wrap items-center gap-2">
    {#each steps as step, index (step.id)}
      <li
        data-testid={`wizard-step-${step.id}`}
        aria-current={step.status === 'current' ? 'step' : undefined}
        class="flex min-h-11 items-center gap-2"
      >
        {#if index > 0}
          <span aria-hidden="true" class="h-px w-4 bg-border-subtle sm:w-6"></span>
        {/if}
        <span
          aria-hidden="true"
          class="flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold {step.status ===
          'complete'
            ? 'bg-success text-success-foreground'
            : step.status === 'current'
              ? 'bg-primary text-primary-foreground'
              : 'border border-border text-muted-foreground'}"
        >
          {#if step.status === 'complete'}
            <Check class="size-4" />
          {:else}
            {index + 1}
          {/if}
        </span>
        <span
          class="text-sm {step.status === 'current'
            ? 'font-semibold text-foreground'
            : 'text-muted-foreground'}"
        >
          {step.label}
        </span>
        {#if step.status === 'current'}
          <span
            class="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground"
          >
            Current
          </span>
        {:else if step.status === 'complete'}
          <span class="sr-only">Completed</span>
        {:else}
          <span class="sr-only">Next</span>
        {/if}
      </li>
    {/each}
  </ol>
</nav>
