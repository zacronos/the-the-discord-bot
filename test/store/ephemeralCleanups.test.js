import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addCleanup, listCleanups, removeCleanup } from '../../src/store/ephemeralCleanups.js';
import { tempDb } from './helpers.js';

test('addCleanup stores rows that listCleanups returns; removeCleanup deletes them', (t) => {
  const db = tempDb(t);
  addCleanup(db, { token: 'tok-1', deleteAt: 5_000, expiresAt: 6_000 });
  addCleanup(db, { token: 'tok-2', deleteAt: 7_000, expiresAt: 8_000 });

  const rows = listCleanups(db);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.token, r.delete_at, r.expires_at]),
    [
      ['tok-1', 5_000, 6_000],
      ['tok-2', 7_000, 8_000],
    ]
  );

  removeCleanup(db, 'tok-1');
  assert.equal(listCleanups(db).length, 1);
});

test('re-adding a token replaces its schedule', (t) => {
  const db = tempDb(t);
  addCleanup(db, { token: 'tok-1', deleteAt: 5_000, expiresAt: 6_000 });
  addCleanup(db, { token: 'tok-1', deleteAt: 9_000, expiresAt: 10_000 });
  const [row] = listCleanups(db);
  assert.equal(row.delete_at, 9_000);
});
