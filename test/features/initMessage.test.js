import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INIT_MARKER, buildInitMessage, ensureInitMessage } from '../../src/features/initMessage.js';
import { getConfig, setConfig } from '../../src/store/guildConfig.js';
import { tempDb } from '../store/helpers.js';

const FULL_CONFIG = {
  poll_channel_id: 'chan-1',
  hard_no_weight: 'veto',
  threshold_type: 'count',
  threshold_value: 3,
  permanent_category_id: 'cat-1',
};

function fakeMessage({ id, authorId = 'bot-user', footer = INIT_MARKER } = {}) {
  return {
    id,
    author: { id: authorId },
    embeds: [{ footer: { text: footer } }],
    deleted: false,
    async delete() {
      this.deleted = true;
    },
  };
}

function fakeChannel({ id, messages = [] } = {}) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  return {
    id,
    sent: [],
    byId,
    messages: {
      fetch: async (arg) => {
        if (typeof arg === 'string') {
          const found = byId.get(arg);
          if (!found) throw new Error('Unknown Message');
          return found;
        }
        return byId; // { limit } scan: Map is iterable like a Collection
      },
    },
    async send(payload) {
      const sent = fakeMessage({ id: `sent-${this.sent.length + 1}` });
      sent.payload = payload;
      this.sent.push(sent);
      byId.set(sent.id, sent);
      return sent;
    },
  };
}

function fakeGuild({ id = 'g1', channels = [] } = {}) {
  const byId = new Map(channels.map((c) => [c.id, c]));
  return {
    id,
    client: { user: { id: 'bot-user' } },
    channels: {
      fetch: async (channelId) => {
        const found = byId.get(channelId);
        if (!found) throw new Error('Unknown Channel');
        return found;
      },
    },
  };
}

test('buildInitMessage carries the marker footer and both start buttons', () => {
  const payload = buildInitMessage();
  assert.equal(payload.embeds[0].data.footer.text, INIT_MARKER);
  const ids = payload.components[0].components.map((b) => b.data.custom_id);
  assert.deepEqual(ids, ['ttdb:start:invite', 'ttdb:start:permchan']);
});

test('does nothing while required config is incomplete', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { poll_channel_id: 'chan-1' });
  const channel = fakeChannel({ id: 'chan-1' });
  const guild = fakeGuild({ channels: [channel] });

  assert.equal(await ensureInitMessage({ db }, guild), null);
  assert.equal(channel.sent.length, 0);
});

test('keeps the stored message when it still exists', async (t) => {
  const db = tempDb(t);
  const existing = fakeMessage({ id: 'msg-1' });
  const channel = fakeChannel({ id: 'chan-1', messages: [existing] });
  const guild = fakeGuild({ channels: [channel] });
  setConfig(db, 'g1', { ...FULL_CONFIG, init_message_id: 'msg-1', init_channel_id: 'chan-1' });

  const result = await ensureInitMessage({ db }, guild);
  assert.equal(result, existing);
  assert.equal(channel.sent.length, 0);
});

test('adopts an orphaned marker message when the stored id is stale', async (t) => {
  const db = tempDb(t);
  const stranger = fakeMessage({ id: 'msg-a', authorId: 'someone-else' });
  const orphan = fakeMessage({ id: 'msg-b' });
  const channel = fakeChannel({ id: 'chan-1', messages: [stranger, orphan] });
  const guild = fakeGuild({ channels: [channel] });
  setConfig(db, 'g1', { ...FULL_CONFIG, init_message_id: 'gone', init_channel_id: 'chan-1' });

  const result = await ensureInitMessage({ db }, guild);
  assert.equal(result, orphan);
  assert.equal(channel.sent.length, 0);
  assert.equal(getConfig(db, 'g1').init_message_id, 'msg-b');
});

test('posts a fresh init message and stores its ids when none exists', async (t) => {
  const db = tempDb(t);
  const channel = fakeChannel({ id: 'chan-1' });
  const guild = fakeGuild({ channels: [channel] });
  setConfig(db, 'g1', FULL_CONFIG);

  const result = await ensureInitMessage({ db }, guild);
  assert.equal(channel.sent.length, 1);
  assert.equal(result.payload.embeds[0].data.footer.text, INIT_MARKER);
  const cfg = getConfig(db, 'g1');
  assert.equal(cfg.init_message_id, result.id);
  assert.equal(cfg.init_channel_id, 'chan-1');
});

test('when the poll channel changes, deletes the old message and posts in the new channel', async (t) => {
  const db = tempDb(t);
  const oldMessage = fakeMessage({ id: 'msg-old' });
  const oldChannel = fakeChannel({ id: 'chan-old', messages: [oldMessage] });
  const newChannel = fakeChannel({ id: 'chan-new' });
  const guild = fakeGuild({ channels: [oldChannel, newChannel] });
  setConfig(db, 'g1', {
    ...FULL_CONFIG,
    poll_channel_id: 'chan-new',
    init_message_id: 'msg-old',
    init_channel_id: 'chan-old',
  });

  const result = await ensureInitMessage({ db }, guild);
  assert.equal(oldMessage.deleted, true);
  assert.equal(newChannel.sent.length, 1);
  const cfg = getConfig(db, 'g1');
  assert.equal(cfg.init_message_id, result.id);
  assert.equal(cfg.init_channel_id, 'chan-new');
});

test('throws a helpful error when the configured poll channel is gone', async (t) => {
  const db = tempDb(t);
  const guild = fakeGuild({ channels: [] });
  setConfig(db, 'g1', FULL_CONFIG);

  await assert.rejects(() => ensureInitMessage({ db }, guild), /no longer exists/);
});
