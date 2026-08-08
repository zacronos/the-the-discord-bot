// Entry point: wires env, database, Discord client, and interaction routing.
import { Events } from 'discord.js';
import { loadEnv } from './env.js';
import { openDb } from './db.js';
import { createClient } from './discord/client.js';
import { createRouter } from './discord/interactionRouter.js';
import { handleCastButton, handleVoteButton } from './features/ballot.js';
import { handleConfigCommand } from './features/configCommands.js';
import { ensureInitMessage } from './features/initMessage.js';
import { deleteChannelAction } from './features/actions/deleteChannel.js';
import { inviteAction } from './features/actions/invite.js';
import { permanentChannelAction } from './features/actions/permanentChannel.js';
import { auditGuildPermissions } from './features/audit.js';
import { rehydrateEphemeralCleanups } from './features/ephemeralCleanup.js';
import { closePollPipeline, handleGuildLeave, handleResendButton } from './features/pollClose.js';
import { handleCreateModal, handleStartButton } from './features/pollCreate.js';
import { ensureProfile } from './features/profile.js';
import { startScheduler } from './features/scheduler.js';

const env = loadEnv();
const db = openDb(env.dbPath);
const client = createClient();

const ctx = {
  env,
  db,
  client,
  actions: {
    invite: inviteAction,
    permanent_channel: permanentChannelAction,
    delete_channel: deleteChannelAction,
  },
};
ctx.ensureInitMessage = (guild) => ensureInitMessage(ctx, guild);
ctx.closeDuePoll = (poll) => closePollPipeline(ctx, poll);
ctx.ensureProfile = () => ensureProfile(ctx);

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
    try {
      const problems = await auditGuildPermissions(ctx, guild);
      for (const problem of problems) {
        console.warn(`[ttdb] permission audit (${guild.name ?? guild.id}): ${problem}`);
      }
    } catch (err) {
      console.error(`[ttdb] permission audit for guild ${guild.id}: ${err.message}`);
    }
  }
  try {
    await ctx.ensureProfile();
  } catch (err) {
    console.error(`[ttdb] profile sync: ${err.message}`);
  }
  try {
    await rehydrateEphemeralCleanups(ctx);
  } catch (err) {
    console.error(`[ttdb] ephemeral cleanup rehydration: ${err.message}`);
  }
  startScheduler(ctx);
});

client.on(Events.GuildDelete, (guild) =>
  handleGuildLeave(ctx, guild).catch((err) => console.error('[ttdb] guild-leave cleanup:', err))
);

process.on('unhandledRejection', (err) => {
  console.error('[ttdb] unhandled rejection:', err);
});

await client.login(env.token);
