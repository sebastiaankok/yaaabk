import { describe, expect, it } from 'vitest';
import { normaliseGeneratedIssues } from './generated-issue';

describe('normaliseGeneratedIssues', () => {
  it('accepts a well-formed issue list and fills optional fields', () => {
    const result = normaliseGeneratedIssues([{ title: ' Save a bookmark ', body: 'body' }]);

    expect(result).toEqual({
      ok: true,
      value: [
        {
          title: 'Save a bookmark',
          body: 'body',
          labels: [],
          depends_on: [],
        },
      ],
    });
  });

  it('rejects a non-array payload', () => {
    const result = normaliseGeneratedIssues({ title: 'Save a bookmark' });

    expect(result.ok).toBe(false);
  });

  it('rejects an issue without a title', () => {
    const result = normaliseGeneratedIssues([{ title: '  ', body: 'body' }]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('title');
  });

  it('rejects a non-string labels or depends_on entry', () => {
    expect(normaliseGeneratedIssues([{ title: 'One', labels: [1] }]).ok).toBe(false);
    expect(normaliseGeneratedIssues([{ title: 'One', depends_on: [1] }]).ok).toBe(false);
  });
});
