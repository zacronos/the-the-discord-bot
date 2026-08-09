import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import {
  choiceLabel,
  clearBallotTracking,
  deleteBallots,
  handleCastButton,
  handleVoteButton,
} from '../../src/features/ballot.js';
import { setConfig } from '../../src/store/guildConfig.js';
import { createPoll, setMessageId } from '../../src/store/polls.js';
import { castVote, getVote } from '../../src/store/votes.js';
import { closePoll } from '../../src/store/polls.js';
import { clearEligibilityCache } from '../../src/features/eligibility.js';
import { clearRefreshThrottle } from '../../src/features/pollMessage.js';
import { tempDb } from '../store/helpers.js';

function makePoll(db, over = {}) {
  const poll = createPoll(db, {
    guildId: 'g1',
    type: 'invite',
    subject: 'Ada',
    initiatorId: 'u9',
    channelId: 'chan-poll',
    closesAt: 9_000_000_000,
    ...over,
  });
  setMessageId(db, poll.id, 'msg-1');
  return poll;
}

function fakeGuild(memberCount = 3) {
  const members = new Map(
    Array.from({ length: memberCount }, (_, i) => [`u${i + 1}`, { user: { bot: false } }])
  );
  const message = { edits: [], edit: async (p) => message.edits.push(p) };
  const channel = { id: 'chan-poll', messages: { fetch: async () => message } };
  return {
    id: 'g1',
    message,
    channels: { fetch: async () => channel },
    members: { fetch: async () => members },
  };
}

function fakeInteraction({ guild, userId = 'u1' } = {}) {
  const interaction = {
    guildId: 'g1',
    guild,
    user: { id: userId },
    replies: [],
    updates: [],
    deletedReplies: 0,
    reply: async (p) => interaction.replies.push(p),
    update: async (p) => interaction.updates.push(p),
    deleteReply: async () => {
      interaction.deletedReplies += 1;
    },
  };
  return interaction;
}

test('choiceLabel wording matches the spec per poll type', () => {
  assert.equal(choiceLabel('invite', 'yes'), 'Yes!');
  assert.equal(
    choiceLabel('invite', 'no'),
    "No, I'd rather not invite them, but I won't object if enough people want to"
  );
  assert.ok(choiceLabel('invite', 'no').length <= 80, 'fits the button label limit');
  assert.equal(
    choiceLabel('permanent_channel', 'no'),
    "No, I'd rather not, but I won't object if enough people want to"
  );
  assert.equal(
    choiceLabel('delete_channel', 'no'),
    "No, I'd rather not, but I won't object if enough people want to"
  );
  assert.equal(choiceLabel('invite', 'hard_no'), "Hard no, I really don't want this");
  assert.equal(choiceLabel('invite', 'abstain'), 'I abstain from voting');
});

test('vote button opens a private ballot with all four choices', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  const poll = makePoll(db);
  const interaction = fakeInteraction({ guild: fakeGuild() });

  await handleVoteButton({ db }, interaction, [String(poll.id)]);
  const reply = interaction.replies[0];
  assert.equal(reply.flags, MessageFlags.Ephemeral);
  assert.match(reply.content, /\*\*Should we invite Ada to the server\?\*\*/, 'ballot says what is being voted on');
  assert.match(reply.content, /haven't voted yet/i);
  assert.deepEqual(reply.allowedMentions, { parse: [] }, 'user-supplied subject cannot ping');
  const ids = reply.components.flatMap((row) => row.components.map((b) => b.data.custom_id));
  assert.deepEqual(ids, [
    `ttdb:cast:${poll.id}:yes`,
    `ttdb:cast:${poll.id}:no`,
    `ttdb:cast:${poll.id}:hard_no`,
    `ttdb:cast:${poll.id}:abstain`,
  ]);
});

test('vote button shows your current vote to you only', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  const poll = makePoll(db);
  castVote(db, poll.id, 'u1', 'hard_no');
  const interaction = fakeInteraction({ guild: fakeGuild() });

  await handleVoteButton({ db }, interaction, [String(poll.id)]);
  assert.match(interaction.replies[0].content, /Hard no, I really don't want this/);
});

test('vote button on a closed poll says so', async (t) => {
  const db = tempDb(t);
  const poll = makePoll(db);
  closePoll(db, poll.id, 'failed');
  const interaction = fakeInteraction({ guild: fakeGuild() });

  await handleVoteButton({ db }, interaction, [String(poll.id)]);
  assert.match(interaction.replies[0].content, /closed/i);
});

