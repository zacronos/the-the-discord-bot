#!/usr/bin/env node
// Prints the OAuth2 install URL for the bot. Needs DISCORD_APP_ID only --
// no secrets are read or printed.
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { loadEnv } from '../src/env.js';

const { appId } = loadEnv({ required: ['DISCORD_APP_ID'] });

// The bot requires server-wide Administrator. Private-channel polls only
// work if no channel overwrite can hide a channel from the bot, and
// Administrator is the one grant overwrites can't take away; it also
// subsumes everything else the features use (view / send / embeds /
// history / mention @everyone, create instant invite, manage channels +
// manage roles).
const permissions = PermissionsBitField.resolve(PermissionFlagsBits.Administrator);

const url =
  'https://discord.com/oauth2/authorize' +
  `?client_id=${appId}` +
  '&scope=bot%20applications.commands' +
  `&permissions=${permissions}`;

console.log('Open this URL in a browser, pick your server, and press Authorize:');
console.log(url);
