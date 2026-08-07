import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearEligibilityCache, eligibleVoterCount } from '../../src/features/eligibility.js';

function fakeGuild(members, id = 'g1') {
  let fetches = 0;
  return {
    id,
    get fetches() {
      return fetches;
    },
    members: {
      fetch: async () => {
        fetches += 1;
        return new Map(members.map((m, i) => [String(i), m]));
      },
    },
  };
}

test('counts only non-bot members', async () => {
  clearEligibilityCache();
  const guild = fakeGuild([
    { user: { bot: false } },
    { user: { bot: true } },
    { user: { bot: false } },
  ]);
  assert.equal(await eligibleVoterCount(guild), 2);
});

test('caches the count per guild for the ttl window', async () => {
  clearEligibilityCache();
  const guild = fakeGuild([{ user: { bot: false } }]);
  await eligibleVoterCount(guild, { now: 1000 });
  await eligibleVoterCount(guild, { now: 30_000 });
  assert.equal(guild.fetches, 1, 'second call inside ttl uses the cache');
  await eligibleVoterCount(guild, { now: 70_000 });
  assert.equal(guild.fetches, 2, 'call after ttl refetches');
});
