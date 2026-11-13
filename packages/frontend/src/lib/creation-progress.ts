import type { ProvisioningStep } from '@yaaabk/projects';

/**
 * The optimistic progress checklist shown while a Project is being created.
 *
 * The backend's `POST /api/projects` is a single synchronous call that reports
 * no per-step progress, so the wizard shows the known provisioning steps and
 * advances them on a timer while the request is in flight, then settles the
 * whole checklist on success or marks the current step failed. This module is
 * the pure state machine behind that display; the wizard only drives the timer
 * and the request.
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

/** Completes the active step and activates the next, if any. */
export function advanceCreation(state: CreationState): CreationState {
  const active = state.steps.findIndex((step) => step.status === 'active');
  if (active === -1) {
    return state;
  }
  return {
    ...state,
    steps: state.steps.map((step, index) => {
      if (index <= active) {
        return { ...step, status: 'done' };
      }
      if (index === active + 1) {
        return { ...step, status: 'active' };
      }
      return step;
    }),
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
