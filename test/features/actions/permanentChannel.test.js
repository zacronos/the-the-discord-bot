import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permanentChannelAction } from '../../../src/features/actions/permanentChannel.js';
import { setConfig } from '../../../src/store/guildConfig.js';
import { tempDb } from '../../store/helpers.js';

const POLL = { id: 9, type: 'permanent_channel', subject: 'chan-target' };

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

test('moves the channel into the category with permissions synced', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { permanent_category_id: 'cat-1' });
  const moves = [];
  const target = {
    id: 'chan-target',
    setParent: async (categoryId, options) => moves.push([categoryId, options]),
  };
  const guild = fakeGuild({ 'chan-target': target, 'cat-1': { id: 'cat-1' } });

  const note = await permanentChannelAction({ db }, guild, POLL);

  assert.equal(moves.length, 1);
  assert.equal(moves[0][0], 'cat-1');
  assert.equal(moves[0][1].lockPermissions, true, 'permission overwrites synced with the category');
  assert.match(note, /<#chan-target>/);
  assert.match(note, /<#cat-1>/);
});

test('fails clearly when the voted-on channel no longer exists', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { permanent_category_id: 'cat-1' });
  const guild = fakeGuild({ 'cat-1': { id: 'cat-1' } });

  await assert.rejects(() => permanentChannelAction({ db }, guild, POLL), /channel no longer exists/i);
});

test('fails clearly when the configured category no longer exists', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { permanent_category_id: 'cat-gone' });
  const guild = fakeGuild({ 'chan-target': { id: 'chan-target', setParent: async () => {} } });

  await assert.rejects(() => permanentChannelAction({ db }, guild, POLL), /category no longer exists/i);
});
