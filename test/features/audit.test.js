import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditGuildPermissions } from '../../src/features/audit.js';
import { setConfig } from '../../src/store/guildConfig.js';
import { tempDb } from '../store/helpers.js';

function fakeGuild(channels) {
  return {
    id: 'g1',
    members: { me: { id: 'bot-user' } },
    channels: {
      fetch: async (id) => {
        const channel = channels[id];
        if (!channel) throw new Error('Unknown Channel');
        return channel;
      },
    },
  };
}

const channelWithMissing = (id, missing) => ({
  id,
  permissionsFor: () => ({ missing: () => missing }),
});

test('reports nothing for an unconfigured or fully-permitted guild', async (t) => {
  const db = tempDb(t);
  assert.deepEqual(await auditGuildPermissions({ db }, fakeGuild({})), []);

  setConfig(db, 'g1', { poll_channel_id: 'chan-1' });
  const guild = fakeGuild({ 'chan-1': channelWithMissing('chan-1', []) });
  assert.deepEqual(await auditGuildPermissions({ db }, guild), []);
});

test('reports missing permissions and vanished channels per configured target', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', {
    poll_channel_id: 'chan-1',
    invite_channel_id: 'chan-2',
    permanent_category_id: 'cat-gone',
  });
  const guild = fakeGuild({
    'chan-1': channelWithMissing('chan-1', ['MentionEveryone']),
    'chan-2': channelWithMissing('chan-2', []),
  });

  const problems = await auditGuildPermissions({ db }, guild);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /poll channel/);
  assert.match(problems[0], /MentionEveryone/);
  assert.match(problems[1], /permanent category/);
  assert.match(problems[1], /no longer exists/);
});
