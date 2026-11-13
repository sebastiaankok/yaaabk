import type { AuthStatus } from './api';

/** Routes that make up the authentication flow itself. */
export const AUTH_ROUTES = ['/setup', '/login'] as const;

/** A route the guard may send the Developer to. */
export type GuardRedirect = '/' | '/setup' | '/login';

export function isAuthRoute(pathname: string): boolean {
  return (AUTH_ROUTES as readonly string[]).includes(pathname);
}

/**
 * Where the route guard should send the Developer, or `null` to stay put.
 *
 * - Until setup is complete, everything except `/setup` goes to `/setup`.
 * - Once setup is complete but the Developer is signed out, everything except
 *   `/login` goes to `/login`.
 * - A signed-in Developer who lands on `/setup` or `/login` goes to `/`.
 */
export function redirectTarget(status: AuthStatus, pathname: string): GuardRedirect | null {
  if (!status.setupComplete) {
    return pathname === '/setup' ? null : '/setup';
  }
  if (!status.authenticated) {
    return pathname === '/login' ? null : '/login';
  }
  return isAuthRoute(pathname) ? '/' : null;
}
