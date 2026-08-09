import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import {
  buildCreateModal,
  extractModalValues,
  handleConfirmPublicButton,
  handleCreateModal,
  handleStartButton,
} from '../../src/features/pollCreate.js';
import { listCleanups } from '../../src/store/ephemeralCleanups.js';
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
    name: 'polls',
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
  const otherProtected = { id: 'chan-other', name: 'archive', parentId: 'cat-other' };
  const byId = new Map([
    ['chan-poll', pollChannel],
    ['chan-target', targetChannel],
    ['chan-owned', inCategory],
    ['chan-voice', voiceChannel],
    ['chan-voice-owned', voiceOwned],
    ['chan-other', otherProtected],
  ]);
  return {
    id: 'g1',
    pollChannel,
    roles: { everyone: { id: 'role-everyone' } },
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
    token: 'modal-token',
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
    updates: [],
    update: async (payload) => interaction.updates.push(payload),
    deleteReply: async () => {
      interaction.deletedReplies += 1;
    },
  };
  return interaction;
}

// The ack button the make-it-public warning must carry.
const ackButtonOf = (reply) => reply.components?.[0]?.components?.[0];

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

test('buildCreateModal (permchan) uses a bot-built option list', () => {
  const modal = buildCreateModal('permchan', { ...FULL_CONFIG }, false, {
    channelOptions: [{ label: '#a', value: 'a' }],
  });
  assert.equal(modal.custom_id, 'ttdb:create:permchan');
  const channel = modal.components.find((c) => c.component?.custom_id === 'channel');
  assert.equal(channel.component.type, 3);
  assert.deepEqual(channel.component.options, [{ label: '#a', value: 'a' }]);
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
  assert.equal(
    listCleanups(db).length,
    1,
    'the pending cleanup is persisted so a restart cannot lose it'
  );
  await scheduled[0].fn();
  assert.equal(interaction.deletedReplies, 1);
  assert.equal(listCleanups(db).length, 0);
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

test('channel-deletion polls need a threshold, and each kind unlocks its own channels', async (t) => {
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
  const permanentOnly = fakeInteraction({ guild: fakeGuild() });
  await handleStartButton({ db }, permanentOnly, ['delchan']);
  assert.equal(permanentOnly.shown.length, 1);
  assert.equal(permanentOnly.shown[0].custom_id, 'ttdb:create:delchan');
  const permanentSelect = permanentOnly.shown[0].components.find((c) => c.component?.custom_id === 'channel');
  assert.equal(permanentSelect.component.type, 3, 'a bot-built option list, not a raw channel select');
  assert.deepEqual(
    permanentSelect.component.options.map((o) => o.value),
    ['chan-owned'],
    'only permanent-category channels until the other-channel threshold exists'
  );

  setConfig(db, 'g1', { threshold_type_delchan_other: 'count', threshold_value_delchan_other: 3 });
  const both = fakeInteraction({ guild: fakeGuild() });
  await handleStartButton({ db }, both, ['delchan']);
  const bothSelect = both.shown[0].components.find((c) => c.component?.custom_id === 'channel');
  assert.deepEqual(
    bothSelect.component.options.map((o) => o.value),
    ['chan-other', 'chan-owned', 'chan-poll', 'chan-target', 'chan-voice', 'chan-voice-owned'],
    'both thresholds set: every visible text/voice channel is offered'
  );
});

test('only the other-channel threshold set: permanent-category channels are not offered', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', {
    poll_channel_id: 'chan-poll',
    hard_no_weight: 'veto',
    threshold_type_invite: 'count',
    threshold_value_invite: 1,
    threshold_type_permchan: 'count',
    threshold_value_permchan: 1,
    permanent_category_id: 'cat-1',
    threshold_type_delchan_other: 'count',
    threshold_value_delchan_other: 3,
  });
  const interaction = fakeInteraction({ guild: fakeGuild() });
  await handleStartButton({ db }, interaction, ['delchan']);
  const select = interaction.shown[0].components.find((c) => c.component?.custom_id === 'channel');
  assert.deepEqual(
    select.component.options.map((o) => o.value),
    ['chan-other', 'chan-poll', 'chan-target', 'chan-voice', 'chan-voice-owned'],
    'the permanent-category channel stays locked behind its own threshold'
  );
});

