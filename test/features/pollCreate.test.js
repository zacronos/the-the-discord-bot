import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import {
  buildCreateModal,
  extractModalValues,
  handleCreateModal,
  handleStartButton,
} from '../../src/features/pollCreate.js';
import { setConfig } from '../../src/store/guildConfig.js';
import { createPoll, getPoll, listOpen } from '../../src/store/polls.js';
import { clearEligibilityCache } from '../../src/features/eligibility.js';
import { tempDb } from '../store/helpers.js';

const FULL_CONFIG = {
  poll_channel_id: 'chan-poll',
  hard_no_weight: 'veto',
  threshold_type: 'count',
  threshold_value: 3,
  permanent_category_id: 'cat-1',
};

function fakeGuild() {
  const sent = [];
  const pollChannel = {
    id: 'chan-poll',
    sent,
    send: async (payload) => {
      sent.push(payload);
      return { id: `msg-${sent.length}` };
    },
  };
  const targetChannel = { id: 'chan-target', name: 'target', parentId: null };
  const inCategory = { id: 'chan-owned', name: 'perm-chat', parentId: 'cat-1' };
  const voiceChannel = { id: 'chan-voice', name: 'lounge', type: 2, parentId: null };
  const voiceOwned = { id: 'chan-voice-owned', name: 'perm-voice', type: 2, parentId: 'cat-v' };
  const byId = new Map([
    ['chan-poll', pollChannel],
    ['chan-target', targetChannel],
    ['chan-owned', inCategory],
    ['chan-voice', voiceChannel],
    ['chan-voice-owned', voiceOwned],
  ]);
  return {
    id: 'g1',
    pollChannel,
    channels: {
      fetch: async (id) => {
        if (id === undefined) return byId; // full listing
        const found = byId.get(id);
        if (!found) throw new Error('Unknown Channel');
        return found;
      },
    },
    members: {
      fetch: async () => new Map([['u1', { user: { bot: false } }], ['u2', { user: { bot: false } }]]),
    },
  };
}

function fakeInteraction({ guild, hasRole = true, values = {} } = {}) {
  const interaction = {
    guildId: 'g1',
    guild,
    user: { id: 'u1' },
    member: { roles: { cache: { has: () => hasRole } } },
    shown: [],
    replies: [],
    deletedReplies: 0,
    // modal-submit values arrive as label-wrapped components
    components: Object.entries(values).map(([id, value]) => ({
      component: Array.isArray(value)
        ? { custom_id: id, values: value }
        : { custom_id: id, value },
    })),
    showModal: async (payload) => interaction.shown.push(payload),
    reply: async (payload) => interaction.replies.push(payload),
    deleteReply: async () => {
      interaction.deletedReplies += 1;
    },
  };
  return interaction;
}

test('buildCreateModal (invite) carries explanation, name input, and duration select with default', () => {
  const modal = buildCreateModal('invite', { ...FULL_CONFIG }, false);
  assert.equal(modal.custom_id, 'ttdb:create:invite');
  const textDisplay = modal.components.find((c) => c.type === 10);
  assert.match(textDisplay.content, /anonymous/i);
  assert.match(textDisplay.content, /closes after the duration you pick/);
  assert.match(textDisplay.content, /avoid shorter durations/i);
  const name = modal.components.find((c) => c.component?.custom_id === 'name');
  assert.equal(name.component.type, 4);
  assert.equal(name.component.max_length, 80);
  const duration = modal.components.find((c) => c.component?.custom_id === 'duration');
  assert.equal(duration.component.type, 3);
  assert.equal(duration.component.options.find((o) => o.default).value, '604800');
});

test('buildCreateModal (permchan) offers text and voice channels', () => {
  const modal = buildCreateModal('permchan', { ...FULL_CONFIG }, false);
  assert.equal(modal.custom_id, 'ttdb:create:permchan');
  const channel = modal.components.find((c) => c.component?.custom_id === 'channel');
  assert.equal(channel.component.type, 8);
  assert.deepEqual(channel.component.channel_types, [0, 2]);
});

test('the creation explanation stops after the closing rules — scoring lives in the init message', () => {
  const text = buildCreateModal('invite', FULL_CONFIG, false).components.find((c) => c.type === 10).content;
  assert.match(text, /everyone on the server has voted\.\n\n⚠️/, 'closing rules flow straight into the urgency warning');
  assert.doesNotMatch(text, /At close:/);
  assert.doesNotMatch(text, /point total/);
  assert.doesNotMatch(text, /Hard no/);
});

