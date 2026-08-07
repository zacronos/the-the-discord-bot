// Entry point: wires env, database, Discord client, and interaction routing.
import { Events } from 'discord.js';
import { loadEnv } from './env.js';
import { openDb } from './db.js';
import { createClient } from './discord/client.js';
import { createRouter } from './discord/interactionRouter.js';
import { handleCastButton, handleVoteButton } from './features/ballot.js';
import { handleConfigCommand } from './features/configCommands.js';
import { ensureInitMessage } from './features/initMessage.js';
import { closePollPipeline, handleResendButton } from './features/pollClose.js';
import { handleCreateModal, handleStartButton } from './features/pollCreate.js';
import { startScheduler } from './features/scheduler.js';

const env = loadEnv();
const db = openDb(env.dbPath);
const client = createClient();

const ctx = { env, db, client, actions: {} };
ctx.ensureInitMessage = (guild) => ensureInitMessage(ctx, guild);
ctx.closeDuePoll = (poll) => closePollPipeline(ctx, poll);

const router = createRouter(ctx);
router.command('ttdb-config', handleConfigCommand);
router.component('start', handleStartButton);
router.component('vote', handleVoteButton);
router.component('cast', handleCastButton);
router.component('resend', handleResendButton);
router.modal('create', handleCreateModal);

client.on(Events.InteractionCreate, (interaction) => router.dispatch(interaction));

client.once(Events.ClientReady, async () => {
  console.log(`[ttdb] logged in as ${client.user.tag}; ${client.guilds.cache.size} guild(s)`);
  for (const guild of client.guilds.cache.values()) {
    try {
      await ctx.ensureInitMessage(guild);
    } catch (err) {
      console.error(`[ttdb] init message for guild ${guild.id}: ${err.message}`);
    }
  }
  startScheduler(ctx);
});

process.on('unhandledRejection', (err) => {
  console.error('[ttdb] unhandled rejection:', err);
});

await client.login(env.token);
