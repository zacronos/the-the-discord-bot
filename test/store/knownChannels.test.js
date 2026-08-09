import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getKnownChannel,
  listKnownChannels,
  recordKnownChannel,
  removeKnownChannel,
} from '../../src/store/knownChannels.js';
import { tempDb } from './helpers.js';

test('recordKnownChannel stores a channel with its creator and lists per guild', (t) => {
  const db = tempDb(t);
  recordKnownChannel(db, { channelId: 'c1', guildId: 'g1', creatorId: 'u1', recordedAt: 1_000 });
  recordKnownChannel(db, { channelId: 'c2', guildId: 'g1', creatorId: null, recordedAt: 2_000 });
  recordKnownChannel(db, { channelId: 'c3', guildId: 'g2', creatorId: 'u2', recordedAt: 3_000 });

  const row = getKnownChannel(db, 'c1');
  assert.equal(row.guild_id, 'g1');
  assert.equal(row.creator_id, 'u1');
  assert.equal(row.recorded_at, 1_000);
  assert.equal(getKnownChannel(db, 'c2').creator_id, null, 'unknown creators are stored as null');
  assert.deepEqual(
    listKnownChannels(db, 'g1').map((r) => r.channel_id),
    ['c1', 'c2'],
    'listing is per guild'
  );
});

test('re-recording never erases a known creator, but a later lookup can fill an unknown one', (t) => {
  const db = tempDb(t);
  recordKnownChannel(db, { channelId: 'c1', guildId: 'g1', creatorId: 'u1', recordedAt: 1_000 });
  recordKnownChannel(db, { channelId: 'c1', guildId: 'g1', creatorId: null, recordedAt: 2_000 });
  assert.equal(getKnownChannel(db, 'c1').creator_id, 'u1', 'null never clobbers a known creator');

  recordKnownChannel(db, { channelId: 'c2', guildId: 'g1', creatorId: null, recordedAt: 1_000 });
  recordKnownChannel(db, { channelId: 'c2', guildId: 'g1', creatorId: 'u2', recordedAt: 2_000 });
  assert.equal(getKnownChannel(db, 'c2').creator_id, 'u2');
});

test('removeKnownChannel drops the row and reports whether one existed', (t) => {
  const db = tempDb(t);
  recordKnownChannel(db, { channelId: 'c1', guildId: 'g1', creatorId: 'u1', recordedAt: 1_000 });
  assert.equal(removeKnownChannel(db, 'c1'), 1);
  assert.equal(getKnownChannel(db, 'c1'), undefined);
  assert.equal(removeKnownChannel(db, 'c1'), 0);
});