test('a forged submission for a deletion kind without a threshold is refused', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  setConfig(db, 'g1', {
    poll_channel_id: 'chan-poll',
    hard_no_weight: 'veto',
    threshold_type_invite: 'count',
    threshold_value_invite: 1,
    threshold_type_permchan: 'count',
    threshold_value_permchan: 1,
    permanent_category_id: 'cat-1',
    threshold_type_delchan: 'count',
    threshold_value_delchan: 2,
  });
  // chan-target is an "other" channel; only the permanent-category threshold exists.
  const interaction = fakeInteraction({
    guild: fakeGuild(),
    values: { channel: ['chan-target'], duration: ['604800'] },
  });
  await handleCreateModal({ db }, interaction, ['delchan']);
  assert.equal(listOpen(db, 'g1').length, 0);
  assert.match(interaction.replies[0].content, /outside the permanent categories/i);

  // And the mirror case: permanent-category channel with only the other threshold.
  setConfig(db, 'g1', {
    threshold_type_delchan: null,
    threshold_value_delchan: null,
    threshold_type_delchan_other: 'count',
    threshold_value_delchan_other: 3,
  });
  const mirrored = fakeInteraction({
    guild: fakeGuild(),
    values: { channel: ['chan-owned'], duration: ['604800'] },
  });
  await handleCreateModal({ db }, mirrored, ['delchan']);
  assert.equal(listOpen(db, 'g1').length, 0);
  assert.match(mirrored.replies[0].content, /permanent-category channels/i);
});

test('the deletion dropdown lists every visible text and voice channel outside protected groups', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', {
    ...FULL_CONFIG,
    permanent_category_voice_id: 'cat-v',
    other_permanent_category_ids: JSON.stringify(['cat-other']),
  });
  const interaction = fakeInteraction({ guild: fakeGuild() });
  await handleStartButton({ db }, interaction, ['delchan']);

  const select = interaction.shown[0].components.find((c) => c.component?.custom_id === 'channel');
  assert.deepEqual(
    select.component.options,
    [
      { label: '#perm-chat', value: 'chan-owned' },
      { label: '#polls', value: 'chan-poll' },
      { label: '#target', value: 'chan-target' },
      { label: '🔊 lounge', value: 'chan-voice' },
      { label: '🔊 perm-voice', value: 'chan-voice-owned' },
    ],
    'labeled by kind; the protected cat-other channel is the only exclusion'
  );
});

test('the deletion button refuses when every visible channel is protected', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { ...FULL_CONFIG, other_permanent_category_ids: JSON.stringify(['cat-all']) });
  const byId = new Map([
    ['chan-a', { id: 'chan-a', name: 'a', parentId: 'cat-all' }],
    ['chan-b', { id: 'chan-b', name: 'b', type: 2, parentId: 'cat-all' }],
  ]);
  const guild = {
    id: 'g1',
    channels: { fetch: async (id) => (id === undefined ? byId : byId.get(id)) },
    members: { fetch: async () => new Map() },
  };
  const interaction = fakeInteraction({ guild });
  await handleStartButton({ db }, interaction, ['delchan']);
  assert.equal(interaction.shown.length, 0);
  assert.match(interaction.replies[0].content, /no channels you can see/i);
});

test('other permanent groups are protected from the deletion dropdown', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { ...FULL_CONFIG, other_permanent_category_ids: JSON.stringify(['cat-other']) });
  const interaction = fakeInteraction({ guild: fakeGuild() });
  await handleStartButton({ db }, interaction, ['delchan']);

  const select = interaction.shown[0].components.find((c) => c.component?.custom_id === 'channel');
  assert.deepEqual(
    select.component.options.map((o) => o.value),
    ['chan-owned', 'chan-poll', 'chan-target', 'chan-voice', 'chan-voice-owned'],
    'everything visible is deletable — except the other permanent groups'
  );
});

test('the permanence dropdown excludes channels already in any permanent group', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', {
    ...FULL_CONFIG,
    permanent_category_voice_id: 'cat-v',
    other_permanent_category_ids: JSON.stringify(['cat-other']),
  });
  const interaction = fakeInteraction({ guild: fakeGuild() });
  await handleStartButton({ db }, interaction, ['permchan']);

  const select = interaction.shown[0].components.find((c) => c.component?.custom_id === 'channel');
  assert.equal(select.component.type, 3);
  assert.deepEqual(
    select.component.options,
    [
      { label: '#polls', value: 'chan-poll' },
      { label: '#target', value: 'chan-target' },
      { label: '🔊 lounge', value: 'chan-voice' },
    ],
    'members of cat-1, cat-v, and cat-other are all excluded'
  );
});

test('the permanence dropdown offers no voice channels until a voice category is configured', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG); // no voice category
  const interaction = fakeInteraction({ guild: fakeGuild() });
  await handleStartButton({ db }, interaction, ['permchan']);

  const select = interaction.shown[0].components.find((c) => c.component?.custom_id === 'channel');
  const values = select.component.options.map((o) => o.value);
  assert.ok(
    !values.includes('chan-voice') && !values.includes('chan-voice-owned'),
    'no dead-end voice options while voice permanence is unconfigured'
  );
  assert.ok(values.includes('chan-target'), 'text candidates still offered');
});

