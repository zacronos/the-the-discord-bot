import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import {
  handleChannelCreate,
  handleChannelDelete,
  runDailyPermissionSweep,
  scanGuildChannels,
  sweepChannelPermissions,
} from '../../src/features/channelRegistry.js';
import { setConfig } from '../../src/store/guildConfig.js';
import { getKnownChannel, listKnownChannels, recordKnownChannel } from '../../src/store/knownChannels.js';
import { getAppState } from '../../src/store/appState.js';
import { tempDb } from '../store/helpers.js';

const MC = PermissionFlagsBits.ManageChannels;

const bits = (flags = []) => ({ has: (flag) => flags.includes(flag) });

// type omitted = text (0); overwrites: [{ id, type, allow, deny }]
function fakeChannel({ id, name = id, type, parentId = null, overwrites = [] } = {}) {
  const cache = new Map(
    overwrites.map((o) => [o.id, { type: 0, allow: bits(), deny: bits(), ...o }])
  );
  const channel = {
    id,
    name,
    parentId,
    guild: null, // wired by fakeGuild
    edits: [],
    permissionOverwrites: {
      cache,
      edit: async (targetId, perms, opts) => channel.edits.push({ id: targetId, perms, opts }),
    },
  };
  if (type !== undefined) channel.type = type;
  return channel;
}

// auditEntries: [{ id, targetId, executorId }], newest (largest id) first.
function fakeGuild({ id = 'g1', channels = [], auditEntries = [], memberIds = ['u1', 'u2'] } = {}) {
  const byId = new Map(channels.map((c) => [c.id, c]));
  const guild = {
    id,
    auditCalls: [],
    roles: { everyone: { id } }, // like Discord: the @everyone role id is the guild id
    channels: {
      fetch: async (channelId) => {
        if (channelId === undefined) return byId;
        const found = byId.get(channelId);
        if (!found) throw new Error('Unknown Channel');
        return found;
      },
    },
    members: {
      fetch: async (memberId) => {
        if (!memberIds.includes(memberId)) throw new Error('Unknown Member');
        return { id: memberId };
      },
    },
    fetchAuditLogs: async ({ type, limit = 50, before } = {}) => {
      guild.auditCalls.push({ type, limit, before });
      const page = auditEntries
        .filter((e) => (before === undefined ? true : BigInt(e.id) < BigInt(before)))
        .slice(0, limit);
      return { entries: new Map(page.map((e) => [e.id, e])) };
    },
  };
  for (const channel of channels) channel.guild = guild;
  return guild;
}

const ctxFor = (db) => ({ db, sleep: async () => {} });

test('a created channel is recorded with its audit-log creator and locked to creator-only deletion', async (t) => {
  const db = tempDb(t);
  const channel = fakeChannel({ id: 'chan-new' });
  const guild = fakeGuild({
    channels: [channel],
    auditEntries: [{ id: '30', targetId: 'chan-new', executorId: 'u1' }],
  });

  await handleChannelCreate(ctxFor(db), channel);

  const row = getKnownChannel(db, 'chan-new');
  assert.equal(row.creator_id, 'u1');
  assert.equal(row.guild_id, 'g1');
  assert.equal(guild.auditCalls[0].type, AuditLogEvent.ChannelCreate);
  assert.deepEqual(
    channel.edits.map((e) => [e.id, e.perms]),
    [
      ['g1', { ManageChannels: false }],
      ['u1', { ManageChannels: true }],
    ],
    'deny @everyone, allow the creator'
  );
  assert.equal(channel.edits[1].opts.type, 1, 'the creator overwrite is a member overwrite');
});

test('the creator lookup retries while the audit-log entry lags the gateway event', async (t) => {
  const db = tempDb(t);
  const channel = fakeChannel({ id: 'chan-new' });
  const guild = fakeGuild({ channels: [channel] });
  const lateEntries = [{ id: '30', targetId: 'chan-new', executorId: 'u1' }];
  let calls = 0;
  const inner = guild.fetchAuditLogs;
  guild.fetchAuditLogs = async (opts) => {
    calls += 1;
    if (calls === 1) return { entries: new Map() };
    guild.auditEntries = lateEntries;
    const page = new Map(lateEntries.map((e) => [e.id, e]));
    inner(opts); // keep call log
    return { entries: page };
  };

  await handleChannelCreate(ctxFor(db), channel);
  assert.equal(getKnownChannel(db, 'chan-new').creator_id, 'u1', 'second attempt finds the entry');
});

test('a channel whose creator is unknowable is still recorded and locked (admins only)', async (t) => {
  const db = tempDb(t);
  const channel = fakeChannel({ id: 'chan-mystery' });
  fakeGuild({ channels: [channel] }); // no audit entries at all

  await handleChannelCreate(ctxFor(db), channel);

  assert.equal(getKnownChannel(db, 'chan-mystery').creator_id, null);
  assert.deepEqual(
    channel.edits.map((e) => [e.id, e.perms]),
    [['g1', { ManageChannels: false }]],
    'only the @everyone deny — no creator to allow'
  );
});

