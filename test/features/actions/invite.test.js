import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inviteAction } from '../../../src/features/actions/invite.js';
import { setConfig } from '../../../src/store/guildConfig.js';
import { tempDb } from '../../store/helpers.js';

const POLL = { id: 4, type: 'invite', subject: 'Ada Lovelace' };

function fakeGuild({ channels = {}, systemChannelId = null } = {}) {
  return {
    id: 'g1',
    systemChannelId,
    channels: {
      fetch: async (id) => {
        const channel = channels[id];
        if (!channel) throw new Error('Unknown Channel');
        return channel;
      },
    },
  };
}

function invitableChannel(id) {
  const calls = [];
  return {
    id,
    calls,
    createInvite: async (options) => {
      calls.push(options);
      return { url: `https://discord.gg/${id}` };
    },
  };
}

test('creates a single-use 7-day invite in the configured invite channel', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { invite_channel_id: 'chan-welcome', poll_channel_id: 'chan-poll' });
  const welcome = invitableChannel('chan-welcome');
  const guild = fakeGuild({ channels: { 'chan-welcome': welcome } });

  const note = await inviteAction({ db }, guild, POLL);

  assert.equal(welcome.calls.length, 1);
  assert.equal(welcome.calls[0].maxUses, 1);
  assert.equal(welcome.calls[0].maxAge, 604_800);
  assert.equal(welcome.calls[0].unique, true);
  assert.match(note, /single-use/);
  assert.match(note, /7 days/);
  assert.match(note, /Ada Lovelace/);
  assert.match(note, /discord\.gg\/chan-welcome/);
});

test('falls back to the system channel, then the poll channel (Q3)', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { poll_channel_id: 'chan-poll' });

  const system = invitableChannel('chan-system');
  const withSystem = fakeGuild({ systemChannelId: 'chan-system', channels: { 'chan-system': system } });
  await inviteAction({ db }, withSystem, POLL);
  assert.equal(system.calls.length, 1);

  const pollChannel = invitableChannel('chan-poll');
  const withoutSystem = fakeGuild({ channels: { 'chan-poll': pollChannel } });
  await inviteAction({ db }, withoutSystem, POLL);
  assert.equal(pollChannel.calls.length, 1);
});

test('throws a clear error when no invite channel can be resolved', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { poll_channel_id: 'chan-gone' });
  const guild = fakeGuild({ channels: {} });

  await assert.rejects(() => inviteAction({ db }, guild, POLL), /no usable channel/i);
});
