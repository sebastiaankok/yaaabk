/// <reference types="bun" />
import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import {
  createSqliteBudgetStore,
  type BudgetRecord,
  type SqliteDatabase,
} from '@yaaabk/cost-control';

const RECORD: BudgetRecord = {
  issueId: 'issue-1',
  keyHash: 'hash-1',
  budgetCents: 50,
  spentCents: 30,
  attempt: 2,
  expiresAt: '2026-12-13T09:00:00.000Z',
  createdAt: '2026-11-13T09:00:00.000Z',
};

function database(): SqliteDatabase {
  return new Database(':memory:') as unknown as SqliteDatabase;
}

describe('sqlite budget store', () => {
  it('persists an Issue budget across store instances', () => {
    const db = database();
    createSqliteBudgetStore(db).save(RECORD);

    expect(createSqliteBudgetStore(db).get('issue-1')).toEqual(RECORD);
  });

  it('replaces the previous attempt and deletes the record', () => {
    const store = createSqliteBudgetStore(database());
    store.save(RECORD);

    store.save({ ...RECORD, keyHash: 'hash-2', spentCents: 45, attempt: 3 });
    expect(store.get('issue-1')).toMatchObject({
      keyHash: 'hash-2',
      spentCents: 45,
      attempt: 3,
    });

    store.delete('issue-1');
    expect(store.get('issue-1')).toBeUndefined();
  });
});