test('the permanence button refuses when every channel is already permanent', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG);
  const byId = new Map([
    ['chan-a', { id: 'chan-a', name: 'a', parentId: 'cat-1' }],
    ['chan-b', { id: 'chan-b', name: 'b', type: 2, parentId: 'cat-1' }],
  ]);
  const guild = {
    id: 'g1',
    channels: { fetch: async (id) => (id === undefined ? byId : byId.get(id)) },
    members: { fetch: async () => new Map() },
  };
  const interaction = fakeInteraction({ guild });
  await handleStartButton({ db }, interaction, ['permchan']);
  assert.equal(interaction.shown.length, 0);
  assert.match(interaction.replies[0].content, /already in a permanent group/i);
});

test('the deletion dropdown omits channels the initiator cannot see', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { ...FULL_CONFIG, permanent_category_voice_id: 'cat-v' });
  const guild = fakeGuild();
  const hidden = await guild.channels.fetch('chan-owned');
  hidden.permissionsFor = () => ({ has: () => false });

  const interaction = fakeInteraction({ guild });
  await handleStartButton({ db }, interaction, ['delchan']);
  const select = interaction.shown[0].components.find((c) => c.component?.custom_id === 'channel');
  assert.deepEqual(
    select.component.options.map((o) => o.value),
    ['chan-other', 'chan-poll', 'chan-target', 'chan-voice', 'chan-voice-owned'],
    'the hidden channel is not offered to this member'
  );
});

test('the permanence dropdown omits channels the initiator cannot see', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG);
  const guild = fakeGuild();
  const hidden = await guild.channels.fetch('chan-target');
  hidden.permissionsFor = () => ({ has: () => false });

  const interaction = fakeInteraction({ guild });
  await handleStartButton({ db }, interaction, ['permchan']);
  const select = interaction.shown[0].components.find((c) => c.component?.custom_id === 'channel');
  const values = select.component.options.map((o) => o.value);
  assert.ok(!values.includes('chan-target'), 'hidden channel not offered');
  assert.ok(values.includes('chan-poll'), 'visible channels still offered');
});

test('a forged submission for an invisible channel is refused (both channel poll types)', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG);

  const delGuild = fakeGuild();
  (await delGuild.channels.fetch('chan-owned')).permissionsFor = () => ({ has: () => false });
  const delSubmit = fakeInteraction({
    guild: delGuild,
    values: { channel: ['chan-owned'], duration: ['604800'] },
  });
  await handleCreateModal({ db }, delSubmit, ['delchan']);
  assert.equal(listOpen(db, 'g1').length, 0);
  assert.match(delSubmit.replies[0].content, /channels you can see/i);

  const permGuild = fakeGuild();
  (await permGuild.channels.fetch('chan-target')).permissionsFor = () => ({ has: () => false });
  const permSubmit = fakeInteraction({
    guild: permGuild,
    values: { channel: ['chan-target'], duration: ['604800'] },
  });
  await handleCreateModal({ db }, permSubmit, ['permchan']);
  assert.equal(listOpen(db, 'g1').length, 0);
  assert.match(permSubmit.replies[0].content, /channels you can see/i);
});

function makePrivate(channel) {
  channel.permissionsFor = (who) => ({ has: () => who?.id !== 'role-everyone' });
  channel.sent = [];
  channel.send = async (payload) => {
    channel.sent.push(payload);
    return { id: `priv-msg-${channel.sent.length}` };
  };
  return channel;
}

test('nominating a private channel for permanence warns it will become public, and creates no poll yet', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG);
  const guild = fakeGuild();
  makePrivate(await guild.channels.fetch('chan-target'));

  const interaction = fakeInteraction({
    guild,
    values: { channel: ['chan-target'], duration: ['604800'] },
  });
  await handleCreateModal({ db, now: () => 0 }, interaction, ['permchan']);

  assert.equal(listOpen(db, 'g1').length, 0, 'no poll until the initiator acknowledges');
  const warning = interaction.replies[0];
  assert.match(warning.content, /private channel/i);
  assert.match(warning.content, /make it \*\*public\*\*|become \*\*public\*\*/i);
  const button = ackButtonOf(warning);
  assert.equal(button.custom_id, 'ttdb:pubok:chan-target:604800', 'the ack button carries channel and duration');
});

