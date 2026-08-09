// /ttdb-deletions: admin visibility and an escape hatch for the 24-hour
// window between a passed deletion poll and its execution. Restricted to
// Manage Server, like /ttdb-config.
import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import {
  getScheduledDeletion,
  listScheduledDeletions,
  removeScheduledDeletion,
} from '../store/scheduledDeletions.js';

export const deletionsCommandDefinition = new SlashCommandBuilder()
  .setName('ttdb-deletions')
  .setDescription('See or cancel scheduled channel deletions (Manage Server only)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) => sub.setName('list').setDescription('List channels scheduled for deletion'))
  .addSubcommand((sub) =>
    sub
      .setName('cancel')
      .setDescription('Cancel a scheduled channel deletion')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('The channel whose scheduled deletion should be canceled')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice)
          .setRequired(true)
      )
  )
  .toJSON();

const replyEphemeral = (interaction, content) =>
  interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

const when = (deleteAt) => {
  const sec = Math.floor(deleteAt / 1000);
  return `<t:${sec}:F> (<t:${sec}:R>)`;
};

export async function handleDeletionsCommand(ctx, interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    const rows = listScheduledDeletions(ctx.db, interaction.guildId);
    if (rows.length === 0) {
      return replyEphemeral(interaction, 'There are no scheduled deletions on this server.');
    }
    const lines = rows.map(
      (row) =>
        `• <#${row.channel_id}> — deletes ${when(row.delete_at)}${row.poll_id ? ` — from poll #${row.poll_id}` : ''}`
    );
    return replyEphemeral(interaction, ['**Channels scheduled for deletion**', ...lines].join('\n'));
  }

  if (sub === 'cancel') {
    const channel = interaction.options.getChannel('channel', true);
    const row = getScheduledDeletion(ctx.db, channel.id);
    if (!row || row.guild_id !== interaction.guildId) {
      return replyEphemeral(interaction, `⚠️ There is no scheduled deletion for <#${channel.id}>.`);
    }
    removeScheduledDeletion(ctx.db, channel.id);
    console.log(
      `[ttdb] scheduled deletion of channel ${channel.id} canceled by user ${interaction.user.id}`
    );
    // The channel got a warning when the deletion was scheduled — it gets
    // the all-clear too, naming who canceled (rendered, never pinged).
    let announced = true;
    try {
      const target = await interaction.guild.channels.fetch(channel.id);
      await target.send({
        content: `🛑 The scheduled deletion of this channel has been **canceled** by <@${interaction.user.id}>.`,
        allowedMentions: { parse: [] },
      });
    } catch {
      announced = false;
    }
    return replyEphemeral(
      interaction,
      announced
        ? `✅ Canceled — <#${channel.id}> will not be deleted. A notice was posted in the channel.`
        : `✅ Canceled — <#${channel.id}> will not be deleted, but I couldn't post the notice there.`
    );
  }

  return replyEphemeral(interaction, `⚠️ Unknown subcommand: ${sub}.`);
}
