import { describe, expect, it } from 'vitest';
import { decodeIssueBody, encodeIssueBody } from './metadata';

describe('issue metadata', () => {
  it('round-trips a body with dependencies and a budget', () => {
    const encoded = encodeIssueBody('Add the login form.', {
      dependsOn: ['Schema', 'Auth API'],
      budgetCents: 75,
    });

    const decoded = decodeIssueBody(encoded);

    expect(decoded.body).toBe('Add the login form.');
    expect(decoded.metadata).toEqual({ dependsOn: ['Schema', 'Auth API'], budgetCents: 75 });
  });

  it('leaves a body without a footer untouched', () => {
    const decoded = decodeIssueBody('Just a plain body.');

    expect(decoded.body).toBe('Just a plain body.');
    expect(decoded.metadata).toBeNull();
  });

  it('carries an empty dependency list', () => {
    const decoded = decodeIssueBody(
      encodeIssueBody('No deps.', { dependsOn: [], budgetCents: 50 }),
    );

    expect(decoded.body).toBe('No deps.');
    expect(decoded.metadata).toEqual({ dependsOn: [], budgetCents: 50 });
  });

  it('treats a corrupt footer as no metadata but still hides it', () => {
    const decoded = decodeIssueBody('Body text.\n\n<!-- yaaabk:meta not-json -->');

    expect(decoded.body).toBe('Body text.');
    expect(decoded.metadata).toBeNull();
  });
});
