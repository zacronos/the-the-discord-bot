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
    name: 'quarterly',
    setParent: async (categoryId, options) => moves.push([categoryId, options]),
  };
  const guild = fakeGuild({ 'chan-target': target, 'cat-1': { id: 'cat-1', name: 'permanent' } });

  const note = await permanentChannelAction({ db }, guild, POLL);

  assert.equal(moves.length, 1);
  assert.equal(moves[0][0], 'cat-1');
  assert.equal(moves[0][1].lockPermissions, true, 'permission overwrites synced with the category');
  assert.match(note, /#quarterly \(<#chan-target>\)/, 'name plus clickable reference');
  assert.match(note, /#permanent \(<#cat-1>\)/);
});

test('fails clearly when the voted-on channel no longer exists', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { permanent_category_id: 'cat-1' });
  const guild = fakeGuild({ 'cat-1': { id: 'cat-1' } });

  await assert.rejects(() => permanentChannelAction({ db }, guild, POLL), /channel no longer exists/i);
});

test('voice channels move into the voice category, text into the text category (autodetected)', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { permanent_category_text_id: 'cat-t', permanent_category_voice_id: 'cat-v' });
  const moves = [];
  const textChannel = { id: 'chan-text', setParent: async (id, opts) => moves.push(['chan-text', id, opts]) };
  const voiceChannel = {
    id: 'chan-voice',
    type: 2,
    setParent: async (id, opts) => moves.push(['chan-voice', id, opts]),
  };
  const guild = fakeGuild({
    'chan-text': textChannel,
    'chan-voice': voiceChannel,
    'cat-t': { id: 'cat-t' },
    'cat-v': { id: 'cat-v' },
  });

  await permanentChannelAction({ db }, guild, { id: 1, type: 'permanent_channel', subject: 'chan-text' });
  await permanentChannelAction({ db }, guild, { id: 2, type: 'permanent_channel', subject: 'chan-voice' });
  assert.deepEqual(moves.map((m) => [m[0], m[1]]), [['chan-text', 'cat-t'], ['chan-voice', 'cat-v']]);
  assert.ok(moves.every((m) => m[2].lockPermissions === true));
});

test('a voice channel with no voice category configured fails clearly', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { permanent_category_id: 'cat-1' }); // legacy/text only
  const guild = fakeGuild({
    'chan-voice': { id: 'chan-voice', type: 2, setParent: async () => {} },
    'cat-1': { id: 'cat-1' },
  });

  await assert.rejects(
    () => permanentChannelAction({ db }, guild, { id: 3, type: 'permanent_channel', subject: 'chan-voice' }),
    /voice/i
  );
});

test('fails clearly when the configured category no longer exists', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { permanent_category_id: 'cat-gone' });
  const guild = fakeGuild({ 'chan-target': { id: 'chan-target', setParent: async () => {} } });

  await assert.rejects(() => permanentChannelAction({ db }, guild, POLL), /category no longer exists/i);
});
