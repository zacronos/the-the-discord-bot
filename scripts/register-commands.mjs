#!/usr/bin/env node
// Registers the bot's slash commands with Discord. Guild-scoped (available
// instantly) when TTDB_GUILD_ID is set; global (~1 h to propagate)
// otherwise. Re-run after any command definition change. Output is
// REDACTED -- the token is never printed or logged.
import { REST, Routes } from 'discord.js';
import { loadEnv } from '../src/env.js';
import { configCommandDefinition } from '../src/features/configCommands.js';
import { closeHttpAgent, makeScriptLog } from './script-log.mjs';

const { say, finish, scrub, setSecret } = makeScriptLog('register-commands');

const HINTS = [
  [
    'missing required environment',
    'Add DISCORD_TOKEN and DISCORD_APP_ID to the .env file -- see the "Development" section of README.md.',
  ],
  [
    'invalid token',
    'The token was rejected. Developer Portal -> your app -> Bot -> Reset Token, then update DISCORD_TOKEN.',
  ],
  [
    'missing access',
    'The bot is not in the TTDB_GUILD_ID server. Invite it first: `npm run invite-url`.',
  ],
  [
    'unknown application',
    'DISCORD_APP_ID does not match an application. Re-copy it from General Information.',
  ],
];

const COMMANDS = [configCommandDefinition];

try {
  const env = loadEnv();
  setSecret(env.token);

  const rest = new REST().setToken(env.token);
  let route;
  let scopeNote;
  if (env.guildId) {
    route = Routes.applicationGuildCommands(env.appId, env.guildId);
    scopeNote = `guild ${env.guildId} (available immediately)`;
  } else {
    route = Routes.applicationCommands(env.appId);
    scopeNote = 'global (may take up to an hour to appear)';
  }
  const result = await rest.put(route, { body: COMMANDS });

  say(`OK: registered ${result.length} command(s) -- scope: ${scopeNote}`);
  for (const command of result) say(`  - /${command.name}`);
  if (env.guildId) {
    // A guild-scoped registration supersedes any earlier global one; clear
    // the global set so members don't see duplicate command entries.
    await rest.put(Routes.applicationCommands(env.appId), { body: [] });
    say('Cleared the global command set (guild-scoped registration wins).');
  }
  await closeHttpAgent();
  finish(0);
} catch (err) {
  const msg = scrub(err?.message ?? err);
  say(`FAIL: ${msg}`);
  const hint = HINTS.find(([needle]) => msg.toLowerCase().includes(needle));
  if (hint) say(`HINT: ${hint[1]}`);
  await closeHttpAgent();
  finish(1);
}
