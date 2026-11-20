import { describe, expect, it } from 'vitest';
import { buildGrillSessionPrompt, type GrillSessionPromptInput } from './prompt';

const INPUT: GrillSessionPromptInput = {
  projectId: 'p1',
  projectName: 'todo-app',
  idea: 'A recipe box',
  mode: 'guided',
  model: 'openrouter/anthropic/claude-sonnet-4.5',
};

describe('the grill session opening prompt', () => {
  it('tells the agent to load the grill-me skill before anything else', () => {
    const prompt = buildGrillSessionPrompt(INPUT);

    expect(prompt).toMatch(/before anything else/i);
    expect(prompt).toMatch(/load .*`?grill-me`? (?:skill|with the `?skill`? tool)/i);
  });

  it('tells the Developer to ask for the Plan in the terminal', () => {
    const prompt = buildGrillSessionPrompt(INPUT);

    expect(prompt).toContain('"write the Plan now"');
    expect(prompt).not.toContain('write the PRD now');
  });

  it('names the skill by the id OpenCode registers for the image directory', () => {
    const prompt = buildGrillSessionPrompt(INPUT);

    expect(prompt).toContain('`grill-me`');
    expect(prompt).toContain('skill');
  });

  it('carries the Project, Project Mode, model and idea', () => {
    const prompt = buildGrillSessionPrompt({ ...INPUT, mode: 'autonomous' });

    expect(prompt).toContain('todo-app');
    expect(prompt).toContain('p1');
    expect(prompt).toContain('Mode: autonomous');
    expect(prompt).not.toContain('Developer skill level');
    expect(prompt).toContain(INPUT.model);
    expect(prompt).toContain('A recipe box');
  });

  it('uses an existing active Plan as context', () => {
    const prompt = buildGrillSessionPrompt({ ...INPUT, activePlan: '# Existing PRD' });

    expect(prompt).toContain('# Existing PRD');
    expect(prompt).toMatch(/context/i);
  });

  it('names the repository when the Project has one', () => {
    const prompt = buildGrillSessionPrompt({ ...INPUT, repoFullName: 'acme/todo-app' });

    expect(prompt).toContain('acme/todo-app');
  });

  it('tells the agent it may inspect the cloned repository and the Project workloads', () => {
    const prompt = buildGrillSessionPrompt({ ...INPUT, repoFullName: 'acme/todo-app' });

    expect(prompt).toMatch(/repository/i);
    expect(prompt).toMatch(/kubectl/i);
    expect(prompt).toMatch(/read-only/i);
    expect(prompt).toMatch(/instead of asking/i);
  });

  it('resumes an existing conversation instead of restarting the interview', () => {
    const prompt = buildGrillSessionPrompt(INPUT);

    expect(prompt).toMatch(/reconnect|replayed|resume/i);
    expect(prompt).toMatch(/do not restart/i);
  });

  it('never asks for the removed marker protocol', () => {
    const prompt = buildGrillSessionPrompt(INPUT);

    for (const marker of ['<QUESTION>', '<PLAN>', '<ISSUES>']) {
      expect(prompt).not.toContain(marker);
    }
  });
});
