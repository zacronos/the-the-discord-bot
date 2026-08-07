import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHOICES,
  castVote,
  countByChoice,
  countVoters,
  deleteVote,
  deleteVotes,
  getVote,
  listVoters,
  listVotersByChoice,
} from '../../src/store/votes.js';
import { tempDb } from './helpers.js';

test('CHOICES lists the four ballot options', () => {
  assert.deepEqual(CHOICES, ['yes', 'no', 'hard_no', 'abstain']);
});

test('castVote records a vote and getVote returns it', (t) => {
  const db = tempDb(t);
  castVote(db, 1, 'user-1', 'yes', 1000);
  assert.equal(getVote(db, 1, 'user-1'), 'yes');
  assert.equal(getVote(db, 1, 'user-2'), undefined, 'non-voter has no vote');
});

test('castVote replaces an existing vote — one vote per user per poll', (t) => {
  const db = tempDb(t);
  castVote(db, 1, 'user-1', 'yes', 1000);
  castVote(db, 1, 'user-1', 'hard_no', 2000);
  assert.equal(getVote(db, 1, 'user-1'), 'hard_no');
  assert.equal(countVoters(db, 1), 1);
});

test('castVote rejects an invalid choice', (t) => {
  const db = tempDb(t);
  assert.throws(() => castVote(db, 1, 'user-1', 'maybe'), /Invalid vote choice: maybe/);
});

test('countByChoice tallies each option, with zeros for unused options', (t) => {
  const db = tempDb(t);
  castVote(db, 1, 'user-1', 'yes');
  castVote(db, 1, 'user-2', 'yes');
  castVote(db, 1, 'user-3', 'no');
  castVote(db, 1, 'user-4', 'abstain');
  castVote(db, 2, 'user-5', 'hard_no'); // different poll, must not bleed in

  assert.deepEqual(countByChoice(db, 1), { yes: 2, no: 1, hard_no: 0, abstain: 1 });
});

test('countVoters counts distinct voters on one poll', (t) => {
  const db = tempDb(t);
  castVote(db, 1, 'user-1', 'yes');
  castVote(db, 1, 'user-2', 'no');
  castVote(db, 2, 'user-3', 'yes');
  assert.equal(countVoters(db, 1), 2);
});

test('deleteVotes removes all votes for a poll and reports how many', (t) => {
  const db = tempDb(t);
  castVote(db, 1, 'user-1', 'yes');
  castVote(db, 1, 'user-2', 'no');
  castVote(db, 2, 'user-3', 'yes');

  assert.equal(deleteVotes(db, 1), 2);
  assert.equal(countVoters(db, 1), 0);
  assert.equal(countVoters(db, 2), 1, 'other polls keep their votes');
});

test('listVoters and listVotersByChoice report who voted (for departure pruning and veto DMs)', (t) => {
  const db = tempDb(t);
  castVote(db, 1, 'u1', 'hard_no');
  castVote(db, 1, 'u2', 'yes');
  castVote(db, 1, 'u3', 'hard_no');
  castVote(db, 2, 'u4', 'hard_no');

  assert.deepEqual(listVoters(db, 1).sort(), ['u1', 'u2', 'u3']);
  assert.deepEqual(listVotersByChoice(db, 1, 'hard_no').sort(), ['u1', 'u3']);
});

test('deleteVote removes a single member vote', (t) => {
  const db = tempDb(t);
  castVote(db, 1, 'u1', 'yes');
  castVote(db, 1, 'u2', 'no');
  deleteVote(db, 1, 'u1');
  assert.equal(getVote(db, 1, 'u1'), undefined);
  assert.equal(getVote(db, 1, 'u2'), 'no');
});