test('casting records the vote, deletes the ballot panel, and refreshes public counts', async (t) => {
  clearBallotTracking();
  clearEligibilityCache();
  clearRefreshThrottle();
  const db = tempDb(t);
  const poll = makePoll(db);
  const guild = fakeGuild(3);
  const interaction = fakeInteraction({ guild });

  await handleCastButton({ db, schedule: () => {} }, interaction, [String(poll.id), 'yes']);
  assert.equal(getVote(db, poll.id, 'u1'), 'yes');
  assert.equal(interaction.deletedReplies, 1, 'ballot dismissed once the vote is cast');
  assert.equal(interaction.updates.length, 0, 'no ballot re-render');
  assert.equal(guild.message.edits.length, 1, 'public counts refreshed');
});

test('when the last eligible voter casts, the early-close hook fires', async (t) => {
  clearEligibilityCache();
  clearRefreshThrottle();
  const db = tempDb(t);
  const poll = makePoll(db);
  const guild = fakeGuild(2);
  castVote(db, poll.id, 'u2', 'no');
  const closed = [];
  const ctx = { db, closeDuePoll: async (p) => closed.push(p.id) };

  await handleCastButton(ctx, fakeInteraction({ guild }), [String(poll.id), 'abstain']);
  assert.deepEqual(closed, [poll.id]);
});

test('open ballots are deleted when asked, then tracking is cleared', async (t) => {
  clearBallotTracking();
  clearEligibilityCache();
  clearRefreshThrottle();
  const db = tempDb(t);
  const poll = makePoll(db);
  const ballot = fakeInteraction({ guild: fakeGuild() });
  await handleVoteButton({ db, now: () => 1_000, schedule: () => {} }, ballot, [String(poll.id)]);

  assert.equal(await deleteBallots(poll.id, 61_000), 1);
  assert.equal(ballot.deletedReplies, 1);
  assert.equal(await deleteBallots(poll.id, 61_000), 0, 'second pass finds nothing');
});

test('casting untracks the ballot; never-cast expired ones are left alone', async (t) => {
  clearBallotTracking();
  clearEligibilityCache();
  clearRefreshThrottle();
  const db = tempDb(t);
  const poll = makePoll(db);
  const guild = fakeGuild(3);

  const opened = fakeInteraction({ guild });
  await handleVoteButton({ db, now: () => 0, schedule: () => {} }, opened, [String(poll.id)]);
  const casted = fakeInteraction({ guild });
  await handleCastButton({ db, now: () => 60_000, schedule: () => {} }, casted, [String(poll.id), 'yes']);
  assert.equal(casted.deletedReplies, 1, 'the ballot message was deleted via the cast interaction');
  assert.equal(await deleteBallots(poll.id, 61_000), 0, 'the cast removed the tracking');

  const stale = fakeInteraction({ guild });
  const second = makePoll(db, { subject: 'Grace' });
  await handleVoteButton({ db, now: () => 0, schedule: () => {} }, stale, [String(second.id)]);
  assert.equal(await deleteBallots(second.id, 20 * 60_000), 0, 'fully expired ballots are left alone');
  assert.equal(stale.deletedReplies, 0);
});

test('an uncast ballot self-deletes after 14 minutes', async (t) => {
  clearBallotTracking();
  clearEligibilityCache();
  clearRefreshThrottle();
  const db = tempDb(t);
  const poll = makePoll(db);
  const scheduled = [];
  const ctx = {
    db,
    now: () => 0,
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
    },
  };
  const ballot = fakeInteraction({ guild: fakeGuild() });
  await handleVoteButton(ctx, ballot, [String(poll.id)]);

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 14 * 60_000);
  await scheduled[0].fn();
  assert.equal(ballot.deletedReplies, 1);
  assert.equal(await deleteBallots(poll.id, 1_000), 0, 'the timer removed the tracking too');
});

test('casting does not close early while eligible voters remain, and bots never block the close', async (t) => {
  clearBallotTracking();
  clearEligibilityCache();
  clearRefreshThrottle();
  const db = tempDb(t);
  const closed = [];
  const ctx = { db, closeDuePoll: async (p) => closed.push(p.id), schedule: () => {} };

  const pollA = makePoll(db);
  await handleCastButton(ctx, fakeInteraction({ guild: fakeGuild(3) }), [String(pollA.id), 'yes']);
  assert.deepEqual(closed, [], 'one of three voting must not close the poll');

  clearEligibilityCache(db); // also drop the persisted snapshot for this guild
  const pollB = makePoll(db, { subject: 'Grace' });
  const message = { edits: [], edit: async (p) => message.edits.push(p) };
  const channel = { id: 'chan-poll', messages: { fetch: async () => message } };
  const guildWithBot = {
    id: 'g1',
    channels: { fetch: async () => channel },
    members: {
      fetch: async () =>
        new Map([
          ['u1', { user: { bot: false } }],
          ['u2', { user: { bot: false } }],
          ['bot1', { user: { bot: true } }],
        ]),
    },
  };
  castVote(db, pollB.id, 'u2', 'no');
  await handleCastButton({ ...ctx }, fakeInteraction({ guild: guildWithBot }), [String(pollB.id), 'abstain']);
  assert.deepEqual(closed, [pollB.id], 'the unvoted bot must not block the everyone-voted close');
});

