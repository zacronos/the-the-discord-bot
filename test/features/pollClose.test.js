import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  abortPoll,
  buildResultDm,
  closePollPipeline,
  handleGuildLeave,
  handleResendButton,
} from '../../src/features/pollClose.js';
import { setConfig } from '../../src/store/guildConfig.js';
import { claimForClose, createPoll, getPoll, setMessageId } from '../../src/store/polls.js';
import { castVote, countVoters } from '../../src/store/votes.js';
import { clearBallotTracking, handleVoteButton } from '../../src/features/ballot.js';
import { clearEligibilityCache } from '../../src/features/eligibility.js';
import { tempDb } from '../store/helpers.js';

const CONFIG = {
  poll_channel_id: 'chan-poll',
  hard_no_weight: 'veto',
  threshold_type: 'count',
  threshold_value: 2,
  permanent_category_id: 'cat-1',
};

function makeWorld(t, { memberIds = ['u1', 'u2', 'u3'], dmFailFor = [], config = CONFIG } = {}) {
  clearEligibilityCache();
  const db = tempDb(t);
  setConfig(db, 'g1', config);

  const dms = []; // { userId, content }
  const channelSends = [];
  const message = { deleted: false, delete: async () => (message.deleted = true), edit: async () => {} };
  const channel = {
    id: 'chan-poll',
    messages: { fetch: async () => message },
    send: async (payload) => channelSends.push(payload),
  };
  const guild = {
    id: 'g1',
    channels: { fetch: async () => channel },
    members: {
      fetch: async () => new Map(memberIds.map((id) => [id, { user: { bot: false } }])),
    },
  };
  const client = {
    guilds: { fetch: async () => guild },
    users: {
      fetch: async (userId) => ({
        send: async (content) => {
          if (dmFailFor.includes(userId)) throw new Error('Cannot send messages to this user');
          dms.push({ userId, content });
        },
      }),
    },
  };
  const ctx = { db, client, sleep: async () => {}, now: () => 10_000, actions: {} };
  const poll = createPoll(db, {
    guildId: 'g1',
    type: 'invite',
    subject: 'Ada',
    initiatorId: 'u1',
    channelId: 'chan-poll',
    closesAt: 5_000,
  });
  setMessageId(db, poll.id, 'msg-1');
  return { db, ctx, poll, guild, message, dms, channelSends };
}

test('a poll already being closed is not closed twice', async (t) => {
  const { db, ctx, poll, dms } = makeWorld(t);
  claimForClose(db, poll.id);
  assert.equal(await closePollPipeline(ctx, poll), false);
  assert.equal(dms.length, 0);
});

test('vetoed poll: initiator told the count, vetoers told privately, message deleted, votes purged', async (t) => {
  const { db, ctx, poll, message, dms } = makeWorld(t);
  castVote(db, poll.id, 'u1', 'yes');
  castVote(db, poll.id, 'u2', 'hard_no');
  castVote(db, poll.id, 'u3', 'hard_no');

  await closePollPipeline(ctx, poll);

  const closed = getPoll(db, poll.id);
  assert.equal(closed.status, 'vetoed');
  assert.equal(closed.veto_count, 2);
  assert.equal(message.deleted, true);
  assert.equal(countVoters(db, poll.id), 0, 'Q5 retention: vote rows purged');

  const initiator = dms.find((d) => d.userId === 'u1');
  assert.match(initiator.content, /vetoed by 2 member/);
  assert.match(initiator.content, /refrain from starting/i);
  const vetoerDms = dms.filter((d) => ['u2', 'u3'].includes(d.userId));
  assert.equal(vetoerDms.length, 2);
  for (const dm of vetoerDms) {
    assert.match(dm.content, /because of your veto/);
    assert.match(dm.content, /<@u1>/);
  }
});

test('failed poll: initiator gets pass/fail only — no totals leak', async (t) => {
  const { db, ctx, poll, dms } = makeWorld(t, { config: { ...CONFIG, hard_no_weight: '-2' } });
  castVote(db, poll.id, 'u2', 'no');

  await closePollPipeline(ctx, poll);

  assert.equal(getPoll(db, poll.id).status, 'failed');
  const initiator = dms.find((d) => d.userId === 'u1');
  assert.match(initiator.content, /did not pass/);
  assert.doesNotMatch(initiator.content, /total|[0-9]/, 'no numbers in a failure DM');
});

test('passed poll: runs the type action and includes its note in the DM', async (t) => {
  const { db, ctx, poll, dms } = makeWorld(t);
  const actionCalls = [];
  ctx.actions.invite = async (c, guild, p) => {
    actionCalls.push(p.id);
    return 'Here is the invite link: https://discord.gg/abc';
  };
  castVote(db, poll.id, 'u1', 'yes');
  castVote(db, poll.id, 'u2', 'yes');

  await closePollPipeline(ctx, poll);

  assert.deepEqual(actionCalls, [poll.id]);
  assert.equal(getPoll(db, poll.id).status, 'passed');
  const initiator = dms.find((d) => d.userId === 'u1');
  assert.match(initiator.content, /passed/);
  assert.match(initiator.content, /discord\.gg\/abc/);
});

test('a failing action still reports success with a manual-follow-up note', async (t) => {
  const { db, ctx, poll, dms } = makeWorld(t);
  ctx.actions.invite = async () => {
    throw new Error('Missing Permissions');
  };
  castVote(db, poll.id, 'u1', 'yes');
  castVote(db, poll.id, 'u2', 'yes');

  await closePollPipeline(ctx, poll);
  const initiator = dms.find((d) => d.userId === 'u1');
  assert.match(initiator.content, /passed/);
  assert.match(initiator.content, /Missing Permissions/);
  assert.match(initiator.content, /admin/i);
});