test('extractModalValues reads text values and select value arrays from nested shapes', () => {
  const values = extractModalValues({
    components: [
      { component: { custom_id: 'name', value: ' Ada ' } },
      { component: { custom_id: 'duration', values: ['604800'] } },
      { components: [{ custom_id: 'extra', value: 'nested-row' }] },
    ],
  });
  assert.deepEqual(values, { name: ' Ada ', duration: ['604800'], extra: 'nested-row' });
});

test('start button refuses while required config is missing', async (t) => {
  const db = tempDb(t);
  const interaction = fakeInteraction({ guild: fakeGuild() });
  await handleStartButton({ db }, interaction, ['invite']);
  assert.equal(interaction.shown.length, 0);
  assert.match(interaction.replies[0].content, /ttdb-config/);
  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
});

test('start button enforces the poll-starter role when configured', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { ...FULL_CONFIG, poll_starter_role_id: 'role-1' });
  const refused = fakeInteraction({ guild: fakeGuild(), hasRole: false });
  await handleStartButton({ db }, refused, ['invite']);
  assert.equal(refused.shown.length, 0);
  assert.match(refused.replies[0].content, /<@&role-1>/);

  const allowed = fakeInteraction({ guild: fakeGuild(), hasRole: true });
  await handleStartButton({ db }, allowed, ['invite']);
  assert.equal(allowed.shown.length, 1);
});

test('invite modal submit creates the poll, posts @everyone message, stores rounded close time', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG);
  const guild = fakeGuild();
  const interaction = fakeInteraction({
    guild,
    values: { name: '  Ada   Lovelace ', duration: ['259200'] },
  });
  const now = 1_000; // raw close = 259_201_000 → next hour boundary = 262_800_000
  await handleCreateModal({ db, now: () => now }, interaction, ['invite']);

  const [poll] = listOpen(db, 'g1');
  assert.equal(poll.subject, 'Ada Lovelace', 'whitespace collapsed');
  assert.equal(poll.closes_at, 262_800_000);
});

test('control and zero-width characters are stripped from names (7.5)', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG);
  const interaction = fakeInteraction({
    guild: fakeGuild(),
    values: { name: 'A​da Lovelace', duration: ['259200'] },
  });
  await handleCreateModal({ db, now: () => 0 }, interaction, ['invite']);
  const [poll] = listOpen(db, 'g1');
  assert.equal(poll.subject, 'Ada Lovelace');
});

test('invite modal closes-at rounding sanity (moved assertion)', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG);
  const guild = fakeGuild();
  const interaction = fakeInteraction({ guild, values: { name: 'Grace', duration: ['259200'] } });
  const now = 1_000;
  const scheduled = [];
  await handleCreateModal(
    { db, now: () => now, schedule: (fn, ms) => scheduled.push({ fn, ms }) },
    interaction,
    ['invite']
  );
  const poll = listOpen(db, 'g1').find((p) => p.subject === 'Grace');
  assert.equal(poll.closes_at, 262_800_000);
  assert.equal(poll.message_id, 'msg-1');
  assert.equal(guild.pollChannel.sent[0].content, '@everyone');
  assert.match(
    interaction.replies[0].content,
    /\*\*Should we invite Grace to the server\?\*\*/,
    'confirmation says what the poll is for'
  );
  assert.match(interaction.replies[0].content, /discord\.com\/channels\/g1\/chan-poll\/msg-1/);

  assert.equal(scheduled.length, 1, 'confirmation self-destruct scheduled');
  assert.equal(scheduled[0].ms, 14 * 60_000);
  await scheduled[0].fn();
  assert.equal(interaction.deletedReplies, 1);
});

test('a duplicate open poll for the same person is refused (case-insensitive)', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG);
  createPoll(db, {
    guildId: 'g1',
    type: 'invite',
    subject: 'Ada Lovelace',
    initiatorId: 'u9',
    channelId: 'chan-poll',
    closesAt: 9_000_000_000,
  });
  const interaction = fakeInteraction({
    guild: fakeGuild(),
    values: { name: 'ada lovelace', duration: ['259200'] },
  });
  await handleCreateModal({ db }, interaction, ['invite']);

  assert.equal(listOpen(db, 'g1').length, 1, 'no second poll created');
  assert.match(interaction.replies[0].content, /already an open poll/i);
});

test('permchan modal submit stores the channel id and refuses channels already in the category', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG);

  const refused = fakeInteraction({
    guild: fakeGuild(),
    values: { channel: ['chan-owned'], duration: ['604800'] },
  });
  await handleCreateModal({ db }, refused, ['permchan']);
  assert.match(refused.replies[0].content, /already/i);
  assert.equal(listOpen(db, 'g1').length, 0);

  const ok = fakeInteraction({
    guild: fakeGuild(),
    values: { channel: ['chan-target'], duration: ['604800'] },
  });
  await handleCreateModal({ db, now: () => 0 }, ok, ['permchan']);
  const [poll] = listOpen(db, 'g1');
  assert.equal(poll.type, 'permanent_channel');
  assert.equal(poll.subject, 'chan-target');
});