test('channels in other permanent groups and non-text/voice channels are not tracked', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { other_permanent_category_ids: JSON.stringify(['cat-other']) });
  const grouped = fakeChannel({ id: 'chan-grouped', parentId: 'cat-other' });
  const category = fakeChannel({ id: 'cat-x', type: 4 });
  fakeGuild({ channels: [grouped, category] });

  await handleChannelCreate(ctxFor(db), grouped);
  await handleChannelCreate(ctxFor(db), category);

  assert.equal(getKnownChannel(db, 'chan-grouped'), undefined);
  assert.equal(getKnownChannel(db, 'cat-x'), undefined);
  assert.equal(grouped.edits.length, 0, 'no permission changes on protected channels');
});

test('a channel created inside a configured permanent category is recorded but not locked', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { permanent_category_text_id: 'cat-perm' });
  const channel = fakeChannel({ id: 'chan-perm', parentId: 'cat-perm' });
  fakeGuild({
    channels: [channel],
    auditEntries: [{ id: '30', targetId: 'chan-perm', executorId: 'u1' }],
  });

  await handleChannelCreate(ctxFor(db), channel);

  assert.equal(getKnownChannel(db, 'chan-perm').creator_id, 'u1', 'creator still recorded');
  assert.equal(channel.edits.length, 0, 'community-owned channels keep their permissions');
});

test('a departed creator gets no overwrite; the @everyone deny still applies', async (t) => {
  const db = tempDb(t);
  const channel = fakeChannel({ id: 'chan-orphaned' });
  fakeGuild({
    channels: [channel],
    memberIds: ['someone-else'],
    auditEntries: [{ id: '30', targetId: 'chan-orphaned', executorId: 'u-gone' }],
  });

  await handleChannelCreate(ctxFor(db), channel);

  assert.equal(getKnownChannel(db, 'chan-orphaned').creator_id, 'u-gone', 'creator remembered for a possible return');
  assert.deepEqual(channel.edits.map((e) => e.id), ['g1'], 'no member overwrite for a departed creator');
});

test('handleChannelDelete forgets the channel', async (t) => {
  const db = tempDb(t);
  recordKnownChannel(db, { channelId: 'chan-1', guildId: 'g1', creatorId: 'u1', recordedAt: 0 });
  await handleChannelDelete({ db }, { id: 'chan-1', guild: { id: 'g1' } });
  assert.equal(getKnownChannel(db, 'chan-1'), undefined);
});

test('the startup scan backfills unrecorded channels from a paginated audit-log backscan', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', {
    permanent_category_id: 'cat-perm',
    other_permanent_category_ids: JSON.stringify(['cat-other']),
  });
  recordKnownChannel(db, { channelId: 'chan-known', guildId: 'g1', creatorId: 'u2', recordedAt: 5 });

  const fresh = fakeChannel({ id: 'chan-fresh' });
  const ancient = fakeChannel({ id: 'chan-ancient' }); // no audit entry: creator unknowable
  const known = fakeChannel({ id: 'chan-known' });
  const grouped = fakeChannel({ id: 'chan-grouped', parentId: 'cat-other' });
  const category = fakeChannel({ id: 'cat-perm', type: 4 });
  const inPerm = fakeChannel({ id: 'chan-perm', parentId: 'cat-perm' });
  // 100-entry first page forces a second, older page that holds chan-fresh's entry.
  const filler = Array.from({ length: 100 }, (_, i) => ({
    id: String(9_000 - i),
    targetId: `deleted-${i}`,
    executorId: 'u2',
  }));
  const guild = fakeGuild({
    channels: [fresh, ancient, known, grouped, category, inPerm],
    auditEntries: [
      ...filler,
      { id: '150', targetId: 'chan-fresh', executorId: 'u1' },
      { id: '140', targetId: 'chan-perm', executorId: 'u2' },
    ],
  });

  const result = await scanGuildChannels(ctxFor(db), guild, 77);

  assert.equal(result.recorded, 3, 'fresh, ancient, and the permanent-category channel');
  assert.equal(getKnownChannel(db, 'chan-fresh').creator_id, 'u1', 'found on the second audit page');
  assert.equal(getKnownChannel(db, 'chan-fresh').recorded_at, 77);
  assert.equal(getKnownChannel(db, 'chan-ancient').creator_id, null);
  assert.equal(getKnownChannel(db, 'chan-grouped'), undefined, 'other-group channels stay unrecorded');
  assert.equal(getKnownChannel(db, 'cat-perm'), undefined, 'categories are not channels');
  assert.equal(getKnownChannel(db, 'chan-known').recorded_at, 5, 'already-recorded rows untouched');
  assert.ok(guild.auditCalls.length >= 2, 'the backscan paginated');
  assert.ok(guild.auditCalls.every((c) => c.type === AuditLogEvent.ChannelCreate));

  assert.deepEqual(
    fresh.edits.map((e) => [e.id, e.perms]),
    [
      ['g1', { ManageChannels: false }],
      ['u1', { ManageChannels: true }],
    ],
    'backfilled channels are locked too'
  );
  assert.equal(inPerm.edits.length, 0, 'permanent-category channels stay unlocked');
  assert.equal(known.edits.length, 0, 'already-recorded channels are left to the daily sweep');
});

