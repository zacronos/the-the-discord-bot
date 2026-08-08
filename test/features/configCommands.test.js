import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InteractionContextType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  configCommandDefinition,
  handleConfigCommand,
  missingRequiredSettings,
} from '../../src/features/configCommands.js';
import { getConfig, setConfig } from '../../src/store/guildConfig.js';
import { tempDb } from '../store/helpers.js';

// Minimal stand-in for a ChatInputCommandInteraction: just the surface the
// handler uses. Channels/roles are plain objects; every channel gets a
// permissionsFor() reporting `missingPerms`.
function fakeInteraction({ sub, opts = {}, guildId = 'g1', missingPerms = [] }) {
  const replies = [];
  const wrapChannel = (channel) =>
    channel && {
      ...channel,
      permissionsFor: () => ({ missing: () => missingPerms }),
    };
  return {
    guildId,
    guild: { id: guildId, members: { me: { id: 'bot-user' } } },
    replies,
    options: {
      getSubcommand: () => sub,
      getChannel: (name) => wrapChannel(opts[name] ?? null),
      getString: (name) => opts[name] ?? null,
      getNumber: (name) => opts[name] ?? null,
      getInteger: (name) => opts[name] ?? null,
      getRole: (name) => opts[name] ?? null,
    },
    reply: async (payload) => {
      replies.push(payload);
    },
  };
}

const lastReply = (i) => i.replies.at(-1);

test('command definition: name, admin-only default permission, guild-only, all subcommands', () => {
  assert.equal(configCommandDefinition.name, 'ttdb-config');
  assert.equal(
    configCommandDefinition.default_member_permissions,
    PermissionFlagsBits.ManageGuild.toString()
  );
  assert.deepEqual(configCommandDefinition.contexts, [InteractionContextType.Guild]);
  const subs = configCommandDefinition.options.map((o) => o.name).sort();
  assert.deepEqual(
    subs,
    [
      'hard-no-weight',
      'invite-channel',
      'max-open-polls',
      'pass-threshold',
      'permanent-category',
      'poll-channel',
      'poll-starter-role',
      'show',
    ].sort()
  );
  const passThreshold = configCommandDefinition.options.find((o) => o.name === 'pass-threshold');
  const unit = passThreshold.options.find((o) => o.name === 'unit');
  assert.deepEqual(
    unit.choices.map((c) => c.name),
    ['points — literal points total', 'percent — of current (non-bot) members'],
    'the literal-count choice speaks of points, not votes'
  );
});

test('max-open-polls stores the cap; show reports the default until then', async (t) => {
  const db = tempDb(t);
  const fresh = fakeInteraction({ sub: 'show' });
  await handleConfigCommand({ db }, fresh);
  assert.match(lastReply(fresh).content, /Max open polls: 10 \(default\)/);

  const set = fakeInteraction({ sub: 'max-open-polls', opts: { value: 3 } });
  await handleConfigCommand({ db }, set);
  assert.equal(getConfig(db, 'g1').max_open_polls, 3);
  assert.match(lastReply(set).content, /At most 3 poll/);

  const after = fakeInteraction({ sub: 'show' });
  await handleConfigCommand({ db }, after);
  assert.match(lastReply(after).content, /Max open polls: 3/);
});

test('missingRequiredSettings names each unset required subcommand', () => {
  assert.deepEqual(missingRequiredSettings(undefined), [
    'poll-channel',
    'hard-no-weight',
    'pass-threshold',
    'permanent-category',
  ]);
  assert.deepEqual(
    missingRequiredSettings({
      poll_channel_id: 'c1',
      hard_no_weight: 'veto',
      threshold_type: 'count',
      threshold_value: 0, // zero is a valid configured value
      permanent_category_id: 'cat1',
    }),
    [],
    'legacy shared columns satisfy the per-type requirements (fallback)'
  );
  assert.deepEqual(
    missingRequiredSettings({
      poll_channel_id: 'c1',
      hard_no_weight: 'veto',
      threshold_type_invite: 'count',
      threshold_value_invite: 1,
      threshold_type_permchan: 'percent',
      threshold_value_permchan: 50,
      permanent_category_text_id: 'cat-t',
    }),
    [],
    'per-type columns alone are sufficient'
  );
  assert.deepEqual(
    missingRequiredSettings({
      poll_channel_id: 'c1',
      hard_no_weight: 'veto',
      threshold_type_invite: 'count',
      threshold_value_invite: 1,
      permanent_category_voice_id: 'cat-v', // voice alone doesn't satisfy the text requirement
    }),
    ['pass-threshold', 'permanent-category'],
    'one-type thresholds and voice-only categories are incomplete'
  );
});

