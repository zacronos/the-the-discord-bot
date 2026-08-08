import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearMemberCache, getMemberCache, setMemberCache } from '../../src/store/memberCache.js';
import { tempDb } from './helpers.js';

test('setMemberCache stores a snapshot that getMemberCache returns until it expires', (t) => {
  const db = tempDb(t);
  setMemberCache(db, 'g1', [['u1', false], ['bot1', true]], 1, 5_000);

  const hit = getMemberCache(db, 'g1', 4_999);
  assert.equal(hit.count, 1);
  assert.equal(hit.expiresAt, 5_000);
  assert.equal(hit.members.has('u1'), true);
  assert.equal(hit.members.get('bot1').user.bot, true);

  assert.equal(getMemberCache(db, 'g1', 5_000), null, 'expired at the timestamp');
  assert.equal(getMemberCache(db, 'g2', 0), null, 'unknown guild');
});

test('re-caching a guild replaces its snapshot; clearMemberCache wipes everything', (t) => {
  const db = tempDb(t);
  setMemberCache(db, 'g1', [['u1', false]], 1, 5_000);
  setMemberCache(db, 'g1', [['u1', false], ['u2', false]], 2, 9_000);
  assert.equal(getMemberCache(db, 'g1', 6_000).count, 2);

  clearMemberCache(db);
  assert.equal(getMemberCache(db, 'g1', 0), null);
});
