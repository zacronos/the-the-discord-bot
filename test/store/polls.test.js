import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimForClose,
  closePoll,
  createPoll,
  getPoll,
  listDue,
  listOpen,
  listOpenAll,
  releaseClose,
  setMessageId,
} from '../../src/store/polls.js';
import { tempDb } from './helpers.js';

const base = {
  guildId: 'g1',
  type: 'invite',
  subject: 'Ada Lovelace',
  initiatorId: 'user-1',
  channelId: 'chan-1',
  closesAt: 5000,
  createdAt: 1000,
};

test('createPoll stores an open poll and returns it with an id', (t) => {
  const db = tempDb(t);
  const poll = createPoll(db, base);

  assert.ok(Number.isInteger(poll.id) && poll.id > 0);
  assert.equal(poll.guild_id, 'g1');
  assert.equal(poll.type, 'invite');
  assert.equal(poll.subject, 'Ada Lovelace');
  assert.equal(poll.initiator_id, 'user-1');
  assert.equal(poll.channel_id, 'chan-1');
  assert.equal(poll.created_at, 1000);
  assert.equal(poll.closes_at, 5000);
  assert.equal(poll.status, 'open');
  assert.equal(poll.message_id, null);
});

test('createPoll rejects an unknown poll type', (t) => {
  const db = tempDb(t);
  assert.throws(() => createPoll(db, { ...base, type: 'coup' }), /Unknown poll type: coup/);
});

test('setMessageId attaches the Discord message id', (t) => {
  const db = tempDb(t);
  const poll = createPoll(db, base);
  setMessageId(db, poll.id, 'msg-42');
  assert.equal(getPoll(db, poll.id).message_id, 'msg-42');
});

test('listDue returns only open polls whose close time has passed', (t) => {
  const db = tempDb(t);
  const due = createPoll(db, { ...base, closesAt: 5000 });
  createPoll(db, { ...base, closesAt: 9000 }); // future
  const closed = createPoll(db, { ...base, closesAt: 4000 });
  closePoll(db, closed.id, 'failed');

  const ids = listDue(db, 5000).map((p) => p.id);
  assert.deepEqual(ids, [due.id]);
});

test('listOpen returns open polls for that guild only', (t) => {
  const db = tempDb(t);
  const mine = createPoll(db, base);
  createPoll(db, { ...base, guildId: 'g2' });
  const closed = createPoll(db, base);
  closePoll(db, closed.id, 'passed');

  const ids = listOpen(db, 'g1').map((p) => p.id);
  assert.deepEqual(ids, [mine.id]);
});

test('closePoll records status, veto count, and closed_at; re-closing is a no-op', (t) => {
  const db = tempDb(t);
  const poll = createPoll(db, base);

  assert.equal(closePoll(db, poll.id, 'vetoed', 2, 6000), true);
  const closed = getPoll(db, poll.id);
  assert.equal(closed.status, 'vetoed');
  assert.equal(closed.veto_count, 2);
  assert.equal(closed.closed_at, 6000);

  assert.equal(closePoll(db, poll.id, 'passed', null, 7000), false, 'second close must not claim');
  assert.equal(getPoll(db, poll.id).status, 'vetoed', 'status unchanged by second close');
});

test('closePoll rejects a non-final status', (t) => {
  const db = tempDb(t);
  const poll = createPoll(db, base);
  assert.throws(() => closePoll(db, poll.id, 'open'), /Invalid poll close status: open/);
});

test('claimForClose claims an open poll exactly once', (t) => {
  const db = tempDb(t);
  const poll = createPoll(db, base);
  assert.equal(claimForClose(db, poll.id), true);
  assert.equal(getPoll(db, poll.id).status, 'closing');
  assert.equal(claimForClose(db, poll.id), false, 'second concurrent claim loses');
  assert.equal(closePoll(db, poll.id, 'passed'), true, 'claimed poll can still be finalized');
});

test('releaseClose reopens a claimed poll for a later retry', (t) => {
  const db = tempDb(t);
  const poll = createPoll(db, base);
  claimForClose(db, poll.id);
  assert.equal(releaseClose(db, poll.id), true);
  assert.equal(getPoll(db, poll.id).status, 'open');
  assert.equal(claimForClose(db, poll.id), true, 'claimable again');
  closePoll(db, poll.id, 'failed');
  assert.equal(releaseClose(db, poll.id), false, 'finalized polls are not reopened');
});

test('listOpenAll returns open polls across every guild', (t) => {
  const db = tempDb(t);
  const a = createPoll(db, base);
  const b = createPoll(db, { ...base, guildId: 'g2' });
  const closed = createPoll(db, base);
  closePoll(db, closed.id, 'failed');
  assert.deepEqual(listOpenAll(db).map((p) => p.id), [a.id, b.id]);
});
