import { describe, expect, it } from 'vitest';
import { redirectTarget } from './auth-guard';

const needsSetup = { setupComplete: false, authenticated: false };
const signedOut = { setupComplete: true, authenticated: false };
const signedIn = { setupComplete: true, authenticated: true, user: { id: 'u', username: 'alice' } };

describe('redirectTarget', () => {
  it('sends every route to setup until setup is complete', () => {
    expect(redirectTarget(needsSetup, '/')).toBe('/setup');
    expect(redirectTarget(needsSetup, '/login')).toBe('/setup');
    expect(redirectTarget(needsSetup, '/settings')).toBe('/setup');
    expect(redirectTarget(needsSetup, '/setup')).toBeNull();
  });

  it('sends every route to login once setup is complete but signed out', () => {
    expect(redirectTarget(signedOut, '/')).toBe('/login');
    expect(redirectTarget(signedOut, '/setup')).toBe('/login');
    expect(redirectTarget(signedOut, '/login')).toBeNull();
  });

  it('keeps a signed-in Developer out of the auth routes', () => {
    expect(redirectTarget(signedIn, '/')).toBeNull();
    expect(redirectTarget(signedIn, '/setup')).toBe('/');
    expect(redirectTarget(signedIn, '/login')).toBe('/');
  });
});
