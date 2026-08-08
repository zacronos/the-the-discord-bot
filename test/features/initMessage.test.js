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

const currentFooter = (cfg = FULL_CONFIG) => buildInitMessage(cfg).embeds[0].data.footer.text;

function fakeMessage({ id, authorId = 'bot-user', footer = INIT_MARKER } = {}) {
  return {
    id,
    author: { id: authorId },
    embeds: [{ footer: { text: footer } }],
    deleted: false,
    edits: [],
    async delete() {
      this.deleted = true;
    },
    async edit(payload) {
      this.edits.push(payload);
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

test('the init message explains point totaling as a bullet list that tracks the hard-no setting', () => {
  const veto = buildInitMessage(FULL_CONFIG); // hard_no_weight: 'veto'
  const description = veto.embeds[0].data.description;
  assert.match(description, /__When a poll closes, votes are totaled as points__\n/);
  assert.match(description, /• Yes {2}=> {2}\*\*\+1\*\*/);
  assert.match(description, /• No {2}=> {2}\*\*−1\*\*/);
  assert.match(description, /• Abstain {2}=> {2}\*\*0\*\*/);
  assert.match(
    description,
    /• Hard no {2}=> {2}\*\*vetoes the poll\*\* \(it fails outright if there are any vetoes\)/
  );
  assert.doesNotMatch(
    description.split('\n')[0],
    /Votes are\n/,
    'intro renders as one flowing paragraph'
  );
  assert.match(
    description,
    /the closing time are public\.\n\nResults are delivered privately to whoever started the poll, and then the poll is deleted\./,
    'the result-delivery sentence is its own paragraph and mentions deletion'
  );

  const minus3 = buildInitMessage({ ...FULL_CONFIG, hard_no_weight: '-3' });
  assert.match(minus3.embeds[0].data.description, /• Hard no {2}=> {2}\*\*−3\*\*/);
  assert.notEqual(
    veto.embeds[0].data.footer.text,
    minus3.embeds[0].data.footer.text,
    'different hard-no values hash differently, so a stored message gets edited on change'
  );
});

test('the init message ends with the per-poll-type thresholds and tracks changes to them', () => {
  const base = buildInitMessage(FULL_CONFIG); // legacy shared threshold: 3 votes
  const description = base.embeds[0].data.description;
  assert.match(description, /__Current pass thresholds__\nThe point total at poll closing must be at least:/);
  assert.match(description, /• Invite polls: _3 points total_/);
  assert.match(description, /• Channel-permanence polls: _3 points total_/);

  const changed = buildInitMessage({
    ...FULL_CONFIG,
    threshold_type_permchan: 'percent',
    threshold_value_permchan: 50,
  });
  assert.match(changed.embeds[0].data.description, /• Channel-permanence polls: _50% of current members_/);
  assert.notEqual(
    base.embeds[0].data.footer.text,
    changed.embeds[0].data.footer.text,
    'threshold changes re-hash the message, so stored copies get edited'
  );
});

test('buildInitMessage carries the marker footer with a content hash, and both start buttons', () => {
  const payload = buildInitMessage(FULL_CONFIG);
  assert.match(
    payload.embeds[0].data.footer.text,
    new RegExp(`^${INIT_MARKER} [0-9a-f]{8}$`),
    'footer = marker + short hash of the current content'
  );
  const ids = payload.components[0].components.map((b) => b.data.custom_id);
  assert.deepEqual(ids, ['ttdb:start:invite', 'ttdb:start:permchan']);
  assert.equal(currentFooter(), currentFooter(), 'hash is deterministic');
});

test('does nothing while required config is incomplete', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { poll_channel_id: 'chan-1' });
  const channel = fakeChannel({ id: 'chan-1' });
  const guild = fakeGuild({ channels: [channel] });

  assert.equal(await ensureInitMessage({ db }, guild), null);
  assert.equal(channel.sent.length, 0);
});

test('keeps the stored message untouched when its content is current', async (t) => {
  const db = tempDb(t);
  const existing = fakeMessage({ id: 'msg-1', footer: currentFooter() });
  const channel = fakeChannel({ id: 'chan-1', messages: [existing] });
  const guild = fakeGuild({ channels: [channel] });
  setConfig(db, 'g1', { ...FULL_CONFIG, init_message_id: 'msg-1', init_channel_id: 'chan-1' });

  const result = await ensureInitMessage({ db }, guild);
  assert.equal(result, existing);
  assert.equal(channel.sent.length, 0);
  assert.equal(existing.edits.length, 0, 'no pointless edit when content already matches');
});

test('edits the stored message in place when its content is outdated', async (t) => {
  const db = tempDb(t);
  const stale = fakeMessage({ id: 'msg-1', footer: `${INIT_MARKER} 00000000` });
  const channel = fakeChannel({ id: 'chan-1', messages: [stale] });
  const guild = fakeGuild({ channels: [channel] });
  setConfig(db, 'g1', { ...FULL_CONFIG, init_message_id: 'msg-1', init_channel_id: 'chan-1' });

  const result = await ensureInitMessage({ db }, guild);
  assert.equal(result, stale);
  assert.equal(channel.sent.length, 0, 'edited, not reposted');
  assert.equal(stale.edits.length, 1);
  assert.equal(stale.edits[0].embeds[0].data.footer.text, currentFooter());
  assert.equal(getConfig(db, 'g1').init_message_id, 'msg-1', 'same message id kept');
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
  assert.equal(orphan.edits.length, 1, 'legacy-footer orphan is brought up to date');
  assert.equal(orphan.edits[0].embeds[0].data.footer.text, currentFooter());
});

test('posts a fresh init message and stores its ids when none exists', async (t) => {
  const db = tempDb(t);
  const channel = fakeChannel({ id: 'chan-1' });
  const guild = fakeGuild({ channels: [channel] });
  setConfig(db, 'g1', FULL_CONFIG);

  const result = await ensureInitMessage({ db }, guild);
  assert.equal(channel.sent.length, 1);
  assert.equal(result.payload.embeds[0].data.footer.text, currentFooter());
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
