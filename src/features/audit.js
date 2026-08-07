// Startup permission audit: one readable problem list per configured guild,
// logged so a self-hoster can spot broken permissions before members do.
import { PermissionFlagsBits } from 'discord.js';
import { getConfig } from '../store/guildConfig.js';

const CHECKS = [
  {
    field: 'poll_channel_id',
    label: 'poll channel',
    perms: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.MentionEveryone,
      PermissionFlagsBits.ReadMessageHistory,
    ],
  },
  {
    field: 'invite_channel_id',
    label: 'invite channel',
    perms: [PermissionFlagsBits.CreateInstantInvite],
  },
  {
    field: 'permanent_category_id',
    label: 'permanent category',
    perms: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
  },
];

export async function auditGuildPermissions(ctx, guild) {
  const cfg = getConfig(ctx.db, guild.id);
  if (!cfg) return [];
  const problems = [];
  for (const check of CHECKS) {
    const id = cfg[check.field];
    if (!id) continue;
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (!channel) {
      problems.push(`${check.label} <#${id}> no longer exists`);
      continue;
    }
    const perms = channel.permissionsFor?.(guild.members.me);
    const missing = perms ? perms.missing(check.perms) : [];
    if (missing.length > 0) {
      problems.push(`${check.label} <#${id}>: missing ${missing.join(', ')}`);
    }
  }
  return problems;
}
