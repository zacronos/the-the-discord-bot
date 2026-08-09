import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, InteractionContextType, PermissionFlagsBits } from 'discord.js';
import {
  handleSetCreatorCommand,
  setCreatorCommandDefinition,
} from '../../src/features/setCreatorCommand.js';
import { setConfig } from '../../src/store/guildConfig.js';
import { getKnownChannel, recordKnownChannel } from '../../src/store/knownChannels.js';
import { tempDb } from '../store/helpers.js';

const MC = PermissionFlagsBits.ManageChannels;
const bits = (flags = []) => ({ has: (flag) => flags.includes(flag) });

// A creator-locked channel the way the registry leaves them; visibleTo
// controls which member ids can see it.
function fakeChannel({ id, parentId = null, overwrites, visibleTo = ['u1', 'u2', 'u-admin'] } = {}) {
  const cache = new Map(
    (
      overwrites ?? [
        { id: 'g1', type: 0, deny: bits([MC]) },
        { id: 'u1', type: 1, allow: bits([MC]) },
      ]
    ).map((o) => [o.id, { type: 0, allow: bits(), deny: bits(), ...o }])
  );
  const channel = {
    id,
    name: id,
    parentId,
    edits: [],
    permissionsFor: (who) => ({ has: () => visibleTo.includes(who?.id) }),
    permissionOverwrites: {
      cache,
      edit: async (targetId, perms, opts) => channel.edits.push({ id: targetId, perms, opts }),
    },
  };
  return channel;
}

function fakeInteraction({
  db,
  channel,
  target,
  userId = 'u1',
  manageGuild = false,
  guildMemberIds = ['u1', 'u2', 'u-admin'],
} = {}) {
  const replies = [];
  return {
    guildId: 'g1',
    user: { id: userId },
    memberPermissions: { has: (flag) => manageGuild && flag === PermissionFlagsBits.ManageGuild },
    guild: {
      id: 'g1',
      roles: { everyone: { id: 'g1' } },
      members: {
        fetch: async (memberId) => {
          if (!guildMemberIds.includes(memberId)) throw new Error('Unknown Member');
          return { id: memberId };
        },
      },
      channels: { fetch: async () => channel },
    },
    replies,
    options: {
      getSubcommand: () => null,
      getChannel: () => channel,
      getMember: () => target,
    },
    reply: async (payload) => replies.push(payload),
  };
}

const lastReply = (interaction) => interaction.replies.at(-1);

// Channel protection is opt-in per guild: /ttdb-scan-channels stamps this.
const activate = (db) => setConfig(db, 'g1', { registry_activated_at: 1 });

test('command definition: visible to everyone, guild-only, channel + member options', () => {
  assert.equal(setCreatorCommandDefinition.name, 'ttdb-set-creator');
  assert.equal(
    setCreatorCommandDefinition.default_member_permissions,
    undefined,
    'no permission gate — creators are ordinary members; authorization happens in the handler'
  );
  assert.deepEqual(setCreatorCommandDefinition.contexts, [InteractionContextType.Guild]);
  const channelOpt = setCreatorCommandDefinition.options.find((o) => o.name === 'channel');
  assert.equal(channelOpt.required, true);
  assert.deepEqual(channelOpt.channel_types, [ChannelType.GuildText, ChannelType.GuildVoice]);
  const memberOpt = setCreatorCommandDefinition.options.find((o) => o.name === 'member');
  assert.equal(memberOpt.required, true);
});

test('the recorded creator can hand the channel to a visible member', async (t) => {
  const db = tempDb(t);
  activate(db);
  recordKnownChannel(db, { channelId: 'chan-1', guildId: 'g1', creatorId: 'u1', recordedAt: 0 });
  const channel = fakeChannel({ id: 'chan-1' });
  const interaction = fakeInteraction({ db, channel, target: { id: 'u2', user: { bot: false } } });

  await handleSetCreatorCommand({ db }, interaction);

  assert.equal(getKnownChannel(db, 'chan-1').creator_id, 'u2', 'registry updated');
  assert.deepEqual(
    channel.edits.map((e) => [e.id, e.perms]),
    [
      ['u2', { ManageChannels: true }],
      ['u1', { ManageChannels: null }],
    ],
    'new creator gains the grant; the old creator loses it; the @everyone deny already stood'
  );
  assert.match(lastReply(interaction).content, /<@u2>/);
  assert.match(lastReply(interaction).content, /creator/i);
});

test('a Manage Server member can transfer any channel, including one with an unknown creator', async (t) => {
  const db = tempDb(t);
  activate(db);
  recordKnownChannel(db, { channelId: 'chan-1', guildId: 'g1', creatorId: null, recordedAt: 0 });
  const channel = fakeChannel({ id: 'chan-1', overwrites: [{ id: 'g1', type: 0, deny: bits([MC]) }] });
  const interaction = fakeInteraction({
    db,
    channel,
    target: { id: 'u2', user: { bot: false } },
    userId: 'u-admin',
    manageGuild: true,
  });

  await handleSetCreatorCommand({ db }, interaction);

  assert.equal(getKnownChannel(db, 'chan-1').creator_id, 'u2');
  assert.deepEqual(channel.edits.map((e) => [e.id, e.perms]), [['u2', { ManageChannels: true }]]);
});

