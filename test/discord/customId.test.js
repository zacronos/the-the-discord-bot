import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildId, parseId } from '../../src/discord/customId.js';

test('buildId joins parts under the ttdb prefix', () => {
  assert.equal(buildId('start', 'invite'), 'ttdb:start:invite');
  assert.equal(buildId('cast', 12, 'hard_no'), 'ttdb:cast:12:hard_no');
});

test('buildId rejects ids over the 100-char Discord limit', () => {
  assert.throws(() => buildId('x'.repeat(101)), /100/);
});

test('parseId returns the parts for ttdb ids and null for foreign ids', () => {
  assert.deepEqual(parseId('ttdb:vote:7'), ['vote', '7']);
  assert.equal(parseId('otherbot:vote:7'), null);
  assert.equal(parseId(undefined), null);
});
