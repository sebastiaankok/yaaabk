import { describe, expect, it } from 'vitest';
import { describePush, describeSyncStatus } from './issue-sync';

describe('describeSyncStatus', () => {
  it('handles an empty project', () => {
    expect(describeSyncStatus({ total: 0, synced: 0, pending: 0, lastSyncedAt: null })).toBe(
      'No issues yet.',
    );
  });

  it('says nothing is on GitHub yet', () => {
    expect(describeSyncStatus({ total: 3, synced: 0, pending: 3, lastSyncedAt: null })).toBe(
      'Not yet on GitHub · 3 pending',
    );
  });

  it('reports a fully mirrored project', () => {
    expect(describeSyncStatus({ total: 3, synced: 3, pending: 0, lastSyncedAt: 'x' })).toBe(
      'All 3 issues on GitHub',
    );
  });

  it('reports a partially mirrored project', () => {
    expect(describeSyncStatus({ total: 4, synced: 3, pending: 1, lastSyncedAt: 'x' })).toBe(
      '3 of 4 on GitHub · 1 pending',
    );
  });
});

describe('describePush', () => {
  it('reports created and updated counts', () => {
    expect(
      describePush({
        created: 2,
        updated: 1,
        status: { total: 3, synced: 3, pending: 0, lastSyncedAt: 'x' },
      }),
    ).toBe('GitHub in sync · 2 created, 1 updated');
  });

  it('reports a no-op push', () => {
    expect(
      describePush({
        created: 0,
        updated: 0,
        status: { total: 0, synced: 0, pending: 0, lastSyncedAt: null },
      }),
    ).toBe('Everything already up to date.');
  });
});
