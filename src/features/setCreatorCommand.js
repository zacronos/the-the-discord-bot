// /ttdb-set-creator: hand a channel's creator privileges to another member.
// Visible to everyone — creators are ordinary members — so authorization
// happens here: the recorded creator, or anyone with Manage Server (which
// also covers fixing channels whose creator the audit log never revealed).
// Channels inside any permanent group are refused: their permissions belong
// to the category, not a creator.
import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { getKnownChannel, recordKnownChannel } from '../store/knownChannels.js';
import { getConfig } from '../store/guildConfig.js';
import { enforceCreatorOnlyDeletion } from './channelRegistry.js';
import { managedPermanentCategoryIds, otherPermanentCategoryIds } from './configCommands.js';
import { memberCanView } from './pollCreate.js';

export const setCreatorCommandDefinition = new SlashCommandBuilder()
  .setName('ttdb-set-creator')
  .setDescription("Hand a channel's creator privileges to another member (creator or Manage Server only)")
  .setContexts(InteractionContextType.Guild)
  .addChannelOption((opt) =>
    opt
      .setName('channel')
      .setDescription('The channel to hand over')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice)
      .setRequired(true)
  )
  .addUserOption((opt) =>
    opt.setName('member').setDescription('The member who becomes the creator').setRequired(true)
  )
  .toJSON();

const replyEphemeral = (interaction, content) =>
  interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

export async function handleSetCreatorCommand(ctx, interaction) {
  const cfg = getConfig(ctx.db, interaction.guildId);
  const channel = interaction.options.getChannel('channel', true);

  if (new Set(otherPermanentCategoryIds(cfg)).has(channel.parentId)) {
    return replyEphemeral(
      interaction,
      `⚠️ <#${channel.id}> is in a protected permanent group — the bot doesn't manage creators there.`
    );
  }
  if (managedPermanentCategoryIds(cfg).has(channel.parentId)) {
    return replyEphemeral(
      interaction,
      `⚠️ <#${channel.id}> is in one of the permanent categories — those channels belong to the community and have no creator privileges.`
    );
  }

  const row = getKnownChannel(ctx.db, channel.id);
  const isCreator = row?.creator_id != null && row.creator_id === interaction.user.id;
  const isManager = Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild));
  if (!isCreator && !isManager) {
    return replyEphemeral(
      interaction,
      "⚠️ Only the channel's creator or a member with Manage Server can hand over creator privileges."
    );
  }

  const target = interaction.options.getMember('member');
  if (!target) {
    return replyEphemeral(interaction, '⚠️ That user is not a member of this server.');
  }
  if (target.user?.bot) {
    return replyEphemeral(interaction, '⚠️ A bot cannot hold creator privileges.');
  }
  if (!memberCanView(channel, target)) {
    return replyEphemeral(
      interaction,
      '⚠️ You can only hand a channel to a member who can see it.'
    );
  }
  if (row?.creator_id === target.id) {
    return replyEphemeral(interaction, `<@${target.id}> is already recorded as the creator of <#${channel.id}>.`);
  }

  recordKnownChannel(ctx.db, {
    channelId: channel.id,
    guildId: interaction.guildId,
    creatorId: target.id,
    recordedAt: ctx.now?.() ?? Date.now(),
  });
  console.log(
    `[ttdb] creator of channel ${channel.id} set to ${target.id} by user ${interaction.user.id}`
  );

  // Re-running the lock enforcement grants the new creator and strips the
  // old one (whose grant is now just another foreign allow).
  let enforced = true;
  try {
    await enforceCreatorOnlyDeletion(interaction.guild, channel, target.id);
  } catch (err) {
    enforced = false;
    console.error(`[ttdb] creator handover for channel ${channel.id}: permission update failed:`, err);
  }
  return replyEphemeral(
    interaction,
    enforced
      ? `✅ <@${target.id}> now holds the creator privileges for <#${channel.id}> — only they (and administrators) can delete it.`
      : `✅ <@${target.id}> is now recorded as the creator of <#${channel.id}>, but updating the channel permissions failed — the daily check will retry, or an admin can fix them manually.`
  );
}
