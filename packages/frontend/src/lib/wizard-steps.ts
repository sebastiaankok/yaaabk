/**
 * The new-project wizard's steps.
 *
 * The page renders the same two steps in every phase; this module decides which
 * one is current so the stepper, the form and its assistive-technology hints
 * cannot disagree about where the Developer is.
 */

export type WizardStepId = 'details' | 'mode';

export type WizardStepStatus = 'complete' | 'current' | 'upcoming';

export interface WizardStep {
  id: WizardStepId;
  label: string;
  status: WizardStepStatus;
}

const STEPS: readonly { id: WizardStepId; label: string }[] = [
  { id: 'details', label: 'Details' },
  { id: 'mode', label: 'Mode' },
];

/**
 * The wizard steps and their state for the given phase.
 *
 * `null` means provisioning has begun: both steps are complete and no step is
 * `aria-current`, because the checklist below owns the progress from then on.
 */
export function projectWizardSteps(active: WizardStepId | null): WizardStep[] {
  const activeIndex =
    active === null ? STEPS.length : STEPS.findIndex((step) => step.id === active);

  return STEPS.map((step, index) => ({
    ...step,
    status: index < activeIndex ? 'complete' : index === activeIndex ? 'current' : 'upcoming',
  }));
}
