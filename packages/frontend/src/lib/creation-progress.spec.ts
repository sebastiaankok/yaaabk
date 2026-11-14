import { describe, expect, it } from 'vitest';
import {
  CREATION_STEPS,
  startCreation,
  applyProvisioningEvent,
  completeCreation,
  failCreation,
  type ProvisioningEvent,
} from './creation-progress';

/** Convenience builder for a real backend event. */
function event(step: string, status: 'started' | 'completed'): ProvisioningEvent {
  return { step: step as ProvisioningEvent['step'], status };
}

/** A checklist one step into creation, matching common test setups. */
function oneStepDone() {
  return applyProvisioningEvent(startCreation(), event('repository', 'completed'));
}

describe('startCreation', () => {
  it('marks the first step active and the rest pending', () => {
    const state = startCreation();

    expect(state.status).toBe('running');
    expect(state.steps).toHaveLength(CREATION_STEPS.length);
    expect(state.steps[0]?.status).toBe('active');
    expect(state.steps.slice(1).every((step) => step.status === 'pending')).toBe(true);
  });
});

describe('completeCreation', () => {
  it('marks every step done and the run succeeded', () => {
    const state = completeCreation(oneStepDone());

    expect(state.status).toBe('succeeded');
    expect(state.steps.every((step) => step.status === 'done')).toBe(true);
  });
});

describe('failCreation', () => {
  it('fails the active step, leaves later steps pending, and reports the message', () => {
    const state = failCreation(oneStepDone(), 'repository is taken');

    expect(state.status).toBe('failed');
    expect(state.message).toBe('repository is taken');
    expect(state.steps[0]?.status).toBe('done');
    expect(state.steps[1]?.status).toBe('failed');
    expect(state.steps[2]?.status).toBe('pending');
  });
});

describe('applyProvisioningEvent', () => {
  it('walks the checklist in step order from real events', () => {
    let state = startCreation();

    state = applyProvisioningEvent(state, event('repository', 'started'));
    expect(state.status).toBe('running');
    expect(state.steps[0]?.status).toBe('active');

    state = applyProvisioningEvent(state, event('repository', 'completed'));
    expect(state.steps[0]?.status).toBe('done');
    expect(state.steps[1]?.status).toBe('active');
    expect(state.steps.slice(2).every((step) => step.status === 'pending')).toBe(true);

    // A later completed event implies the steps before it finished too.
    state = applyProvisioningEvent(state, event('scaffold', 'completed'));
    expect(state.steps[1]?.status).toBe('done');
    expect(state.steps[2]?.status).toBe('active');
  });

  it('knows every provisioning step the backend runs', () => {
    expect(CREATION_STEPS.map((step) => step.id)).toEqual([
      'repository',
      'scaffold',
      'namespace',
      'service-account',
      'role-binding',
      'secret',
      'argocd',
      'persist',
    ]);
  });

  it('completing the final step readies the checklist for completion', () => {
    let state = startCreation();
    for (const id of CREATION_STEPS.map((step) => step.id)) {
      state = applyProvisioningEvent(state, event(id, 'completed'));
    }

    expect(state.steps.every((step) => step.status === 'done')).toBe(true);
  });
});
