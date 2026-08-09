// /ttdb-scan-channels: the one-time switch that turns channel protection
// on for a guild — and the manual re-scan afterwards. Nothing is scanned
// or locked before this runs, so admins can configure exemptions
// (other-permanent-groups) on a fresh server first. The scan can take a
// while (audit-log pages + permission edits), so the reply is deferred.
import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { getConfig, setConfig } from '../store/guildConfig.js';
import { registryActive, scanGuildChannels } from './channelRegistry.js';

export const scanCommandDefinition = new SlashCommandBuilder()
  .setName('ttdb-scan-channels')
  .setDescription('Scan and lock existing channels — activates channel protection (Manage Server only)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .toJSON();

export async function handleScanChannelsCommand(ctx, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const now = ctx.now?.() ?? Date.now();
  const wasActive = registryActive(getConfig(ctx.db, interaction.guildId));
  if (!wasActive) {
    setConfig(ctx.db, interaction.guildId, { registry_activated_at: now });
    console.log(`[ttdb] channel protection activated for guild ${interaction.guildId} by user ${interaction.user.id}`);
  }
  const { recorded, unknown } = await scanGuildChannels(ctx, interaction.guild, now);

  const lines = [
    wasActive
      ? `✅ Re-scan complete — recorded and locked ${recorded} new channel(s).`
      : `✅ Channel protection is now **active** — recorded and locked ${recorded} channel(s).`,
  ];
  if (unknown > 0) {
    lines.push(
      `${unknown} of them have an **unknown creator** (older than the audit log keeps) and are locked to administrators — assign owners with \`/ttdb-set-creator\`.`
    );
  }
  if (!wasActive) {
    lines.push(
      'From here on, new channels are recorded and locked as they are created, and permissions are re-checked daily.'
    );
  }
  return interaction.editReply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
}
