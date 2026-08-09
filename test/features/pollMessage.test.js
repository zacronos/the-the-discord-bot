import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearRefreshThrottle,
  pollRulesFor,
  pollTitle,
  refreshPollCounts,
  renderPollMessage,
} from '../../src/features/pollMessage.js';
import { setConfig } from '../../src/store/guildConfig.js';
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

test('renderPollMessage includes a Pass rules field only when rules are provided', () => {
  const withRules = renderPollMessage(basePoll, {
    responded: 0,
    eligible: 4,
    rules: 'Yes **+1** — passes at 3',
  });
  const field = withRules.embeds[0].data.fields.find((f) => f.name === 'Pass rules');
  assert.equal(field.value, 'Yes **+1** — passes at 3');

  const without = renderPollMessage(basePoll, { responded: 0, eligible: 4 });
  assert.equal(without.embeds[0].data.fields.find((f) => f.name === 'Pass rules'), undefined);
});

test('pollRulesFor formats the vote weights and the threshold that applies to this poll', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', {
    hard_no_weight: '-3',
    threshold_type_invite: 'count',
    threshold_value_invite: 5,
    permanent_category_id: 'cat-1',
    threshold_type_delchan: 'count',
    threshold_value_delchan: 9,
    threshold_type_delchan_other: 'percent',
    threshold_value_delchan_other: 50,
  });
  const guild = {
    id: 'g1',
    channels: { fetch: async (id) => ({ id, parentId: id === 'chan-perm' ? 'cat-1' : null }) },
  };

  const invite = await pollRulesFor({ db }, guild, { type: 'invite', subject: 'Ada' });
  assert.match(invite, /Yes \*\*\+1\*\* · No \*\*−1\*\* · Abstain \*\*0\*\* · Hard no \*\*−3\*\*/);
  assert.match(invite, /at least \*\*5 points total\*\*/);

  const permDeletion = await pollRulesFor({ db }, guild, { type: 'delete_channel', subject: 'chan-perm' });
  assert.match(permDeletion, /at least \*\*9 points total\*\*/, 'permanent-category deletion bar');

  const otherDeletion = await pollRulesFor({ db }, guild, { type: 'delete_channel', subject: 'chan-free' });
  assert.match(otherDeletion, /at least \*\*50% of current members\*\*/, 'other-channel deletion bar');
});

test('pollRulesFor speaks veto, and says when the threshold is unconfigured', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { hard_no_weight: 'veto' });
  const guild = { id: 'g1', channels: { fetch: async () => ({ parentId: null }) } };
  const rules = await pollRulesFor({ db }, guild, { type: 'invite', subject: 'Ada' });
  assert.match(rules, /vetoes the poll/);
  assert.match(rules, /not configured/i);
});

test('refreshPollCounts keeps the pass rules current with config changes', async (t) => {
  clearRefreshThrottle();
  clearEligibilityCache();
  const db = tempDb(t);
  setConfig(db, 'g1', { hard_no_weight: '-2', threshold_type_invite: 'count', threshold_value_invite: 3 });
  const poll = createPoll(db, {
    guildId: 'g1',
    type: 'invite',
    subject: 'Ada',
    initiatorId: 'u1',
    channelId: 'chan-1',
    closesAt: 3_600_000,
  });
  setMessageId(db, poll.id, 'msg-1');

  const edits = [];
  const message = { edit: async (payload) => edits.push(payload) };
  const channel = { id: 'chan-1', messages: { fetch: async () => message } };
  const guild = {
    id: 'g1',
    channels: { fetch: async () => channel },
    members: { fetch: async () => new Map([['u1', { user: { bot: false } }]]) },
  };

  await refreshPollCounts({ db }, guild, poll);
  const rulesOf = (edit) => edit.embeds[0].data.fields.find((f) => f.name === 'Pass rules').value;
  assert.match(rulesOf(edits[0]), /at least \*\*3 points total\*\*/);

  setConfig(db, 'g1', { threshold_value_invite: 8 });
  await refreshPollCounts({ db }, guild, poll, { force: true });
  assert.match(rulesOf(edits[1]), /at least \*\*8 points total\*\*/, 'mid-poll changes surface on refresh');
});

test('pollRulesFor notes that Hard no is unavailable on non-permanent deletion polls', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', {
    hard_no_weight: '-3',
    permanent_category_id: 'cat-1',
    threshold_type_delchan: 'count',
    threshold_value_delchan: 9,
    threshold_type_delchan_other: 'count',
    threshold_value_delchan_other: 2,
  });
  const guild = {
    id: 'g1',
    channels: { fetch: async (id) => ({ id, parentId: id === 'chan-perm' ? 'cat-1' : null }) },
  };

  const other = await pollRulesFor({ db }, guild, { type: 'delete_channel', subject: 'chan-free' });
  assert.match(other, /Hard no \*\*not available\*\*/i);
  assert.doesNotMatch(other, /−3/);

  const perm = await pollRulesFor({ db }, guild, { type: 'delete_channel', subject: 'chan-perm' });
  assert.match(perm, /Hard no \*\*−3\*\*/, 'permanent-category deletions keep the weight');
});
