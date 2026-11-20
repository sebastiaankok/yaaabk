import { describe, expect, it } from 'vitest';
import { projectModeLabel } from './project-mode';

describe('projectModeLabel', () => {
  it('humanises both project modes', () => {
    expect(projectModeLabel('guided')).toBe('Guided');
    expect(projectModeLabel('autonomous')).toBe('Autonomous');
  });
});