test('the acknowledgement button creates the poll inside the private channel', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG);
  const guild = fakeGuild();
  const target = makePrivate(await guild.channels.fetch('chan-target'));

  const interaction = fakeInteraction({ guild });
  await handleConfirmPublicButton({ db, now: () => 0 }, interaction, ['chan-target', '604800']);

  const [poll] = listOpen(db, 'g1');
  assert.equal(poll.type, 'permanent_channel');
  assert.equal(poll.is_private, 1);
  assert.equal(poll.channel_id, 'chan-target', 'the poll lives in the private channel');
  assert.equal(target.sent.length, 1, 'posted into the nominated channel');
  assert.equal(guild.pollChannel.sent.length, 0, 'nothing leaks into the public poll channel');
  const confirmation = interaction.updates[0];
  assert.match(confirmation.content, /channels\/g1\/chan-target\//, 'the warning morphs into the confirmation');
  assert.deepEqual(confirmation.components, [], 'the ack button is removed');
  assert.equal(interaction.replies.length, 0, 'no second ephemeral is created');
});

test('a public channel needs no acknowledgement, and the ack button re-validates', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG);

  // Public channel: the modal submit creates the poll directly, as before.
  const direct = fakeInteraction({
    guild: fakeGuild(),
    values: { channel: ['chan-target'], duration: ['604800'] },
  });
  await handleCreateModal({ db, now: () => 0 }, direct, ['permchan']);
  assert.equal(listOpen(db, 'g1').length, 1, 'no warning detour for public channels');
  assert.equal(direct.updates.length, 0);

  // A stale ack button for a channel that meanwhile became permanent is refused.
  const staleGuild = fakeGuild();
  const owned = makePrivate(await staleGuild.channels.fetch('chan-owned')); // parentId cat-1
  const stale = fakeInteraction({ guild: staleGuild });
  await handleConfirmPublicButton({ db, now: () => 0 }, stale, ['chan-owned', '604800']);
  assert.equal(owned.sent.length, 0);
  assert.match(stale.updates[0].content, /already in a permanent group/i);
});

test('a private deletion poll also stays inside the channel', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG);
  const guild = fakeGuild();
  const owned = makePrivate(await guild.channels.fetch('chan-owned'));

  const interaction = fakeInteraction({
    guild,
    values: { channel: ['chan-owned'], duration: ['604800'] },
  });
  await handleCreateModal({ db, now: () => 0 }, interaction, ['delchan']);

  const [poll] = listOpen(db, 'g1');
  assert.equal(poll.type, 'delete_channel');
  assert.equal(poll.is_private, 1);
  assert.equal(poll.channel_id, 'chan-owned');
  assert.equal(owned.sent.length, 1);
  assert.equal(guild.pollChannel.sent.length, 0);
});

test('when the bot cannot post into the private channel, creation fails cleanly', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG);
  const guild = fakeGuild();
  const target = makePrivate(await guild.channels.fetch('chan-target'));
  target.send = async () => {
    throw new Error('Missing Access');
  };

  const interaction = fakeInteraction({ guild });
  await handleConfirmPublicButton({ db, now: () => 0 }, interaction, ['chan-target', '604800']);

  assert.equal(listOpen(db, 'g1').length, 0, 'no open poll is left behind');
  assert.match(interaction.updates[0].content, /post in|access/i);
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

test('other-permanent-group channels are refused for deletion; any other visible channel is accepted', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  // legacy threshold covers delchan via fallback
  setConfig(db, 'g1', { ...FULL_CONFIG, other_permanent_category_ids: JSON.stringify(['cat-other']) });

  const protectedSubmit = fakeInteraction({
    guild: fakeGuild(),
    values: { channel: ['chan-other'], duration: ['604800'] }, // parentId cat-other
  });
  await handleCreateModal({ db }, protectedSubmit, ['delchan']);
  assert.equal(listOpen(db, 'g1').length, 0);
  assert.match(protectedSubmit.replies[0].content, /protected permanent group/i);

  const plain = fakeInteraction({
    guild: fakeGuild(),
    values: { channel: ['chan-target'], duration: ['604800'] }, // ordinary uncategorized channel
  });
  await handleCreateModal({ db, now: () => 0 }, plain, ['delchan']);
  const [poll] = listOpen(db, 'g1');
  assert.equal(poll.type, 'delete_channel');
  assert.equal(poll.subject, 'chan-target');
  assert.equal(poll.subject_name, 'target', 'the name is captured for post-deletion DMs');
});

test('a forged deletion submission naming a category is refused', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG);
  const guild = fakeGuild();
  const orig = guild.channels.fetch;
  guild.channels.fetch = async (id) =>
    id === 'cat-1' ? { id: 'cat-1', name: 'perm-group', type: 4 } : orig(id);

  const interaction = fakeInteraction({
    guild,
    values: { channel: ['cat-1'], duration: ['604800'] },
  });
  await handleCreateModal({ db }, interaction, ['delchan']);
  assert.equal(listOpen(db, 'g1').length, 0);
  assert.match(interaction.replies[0].content, /text and voice channels/i);
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
