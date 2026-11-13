import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rate-limit';

const T0 = Date.UTC(2026, 0, 1);

function limiterAt(clock: { ms: number }, options = {}) {
  return createRateLimiter({ now: () => new Date(clock.ms), ...options });
}

describe('createRateLimiter', () => {
  it('allows up to the limit and then blocks', () => {
    const limiter = limiterAt({ ms: T0 }, { limit: 5 });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(limiter.check('1.2.3.4')).toBe(true);
    }
    expect(limiter.check('1.2.3.4')).toBe(false);
  });

  it('forgets attempts once the window has passed', () => {
    const clock = { ms: T0 };
    const limiter = limiterAt(clock, { limit: 1, windowMs: 60_000 });

    expect(limiter.check('1.2.3.4')).toBe(true);
    expect(limiter.check('1.2.3.4')).toBe(false);

    clock.ms = T0 + 60_000;

    expect(limiter.check('1.2.3.4')).toBe(true);
  });

  it('counts each key independently', () => {
    const limiter = limiterAt({ ms: T0 }, { limit: 1 });

    expect(limiter.check('1.2.3.4')).toBe(true);
    expect(limiter.check('1.2.3.4')).toBe(false);
    expect(limiter.check('5.6.7.8')).toBe(true);
  });

  it('reports the attempts remaining in the window', () => {
    const limiter = limiterAt({ ms: T0 }, { limit: 3 });

    expect(limiter.remaining('1.2.3.4')).toBe(3);
    limiter.check('1.2.3.4');
    expect(limiter.remaining('1.2.3.4')).toBe(2);
  });

  it('clears a key on reset', () => {
    const limiter = limiterAt({ ms: T0 }, { limit: 1 });
    limiter.check('1.2.3.4');

    limiter.reset('1.2.3.4');

    expect(limiter.check('1.2.3.4')).toBe(true);
  });
});