test('members without the poll-starter role can still vote', async (t) => {
  clearBallotTracking();
  clearEligibilityCache();
  clearRefreshThrottle();
  const db = tempDb(t);
  setConfig(db, 'g1', {
    poll_channel_id: 'chan-poll',
    hard_no_weight: 'veto',
    threshold_type: 'count',
    threshold_value: 2,
    permanent_category_id: 'cat-1',
    poll_starter_role_id: 'role-1',
  });
  const poll = makePoll(db);
  const interaction = fakeInteraction({ guild: fakeGuild() });
  interaction.member = { roles: { cache: { has: () => false } } };

  await handleVoteButton({ db, schedule: () => {} }, interaction, [String(poll.id)]);
  assert.equal(interaction.replies.length, 1, 'ballot opens for non-role members');

  await handleCastButton({ db, schedule: () => {} }, interaction, [String(poll.id), 'yes']);
  assert.equal(getVote(db, poll.id, 'u1'), 'yes', 'voting is open to everyone');
});

test('a vote or cast forged from another guild records nothing', async (t) => {
  clearBallotTracking();
  clearEligibilityCache();
  clearRefreshThrottle();
  const db = tempDb(t);
  const poll = makePoll(db); // guild g1
  const closed = [];
  const ctx = { db, closeDuePoll: async (p) => closed.push(p.id), schedule: () => {} };

  const foreign = fakeInteraction({ guild: fakeGuild() });
  foreign.guildId = 'g2';
  await handleVoteButton(ctx, foreign, [String(poll.id)]);
  assert.match(foreign.replies[0].content, /closed|not available/i, 'no ballot for foreign guilds');

  await handleCastButton(ctx, foreign, [String(poll.id), 'yes']);
  assert.equal(getVote(db, poll.id, 'u1'), undefined, 'forged cast records no vote');
  assert.deepEqual(closed, []);
});

function privateWorld(db, viewerIds, memberCount = 3) {
  const poll = createPoll(db, {
    guildId: 'g1',
    type: 'permanent_channel',
    subject: 'chan-priv',
    initiatorId: 'u9',
    channelId: 'chan-priv',
    closesAt: 9_000_000_000,
    isPrivate: true,
  });
  setMessageId(db, poll.id, 'msg-1');
  const members = new Map(
    Array.from({ length: memberCount }, (_, i) => [`u${i + 1}`, { id: `u${i + 1}`, user: { bot: false } }])
  );
  const message = { edits: [], edit: async (p) => message.edits.push(p) };
  const channel = {
    id: 'chan-priv',
    permissionsFor: (who) => ({ has: () => viewerIds.includes(who?.id) }),
    messages: { fetch: async () => message },
  };
  const guild = {
    id: 'g1',
    channels: { fetch: async () => channel },
    members: { cache: members, fetch: async () => members },
  };
  return { poll, guild };
}

test('a private poll closes early once every channel viewer has voted', async (t) => {
  clearBallotTracking();
  clearEligibilityCache();
  clearRefreshThrottle();
  const db = tempDb(t);
  const { poll, guild } = privateWorld(db, ['u1', 'u2']); // 2 viewers of 3 members
  castVote(db, poll.id, 'u2', 'no');
  const closed = [];
  const ctx = { db, closeDuePoll: async (p) => closed.push(p.id), schedule: () => {} };

  const voter = fakeInteraction({ guild, userId: 'u1' });
  voter.member = { id: 'u1', roles: { cache: { has: () => true } } };
  await handleCastButton(ctx, voter, [String(poll.id), 'yes']);
  assert.deepEqual(closed, [poll.id], 'all viewers voted; the third member cannot see the poll');
});

