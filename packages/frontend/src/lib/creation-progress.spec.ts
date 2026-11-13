import { describe, expect, it } from 'vitest';
import {
  CREATION_STEPS,
  startCreation,
  advanceCreation,
  completeCreation,
  failCreation,
} from './creation-progress';

describe('startCreation', () => {
  it('marks the first step active and the rest pending', () => {
    const state = startCreation();

    expect(state.status).toBe('running');
    expect(state.steps).toHaveLength(CREATION_STEPS.length);
    expect(state.steps[0]?.status).toBe('active');
    expect(state.steps.slice(1).every((step) => step.status === 'pending')).toBe(true);
  });
});

describe('advanceCreation', () => {
  it('completes the active step and activates the next', () => {
    const state = advanceCreation(startCreation());

    expect(state.steps[0]?.status).toBe('done');
    expect(state.steps[1]?.status).toBe('active');
  });

  it('never activates past the final step', () => {
    let state = startCreation();
    for (let i = 0; i < CREATION_STEPS.length + 3; i += 1) {
      state = advanceCreation(state);
    }

    expect(state.steps.every((step) => step.status === 'done')).toBe(true);
    expect(state.steps.some((step) => step.status === 'active')).toBe(false);
  });
});

describe('completeCreation', () => {
  it('marks every step done and the run succeeded', () => {
    const state = completeCreation(advanceCreation(startCreation()));

    expect(state.status).toBe('succeeded');
    expect(state.steps.every((step) => step.status === 'done')).toBe(true);
  });
});

describe('failCreation', () => {
  it('fails the active step, leaves later steps pending, and reports the message', () => {
    const state = failCreation(advanceCreation(startCreation()), 'repository is taken');

    expect(state.status).toBe('failed');
    expect(state.message).toBe('repository is taken');
    expect(state.steps[0]?.status).toBe('done');
    expect(state.steps[1]?.status).toBe('failed');
    expect(state.steps[2]?.status).toBe('pending');
  });
});
