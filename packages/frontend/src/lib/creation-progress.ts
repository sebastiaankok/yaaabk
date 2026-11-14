import type { ProvisioningEvent, ProvisioningStep } from '@yaaabk/projects';

export type { ProvisioningEvent };

/**
 * The checklist shown while a Project is being created.
 *
 * The backend streams a `progress` frame per provisioning step lifecycle event;
 * `applyProvisioningEvent` folds those real events into the checklist state.
 */

/** Lifecycle of one provisioning step in the checklist. */
export type StepStatus = 'pending' | 'active' | 'done' | 'failed';

/** Overall outcome of a creation attempt. */
export type CreationStatus = 'running' | 'succeeded' | 'failed';

export interface CreationStep {
  /** The backend provisioning step this entry represents. */
  id: ProvisioningStep;
  label: string;
  status: StepStatus;
}

export interface CreationState {
  status: CreationStatus;
  /** Why creation failed, when it did. */
  message?: string;
  steps: CreationStep[];
}

/** The steps shown while creating a Project, in the order the backend runs them. */
const STEP_DEFS: readonly { id: ProvisioningStep; label: string }[] = [
  { id: 'repository', label: 'Creating GitHub repository' },
  { id: 'scaffold', label: 'Scaffolding project files' },
  { id: 'namespace', label: 'Provisioning namespace' },
  { id: 'service-account', label: 'Creating agent service account' },
  { id: 'role-binding', label: 'Granting agent permissions' },
  { id: 'secret', label: 'Storing GitHub credentials' },
  { id: 'argocd', label: 'Configuring ArgoCD' },
  { id: 'persist', label: 'Finishing up' },
];

/** The checklist's step definitions, exposed for tests and rendering. */
export const CREATION_STEPS = STEP_DEFS;

/** A fresh, running checklist with the first step active. */
export function startCreation(): CreationState {
  return {
    status: 'running',
    steps: STEP_DEFS.map((def, index) => ({
      ...def,
      status: index === 0 ? 'active' : 'pending',
    })),
  };
}

/** Marks every step done and the attempt succeeded. */
export function completeCreation(state: CreationState): CreationState {
  return {
    status: 'succeeded',
    steps: state.steps.map((step) => ({ ...step, status: 'done' })),
  };
}

/** Fails the active step, leaving later steps pending. */
export function failCreation(state: CreationState, message: string): CreationState {
  return {
    status: 'failed',
    message,
    steps: state.steps.map((step) =>
      step.status === 'active' ? { ...step, status: 'failed' } : step,
    ),
  };
}

/**
 * Folds one real provisioning event from the backend into the checklist.
 *
 * A `started` event makes its step active and resets later steps to pending;
 * a `completed` event finishes its step (and anything before it) and activates
 * the next. Events for steps the checklist does not show are ignored.
 */
export function applyProvisioningEvent(
  state: CreationState,
  event: ProvisioningEvent,
): CreationState {
  const index = state.steps.findIndex((step) => step.id === event.step);
  if (index === -1) {
    return state;
  }
  return {
    ...state,
    steps: state.steps.map((step, position) => {
      if (position < index || (event.status === 'completed' && position === index)) {
        return { ...step, status: 'done' };
      }
      if (position === index || (event.status === 'completed' && position === index + 1)) {
        return { ...step, status: 'active' };
      }
      return step;
    }),
  };
}