test('non-viewers cannot open or cast a ballot on a private poll', async (t) => {
  clearBallotTracking();
  clearEligibilityCache();
  clearRefreshThrottle();
  const db = tempDb(t);
  const { poll, guild } = privateWorld(db, ['u1']); // u2 cannot see the channel
  const outsider = fakeInteraction({ guild, userId: 'u2' });
  outsider.member = { id: 'u2', roles: { cache: { has: () => true } } };

  await handleVoteButton({ db, schedule: () => {} }, outsider, [String(poll.id)]);
  assert.match(outsider.replies[0].content, /closed/i);
  assert.equal(outsider.replies[0].components ?? undefined, undefined, 'no ballot options offered');

  await handleCastButton({ db, schedule: () => {} }, outsider, [String(poll.id), 'yes']);
  assert.equal(getVote(db, poll.id, 'u2'), undefined, 'forged cast records nothing');
});

test('casting on a closed poll is refused and records nothing', async (t) => {
  const db = tempDb(t);
  const poll = makePoll(db);
  closePoll(db, poll.id, 'failed');
  const interaction = fakeInteraction({ guild: fakeGuild() });

  await handleCastButton({ db }, interaction, [String(poll.id), 'yes']);
  assert.equal(getVote(db, poll.id, 'u1'), undefined);
  assert.match(interaction.updates[0].content, /closed/i);
});

test("the initiator's ballot carries a withdraw button; other voters' do not", async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  const poll = makePoll(db); // initiator u9
  const initiator = fakeInteraction({ guild: fakeGuild(), userId: 'u9' });
  await handleVoteButton({ db }, initiator, [String(poll.id)]);
  const ids = initiator.replies[0].components.flatMap((row) => row.components.map((b) => b.data.custom_id));
  assert.ok(ids.includes(`ttdb:withdraw:${poll.id}`), 'the initiator sees the withdraw button');
  assert.equal(ids.length, 5, 'four choices plus withdraw');

  const voter = fakeInteraction({ guild: fakeGuild(), userId: 'u1' });
  await handleVoteButton({ db }, voter, [String(poll.id)]);
  const voterIds = voter.replies[0].components.flatMap((row) => row.components.map((b) => b.data.custom_id));
  assert.ok(!voterIds.some((id) => id.startsWith('ttdb:withdraw')), 'ordinary voters do not');
});

test('deletion polls for non-permanent channels offer no Hard no; permanent-category ones do', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  setConfig(db, 'g1', { permanent_category_id: 'cat-1' });
  const guild = fakeGuild();
  const subjects = {
    'chan-free': { id: 'chan-free', parentId: null },
    'chan-perm': { id: 'chan-perm', parentId: 'cat-1' },
  };
  const orig = guild.channels.fetch;
  guild.channels.fetch = async (id) => subjects[id] ?? orig(id);

  const freePoll = makePoll(db, { type: 'delete_channel', subject: 'chan-free' });
  const freeBallot = fakeInteraction({ guild });
  await handleVoteButton({ db }, freeBallot, [String(freePoll.id)]);
  const freeIds = freeBallot.replies[0].components.flatMap((row) => row.components.map((b) => b.data.custom_id));
  assert.ok(!freeIds.includes(`ttdb:cast:${freePoll.id}:hard_no`), 'no Hard no outside the permanent categories');
  assert.ok(freeIds.includes(`ttdb:cast:${freePoll.id}:no`), 'the other choices remain');

  const permPoll = makePoll(db, { type: 'delete_channel', subject: 'chan-perm' });
  const permBallot = fakeInteraction({ guild });
  await handleVoteButton({ db }, permBallot, [String(permPoll.id)]);
  const permIds = permBallot.replies[0].components.flatMap((row) => row.components.map((b) => b.data.custom_id));
  assert.ok(permIds.includes(`ttdb:cast:${permPoll.id}:hard_no`), 'permanent-category deletions keep Hard no');
});

test('a forged Hard no cast on a non-permanent deletion poll is refused', async (t) => {
  clearEligibilityCache();
  clearRefreshThrottle();
  const db = tempDb(t);
  const guild = fakeGuild();
  const orig = guild.channels.fetch;
  guild.channels.fetch = async (id) => (id === 'chan-free' ? { id, parentId: null } : orig(id));
  const poll = makePoll(db, { type: 'delete_channel', subject: 'chan-free' });

  const interaction = fakeInteraction({ guild });
  await handleCastButton({ db }, interaction, [String(poll.id), 'hard_no']);
  assert.equal(getVote(db, poll.id, 'u1'), undefined, 'no vote recorded');
  assert.match(interaction.updates[0].content, /not available/i);

  await handleCastButton({ db }, interaction, [String(poll.id), 'no']);
  assert.equal(getVote(db, poll.id, 'u1'), 'no', 'ordinary choices still cast');
});
