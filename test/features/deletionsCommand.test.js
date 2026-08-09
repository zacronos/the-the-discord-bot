import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  deletionsCommandDefinition,
  handleDeletionsCommand,
} from '../../src/features/deletionsCommand.js';
import { getScheduledDeletion, scheduleDeletion } from '../../src/store/scheduledDeletions.js';
import { tempDb } from '../store/helpers.js';

function fakeChannel(id) {
  const channel = { id, sent: [], send: async (payload) => channel.sent.push(payload) };
  return channel;
}

function fakeInteraction({ sub, opts = {}, guildId = 'g1', channels = {} } = {}) {
  const replies = [];
  return {
    guildId,
    user: { id: 'u-admin' },
    guild: {
      id: guildId,
      channels: {
        fetch: async (id) => {
          const channel = channels[id];
          if (!channel) throw new Error('Unknown Channel');
          return channel;
        },
      },
    },
    replies,
    options: {
      getSubcommand: () => sub,
      getChannel: (name) => opts[name] ?? null,
    },
    reply: async (payload) => replies.push(payload),
  };
}

const lastReply = (interaction) => interaction.replies.at(-1);

test('command definition: Manage Server only, guild-only, list and cancel subcommands', () => {
  assert.equal(deletionsCommandDefinition.name, 'ttdb-deletions');
  assert.equal(
    deletionsCommandDefinition.default_member_permissions,
    PermissionFlagsBits.ManageGuild.toString()
  );
  assert.deepEqual(deletionsCommandDefinition.contexts, [InteractionContextType.Guild]);
  assert.deepEqual(
    deletionsCommandDefinition.options.map((o) => o.name).sort(),
    ['cancel', 'list']
  );
  const cancel = deletionsCommandDefinition.options.find((o) => o.name === 'cancel');
  const channelOpt = cancel.options.find((o) => o.name === 'channel');
  assert.equal(channelOpt.required, true);
  assert.deepEqual(
    channelOpt.channel_types,
    [ChannelType.GuildText, ChannelType.GuildVoice],
    'only deletable channel kinds are selectable'
  );
});

test('list: reports none pending, or each pending deletion with its time and poll', async (t) => {
  const db = tempDb(t);
  const empty = fakeInteraction({ sub: 'list' });
  await handleDeletionsCommand({ db }, empty);
  assert.equal(lastReply(empty).flags, MessageFlags.Ephemeral);
  assert.match(lastReply(empty).content, /no scheduled deletions/i);

  scheduleDeletion(db, { channelId: 'chan-a', guildId: 'g1', deleteAt: 7_200_000, pollId: 4 });
  scheduleDeletion(db, { channelId: 'chan-b', guildId: 'g1', deleteAt: 3_600_000 });
  scheduleDeletion(db, { channelId: 'chan-z', guildId: 'g2', deleteAt: 3_600_000 });
  const listed = fakeInteraction({ sub: 'list' });
  await handleDeletionsCommand({ db }, listed);
  const content = lastReply(listed).content;
  assert.match(content, /<#chan-b> — deletes <t:3600:F> \(<t:3600:R>\)/);
  assert.match(content, /<#chan-a> — deletes <t:7200:F> \(<t:7200:R>\) — from poll #4/);
  assert.doesNotMatch(content, /chan-z/, "other guilds' rows never leak");
  assert.ok(content.indexOf('chan-b') < content.indexOf('chan-a'), 'soonest first');
});

test('cancel: removes the schedule, announces in the channel, and names the canceler', async (t) => {
  const db = tempDb(t);
  scheduleDeletion(db, { channelId: 'chan-doomed', guildId: 'g1', deleteAt: 3_600_000, pollId: 9 });
  const doomed = fakeChannel('chan-doomed');
  const interaction = fakeInteraction({
    sub: 'cancel',
    opts: { channel: { id: 'chan-doomed' } },
    channels: { 'chan-doomed': doomed },
  });
  await handleDeletionsCommand({ db }, interaction);

  assert.equal(getScheduledDeletion(db, 'chan-doomed'), undefined, 'schedule removed');
  assert.equal(doomed.sent.length, 1);
  assert.match(doomed.sent[0].content, /deletion .* \*\*canceled\*\*/i);
  assert.match(doomed.sent[0].content, /<@u-admin>/, 'the canceler is named');
  assert.deepEqual(doomed.sent[0].allowedMentions, { parse: [] }, 'named, not pinged');
  assert.equal(lastReply(interaction).flags, MessageFlags.Ephemeral);
  assert.match(lastReply(interaction).content, /will not be deleted/i);
});

test('cancel: refuses channels with nothing scheduled', async (t) => {
  const db = tempDb(t);
  const channel = fakeChannel('chan-fine');
  const interaction = fakeInteraction({
    sub: 'cancel',
    opts: { channel: { id: 'chan-fine' } },
    channels: { 'chan-fine': channel },
  });
  await handleDeletionsCommand({ db }, interaction);
  assert.match(lastReply(interaction).content, /no scheduled deletion for/i);
  assert.equal(channel.sent.length, 0, 'nothing announced');
});

test("cancel: another guild's schedule cannot be canceled through this guild", async (t) => {
  const db = tempDb(t);
  scheduleDeletion(db, { channelId: 'chan-foreign', guildId: 'g2', deleteAt: 3_600_000 });
  const interaction = fakeInteraction({
    sub: 'cancel',
    opts: { channel: { id: 'chan-foreign' } },
  });
  await handleDeletionsCommand({ db }, interaction);
  assert.match(lastReply(interaction).content, /no scheduled deletion for/i);
  assert.ok(getScheduledDeletion(db, 'chan-foreign'), 'row untouched');
});

test('cancel: still cancels when the announcement cannot be posted', async (t) => {
  const db = tempDb(t);
  scheduleDeletion(db, { channelId: 'chan-doomed', guildId: 'g1', deleteAt: 3_600_000 });
  const interaction = fakeInteraction({
    sub: 'cancel',
    opts: { channel: { id: 'chan-doomed' } },
    channels: {}, // channel unfetchable — announcement will fail
  });
  await handleDeletionsCommand({ db }, interaction);
  assert.equal(getScheduledDeletion(db, 'chan-doomed'), undefined, 'canceled regardless');
  assert.match(lastReply(interaction).content, /couldn't post/i);
});
