import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listDueDeletions,
  removeScheduledDeletion,
  scheduleDeletion,
} from '../../src/store/scheduledDeletions.js';
import { tempDb } from './helpers.js';

test('scheduleDeletion stores a row and listDueDeletions returns only due ones', (t) => {
  const db = tempDb(t);
  scheduleDeletion(db, { channelId: 'chan-1', guildId: 'g1', deleteAt: 5_000, pollId: 7 });
  scheduleDeletion(db, { channelId: 'chan-2', guildId: 'g1', deleteAt: 9_000 });

  const due = listDueDeletions(db, 5_000);
  assert.equal(due.length, 1);
  assert.equal(due[0].channel_id, 'chan-1');
  assert.equal(due[0].guild_id, 'g1');
  assert.equal(due[0].poll_id, 7);
});

test('re-scheduling the same channel replaces its deletion time', (t) => {
  const db = tempDb(t);
  scheduleDeletion(db, { channelId: 'chan-1', guildId: 'g1', deleteAt: 5_000 });
  scheduleDeletion(db, { channelId: 'chan-1', guildId: 'g1', deleteAt: 9_000 });
  assert.equal(listDueDeletions(db, 5_000).length, 0);
  assert.equal(listDueDeletions(db, 9_000).length, 1);
});

test('removeScheduledDeletion clears the row', (t) => {
  const db = tempDb(t);
  scheduleDeletion(db, { channelId: 'chan-1', guildId: 'g1', deleteAt: 5_000 });
  removeScheduledDeletion(db, 'chan-1');
  assert.equal(listDueDeletions(db, 99_000).length, 0);
});
