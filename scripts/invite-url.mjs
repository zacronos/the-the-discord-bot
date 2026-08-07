#!/usr/bin/env node
// Prints the OAuth2 install URL for the bot. Needs DISCORD_APP_ID only --
// no secrets are read or printed.
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { loadEnv } from '../src/env.js';

const { appId } = loadEnv({ required: ['DISCORD_APP_ID'] });

// Everything the bot needs across all features:
// - poll channel: view / send / embeds / history / mention @everyone
// - invite polls: create instant invite
// - permanence polls: manage channels + manage roles (move a channel into a
//   category and sync its permission overwrites)
const permissions = PermissionsBitField.resolve([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.CreateInstantInvite,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
]);

const url =
  'https://discord.com/oauth2/authorize' +
  `?client_id=${appId}` +
  '&scope=bot%20applications.commands' +
  `&permissions=${permissions}`;

console.log('Open this URL in a browser, pick your server, and press Authorize:');
console.log(url);
