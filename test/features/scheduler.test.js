import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSweep } from '../../src/features/scheduler.js';
import { setConfig } from '../../src/store/guildConfig.js';
import { createPoll, getPoll, setMessageId } from '../../src/store/polls.js';
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
  const guild = {
    id: 'g1',
    channels: { fetch: async () => channel },
    members: { fetch: async () => new Map([['u1', { user: { bot: false } }]]) },
  };
  const client = {
    guilds: { fetch: async () => guild },
    users: { fetch: async () => ({ send: async () => {} }) },
  };
  return { db, edits, ctx: { db, client, sleep: async () => {}, closed: [], aborted: [] } };
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
