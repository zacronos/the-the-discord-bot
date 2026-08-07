import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../../src/discord/interactionRouter.js';

const baseInteraction = (over = {}) => ({
  isChatInputCommand: () => false,
  isButton: () => false,
  isAnySelectMenu: () => false,
  isModalSubmit: () => false,
  deferred: false,
  replied: false,
  replies: [],
  async reply(payload) {
    this.replies.push(payload);
  },
  async followUp(payload) {
    this.replies.push(payload);
  },
  ...over,
});

test('dispatches slash commands by name with the shared ctx', async () => {
  const calls = [];
  const router = createRouter({ tag: 'ctx' });
  router.command('ttdb-config', (ctx, interaction) => calls.push([ctx.tag, interaction.commandName]));

  await router.dispatch(baseInteraction({ isChatInputCommand: () => true, commandName: 'ttdb-config' }));
  assert.deepEqual(calls, [['ctx', 'ttdb-config']]);
});

test('dispatches buttons by customId action with trailing parts', async () => {
  const calls = [];
  const router = createRouter({});
  router.component('cast', (ctx, interaction, parts) => calls.push(parts));

  await router.dispatch(baseInteraction({ isButton: () => true, customId: 'ttdb:cast:12:yes' }));
  assert.deepEqual(calls, [['12', 'yes']]);
});

test('ignores components from other bots and unknown actions', async () => {
  const calls = [];
  const router = createRouter({});
  router.component('cast', (...args) => calls.push(args));

  await router.dispatch(baseInteraction({ isButton: () => true, customId: 'otherbot:cast:1' }));
  await router.dispatch(baseInteraction({ isButton: () => true, customId: 'ttdb:unknown:1' }));
  assert.equal(calls.length, 0);
});

test('dispatches modal submissions separately from components', async () => {
  const calls = [];
  const router = createRouter({});
  router.modal('create', (ctx, interaction, parts) => calls.push(['modal', ...parts]));
  router.component('create', () => calls.push(['component']));

  await router.dispatch(baseInteraction({ isModalSubmit: () => true, customId: 'ttdb:create:invite' }));
  assert.deepEqual(calls, [['modal', 'invite']]);
});

test('a throwing handler produces an ephemeral apology instead of crashing', async () => {
  const router = createRouter({});
  router.component('boom', () => {
    throw new Error('kaboom');
  });
  const interaction = baseInteraction({ isButton: () => true, customId: 'ttdb:boom' });

  await router.dispatch(interaction); // must not throw
  assert.equal(interaction.replies.length, 1);
  assert.match(interaction.replies[0].content, /went wrong/i);
});
