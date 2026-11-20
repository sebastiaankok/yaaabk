import { describe, expect, it } from 'vitest';
import { projectWizardSteps } from './wizard-steps';

describe('projectWizardSteps', () => {
  it('names the two steps in order', () => {
    expect(projectWizardSteps('details').map((step) => step.label)).toEqual(['Details', 'Mode']);
  });

  it('marks Details current and Mode upcoming while entering details', () => {
    expect(projectWizardSteps('details')).toEqual([
      { id: 'details', label: 'Details', status: 'current' },
      { id: 'mode', label: 'Mode', status: 'upcoming' },
    ]);
  });

  it('marks Details complete once Mode is current', () => {
    expect(projectWizardSteps('mode')).toEqual([
      { id: 'details', label: 'Details', status: 'complete' },
      { id: 'mode', label: 'Mode', status: 'current' },
    ]);
  });

  it('marks both steps complete when provisioning has started', () => {
    expect(projectWizardSteps(null).map((step) => step.status)).toEqual(['complete', 'complete']);
  });
});
