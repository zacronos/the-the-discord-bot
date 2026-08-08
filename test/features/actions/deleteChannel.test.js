import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteChannelAction } from '../../../src/features/actions/deleteChannel.js';
import { listDueDeletions } from '../../../src/store/scheduledDeletions.js';
import { tempDb } from '../../store/helpers.js';

const POLL = { id: 12, type: 'delete_channel', subject: 'chan-doomed' };

function fakeGuild(channels) {
  return {
    id: 'g1',
    channels: {
      fetch: async (id) => {
        const channel = channels[id];
        if (!channel) throw new Error('Unknown Channel');
        return channel;
      },
    },
  };
}

test('schedules deletion 24h out (hour-rounded), warns the channel, and reports the time', async (t) => {
  const db = tempDb(t);
  const sent = [];
  const doomed = { id: 'chan-doomed', name: 'old-plans', send: async (p) => sent.push(p) };
  const guild = fakeGuild({ 'chan-doomed': doomed });

  // now = 1000 → +24h = 86_401_000 → next hour boundary = 90_000_000 (25h)
  const note = await deleteChannelAction({ db, now: () => 1_000 }, guild, POLL);

  const rows = listDueDeletions(db, 90_000_000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel_id, 'chan-doomed');
  assert.equal(rows[0].delete_at, 90_000_000);
  assert.equal(rows[0].poll_id, 12);

  assert.equal(sent.length, 1, 'the channel is warned');
  assert.match(sent[0].content, /scheduled for deletion/);
  assert.match(sent[0].content, /<t:90000:F>/);
  assert.match(sent[0].content, /<t:90000:R>/);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });

  assert.match(note, /#old-plans \(<#chan-doomed>\)/, 'the name survives the eventual deletion');
  assert.match(note, /<t:90000:F>/);
});

test('a vanished channel fails the action clearly and schedules nothing', async (t) => {
  const db = tempDb(t);
  const guild = fakeGuild({});
  await assert.rejects(() => deleteChannelAction({ db, now: () => 0 }, guild, POLL), /no longer exists/);
  assert.equal(listDueDeletions(db, 9_999_999_999).length, 0);
});

test('a failed warning message does not cancel the scheduled deletion', async (t) => {
  const db = tempDb(t);
  const doomed = {
    id: 'chan-doomed',
    send: async () => {
      throw new Error('Missing Access');
    },
  };
  const note = await deleteChannelAction({ db, now: () => 1_000 }, fakeGuild({ 'chan-doomed': doomed }), POLL);
  assert.equal(listDueDeletions(db, 90_000_000).length, 1);
  assert.match(note, /scheduled for deletion/);
});
