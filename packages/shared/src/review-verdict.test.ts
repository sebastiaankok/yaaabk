import { describe, expect, it } from 'vitest';
import { reviewVerdictFromBody, reviewVerdictMarker, withReviewVerdict } from './review-verdict';

describe('review verdict markers', () => {
  it('round-trips a verdict through a review body', () => {
    const body = withReviewVerdict('request-changes', 'Fix the /api fallback.');

    expect(reviewVerdictFromBody(body)).toBe('request-changes');
    expect(body).toContain('Fix the /api fallback.');
  });

  it('reads an approve marker', () => {
    expect(reviewVerdictFromBody(`${reviewVerdictMarker('approve')}\n\nLGTM`)).toBe('approve');
  });

  it('ignores an ordinary comment', () => {
    expect(reviewVerdictFromBody('Looks good, thanks!')).toBeUndefined();
  });
});
