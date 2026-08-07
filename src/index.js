// Entry point: wires env, database, Discord client, and interaction routing.
import { Events } from 'discord.js';
import { loadEnv } from './env.js';
import { openDb } from './db.js';
import { createClient } from './discord/client.js';
import { createRouter } from './discord/interactionRouter.js';
import { handleConfigCommand } from './features/configCommands.js';
import { ensureInitMessage } from './features/initMessage.js';

const env = loadEnv();
const db = openDb(env.dbPath);
const client = createClient();

const ctx = { env, db, client };
ctx.ensureInitMessage = (guild) => ensureInitMessage(ctx, guild);

const router = createRouter(ctx);
router.command('ttdb-config', handleConfigCommand);

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
});

process.on('unhandledRejection', (err) => {
  console.error('[ttdb] unhandled rejection:', err);
});

await client.login(env.token);
