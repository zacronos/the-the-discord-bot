import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearRefreshThrottle,
  pollTitle,
  refreshPollCounts,
  renderPollMessage,
} from '../../src/features/pollMessage.js';
import { createPoll, setMessageId } from '../../src/store/polls.js';
import { castVote } from '../../src/store/votes.js';
import { clearEligibilityCache } from '../../src/features/eligibility.js';
import { tempDb } from '../store/helpers.js';

const basePoll = {
  id: 7,
  type: 'invite',
  subject: 'Ada Lovelace',
  initiator_id: 'user-1',
  closes_at: 3_600_000,
};

test('pollTitle phrases each poll type around its subject', () => {
  assert.equal(pollTitle(basePoll), 'Should we invite Ada Lovelace to the server?');
  assert.equal(
    pollTitle({ type: 'permanent_channel', subject: 'chan-9' }),
    'Should <#chan-9> be made permanent?'
  );
  assert.equal(pollTitle({ type: 'delete_channel', subject: 'chan-9' }), 'Should <#chan-9> be deleted?');
});

test('renderPollMessage pings @everyone intentionally and nothing else', () => {
  const payload = renderPollMessage({ ...basePoll, subject: '@everyone hi' }, { responded: 0, eligible: 4 });
  assert.equal(payload.content, '@everyone');
  assert.deepEqual(payload.allowedMentions, { parse: ['everyone'] });
  // the subject only ever appears inside the embed, where mentions cannot ping
  assert.match(payload.embeds[0].data.title, /@everyone hi/);
});

test('renderPollMessage shows only initiator, subject, counts, and close time, plus one Vote button', () => {
  const payload = renderPollMessage(basePoll, { responded: 2, eligible: 5 });
  const embed = payload.embeds[0].data;
  const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
  assert.equal(byName['Started by'], '<@user-1>');
  assert.equal(byName.Responses, '2 voted · 3 awaiting');
  assert.match(byName.Closes, /<t:3600:F>/);
  const buttons = payload.components[0].components.map((b) => b.data);
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].custom_id, 'ttdb:vote:7');
});

test('refreshPollCounts edits the poll embed, throttled per poll', async (t) => {
  clearRefreshThrottle();
  clearEligibilityCache();
  const db = tempDb(t);
  const poll = createPoll(db, {
    guildId: 'g1',
    type: 'invite',
    subject: 'Ada',
    initiatorId: 'u1',
    channelId: 'chan-1',
    closesAt: 3_600_000,
  });
  setMessageId(db, poll.id, 'msg-1');
  castVote(db, poll.id, 'u1', 'yes');

  const edits = [];
  const message = { edit: async (payload) => edits.push(payload) };
  const channel = { id: 'chan-1', messages: { fetch: async () => message } };
  const guild = {
    id: 'g1',
    channels: { fetch: async () => channel },
    members: { fetch: async () => new Map([['u1', { user: { bot: false } }]]) },
  };

  await refreshPollCounts({ db }, guild, poll);
  await refreshPollCounts({ db }, guild, poll); // throttled: no second edit
  assert.equal(edits.length, 1);
  assert.match(edits[0].embeds[0].data.fields.find((f) => f.name === 'Responses').value, /1 voted/);

  await refreshPollCounts({ db }, guild, poll, { force: true });
  assert.equal(edits.length, 2, 'force bypasses the throttle');
});

test('a private permanence poll warns the channel will become public; other polls do not', () => {
  const base = { id: 7, initiator_id: 'u1', closes_at: 3_600_000, subject: 'chan-1' };
  const privatePerm = renderPollMessage({ ...base, type: 'permanent_channel', is_private: 1 });
  assert.match(privatePerm.embeds[0].data.description, /become public/i);

  const publicPerm = renderPollMessage({ ...base, type: 'permanent_channel', is_private: 0 });
  assert.doesNotMatch(publicPerm.embeds[0].data.description, /become public/i);

  const privateDeletion = renderPollMessage({ ...base, type: 'delete_channel', is_private: 1 });
  assert.doesNotMatch(
    privateDeletion.embeds[0].data.description,
    /become public/i,
    'deletion polls never carry the permanence warning'
  );
});
