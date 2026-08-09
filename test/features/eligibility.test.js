import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  channelViewerCount,
  clearEligibilityCache,
  eligibleVoterCount,
  fetchGuildMembers,
  isPrivateChannel,
  pollPopulation,
} from '../../src/features/eligibility.js';
import { tempDb } from '../store/helpers.js';

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
        return new Map(members.map((m, i) => [`u${i}`, m]));
      },
    },
  };
}

test('counts only non-bot members', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  const guild = fakeGuild([
    { user: { bot: false } },
    { user: { bot: true } },
    { user: { bot: false } },
  ]);
  assert.equal(await eligibleVoterCount(db, guild), 2);
});

test('caches the count per guild for a 1-hour ttl (gateway op8 is rate limited)', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  const guild = fakeGuild([{ user: { bot: false } }]);
  await eligibleVoterCount(db, guild, { now: 1_000 });
  await eligibleVoterCount(db, guild, { now: 3_540_000 });
  assert.equal(guild.fetches, 1, '59 minutes in, still cached');
  await eligibleVoterCount(db, guild, { now: 3_601_001 });
  assert.equal(guild.fetches, 2, 'a call after the expiration timestamp refetches');
});

test('the member cache survives restarts via sqlite', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  const guild = fakeGuild([{ user: { bot: false } }, { user: { bot: true } }]);
  await eligibleVoterCount(db, guild, { now: 1_000 });
  assert.equal(guild.fetches, 1);

  clearEligibilityCache(); // simulate a restart: memory gone, sqlite remains
  assert.equal(await eligibleVoterCount(db, guild, { now: 2_000 }), 1);
  assert.equal(guild.fetches, 1, 'restored from sqlite without a gateway fetch');

  clearEligibilityCache();
  await eligibleVoterCount(db, guild, { now: 1_000 + 3_600_000 + 1 });
  assert.equal(guild.fetches, 2, 'the stored expiration timestamp is honored');
});

test('a restored cache still answers membership checks for pruning', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  const guild = fakeGuild([{ user: { bot: false } }, { user: { bot: true } }]);
  await fetchGuildMembers(db, guild, { now: 1_000 });

  clearEligibilityCache();
  const restored = await fetchGuildMembers(db, guild, { now: 2_000 });
  assert.equal(guild.fetches, 1);
  assert.equal(restored.has('u0'), true);
  assert.equal(restored.has('stranger'), false);
  assert.equal(restored.get('u1').user.bot, true, 'bot flags survive the round-trip');
});

test('fetchGuildMembers shares one gateway fetch between pruning and counting', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  const guild = fakeGuild([{ user: { bot: false } }, { user: { bot: true } }]);
  const members = await fetchGuildMembers(db, guild, { now: 1_000 });
  assert.equal(members.size, 2, 'the full member list is returned');
  assert.equal(await eligibleVoterCount(db, guild, { now: 2_000 }), 1);
  assert.equal(guild.fetches, 1, 'the count reuses the member fetch');
});

test('isPrivateChannel keys off the everyone role; channels without overwrites are public', () => {
  const guild = { roles: { everyone: { id: 'role-everyone' } } };
  const privateChannel = { permissionsFor: (who) => ({ has: () => who?.id !== 'role-everyone' }) };
  const publicChannel = { permissionsFor: () => ({ has: () => true }) };
  assert.equal(isPrivateChannel(guild, privateChannel), true);
  assert.equal(isPrivateChannel(guild, publicChannel), false);
  assert.equal(isPrivateChannel(guild, { id: 'no-perms-fn' }), false, 'fail-public without the method');
});

test('channelViewerCount counts non-bot members who can view, from cache or a fresh fetch', async () => {
  const members = new Map([
    ['u1', { id: 'u1', user: { bot: false } }],
    ['u2', { id: 'u2', user: { bot: false } }],
    ['u3', { id: 'u3', user: { bot: false } }],
    ['bot1', { id: 'bot1', user: { bot: true } }],
  ]);
  const channel = { permissionsFor: (m) => ({ has: () => m.id !== 'u3' }) }; // u3 cannot see it
  const cached = { members: { cache: members, fetch: async () => members } };
  assert.equal(await channelViewerCount(cached, channel), 2);

  let fetched = 0;
  const empty = {
    members: {
      cache: new Map(),
      fetch: async () => {
        fetched += 1;
        return members;
      },
    },
  };
  assert.equal(await channelViewerCount(empty, channel), 2);
  assert.equal(fetched, 1, 'an empty cache falls back to a real fetch');
});

test('pollPopulation uses the guild for public polls and channel viewers for private ones', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  const members = new Map([
    ['u1', { id: 'u1', user: { bot: false } }],
    ['u2', { id: 'u2', user: { bot: false } }],
  ]);
  const privateChannel = { permissionsFor: (m) => ({ has: () => m.id === 'u1' }) };
  const guild = {
    id: 'g1',
    members: { cache: members, fetch: async () => members },
    channels: {
      fetch: async (id) => {
        if (id === 'chan-priv') return privateChannel;
        throw new Error('Unknown Channel');
      },
    },
  };

  assert.equal(await pollPopulation(db, guild, { is_private: 0 }), 2);
  assert.equal(await pollPopulation(db, guild, { is_private: 1, subject: 'chan-priv' }), 1);
  assert.equal(
    await pollPopulation(db, guild, { is_private: 1, subject: 'chan-gone' }),
    null,
    'a vanished private channel yields no population'
  );
});

test('clearEligibilityCache with a db also clears the persisted snapshot', async (t) => {
  clearEligibilityCache();
  const db = tempDb(t);
  const guild = fakeGuild([{ user: { bot: false } }]);
  await eligibleVoterCount(db, guild, { now: 1_000 });

  clearEligibilityCache(db);
  await eligibleVoterCount(db, guild, { now: 2_000 });
  assert.equal(guild.fetches, 2, 'a full clear forces a real refetch');
});
