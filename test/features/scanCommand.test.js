import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InteractionContextType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  handleScanChannelsCommand,
  scanCommandDefinition,
} from '../../src/features/scanCommand.js';
import { getConfig } from '../../src/store/guildConfig.js';
import { getKnownChannel } from '../../src/store/knownChannels.js';
import { tempDb } from '../store/helpers.js';

const bits = (flags = []) => ({ has: (flag) => flags.includes(flag) });

function fakeChannel(id) {
  const channel = {
    id,
    name: id,
    parentId: null,
    guild: null,
    edits: [],
    permissionOverwrites: {
      cache: new Map(),
      edit: async (targetId, perms, opts) => channel.edits.push({ id: targetId, perms, opts }),
    },
  };
  return channel;
}

function fakeGuild({ channels = [], auditEntries = [] } = {}) {
  const byId = new Map(channels.map((c) => [c.id, c]));
  const guild = {
    id: 'g1',
    roles: { everyone: { id: 'g1' } },
    channels: {
      fetch: async (channelId) => {
        if (channelId === undefined) return byId;
        const found = byId.get(channelId);
        if (!found) throw new Error('Unknown Channel');
        return found;
      },
    },
    members: { fetch: async (memberId) => ({ id: memberId }) },
    fetchAuditLogs: async ({ limit = 50, before } = {}) => {
      const page = auditEntries
        .filter((e) => (before === undefined ? true : BigInt(e.id) < BigInt(before)))
        .slice(0, limit);
      return { entries: new Map(page.map((e) => [e.id, e])) };
    },
  };
  for (const channel of channels) channel.guild = guild;
  return guild;
}

function fakeInteraction(guild) {
  const interaction = {
    guildId: 'g1',
    guild,
    user: { id: 'u-admin' },
    deferrals: [],
    edits: [],
    deferReply: async (payload) => interaction.deferrals.push(payload),
    editReply: async (payload) => interaction.edits.push(payload),
  };
  return interaction;
}

test('command definition: Manage Server only, guild-only, no options', () => {
  assert.equal(scanCommandDefinition.name, 'ttdb-scan-channels');
  assert.equal(
    scanCommandDefinition.default_member_permissions,
    PermissionFlagsBits.ManageGuild.toString()
  );
  assert.deepEqual(scanCommandDefinition.contexts, [InteractionContextType.Guild]);
  assert.deepEqual(scanCommandDefinition.options ?? [], []);
});

test('first run activates the registry, scans, locks, and reports', async (t) => {
  const db = tempDb(t);
  const known = fakeChannel('chan-a');
  const ancient = fakeChannel('chan-b'); // no audit entry: unknown creator
  const guild = fakeGuild({
    channels: [known, ancient],
    auditEntries: [{ id: '30', targetId: 'chan-a', executorId: 'u1' }],
  });
  const interaction = fakeInteraction(guild);

  await handleScanChannelsCommand({ db, now: () => 7_000 }, interaction);

  assert.equal(getConfig(db, 'g1').registry_activated_at, 7_000, 'activation stamped');
  assert.equal(getKnownChannel(db, 'chan-a').creator_id, 'u1');
  assert.equal(getKnownChannel(db, 'chan-b').creator_id, null);
  assert.ok(known.edits.length > 0, 'locks applied during the scan');
  assert.equal(interaction.deferrals[0].flags, MessageFlags.Ephemeral, 'long scan: deferred privately');
  const reply = interaction.edits[0].content;
  assert.match(reply, /active/i);
  assert.match(reply, /2 channel/);
  assert.match(reply, /1 .*unknown creator/i);
  assert.match(reply, /ttdb-set-creator/);
});

test('re-running re-scans without re-stamping the activation time', async (t) => {
  const db = tempDb(t);
  const guild = fakeGuild({ channels: [fakeChannel('chan-a')] });
  await handleScanChannelsCommand({ db, now: () => 7_000 }, fakeInteraction(guild));

  const late = fakeChannel('chan-late');
  late.guild = guild;
  (await guild.channels.fetch()).set('chan-late', late);
  const rerun = fakeInteraction(guild);
  await handleScanChannelsCommand({ db, now: () => 9_000 }, rerun);

  assert.equal(getConfig(db, 'g1').registry_activated_at, 7_000, 'original activation time kept');
  assert.ok(getKnownChannel(db, 'chan-late'), 'the re-scan backfills the missed channel');
  assert.match(rerun.edits[0].content, /re-scan/i);
  assert.match(rerun.edits[0].content, /1 new channel/i);
});
