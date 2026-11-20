import { describe, expect, it } from 'vitest';
import { normaliseGeneratedIssues } from './generated-issue';

describe('normaliseGeneratedIssues', () => {
  it('accepts a well-formed issue list and fills optional fields', () => {
    const result = normaliseGeneratedIssues([
      { title: ' Save a bookmark ', body: 'body', summary: 'Save a link for later.' },
    ]);

    expect(result).toEqual({
      ok: true,
      value: [
        {
          title: 'Save a bookmark',
          body: 'body',
          summary: 'Save a link for later.',
          labels: [],
          depends_on: [],
        },
      ],
    });
  });

  it('keeps the labels the agent reported', () => {
    const acceptance = (check: string) =>
      `## What to build\n\nPersist it.\n\n## Acceptance criteria\n\n- [ ] ${check}`;
    const result = normaliseGeneratedIssues([
      {
        title: 'Centre the card',
        summary: 'Centre the card on the page.',
        body: acceptance('Read the page and confirm that the card is centred.'),
        labels: ['ready'],
      },
      {
        title: 'Persist a bookmark',
        summary: 'Persist a bookmark.',
        body: acceptance('`bun test` passes and reports the new test.'),
        labels: ['ready', 'frontend'],
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((issue) => issue.labels)).toEqual([['ready'], ['ready', 'frontend']]);
  });

  it('normalises the summary whitespace', () => {
    const result = normaliseGeneratedIssues([
      { title: 'One', summary: '  Save   and\nfind bookmarks  ' },
    ]);

    expect(result.ok && result.value[0]?.summary).toBe('Save and find bookmarks');
  });

  it('rejects a non-array payload', () => {
    const result = normaliseGeneratedIssues({ title: 'Save a bookmark' });

    expect(result.ok).toBe(false);
  });

  it('rejects an issue without a title', () => {
    const result = normaliseGeneratedIssues([{ title: '  ', body: 'body', summary: 'A summary.' }]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('title');
  });

  it('rejects an issue without a summary', () => {
    const result = normaliseGeneratedIssues([{ title: 'One', body: 'body' }]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('summary');
  });

  it('rejects an empty or over-long summary on any issue', () => {
    expect(normaliseGeneratedIssues([{ title: 'One', summary: '   ' }]).ok).toBe(false);
    expect(normaliseGeneratedIssues([{ title: 'One', summary: 'x'.repeat(201) }]).ok).toBe(false);
  });

  it('rejects a non-string labels or depends_on entry', () => {
    expect(
      normaliseGeneratedIssues([{ title: 'One', summary: 'A summary.', labels: [1] }]).ok,
    ).toBe(false);
    expect(
      normaliseGeneratedIssues([{ title: 'One', summary: 'A summary.', depends_on: [1] }]).ok,
    ).toBe(false);
  });
});