test('channel-deletion polls need their own threshold before the button works', async (t) => {
  const db = tempDb(t);
  // per-type thresholds only — nothing for channel-deletion, no legacy fallback
  setConfig(db, 'g1', {
    poll_channel_id: 'chan-poll',
    hard_no_weight: 'veto',
    threshold_type_invite: 'count',
    threshold_value_invite: 1,
    threshold_type_permchan: 'count',
    threshold_value_permchan: 1,
    permanent_category_id: 'cat-1',
  });
  const refused = fakeInteraction({ guild: fakeGuild() });
  await handleStartButton({ db }, refused, ['delchan']);
  assert.equal(refused.shown.length, 0);
  assert.match(refused.replies[0].content, /poll-type:channel-deletion/);

  setConfig(db, 'g1', { threshold_type_delchan: 'count', threshold_value_delchan: 2 });
  const allowed = fakeInteraction({ guild: fakeGuild() });
  await handleStartButton({ db }, allowed, ['delchan']);
  assert.equal(allowed.shown.length, 1);
  assert.equal(allowed.shown[0].custom_id, 'ttdb:create:delchan');
  const select = allowed.shown[0].components.find((c) => c.component?.custom_id === 'channel');
  assert.equal(select.component.type, 3, 'a bot-built option list, not a raw channel select');
  assert.deepEqual(
    select.component.options.map((o) => o.value),
    ['chan-owned'],
    'only the configured category is offered with this config'
  );
});

test('the deletion dropdown lists channels from both permanent categories, labeled by kind', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { ...FULL_CONFIG, permanent_category_voice_id: 'cat-v' });
  const interaction = fakeInteraction({ guild: fakeGuild() });
  await handleStartButton({ db }, interaction, ['delchan']);

  const select = interaction.shown[0].components.find((c) => c.component?.custom_id === 'channel');
  assert.deepEqual(
    select.component.options,
    [
      { label: '#perm-chat', value: 'chan-owned' },
      { label: '🔊 perm-voice', value: 'chan-voice-owned' },
    ],
    'text and voice members of the permanent categories, nothing else'
  );
});

test('the deletion button refuses when the permanent categories are empty', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { ...FULL_CONFIG, permanent_category_id: 'cat-empty' });
  const interaction = fakeInteraction({ guild: fakeGuild() });
  await handleStartButton({ db }, interaction, ['delchan']);
  assert.equal(interaction.shown.length, 0);
  assert.match(interaction.replies[0].content, /no channels in the permanent categories/i);
});

test('the deletion dropdown caps at the 25-option component limit', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG);
  const byId = new Map(
    Array.from({ length: 30 }, (_, i) => [
      `chan-${i}`,
      { id: `chan-${i}`, name: `room-${String(i).padStart(2, '0')}`, parentId: 'cat-1' },
    ])
  );
  const guild = {
    id: 'g1',
    channels: { fetch: async (id) => (id === undefined ? byId : byId.get(id)) },
    members: { fetch: async () => new Map() },
  };
  const interaction = fakeInteraction({ guild });
  await handleStartButton({ db }, interaction, ['delchan']);

  const select = interaction.shown[0].components.find((c) => c.component?.custom_id === 'channel');
  assert.equal(select.component.options.length, 25);
});

test('only channels inside the permanent categories can be nominated for deletion', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG); // legacy threshold covers delchan via fallback

  const outside = fakeInteraction({
    guild: fakeGuild(),
    values: { channel: ['chan-target'], duration: ['604800'] }, // parentId null
  });
  await handleCreateModal({ db }, outside, ['delchan']);
  assert.equal(listOpen(db, 'g1').length, 0);
  assert.match(outside.replies[0].content, /permanent categories/i);

  const inside = fakeInteraction({
    guild: fakeGuild(),
    values: { channel: ['chan-owned'], duration: ['604800'] }, // parentId cat-1
  });
  await handleCreateModal({ db, now: () => 0 }, inside, ['delchan']);
  const [poll] = listOpen(db, 'g1');
  assert.equal(poll.type, 'delete_channel');
  assert.equal(poll.subject, 'chan-owned');
});

test('voice channels are refused until a voice permanent category is configured', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG); // text/legacy category only
  const interaction = fakeInteraction({
    guild: fakeGuild(),
    values: { channel: ['chan-voice'], duration: ['604800'] },
  });
  await handleCreateModal({ db }, interaction, ['permchan']);
  assert.equal(listOpen(db, 'g1').length, 0);
  assert.match(interaction.replies[0].content, /kind:voice/);
});