test('per-poll-type thresholds are honored at close', async (t) => {
  const { db, ctx, poll } = makeWorld(t, {
    config: {
      ...CONFIG,
      hard_no_weight: '-2',
      threshold_type: null,
      threshold_value: null,
      threshold_type_invite: 'count',
      threshold_value_invite: 1,
      threshold_type_permchan: 'count',
      threshold_value_permchan: 5,
    },
  });
  castVote(db, poll.id, 'u1', 'yes');
  await closePollPipeline(ctx, poll);
  assert.equal(getPoll(db, poll.id).status, 'passed', 'invite threshold is 1');

  const perm = createPoll(db, {
    guildId: 'g1',
    type: 'permanent_channel',
    subject: 'chan-x',
    initiatorId: 'u1',
    channelId: 'chan-poll',
    closesAt: 5_000,
  });
  setMessageId(db, perm.id, 'msg-2');
  castVote(db, perm.id, 'u1', 'yes');
  await closePollPipeline(ctx, perm);
  assert.equal(getPoll(db, perm.id).status, 'failed', 'permanence threshold is 5');
});

test('votes from members who left are dropped before tallying (Q2)', async (t) => {
  const { db, ctx, poll } = makeWorld(t, {
    memberIds: ['u1', 'u2'], // u3 left the server
    config: { ...CONFIG, hard_no_weight: '-2', threshold_value: 2 },
  });
  castVote(db, poll.id, 'u1', 'yes');
  castVote(db, poll.id, 'u3', 'yes'); // departed: must not count

  await closePollPipeline(ctx, poll);
  assert.equal(getPoll(db, poll.id).status, 'failed', 'total is 1, target 2');
});

test('when the initiator DM bounces, a non-revealing notice with a resend button is posted (Q4)', async (t) => {
  const { db, ctx, poll, channelSends } = makeWorld(t, { dmFailFor: ['u1'] });
  castVote(db, poll.id, 'u1', 'yes');
  castVote(db, poll.id, 'u2', 'yes');

  await closePollPipeline(ctx, poll);

  assert.equal(channelSends.length, 1);
  const notice = channelSends[0];
  assert.match(notice.content, /<@u1>/);
  assert.doesNotMatch(notice.content, /passed|failed|vetoed/i, 'notice reveals nothing');
  assert.deepEqual(notice.allowedMentions, { users: ['u1'] });
  const button = notice.components[0].components[0];
  assert.equal(button.data.custom_id, `ttdb:resend:${poll.id}`);
});

test('the resend button re-DMs the stored outcome, initiator only', async (t) => {
  const { db, ctx, poll, dms } = makeWorld(t);
  castVote(db, poll.id, 'u2', 'no');
  await closePollPipeline(ctx, poll); // closes as failed (weight veto unused; no yes votes)
  dms.length = 0;

  const replies = [];
  const stranger = {
    user: { id: 'u2' },
    reply: async (p) => replies.push(p),
  };
  await handleResendButton(ctx, stranger, [String(poll.id)]);
  assert.match(replies[0].content, /initiator/i);
  assert.equal(dms.length, 0);

  const initiator = { user: { id: 'u1' }, reply: async (p) => replies.push(p) };
  await handleResendButton(ctx, initiator, [String(poll.id)]);
  assert.equal(dms.length, 1);
  assert.match(dms[0].content, /did not pass/);
});

test('abortPoll cancels an open poll and tells the initiator why', async (t) => {
  const { db, ctx, poll, dms } = makeWorld(t);
  await abortPoll(ctx, poll, 'its message was deleted');

  assert.equal(getPoll(db, poll.id).status, 'aborted');
  const initiator = dms.find((d) => d.userId === 'u1');
  assert.match(initiator.content, /cancelled/);
  assert.match(initiator.content, /its message was deleted/);
});

test('closing a poll dismisses tracked open ballots', async (t) => {
  const { db, ctx, poll } = makeWorld(t);
  clearBallotTracking();
  castVote(db, poll.id, 'u2', 'no');
  const ballot = {
    guildId: 'g1',
    user: { id: 'u1' },
    replies: [],
    deletedReplies: 0,
    reply: async (p) => ballot.replies.push(p),
    deleteReply: async () => {
      ballot.deletedReplies += 1;
    },
  };
  await handleVoteButton({ db, now: ctx.now }, ballot, [String(poll.id)]);

  await closePollPipeline(ctx, poll);
  assert.equal(ballot.deletedReplies, 1, 'the open ballot was deleted at close');
});

test('leaving a guild aborts all of its open polls (7.3)', async (t) => {
  const { db, ctx, poll } = makeWorld(t);
  const second = createPoll(db, {
    guildId: 'g1',
    type: 'permanent_channel',
    subject: 'chan-x',
    initiatorId: 'u2',
    channelId: 'chan-poll',
    closesAt: 5_000,
  });

  await handleGuildLeave(ctx, { id: 'g1' });
  assert.equal(getPoll(db, poll.id).status, 'aborted');
  assert.equal(getPoll(db, second.id).status, 'aborted');
});

test('buildResultDm names the poll subject in every outcome', () => {
  const poll = { type: 'permanent_channel', subject: 'chan-9', initiator_id: 'u1' };
  assert.match(buildResultDm(poll, 'passed', 0, null), /<#chan-9>/);
  assert.match(buildResultDm(poll, 'failed', 0, null), /<#chan-9>/);
  assert.match(buildResultDm(poll, 'vetoed', 3, null), /3 member/);
});
