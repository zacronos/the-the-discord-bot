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
import { deleteChannelAction } from '../../src/features/actions/deleteChannel.js';
import { clearBallotTracking, handleVoteButton } from '../../src/features/ballot.js';
import { clearEligibilityCache, fetchGuildMembers } from '../../src/features/eligibility.js';
import { listDueDeletions } from '../../src/store/scheduledDeletions.js';
import { tempDb } from '../store/helpers.js';

const CONFIG = {
  poll_channel_id: 'chan-poll',
  hard_no_weight: 'veto',
  threshold_type: 'count',
  threshold_value: 2,
  permanent_category_id: 'cat-1',
};

function makeWorld(
  t,
  {
    memberIds = ['u1', 'u2', 'u3'],
    botIds = [],
    dmFailFor = [],
    config = CONFIG,
    membersFetchFails = false,
  } = {}
) {
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
  let memberFetches = 0;
  const guild = {
    id: 'g1',
    channels: { fetch: async () => channel },
    members: {
      fetch: async () => {
        memberFetches += 1;
        if (membersFetchFails) throw new Error('GuildMembersTimeout');
        return new Map([
          ...memberIds.map((id) => [id, { user: { bot: false } }]),
          ...botIds.map((id) => [id, { user: { bot: true } }]),
        ]);
      },
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
  const world = {
    get memberFetches() {
      return memberFetches;
    },
  };
  const poll = createPoll(db, {
    guildId: 'g1',
    type: 'invite',
    subject: 'Ada',
    initiatorId: 'u1',
    channelId: 'chan-poll',
    closesAt: 5_000,
  });
  setMessageId(db, poll.id, 'msg-1');
  return { db, ctx, poll, guild, message, dms, channelSends, world };
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

test('regression: a zero-vote poll with a percent threshold fails even if everyone left', async (t) => {
  // Mirrors the live bug: percent 30 threshold, empty member list, no votes
  // — the old code computed target 0 and declared the poll passed.
  const { db, ctx, poll, dms } = makeWorld(t, {
    memberIds: [],
    config: { ...CONFIG, threshold_type: 'percent', threshold_value: 30 },
  });

  await closePollPipeline(ctx, poll);
  assert.equal(getPoll(db, poll.id).status, 'failed');
  const initiator = dms.find((d) => d.userId === 'u1');
  assert.match(initiator.content, /did not pass/);
});

test('a percent-threshold close is deferred when the member count is unavailable', async (t) => {
  const { db, ctx, poll, dms, message } = makeWorld(t, {
    membersFetchFails: true,
    config: { ...CONFIG, threshold_type: 'percent', threshold_value: 30 },
  });
  castVote(db, poll.id, 'u1', 'yes');

  assert.equal(await closePollPipeline(ctx, poll), false);
  assert.equal(getPoll(db, poll.id).status, 'open', 'poll stays open for the next sweep');
  assert.equal(dms.length, 0, 'no result was announced');
  assert.equal(message.deleted, false);
  assert.equal(countVoters(db, poll.id), 1, 'votes retained for the retry');
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

function wireDoomedChannel(world) {
  const warned = [];
  const doomed = { id: 'chan-doomed', send: async (p) => warned.push(p) };
  const baseFetch = world.guild.channels.fetch;
  world.guild.channels.fetch = async (id) => (id === 'chan-doomed' ? doomed : baseFetch(id));
  world.ctx.actions.delete_channel = deleteChannelAction;
  return warned;
}

function makeDeletionPoll(db) {
  const poll = createPoll(db, {
    guildId: 'g1',
    type: 'delete_channel',
    subject: 'chan-doomed',
    initiatorId: 'u1',
    channelId: 'chan-poll',
    closesAt: 5_000,
  });
  setMessageId(db, poll.id, 'msg-2');
  return poll;
}

test('a failed or vetoed deletion poll schedules nothing and never touches the channel', async (t) => {
  const failedWorld = makeWorld(t, { config: { ...CONFIG, hard_no_weight: '-2' } });
  const warnedA = wireDoomedChannel(failedWorld);
  const pollA = makeDeletionPoll(failedWorld.db);
  castVote(failedWorld.db, pollA.id, 'u2', 'no');
  await closePollPipeline(failedWorld.ctx, pollA);
  assert.equal(getPoll(failedWorld.db, pollA.id).status, 'failed');
  assert.equal(listDueDeletions(failedWorld.db, Number.MAX_SAFE_INTEGER).length, 0);
  assert.equal(warnedA.length, 0, 'the channel is never warned about a non-deletion');

  const vetoWorld = makeWorld(t);
  const warnedB = wireDoomedChannel(vetoWorld);
  const pollB = makeDeletionPoll(vetoWorld.db);
  castVote(vetoWorld.db, pollB.id, 'u2', 'hard_no');
  await closePollPipeline(vetoWorld.ctx, pollB);
  assert.equal(getPoll(vetoWorld.db, pollB.id).status, 'vetoed');
  assert.equal(listDueDeletions(vetoWorld.db, Number.MAX_SAFE_INTEGER).length, 0);
  assert.equal(warnedB.length, 0);
  assert.ok(vetoWorld.dms.some((d) => d.userId === 'u2' && /veto/.test(d.content)), 'vetoer still notified');
});

test('a passed deletion poll schedules 24h from close (hour-rounded), warns the channel, and reports the time', async (t) => {
  const world = makeWorld(t);
  const warned = wireDoomedChannel(world);
  const poll = makeDeletionPoll(world.db);
  castVote(world.db, poll.id, 'u1', 'yes');
  castVote(world.db, poll.id, 'u2', 'yes');

  await closePollPipeline(world.ctx, poll); // ctx.now = 10_000 → +24h → next hour = 90_000_000
  assert.equal(getPoll(world.db, poll.id).status, 'passed');
  const rows = listDueDeletions(world.db, 90_000_000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel_id, 'chan-doomed');
  assert.equal(rows[0].delete_at, 90_000_000);
  assert.equal(rows[0].poll_id, poll.id);
  assert.match(warned[0].content, /<t:90000:F>/);
  const initiator = world.dms.find((d) => d.userId === 'u1');
  assert.match(initiator.content, /deleting <#chan-doomed>/);
  assert.match(initiator.content, /<t:90000:F>/);
});

test('channel-deletion polls close against their own threshold', async (t) => {
  const world = makeWorld(t, {
    config: {
      ...CONFIG,
      hard_no_weight: '-2',
      threshold_type: null,
      threshold_value: null,
      threshold_type_invite: 'count',
      threshold_value_invite: 1,
      threshold_type_delchan: 'count',
      threshold_value_delchan: 3,
    },
  });
  const actionCalls = [];
  world.ctx.actions.delete_channel = async () => {
    actionCalls.push(1);
    return 'scheduled';
  };

  const low = makeDeletionPoll(world.db);
  castVote(world.db, low.id, 'u1', 'yes');
  await closePollPipeline(world.ctx, low);
  assert.equal(getPoll(world.db, low.id).status, 'failed', 'one yes fails the delchan target of 3');
  assert.equal(actionCalls.length, 0);

  const high = createPoll(world.db, {
    guildId: 'g1',
    type: 'delete_channel',
    subject: 'chan-doomed-2',
    initiatorId: 'u1',
    channelId: 'chan-poll',
    closesAt: 5_000,
  });
  setMessageId(world.db, high.id, 'msg-3');
  for (const id of ['u1', 'u2', 'u3']) castVote(world.db, high.id, id, 'yes');
  await closePollPipeline(world.ctx, high);
  assert.equal(getPoll(world.db, high.id).status, 'passed');
  assert.equal(actionCalls.length, 1);
});

test('passed and failed closes purge individual votes too', async (t) => {
  const passWorld = makeWorld(t);
  castVote(passWorld.db, passWorld.poll.id, 'u1', 'yes');
  castVote(passWorld.db, passWorld.poll.id, 'u2', 'yes');
  await closePollPipeline(passWorld.ctx, passWorld.poll);
  assert.equal(getPoll(passWorld.db, passWorld.poll.id).status, 'passed');
  assert.equal(countVoters(passWorld.db, passWorld.poll.id), 0);

  const failWorld = makeWorld(t, { config: { ...CONFIG, hard_no_weight: '-2' } });
  castVote(failWorld.db, failWorld.poll.id, 'u2', 'no');
  await closePollPipeline(failWorld.ctx, failWorld.poll);
  assert.equal(getPoll(failWorld.db, failWorld.poll.id).status, 'failed');
  assert.equal(countVoters(failWorld.db, failWorld.poll.id), 0);
});

test('a close reuses a persisted member snapshot across a restart — no extra fetch', async (t) => {
  const world = makeWorld(t);
  await fetchGuildMembers(world.db, world.guild, { now: 5_000 });
  assert.equal(world.world.memberFetches, 1);

  clearEligibilityCache(); // restart: memory gone, sqlite snapshot remains
  castVote(world.db, world.poll.id, 'u1', 'yes');
  castVote(world.db, world.poll.id, 'u2', 'yes');
  await closePollPipeline(world.ctx, world.poll);
  assert.equal(world.world.memberFetches, 1, 'decided from the restored snapshot');
  assert.equal(getPoll(world.db, world.poll.id).status, 'passed');
});

test('a close performs at most one gateway member fetch (op8 rate budget)', async (t) => {
  const { db, ctx, poll, world } = makeWorld(t);
  castVote(db, poll.id, 'u1', 'yes');
  castVote(db, poll.id, 'u2', 'yes');

  await closePollPipeline(ctx, poll);
  assert.equal(world.memberFetches, 1, 'pruning and counting share one member fetch');
});

test('a veto from a member who left the server does not veto the poll', async (t) => {
  const { db, ctx, poll, dms } = makeWorld(t, { memberIds: ['u1', 'u2'] });
  castVote(db, poll.id, 'u1', 'yes');
  castVote(db, poll.id, 'u2', 'yes');
  castVote(db, poll.id, 'u3', 'hard_no'); // u3 left the server

  await closePollPipeline(ctx, poll);
  assert.equal(getPoll(db, poll.id).status, 'passed');
  assert.ok(!dms.some((d) => /because of your veto/.test(d.content)), 'no vetoer guidance DMs');
  assert.ok(!dms.some((d) => d.userId === 'u3'), 'the departed member is not contacted');
});

test('percent thresholds count only non-bot members through the close pipeline', async (t) => {
  const { db, ctx, poll } = makeWorld(t, {
    memberIds: ['u1', 'u2', 'u3'],
    botIds: ['bot1'],
    config: { ...CONFIG, hard_no_weight: '-2', threshold_type: 'percent', threshold_value: 100 },
  });
  castVote(db, poll.id, 'u1', 'yes');
  castVote(db, poll.id, 'u2', 'yes');
  castVote(db, poll.id, 'u3', 'yes');

  await closePollPipeline(ctx, poll);
  assert.equal(getPoll(db, poll.id).status, 'passed', 'target is 3 humans, not 4 members');
});

test('the README worked example: 50 percent in a 10-person server', async (t) => {
  const memberIds = Array.from({ length: 10 }, (_, i) => `u${i + 1}`);
  const config = { ...CONFIG, hard_no_weight: '-3', threshold_type: 'percent', threshold_value: 50 };

  const failing = makeWorld(t, { memberIds, config });
  for (const id of ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']) castVote(failing.db, failing.poll.id, id, 'yes');
  castVote(failing.db, failing.poll.id, 'u7', 'no');
  castVote(failing.db, failing.poll.id, 'u8', 'hard_no');
  await closePollPipeline(failing.ctx, failing.poll); // point total 2, target 5
  assert.equal(getPoll(failing.db, failing.poll.id).status, 'failed');

  const passing = makeWorld(t, { memberIds, config });
  for (const id of ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8']) castVote(passing.db, passing.poll.id, id, 'yes');
  castVote(passing.db, passing.poll.id, 'u9', 'abstain');
  castVote(passing.db, passing.poll.id, 'u10', 'abstain');
  await closePollPipeline(passing.ctx, passing.poll); // point total 8, target 5
  assert.equal(getPoll(passing.db, passing.poll.id).status, 'passed');
});

test('a numeric hard-no reduces the total without vetoing or DM-ing the hard-no voter', async (t) => {
  const { db, ctx, poll, dms } = makeWorld(t, {
    memberIds: ['u1', 'u2', 'u3', 'u4'],
    config: { ...CONFIG, hard_no_weight: '-2', threshold_value: 1 },
  });
  castVote(db, poll.id, 'u1', 'yes');
  castVote(db, poll.id, 'u2', 'yes');
  castVote(db, poll.id, 'u3', 'yes');
  castVote(db, poll.id, 'u4', 'hard_no'); // total 3 - 2 = 1

  await closePollPipeline(ctx, poll);
  assert.equal(getPoll(db, poll.id).status, 'passed');
  assert.ok(!dms.some((d) => d.userId === 'u4'), 'hard-no voters are not contacted');
  assert.ok(!dms.some((d) => /veto/i.test(d.content)), 'no veto language anywhere');
});

test('a vetoer whose DMs are closed never surfaces in the poll channel', async (t) => {
  const { db, ctx, poll, dms, channelSends } = makeWorld(t, { dmFailFor: ['u2'] });
  castVote(db, poll.id, 'u1', 'yes');
  castVote(db, poll.id, 'u2', 'hard_no');

  await closePollPipeline(ctx, poll);
  assert.equal(getPoll(db, poll.id).status, 'vetoed');
  assert.equal(channelSends.length, 0, 'no public trace of a vetoer');
  const initiator = dms.find((d) => d.userId === 'u1');
  assert.match(initiator.content, /vetoed by 1 member/);
  assert.doesNotMatch(initiator.content, /u2|<@u2>/, 'count only, never who');
});

test('aborting a poll erases its votes, same as any close (privacy)', async (t) => {
  const first = makeWorld(t);
  castVote(first.db, first.poll.id, 'u1', 'yes');
  castVote(first.db, first.poll.id, 'u2', 'hard_no');
  await abortPoll(first.ctx, first.poll, 'its message was deleted');
  assert.equal(countVoters(first.db, first.poll.id), 0);

  const second = makeWorld(t);
  castVote(second.db, second.poll.id, 'u2', 'no');
  await handleGuildLeave(second.ctx, { id: 'g1' });
  assert.equal(countVoters(second.db, second.poll.id), 0, 'guild-leave aborts purge votes too');
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
  await handleVoteButton({ db, now: ctx.now, schedule: () => {} }, ballot, [String(poll.id)]);

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
  const named = { type: 'delete_channel', subject: 'chan-9', subject_name: 'archive', initiator_id: 'u1' };
  assert.match(
    buildResultDm(named, 'passed', 0, null),
    /deleting #archive \(<#chan-9>\)/,
    'literal name first, clickable reference in parentheses'
  );
  const deletion = { type: 'delete_channel', subject: 'chan-9', initiator_id: 'u1' };
  assert.match(buildResultDm(deletion, 'passed', 0, null), /deleting <#chan-9>/, 'mention-only fallback without a stored name');
  const poll = { type: 'permanent_channel', subject: 'chan-9', subject_name: 'plans', initiator_id: 'u1' };
  assert.match(buildResultDm(poll, 'passed', 0, null), /#plans \(<#chan-9>\)/);
  assert.match(buildResultDm(poll, 'failed', 0, null), /<#chan-9>/);
  assert.match(buildResultDm(poll, 'vetoed', 3, null), /3 member/);
});
