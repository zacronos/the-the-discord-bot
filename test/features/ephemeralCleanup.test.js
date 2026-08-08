import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Routes } from 'discord.js';
import {
  clearCleanupTimers,
  rehydrateEphemeralCleanups,
  scheduleEphemeralCleanup,
} from '../../src/features/ephemeralCleanup.js';
import { addCleanup, listCleanups } from '../../src/store/ephemeralCleanups.js';
import { tempDb } from '../store/helpers.js';

const MIN = 60_000;

function fakeInteraction(token) {
  const interaction = {
    token,
    deletedReplies: 0,
    deleteReply: async () => {
      interaction.deletedReplies += 1;
    },
  };
  return interaction;
}

test('scheduling persists the cleanup; firing deletes the reply and the row', async (t) => {
  clearCleanupTimers();
  const db = tempDb(t);
  const scheduled = [];
  const ctx = { db, schedule: (fn, ms) => scheduled.push({ fn, ms }) };
  const interaction = fakeInteraction('tok-1');

  scheduleEphemeralCleanup(ctx, interaction, { now: 1_000 });

  const [row] = listCleanups(db);
  assert.equal(row.token, 'tok-1');
  assert.equal(row.delete_at, 1_000 + 14 * MIN);
  assert.equal(row.expires_at, 1_000 + 15 * MIN);
  assert.equal(scheduled[0].ms, 14 * MIN);

  await scheduled[0].fn();
  assert.equal(interaction.deletedReplies, 1);
  assert.equal(listCleanups(db).length, 0, 'executed cleanups leave no row behind');
});

test('rehydration after a restart deletes overdue-but-deletable replies via REST', async (t) => {
  clearCleanupTimers();
  const db = tempDb(t);
  const restDeletes = [];
  const ctx = {
    db,
    client: { application: { id: 'app-1' }, rest: { delete: async (route) => restDeletes.push(route) } },
    schedule: () => {},
  };
  // due and still inside the token window → delete immediately
  addCleanup(db, { token: 'tok-due', deleteAt: 10_000, expiresAt: 90_000 });
  // token already dead → just drop the row
  addCleanup(db, { token: 'tok-dead', deleteAt: 5_000, expiresAt: 20_000 });

  await rehydrateEphemeralCleanups(ctx, { now: 30_000 });

  assert.deepEqual(restDeletes, [Routes.webhookMessage('app-1', 'tok-due', '@original')]);
  assert.equal(listCleanups(db).length, 0, 'both rows are gone');
});

test('rehydration re-arms timers for cleanups still in the future', async (t) => {
  clearCleanupTimers();
  const db = tempDb(t);
  const restDeletes = [];
  const scheduled = [];
  const ctx = {
    db,
    client: { application: { id: 'app-1' }, rest: { delete: async (route) => restDeletes.push(route) } },
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
  };
  addCleanup(db, { token: 'tok-future', deleteAt: 100_000, expiresAt: 160_000 });

  await rehydrateEphemeralCleanups(ctx, { now: 40_000 });
  assert.equal(restDeletes.length, 0, 'nothing deleted yet');
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 60_000, 'armed for the remaining time');

  await scheduled[0].fn();
  assert.deepEqual(restDeletes, [Routes.webhookMessage('app-1', 'tok-future', '@original')]);
  assert.equal(listCleanups(db).length, 0);
});
