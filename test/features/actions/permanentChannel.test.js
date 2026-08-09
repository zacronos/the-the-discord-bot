import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { permanentChannelAction } from '../../../src/features/actions/permanentChannel.js';
import { sweepChannelPermissions } from '../../../src/features/channelRegistry.js';
import { setConfig } from '../../../src/store/guildConfig.js';
import { recordKnownChannel } from '../../../src/store/knownChannels.js';
import { getScheduledDeletion, scheduleDeletion } from '../../../src/store/scheduledDeletions.js';
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

test('promotion strips the creator-only deletion lock and the registry never re-adds it', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { permanent_category_id: 'cat-1' });
  recordKnownChannel(db, { channelId: 'chan-target', guildId: 'g1', creatorId: 'u1', recordedAt: 0 });

  const MC = PermissionFlagsBits.ManageChannels;
  const bits = (flags = []) => ({ has: (flag) => flags.includes(flag) });
  const categoryOverwrites = [['g1', { id: 'g1', type: 0, allow: bits(), deny: bits() }]];
  const target = {
    id: 'chan-target',
    name: 'quarterly',
    parentId: null,
    edits: [],
    // Locked the way the channel registry leaves non-permanent channels:
    // @everyone denied Manage Channels, the creator allowed it.
    permissionOverwrites: {
      cache: new Map([
        ['g1', { id: 'g1', type: 0, allow: bits(), deny: bits([MC]) }],
        ['u1', { id: 'u1', type: 1, allow: bits([MC]), deny: bits() }],
      ]),
      edit: async (id, perms, opts) => target.edits.push({ id, perms, opts }),
    },
    setParent: async (categoryId, options) => {
      target.parentId = categoryId;
      if (options?.lockPermissions) {
        // Discord's sync: the channel's overwrites become the category's.
        target.permissionOverwrites.cache = new Map(categoryOverwrites);
      }
    },
  };
  const guild = {
    ...fakeGuild({ 'chan-target': target, 'cat-1': { id: 'cat-1', name: 'permanent' } }),
    roles: { everyone: { id: 'g1' } },
    members: { fetch: async (id) => ({ id }) },
  };

  await permanentChannelAction({ db }, guild, POLL);

  assert.equal(target.parentId, 'cat-1');
  const overwrites = target.permissionOverwrites.cache;
  assert.equal(overwrites.get('u1'), undefined, 'the creator grant does not survive the sync');
  assert.equal(overwrites.get('g1').deny.has(MC), false, 'the @everyone deny is the category\'s, not the lock\'s');

  // The daily sweep must leave the promoted channel untouched — a
  // permanent-category channel never gets its creator grant back.
  const corrections = await sweepChannelPermissions({ db }, guild);
  assert.deepEqual(corrections, []);
  assert.equal(target.edits.length, 0, 'no overwrite edits after promotion');
});

test('promotion cancels a pending scheduled deletion for the channel', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { permanent_category_id: 'cat-1' });
  scheduleDeletion(db, { channelId: 'chan-target', guildId: 'g1', deleteAt: 99_000, pollId: 5 });
  const target = { id: 'chan-target', name: 'quarterly', setParent: async () => {} };
  const guild = fakeGuild({ 'chan-target': target, 'cat-1': { id: 'cat-1', name: 'permanent' } });

  const note = await permanentChannelAction({ db }, guild, POLL);

  assert.equal(getScheduledDeletion(db, 'chan-target'), undefined, 'the pending deletion is canceled');
  assert.match(note, /scheduled deletion was canceled/i);
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

test('a private channel is made public before the move and sync', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { permanent_category_id: 'cat-1' });
  const events = [];
  const target = {
    id: 'chan-target',
    name: 'secret-plans',
    permissionsFor: (who) => ({ has: () => who?.id !== 'g1' }), // @everyone cannot view
    permissionOverwrites: {
      cache: new Map(),
      edit: async (id, perms) => events.push(['edit', id, perms]),
    },
    setParent: async (categoryId, options) => events.push(['move', categoryId, options.lockPermissions]),
  };
  const guild = {
    ...fakeGuild({ 'chan-target': target, 'cat-1': { id: 'cat-1', name: 'permanent' } }),
    roles: { everyone: { id: 'g1' } },
  };

  const note = await permanentChannelAction({ db }, guild, POLL);

  assert.equal(events.length, 2);
  assert.deepEqual(
    events[0],
    ['edit', 'g1', { ViewChannel: null }],
    'first: only the @everyone view deny is lifted'
  );
  assert.deepEqual(events[1], ['move', 'cat-1', true], 'then the move, synced with the category');
  assert.match(note, /now public/i);
});

test('a public channel is moved without any permission edit', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { permanent_category_id: 'cat-1' });
  const events = [];
  const target = {
    id: 'chan-target',
    name: 'open-plans',
    permissionsFor: () => ({ has: () => true }), // @everyone can view
    permissionOverwrites: {
      cache: new Map(),
      edit: async (id, perms) => events.push(['edit', id, perms]),
    },
    setParent: async (categoryId, options) => events.push(['move', categoryId, options.lockPermissions]),
  };
  const guild = {
    ...fakeGuild({ 'chan-target': target, 'cat-1': { id: 'cat-1', name: 'permanent' } }),
    roles: { everyone: { id: 'g1' } },
  };

  const note = await permanentChannelAction({ db }, guild, POLL);
  assert.deepEqual(events, [['move', 'cat-1', true]], 'no permission edit for an already-public channel');
  assert.doesNotMatch(note, /now public/i);
});
