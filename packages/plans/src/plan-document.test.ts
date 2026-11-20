import { describe, expect, it } from 'vitest';
import { renderAcceptedPlan } from './plan-document';

const ACCEPTED_AT = '2026-01-01T12:00:00.000Z';

describe('renderAcceptedPlan', () => {
  it('opens with version and acceptance frontmatter and the version heading', () => {
    const document = renderAcceptedPlan({
      version: 2,
      projectName: 'todo-app',
      contentMarkdown: '# Overview',
      acceptedAt: ACCEPTED_AT,
      issues: [],
    });

    expect(document.startsWith('---\nversion: 2\naccepted: 2026-01-01\n---\n')).toBe(true);
    expect(document).toContain('# Plan v2 — todo-app');
  });

  it('reproduces the accepted Plan content verbatim', () => {
    const contentMarkdown = '# Overview\n\nKeep **all** the Markdown.\n\n- one\n- two';

    const document = renderAcceptedPlan({
      version: 1,
      projectName: 'todo-app',
      contentMarkdown,
      acceptedAt: ACCEPTED_AT,
      issues: [],
    });

    expect(document).toContain(contentMarkdown);
  });

  it('appends each published Issue with its label and dependencies', () => {
    const document = renderAcceptedPlan({
      version: 3,
      projectName: 'todo-app',
      contentMarkdown: '# Overview',
      acceptedAt: ACCEPTED_AT,
      issues: [
        { title: 'Schema', label: 'ready', dependsOn: [] },
        { title: 'API', label: 'refinement-needed', dependsOn: ['Schema', 'Auth'] },
      ],
    });

    expect(document).toContain('## Issues published with this Plan');
    expect(document).toContain('- **Schema** (`ready`)');
    expect(document).toContain('- **API** (`refinement-needed`) — depends on: Schema, Auth');
  });

  it('contains no internal identifiers', () => {
    const document = renderAcceptedPlan({
      version: 1,
      projectName: 'todo-app',
      contentMarkdown: '# Overview',
      acceptedAt: ACCEPTED_AT,
      issues: [{ title: 'Schema', label: 'ready', dependsOn: [] }],
    });

    expect(document).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});