test('an unrecorded channel can be claimed by a Manage Server member, and gets locked', async (t) => {
  const db = tempDb(t);
  activate(db);
  const channel = fakeChannel({ id: 'chan-new', overwrites: [] });
  const interaction = fakeInteraction({
    db,
    channel,
    target: { id: 'u2', user: { bot: false } },
    userId: 'u-admin',
    manageGuild: true,
  });

  await handleSetCreatorCommand({ db }, interaction);

  const row = getKnownChannel(db, 'chan-new');
  assert.equal(row.creator_id, 'u2');
  assert.equal(row.guild_id, 'g1');
  assert.deepEqual(
    channel.edits.map((e) => [e.id, e.perms]),
    [
      ['g1', { ManageChannels: false }],
      ['u2', { ManageChannels: true }],
    ],
    'the full lock is applied to a channel the registry had missed'
  );
});

test('a member who is neither the creator nor Manage Server is refused', async (t) => {
  const db = tempDb(t);
  activate(db);
  recordKnownChannel(db, { channelId: 'chan-1', guildId: 'g1', creatorId: 'u1', recordedAt: 0 });
  const channel = fakeChannel({ id: 'chan-1' });
  const interaction = fakeInteraction({
    db,
    channel,
    target: { id: 'u2', user: { bot: false } },
    userId: 'u2', // not the creator, no Manage Server
  });

  await handleSetCreatorCommand({ db }, interaction);

  assert.equal(getKnownChannel(db, 'chan-1').creator_id, 'u1', 'unchanged');
  assert.equal(channel.edits.length, 0);
  assert.match(lastReply(interaction).content, /creator .*Manage Server|Manage Server/i);
});

test('permanent-category and protected-group channels are refused without permission edits', async (t) => {
  const db = tempDb(t);
  activate(db);
  setConfig(db, 'g1', {
    permanent_category_text_id: 'cat-perm',
    other_permanent_category_ids: JSON.stringify(['cat-other']),
  });
  recordKnownChannel(db, { channelId: 'chan-perm', guildId: 'g1', creatorId: 'u1', recordedAt: 0 });

  const permanent = fakeChannel({ id: 'chan-perm', parentId: 'cat-perm' });
  const inPermanent = fakeInteraction({
    db,
    channel: permanent,
    target: { id: 'u2', user: { bot: false } },
    userId: 'u-admin',
    manageGuild: true,
  });
  await handleSetCreatorCommand({ db }, inPermanent);
  assert.equal(getKnownChannel(db, 'chan-perm').creator_id, 'u1', 'record untouched');
  assert.equal(permanent.edits.length, 0);
  assert.match(lastReply(inPermanent).content, /permanent categor/i);

  const grouped = fakeChannel({ id: 'chan-grouped', parentId: 'cat-other' });
  const inGroup = fakeInteraction({
    db,
    channel: grouped,
    target: { id: 'u2', user: { bot: false } },
    userId: 'u-admin',
    manageGuild: true,
  });
  await handleSetCreatorCommand({ db }, inGroup);
  assert.equal(grouped.edits.length, 0);
  assert.match(lastReply(inGroup).content, /protected permanent group/i);
});

test('the target must be a visible, non-bot member — and not already the creator', async (t) => {
  const db = tempDb(t);
  activate(db);
  recordKnownChannel(db, { channelId: 'chan-1', guildId: 'g1', creatorId: 'u1', recordedAt: 0 });

  const noMember = fakeInteraction({ db, channel: fakeChannel({ id: 'chan-1' }), target: null });
  await handleSetCreatorCommand({ db }, noMember);
  assert.match(lastReply(noMember).content, /member of this server/i);

  const bot = fakeInteraction({
    db,
    channel: fakeChannel({ id: 'chan-1' }),
    target: { id: 'u2', user: { bot: true } },
  });
  await handleSetCreatorCommand({ db }, bot);
  assert.match(lastReply(bot).content, /bot/i);

  const blind = fakeInteraction({
    db,
    channel: fakeChannel({ id: 'chan-1', visibleTo: ['u1'] }),
    target: { id: 'u2', user: { bot: false } },
  });
  await handleSetCreatorCommand({ db }, blind);
  assert.match(lastReply(blind).content, /can see/i);

  const already = fakeInteraction({
    db,
    channel: fakeChannel({ id: 'chan-1' }),
    target: { id: 'u1', user: { bot: false } },
  });
  await handleSetCreatorCommand({ db }, already);
  assert.match(lastReply(already).content, /already/i);
  assert.equal(getKnownChannel(db, 'chan-1').creator_id, 'u1');
});

test('set-creator is refused until channel protection has been activated', async (t) => {
  const db = tempDb(t); // no activate(db)
  recordKnownChannel(db, { channelId: 'chan-1', guildId: 'g1', creatorId: 'u1', recordedAt: 0 });
  const channel = fakeChannel({ id: 'chan-1' });
  const interaction = fakeInteraction({
    db,
    channel,
    target: { id: 'u2', user: { bot: false } },
    userId: 'u-admin',
    manageGuild: true,
  });

  await handleSetCreatorCommand({ db }, interaction);

  assert.equal(getKnownChannel(db, 'chan-1').creator_id, 'u1', 'record untouched');
  assert.equal(channel.edits.length, 0);
  assert.match(lastReply(interaction).content, /ttdb-scan-channels/);
});