test('poll-channel saves the channel and confirms ephemerally', async (t) => {
  const db = tempDb(t);
  const interaction = fakeInteraction({ sub: 'poll-channel', opts: { channel: { id: 'c1' } } });
  await handleConfigCommand({ db }, interaction);

  assert.equal(getConfig(db, 'g1').poll_channel_id, 'c1');
  const reply = lastReply(interaction);
  assert.equal(reply.flags, MessageFlags.Ephemeral);
  assert.match(reply.content, /<#c1>/);
  assert.match(reply.content, /Still needed before polls can start/);
  assert.match(reply.content, /hard-no-weight/);
});

test('poll-channel warns about missing bot permissions but still saves', async (t) => {
  const db = tempDb(t);
  const interaction = fakeInteraction({
    sub: 'poll-channel',
    opts: { channel: { id: 'c1' } },
    missingPerms: ['SendMessages', 'MentionEveryone'],
  });
  await handleConfigCommand({ db }, interaction);

  assert.equal(getConfig(db, 'g1').poll_channel_id, 'c1');
  assert.match(lastReply(interaction).content, /Send Messages/);
  assert.match(lastReply(interaction).content, /Mention Everyone/);
});

test('pass-threshold with no poll-type sets both poll types', async (t) => {
  const db = tempDb(t);
  await handleConfigCommand(
    { db },
    fakeInteraction({ sub: 'pass-threshold', opts: { value: 3, unit: 'votes' } })
  );
  let cfg = getConfig(db, 'g1');
  assert.equal(cfg.threshold_type_invite, 'count');
  assert.equal(cfg.threshold_value_invite, 3);
  assert.equal(cfg.threshold_type_permchan, 'count');
  assert.equal(cfg.threshold_value_permchan, 3);

  await handleConfigCommand(
    { db },
    fakeInteraction({ sub: 'pass-threshold', opts: { value: 50, unit: 'percent' } })
  );
  cfg = getConfig(db, 'g1');
  assert.equal(cfg.threshold_type_invite, 'percent');
  assert.equal(cfg.threshold_value_invite, 50);
  assert.equal(cfg.threshold_type_permchan, 'percent');
  assert.equal(cfg.threshold_value_permchan, 50);
});

test('pass-threshold scoped to one poll type leaves the other alone', async (t) => {
  const db = tempDb(t);
  await handleConfigCommand(
    { db },
    fakeInteraction({ sub: 'pass-threshold', opts: { value: 2, unit: 'votes', 'poll-type': 'invite' } })
  );
  let cfg = getConfig(db, 'g1');
  assert.equal(cfg.threshold_value_invite, 2);
  assert.equal(cfg.threshold_type_permchan, null, 'permanence threshold untouched');
  assert.ok(missingRequiredSettings(cfg).includes('pass-threshold'), 'other type still unresolved');

  await handleConfigCommand(
    { db },
    fakeInteraction({
      sub: 'pass-threshold',
      opts: { value: 60, unit: 'percent', 'poll-type': 'channel-permanence' },
    })
  );
  cfg = getConfig(db, 'g1');
  assert.equal(cfg.threshold_type_permchan, 'percent');
  assert.equal(cfg.threshold_value_invite, 2, 'invite threshold preserved');
  assert.ok(!missingRequiredSettings(cfg).includes('pass-threshold'));
});

test('permanent-category defaults to text channels; kind voice sets the voice category', async (t) => {
  const db = tempDb(t);
  await handleConfigCommand(
    { db },
    fakeInteraction({ sub: 'permanent-category', opts: { category: { id: 'cat-t' } } })
  );
  let cfg = getConfig(db, 'g1');
  assert.equal(cfg.permanent_category_text_id, 'cat-t');
  assert.equal(cfg.permanent_category_voice_id, null);

  await handleConfigCommand(
    { db },
    fakeInteraction({ sub: 'permanent-category', opts: { category: { id: 'cat-v' }, kind: 'voice' } })
  );
  cfg = getConfig(db, 'g1');
  assert.equal(cfg.permanent_category_voice_id, 'cat-v');
  assert.equal(cfg.permanent_category_text_id, 'cat-t', 'text category preserved');
});

test('pass-threshold rejects a percent above 100 and saves nothing', async (t) => {
  const db = tempDb(t);
  const interaction = fakeInteraction({
    sub: 'pass-threshold',
    opts: { value: 150, unit: 'percent' },
  });
  await handleConfigCommand({ db }, interaction);

  assert.equal(getConfig(db, 'g1'), undefined);
  assert.match(lastReply(interaction).content, /can never pass/);
});

test('optional settings save and explain themselves', async (t) => {
  const db = tempDb(t);
  const invite = fakeInteraction({ sub: 'invite-channel', opts: { channel: { id: 'c9' } } });
  await handleConfigCommand({ db }, invite);
  const role = fakeInteraction({ sub: 'poll-starter-role', opts: { role: { id: 'r1' } } });
  await handleConfigCommand({ db }, role);

  const cfg = getConfig(db, 'g1');
  assert.equal(cfg.invite_channel_id, 'c9');
  assert.equal(cfg.poll_starter_role_id, 'r1');
  assert.match(lastReply(role).content, /<@&r1>/);
});

test('ensureInitMessage fires only once required config becomes complete, and again on later changes', async (t) => {
  const db = tempDb(t);
  const calls = [];
  const ctx = { db, ensureInitMessage: async (guild) => calls.push(guild.id) };

  await handleConfigCommand(ctx, fakeInteraction({ sub: 'poll-channel', opts: { channel: { id: 'c1' } } }));
  await handleConfigCommand(ctx, fakeInteraction({ sub: 'hard-no-weight', opts: { weight: 'veto' } }));
  await handleConfigCommand(ctx, fakeInteraction({ sub: 'pass-threshold', opts: { value: 3, unit: 'votes' } }));
  assert.equal(calls.length, 0, 'not called while required config is incomplete');

  await handleConfigCommand(ctx, fakeInteraction({ sub: 'permanent-category', opts: { category: { id: 'cat1' } } }));
  assert.deepEqual(calls, ['g1'], 'called when the last required setting lands');

  await handleConfigCommand(ctx, fakeInteraction({ sub: 'poll-channel', opts: { channel: { id: 'c2' } } }));
  assert.deepEqual(calls, ['g1', 'g1'], 'called again on changes while complete');
});

test('an ensureInitMessage failure still saves the setting and reports the problem', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', {
    poll_channel_id: 'c1',
    hard_no_weight: 'veto',
    threshold_type: 'count',
    threshold_value: 3,
  });
  const ctx = {
    db,
    ensureInitMessage: async () => {
      throw new Error('boom');
    },
  };
  const interaction = fakeInteraction({ sub: 'permanent-category', opts: { category: { id: 'cat1' } } });
  await handleConfigCommand(ctx, interaction);

  assert.equal(getConfig(db, 'g1').permanent_category_text_id, 'cat1');
  assert.match(lastReply(interaction).content, /boom/);
});

