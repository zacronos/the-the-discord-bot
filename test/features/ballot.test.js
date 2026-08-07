import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { choiceLabel, handleCastButton, handleVoteButton } from '../../src/features/ballot.js';
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
  const replies = [];
  const updates = [];
  return {
    guildId: 'g1',
    guild,
    user: { id: userId },
    replies,
    updates,
    reply: async (p) => replies.push(p),
    update: async (p) => updates.push(p),
  };
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
  assert.match(reply.content, /haven't voted yet/i);
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

test('casting records the vote, updates the ballot, and refreshes public counts', async (t) => {
  clearEligibilityCache();
  clearRefreshThrottle();
  const db = tempDb(t);
  const poll = makePoll(db);
  const guild = fakeGuild(3);
  const interaction = fakeInteraction({ guild });

  await handleCastButton({ db }, interaction, [String(poll.id), 'yes']);
  assert.equal(getVote(db, poll.id, 'u1'), 'yes');
  assert.match(interaction.updates[0].content, /Yes!/);
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

test('casting on a closed poll is refused and records nothing', async (t) => {
  const db = tempDb(t);
  const poll = makePoll(db);
  closePoll(db, poll.id, 'failed');
  const interaction = fakeInteraction({ guild: fakeGuild() });

  await handleCastButton({ db }, interaction, [String(poll.id), 'yes']);
  assert.equal(getVote(db, poll.id, 'u1'), undefined);
  assert.match(interaction.updates[0].content, /closed/i);
});