test('the permission sweep corrects drift: missing deny, missing creator allow, foreign allows', async (t) => {
  const db = tempDb(t);
  recordKnownChannel(db, { channelId: 'chan-drift', guildId: 'g1', creatorId: 'u1', recordedAt: 0 });
  const channel = fakeChannel({
    id: 'chan-drift',
    overwrites: [
      { id: 'role-mods', type: 0, allow: bits([MC]) },
      { id: 'u9', type: 1, allow: bits([MC]) },
    ],
  });
  const guild = fakeGuild({ channels: [channel] });

  const corrections = await sweepChannelPermissions(ctxFor(db), guild);

  assert.equal(corrections.length, 1);
  assert.deepEqual(
    channel.edits.map((e) => [e.id, e.perms]),
    [
      ['g1', { ManageChannels: false }],
      ['u1', { ManageChannels: true }],
      ['role-mods', { ManageChannels: null }],
      ['u9', { ManageChannels: null }],
    ],
    'deny restored, creator allow restored, every foreign Manage Channels allow cleared'
  );
  assert.equal(channel.edits[2].opts.type, 0, 'role overwrites keep their type when cleared');
});

test('the permission sweep is a no-op when permissions already align', async (t) => {
  const db = tempDb(t);
  recordKnownChannel(db, { channelId: 'chan-good', guildId: 'g1', creatorId: 'u1', recordedAt: 0 });
  const channel = fakeChannel({
    id: 'chan-good',
    overwrites: [
      { id: 'g1', type: 0, deny: bits([MC]) },
      { id: 'u1', type: 1, allow: bits([MC]) },
    ],
  });
  const guild = fakeGuild({ channels: [channel] });

  const corrections = await sweepChannelPermissions(ctxFor(db), guild);
  assert.deepEqual(corrections, []);
  assert.equal(channel.edits.length, 0, 'nothing to correct, nothing touched');
});

test('the permission sweep forgets vanished channels and skips channels now in permanent groups', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', {
    permanent_category_text_id: 'cat-perm',
    other_permanent_category_ids: JSON.stringify(['cat-other']),
  });
  recordKnownChannel(db, { channelId: 'chan-gone', guildId: 'g1', creatorId: 'u1', recordedAt: 0 });
  recordKnownChannel(db, { channelId: 'chan-promoted', guildId: 'g1', creatorId: 'u1', recordedAt: 0 });
  recordKnownChannel(db, { channelId: 'chan-shelved', guildId: 'g1', creatorId: 'u1', recordedAt: 0 });
  const promoted = fakeChannel({ id: 'chan-promoted', parentId: 'cat-perm' });
  const shelved = fakeChannel({ id: 'chan-shelved', parentId: 'cat-other' });
  const guild = fakeGuild({ channels: [promoted, shelved] });

  await sweepChannelPermissions(ctxFor(db), guild);

  assert.equal(getKnownChannel(db, 'chan-gone'), undefined, 'vanished channel forgotten');
  assert.equal(promoted.edits.length, 0, 'now-permanent channel left alone');
  assert.equal(shelved.edits.length, 0, 'channel moved into an other-group left alone');
  assert.equal(
    listKnownChannels(db, 'g1').length,
    2,
    'still-existing channels stay recorded'
  );
});

test('runDailyPermissionSweep runs at most once per day and stamps app_state', async (t) => {
  const db = tempDb(t);
  recordKnownChannel(db, { channelId: 'chan-1', guildId: 'g1', creatorId: 'u1', recordedAt: 0 });
  const channel = fakeChannel({ id: 'chan-1' });
  const guild = fakeGuild({ channels: [channel] });
  const client = { guilds: { cache: new Map([['g1', guild]]) } };
  const ctx = { db, client, sleep: async () => {} };

  const DAY = 24 * 3_600_000;
  assert.equal(await runDailyPermissionSweep(ctx, DAY), true, 'first run sweeps');
  assert.equal(getAppState(db, 'perm_sweep_at'), String(DAY));
  const editsAfterFirst = channel.edits.length;
  assert.ok(editsAfterFirst > 0, 'the sweep actually enforced');

  assert.equal(await runDailyPermissionSweep(ctx, DAY + 3_600_000), false, 'an hour later: skipped');
  assert.equal(channel.edits.length, editsAfterFirst);

  assert.equal(await runDailyPermissionSweep(ctx, DAY + DAY), true, 'a day later: sweeps again');
});
