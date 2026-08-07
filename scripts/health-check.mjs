#!/usr/bin/env node
// Health check: verifies that DISCORD_TOKEN works and that the required
// gateway intents (Guilds + GuildMembers) are enabled for the app. Output is
// REDACTED -- the token is never printed or written to the log.
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { loadEnv } from '../src/env.js';
import { makeScriptLog } from './script-log.mjs';

const { say, finish, scrub, setSecret } = makeScriptLog('health-check');

const withTimeout = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s ${what}`)), ms).unref();
    }),
  ]);

const HINTS = [
  [
    'disallowed intents',
    'Enable SERVER MEMBERS INTENT: Developer Portal -> your app -> Bot -> Privileged Gateway Intents.',
  ],
  [
    'invalid token',
    'The token was rejected. Developer Portal -> your app -> Bot -> Reset Token, then update DISCORD_TOKEN.',
  ],
  [
    'missing required environment',
    'Set DISCORD_TOKEN and DISCORD_APP_ID first -- see the "Development" section of README.md.',
  ],
];

try {
  const env = loadEnv();
  setSecret(env.token);

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });
  const ready = new Promise((resolve) => client.once(Events.ClientReady, resolve));
  await withTimeout(client.login(env.token).then(() => ready), 30_000, 'connecting to Discord');

  say('OK: logged in, and the required gateway intents are enabled.');
  say(`Bot user: ${client.user.tag} (id ${client.user.id})`);
  if (client.application?.id && client.application.id !== env.appId) {
    say(
      `WARNING: DISCORD_APP_ID (${env.appId}) does not match the logged-in ` +
        `application (${client.application.id}). Check you copied the right ID.`
    );
  } else {
    say(`Application ID: ${env.appId}`);
  }

  const guilds = [...client.guilds.cache.values()];
  if (guilds.length === 0) {
    say('Guilds: none yet -- run `npm run invite-url` and authorize the bot into your server.');
  } else {
    say(`Guilds (${guilds.length}):`);
    for (const guild of guilds) say(`  - ${guild.name} (id ${guild.id})`);
  }

  await client.destroy();
  finish(0);
} catch (err) {
  const msg = scrub(err?.message ?? err);
  say(`FAIL: ${msg}`);
  const hint = HINTS.find(([needle]) => msg.toLowerCase().includes(needle));
  if (hint) say(`HINT: ${hint[1]}`);
  finish(1);
}