test('voice channels can be nominated once the voice category exists, unless already in it', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  setConfig(db, 'g1', { ...FULL_CONFIG, permanent_category_voice_id: 'cat-v' });

  const owned = fakeInteraction({
    guild: fakeGuild(),
    values: { channel: ['chan-voice-owned'], duration: ['604800'] },
  });
  await handleCreateModal({ db }, owned, ['permchan']);
  assert.match(owned.replies[0].content, /already/i);
  assert.equal(listOpen(db, 'g1').length, 0);

  const ok = fakeInteraction({
    guild: fakeGuild(),
    values: { channel: ['chan-voice'], duration: ['604800'] },
  });
  await handleCreateModal({ db, now: () => 0 }, ok, ['permchan']);
  const [poll] = listOpen(db, 'g1');
  assert.equal(poll.type, 'permanent_channel');
  assert.equal(poll.subject, 'chan-voice');
});

test('poll creation is refused at the configured open-poll cap', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { ...FULL_CONFIG, max_open_polls: 2 });
  for (const name of ['Grace', 'Alan']) {
    createPoll(db, {
      guildId: 'g1',
      type: 'invite',
      subject: name,
      initiatorId: 'u9',
      channelId: 'chan-poll',
      closesAt: 9_000_000_000,
    });
  }
  const interaction = fakeInteraction({
    guild: fakeGuild(),
    values: { name: 'Ada', duration: ['259200'] },
  });
  await handleCreateModal({ db }, interaction, ['invite']);
  assert.equal(listOpen(db, 'g1').length, 2, 'no poll created past the cap');
  assert.match(interaction.replies[0].content, /at most 2/);
});

test('the open-poll cap defaults to 10', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG);
  for (let i = 0; i < 10; i += 1) {
    createPoll(db, {
      guildId: 'g1',
      type: 'invite',
      subject: `Person ${i}`,
      initiatorId: 'u9',
      channelId: 'chan-poll',
      closesAt: 9_000_000_000,
    });
  }
  const interaction = fakeInteraction({
    guild: fakeGuild(),
    values: { name: 'Ada', duration: ['259200'] },
  });
  await handleCreateModal({ db }, interaction, ['invite']);
  assert.equal(listOpen(db, 'g1').length, 10);
  assert.match(interaction.replies[0].content, /at most 10/);
});

test('invalid duration values are refused', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG);
  const interaction = fakeInteraction({
    guild: fakeGuild(),
    values: { name: 'Ada', duration: ['12345'] },
  });
  await handleCreateModal({ db }, interaction, ['invite']);
  assert.equal(listOpen(db, 'g1').length, 0);
  assert.match(interaction.replies[0].content, /duration/i);
});

test('TESTING ONLY durations are refused outside test mode, even if forged', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG);
  const interaction = fakeInteraction({
    guild: fakeGuild(),
    values: { name: 'Ada', duration: ['300'] }, // valid only with TTDB_TEST_MODE
  });
  await handleCreateModal({ db }, interaction, ['invite']);
  assert.equal(listOpen(db, 'g1').length, 0);
  assert.match(interaction.replies[0].content, /duration/i);
});

test('permanence duplicates are refused, but subjects do not collide across poll types', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG);
  createPoll(db, {
    guildId: 'g1',
    type: 'permanent_channel',
    subject: 'chan-target',
    initiatorId: 'u9',
    channelId: 'chan-poll',
    closesAt: 9_000_000_000,
  });
  const duplicate = fakeInteraction({
    guild: fakeGuild(),
    values: { channel: ['chan-target'], duration: ['604800'] },
  });
  await handleCreateModal({ db }, duplicate, ['permchan']);
  assert.equal(listOpen(db, 'g1').length, 1);
  assert.match(duplicate.replies[0].content, /already an open poll/i);

  clearEligibilityCache();
  const db2 = tempDb(t);
  setConfig(db2, 'g1', FULL_CONFIG);
  createPoll(db2, {
    guildId: 'g1',
    type: 'invite',
    subject: 'chan-target', // an invite about the same string
    initiatorId: 'u9',
    channelId: 'chan-poll',
    closesAt: 9_000_000_000,
  });
  const crossType = fakeInteraction({
    guild: fakeGuild(),
    values: { channel: ['chan-target'], duration: ['604800'] },
  });
  await handleCreateModal({ db: db2, now: () => 0 }, crossType, ['permchan']);
  assert.equal(listOpen(db2, 'g1').length, 2, 'same subject under a different type is allowed');
});
