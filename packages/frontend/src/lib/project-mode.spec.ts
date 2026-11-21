import { describe, expect, it } from 'vitest';
import { projectModeHint, projectModeLabel } from './project-mode';

describe('projectModeLabel', () => {
  it('humanises both project modes', () => {
    expect(projectModeLabel('guided')).toBe('Guided');
    expect(projectModeLabel('autonomous')).toBe('Autonomous');
  });
});

describe('projectModeHint', () => {
  it('explains how the agent works in both project modes', () => {
    expect(projectModeHint('guided')).toMatch(/interviews you/i);
    expect(projectModeHint('autonomous')).toMatch(/decides everything/i);
  });
});
