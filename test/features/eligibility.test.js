import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearEligibilityCache,
  eligibleVoterCount,
  fetchGuildMembers,
} from '../../src/features/eligibility.js';

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

test('caches the count per guild for a 10-minute ttl (gateway op8 is rate limited)', async () => {
  clearEligibilityCache();
  const guild = fakeGuild([{ user: { bot: false } }]);
  await eligibleVoterCount(guild, { now: 1_000 });
  await eligibleVoterCount(guild, { now: 540_000 });
  assert.equal(guild.fetches, 1, 'nine minutes in, still cached');
  await eligibleVoterCount(guild, { now: 601_500 });
  assert.equal(guild.fetches, 2, 'call after the ttl refetches');
});

test('fetchGuildMembers shares one gateway fetch between pruning and counting', async () => {
  clearEligibilityCache();
  const guild = fakeGuild([{ user: { bot: false } }, { user: { bot: true } }]);
  const members = await fetchGuildMembers(guild, { now: 1_000 });
  assert.equal(members.size, 2, 'the full member list is returned');
  assert.equal(await eligibleVoterCount(guild, { now: 2_000 }), 1);
  assert.equal(guild.fetches, 1, 'the count reuses the member fetch');
});
