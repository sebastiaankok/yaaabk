import { describe, expect, it } from 'vitest';
import { nextAction } from './project-overview';

describe('nextAction', () => {
  it('starts a Plan session when the Project has no Plan', () => {
    expect(nextAction(null)).toEqual({
      id: 'start-plan',
      label: 'Start a Plan',
      detail: 'No Plan yet. Open a Grill-Me Session to turn your idea into a Plan and Issues.',
    });
  });

  it('asks for a review while the active Plan is unaccepted', () => {
    expect(nextAction({ id: 'plan-1', version: 3, acceptedAt: null })).toEqual({
      id: 'review-plan',
      label: 'Review Plan v3',
      detail: 'Plan v3 is waiting for review. Accept it to publish its Issues to GitHub.',
    });
  });

  it('opens the issue board once the active Plan is accepted', () => {
    expect(
      nextAction({ id: 'plan-1', version: 3, acceptedAt: '2026-02-02T00:00:00.000Z' }),
    ).toEqual({
      id: 'issue-board',
      label: 'Open the issue board',
      detail: 'Plan v3 is accepted. Follow the Issues its Agents are working on.',
    });
  });
});
