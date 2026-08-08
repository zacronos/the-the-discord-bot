// Keeps the bot's application profile in sync with its state:
// - description: setup instructions until a server is fully configured,
//   then a pointer to that server's poll channel (by #name — About Me does
//   not render <#id> mention tokens);
// - icon: pushed from assets/bot-icon-1024.png, tracked by content hash so
//   it is only re-uploaded when the file actually changes.
// Runs at startup and after every /ttdb-config change. Note: the profile is
// app-global while config is per-guild; with Public Bot off this bot serves
// one server, and the first fully-configured guild wins.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getAppState, setAppState } from '../store/appState.js';
import { getConfig } from '../store/guildConfig.js';
import { missingRequiredSettings } from './configCommands.js';

export const ICON_PATH = 'assets/bot-icon-1024.png';
const ICON_HASH_KEY = 'app_icon_hash';

export function buildProfileDescription(pollChannelName) {
  return pollChannelName == null
    ? 'admins: use /ttdb-config to set up The The Admin-Polling Bot'
    : `Go to the #${pollChannelName} channel to start a vote! (admins: use \`/ttdb-config\` to configure voting rules)`;
}

async function configuredPollChannelName(ctx) {
  for (const guild of ctx.client.guilds.cache.values()) {
    const cfg = getConfig(ctx.db, guild.id);
    if (!cfg || missingRequiredSettings(cfg).length > 0) continue;
    const channel = await guild.channels.fetch(cfg.poll_channel_id).catch(() => null);
    if (channel?.name) return channel.name;
  }
  return null;
}

export async function ensureProfile(ctx, { iconPath = ICON_PATH } = {}) {
  const app = ctx.client.application;
  if (!app) return false;
  try {
    await app.fetch?.(); // the ready payload only carries a partial application
  } catch {
    // fetch failure: fall back to whatever fields we have
  }

  const patch = {};
  const desired = buildProfileDescription(await configuredPollChannelName(ctx));
  if ((app.description ?? '') !== desired) patch.description = desired;

  let iconHash = null;
  try {
    const icon = await readFile(iconPath);
    iconHash = createHash('sha256').update(icon).digest('hex');
    if (getAppState(ctx.db, ICON_HASH_KEY) !== iconHash || !app.icon) {
      patch.icon = `data:image/png;base64,${icon.toString('base64')}`;
    }
  } catch {
    // icon file missing — description sync still proceeds
  }

  if (Object.keys(patch).length === 0) return false;
  await app.edit(patch);
  if (patch.icon && iconHash) setAppState(ctx.db, ICON_HASH_KEY, iconHash);
  return true;
}
