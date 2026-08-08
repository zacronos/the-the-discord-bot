import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSweep } from '../../src/features/scheduler.js';
import { setConfig } from '../../src/store/guildConfig.js';
import { createPoll, getPoll, setMessageId } from '../../src/store/polls.js';
import { listDueDeletions, scheduleDeletion } from '../../src/store/scheduledDeletions.js';
import { clearEligibilityCache } from '../../src/features/eligibility.js';
import { clearRefreshThrottle } from '../../src/features/pollMessage.js';
import { tempDb } from '../store/helpers.js';

function makeWorld(t, { messageMissing = false } = {}) {
  clearEligibilityCache();
  clearRefreshThrottle();
  const db = tempDb(t);
  setConfig(db, 'g1', {
    poll_channel_id: 'chan-poll',
    hard_no_weight: 'veto',
    threshold_type: 'count',
    threshold_value: 1,
    permanent_category_id: 'cat-1',
  });
  const edits = [];
  const message = { edit: async (p) => edits.push(p), delete: async () => {} };
  const channel = {
    id: 'chan-poll',
    send: async () => {},
    messages: {
      fetch: async () => {
        if (messageMissing) throw new Error('Unknown Message');
        return message;
      },
    },
  };
  const doomedChannel = {
    id: 'chan-doomed',
    deleted: false,
    delete: async () => {
      doomedChannel.deleted = true;
    },
  };
  const guild = {
    id: 'g1',
    channels: {
      fetch: async (id) => {
        if (id === 'chan-doomed') return doomedChannel;
        if (id === 'chan-gone') throw new Error('Unknown Channel');
        return channel;
      },
    },
    members: { fetch: async () => new Map([['u1', { user: { bot: false } }]]) },
  };
  const client = {
    guilds: { fetch: async () => guild },
    users: { fetch: async () => ({ send: async () => {} }) },
  };
  return { db, edits, doomedChannel, ctx: { db, client, sleep: async () => {}, closed: [], aborted: [] } };
}

const mkPoll = (db, over = {}) => {
  const poll = createPoll(db, {
    guildId: 'g1',
    type: 'invite',
    subject: 'Ada',
    initiatorId: 'u1',
    channelId: 'chan-poll',
    closesAt: 5_000,
    ...over,
  });
  setMessageId(db, poll.id, 'msg-1');
  return poll;
};

test('runSweep closes every due poll via the injected pipeline', async (t) => {
  const { db, ctx } = makeWorld(t);
  const due = mkPoll(db, { closesAt: 5_000 });
  const future = mkPoll(db, { closesAt: 99_000, subject: 'Grace' });
  ctx.closeDuePoll = async (poll) => ctx.closed.push(poll.id);

  await runSweep(ctx, 10_000);
  assert.deepEqual(ctx.closed, [due.id]);
  assert.equal(getPoll(db, future.id).status, 'open');
});

test('runSweep refreshes counts on healthy open polls', async (t) => {
  const { db, ctx, edits } = makeWorld(t);
  mkPoll(db, { closesAt: 99_000 });
  ctx.closeDuePoll = async () => {};

  await runSweep(ctx, 10_000);
  assert.equal(edits.length, 1);
});

test('runSweep aborts open polls whose message has vanished (4.4)', async (t) => {
  const { db, ctx } = makeWorld(t, { messageMissing: true });
  const poll = mkPoll(db, { closesAt: 99_000 });
  ctx.closeDuePoll = async () => {};

  await runSweep(ctx, 10_000);
  assert.equal(getPoll(db, poll.id).status, 'aborted');
});

test('runSweep deletes channels whose scheduled deletion has come due', async (t) => {
  const { db, ctx, doomedChannel } = makeWorld(t);
  ctx.closeDuePoll = async () => {};
  scheduleDeletion(db, { channelId: 'chan-doomed', guildId: 'g1', deleteAt: 9_000, pollId: 3 });
  scheduleDeletion(db, { channelId: 'chan-later', guildId: 'g1', deleteAt: 99_000 });

  await runSweep(ctx, 10_000);
  assert.equal(doomedChannel.deleted, true);
  assert.equal(listDueDeletions(db, 10_000).length, 0, 'executed row removed');
  assert.equal(listDueDeletions(db, 999_000).length, 1, 'future deletion untouched');
});

test('runSweep drops a scheduled deletion whose channel already vanished', async (t) => {
  const { db, ctx } = makeWorld(t);
  ctx.closeDuePoll = async () => {};
  scheduleDeletion(db, { channelId: 'chan-gone', guildId: 'g1', deleteAt: 9_000 });

  await runSweep(ctx, 10_000);
  assert.equal(listDueDeletions(db, 999_000).length, 0);
});