test('successful changes trigger the profile sync hook; show does not', async (t) => {
  const db = tempDb(t);
  const calls = [];
  const ctx = { db, ensureProfile: async () => calls.push(1) };

  await handleConfigCommand(ctx, fakeInteraction({ sub: 'poll-channel', opts: { channel: { id: 'c1' } } }));
  assert.equal(calls.length, 1);

  await handleConfigCommand(ctx, fakeInteraction({ sub: 'show' }));
  assert.equal(calls.length, 1, 'show is read-only');
});

test('show on a fresh guild lists unset fields and what is still needed', async (t) => {
  const db = tempDb(t);
  const interaction = fakeInteraction({ sub: 'show' });
  await handleConfigCommand({ db }, interaction);

  const reply = lastReply(interaction);
  assert.equal(reply.flags, MessageFlags.Ephemeral);
  assert.match(reply.content, /not set/);
  assert.match(reply.content, /can't start yet/);
});

test('show renders configured values as mentions and human-readable rules', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', {
    poll_channel_id: 'c1',
    hard_no_weight: 'veto',
    threshold_type: 'percent',
    threshold_value: 50,
    permanent_category_id: 'cat1',
    invite_channel_id: 'c9',
    poll_starter_role_id: 'r1',
  });
  const interaction = fakeInteraction({ sub: 'show' });
  await handleConfigCommand({ db }, interaction);

  const content = lastReply(interaction).content;
  assert.match(content, /<#c1>/);
  assert.match(content, /<#cat1>/);
  assert.match(content, /<#c9>/);
  assert.match(content, /<@&r1>/);
  assert.match(content, /50% of current members/);
  assert.match(content, /veto/);
  assert.doesNotMatch(content, /can't start yet/);
});
