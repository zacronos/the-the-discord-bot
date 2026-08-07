// /ttdb-config: per-server settings, restricted to members with Manage
// Server. Handlers take (ctx, interaction) where ctx = { db,
// ensureInitMessage? }; ensureInitMessage (wired in Phase 2.3) runs after
// any change that leaves the four required settings complete (Q8).
import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { getConfig, setConfig } from '../store/guildConfig.js';

export const HARD_NO_WEIGHTS = ['-2', '-3', '-5', '-10', 'veto'];

// Bot permissions checked when a channel/category is configured.
const POLL_CHANNEL_PERMS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.ReadMessageHistory,
];
const CATEGORY_PERMS = [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles];
const INVITE_PERMS = [PermissionFlagsBits.CreateInstantInvite];

export const configCommandDefinition = new SlashCommandBuilder()
  .setName('ttdb-config')
  .setDescription('Configure The The Bot for this server (Manage Server only)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName('poll-channel')
      .setDescription('Set the channel where polls are posted (required)')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Text channel for polls')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('hard-no-weight')
      .setDescription('How strongly a "Hard no" vote counts against a poll (required)')
      .addStringOption((opt) =>
        opt
          .setName('weight')
          .setDescription('Vote weight of a "Hard no"')
          .setRequired(true)
          .addChoices(
            { name: '-2', value: '-2' },
            { name: '-3', value: '-3' },
            { name: '-5', value: '-5' },
            { name: '-10', value: '-10' },
            { name: 'veto — a single hard no fails the poll', value: 'veto' }
          )
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('pass-threshold')
      .setDescription('Vote total a poll needs to pass (required)')
      .addNumberOption((opt) =>
        opt
          .setName('value')
          .setDescription('The number — a vote total, or a percent')
          .setMinValue(0)
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('unit')
          .setDescription('How to interpret the value')
          .setRequired(true)
          .addChoices(
            { name: 'votes — literal vote total', value: 'votes' },
            { name: 'percent — of current (non-bot) members', value: 'percent' }
          )
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('permanent-category')
      .setDescription('Category that channels voted permanent move into (required)')
      .addChannelOption((opt) =>
        opt
          .setName('category')
          .setDescription('The category')
          .addChannelTypes(ChannelType.GuildCategory)
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('invite-channel')
      .setDescription('Where invite links from passed polls land (optional)')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Text channel invitees land in; unset = system channel')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('poll-starter-role')
      .setDescription('Restrict who may start polls (optional)')
      .addRoleOption((opt) =>
        opt
          .setName('role')
          .setDescription('Only members with this role can start polls')
          .setRequired(true)
      )
  )
  .addSubcommand((sub) => sub.setName('show').setDescription('Show current settings'))
  .toJSON();

// Required-config gate (Q8). Returns the /ttdb-config subcommand names still
// unset; empty array means polls may start.
export function missingRequiredSettings(cfg) {
  const missing = [];
  if (!cfg?.poll_channel_id) missing.push('poll-channel');
  if (!cfg?.hard_no_weight) missing.push('hard-no-weight');
  if (cfg?.threshold_type == null || cfg?.threshold_value == null) missing.push('pass-threshold');
  if (!cfg?.permanent_category_id) missing.push('permanent-category');
  return missing;
}

export function formatThreshold(cfg) {
  return cfg.threshold_type === 'percent'
    ? `${cfg.threshold_value}% of current members`
    : `${cfg.threshold_value} vote total`;
}

const friendly = (permName) => permName.replaceAll(/([a-z])([A-Z])/g, '$1 $2');

function permissionWarnings(interaction, channel, requiredPerms, where) {
  const perms = channel.permissionsFor?.(interaction.guild.members.me);
  const missing = perms ? perms.missing(requiredPerms) : requiredPerms.map(String);
  if (missing.length === 0) return [];
  return [`⚠️ I'm missing permissions ${where}: ${missing.map(friendly).join(', ')}. Please fix that before polls run.`];
}

const replyEphemeral = (interaction, content) =>
  interaction.reply({ content, flags: MessageFlags.Ephemeral });

function renderShow(cfg = {}) {
  const set = (value, render) => (value == null ? '*not set*' : render(value));
  const lines = [
    '**The The Bot settings for this server**',
    `• Poll channel (required): ${set(cfg.poll_channel_id, (id) => `<#${id}>`)}`,
    `• Hard-no weight (required): ${set(cfg.hard_no_weight, (w) => (w === 'veto' ? 'veto — a single hard no fails the poll' : w))}`,
    `• Pass threshold (required): ${
      cfg.threshold_type == null || cfg.threshold_value == null ? '*not set*' : formatThreshold(cfg)
    }`,
    `• Permanent category (required): ${set(cfg.permanent_category_id, (id) => `<#${id}>`)}`,
    `• Invite landing channel: ${set(cfg.invite_channel_id, (id) => `<#${id}>`)}${
      cfg.invite_channel_id ? '' : ' — defaults to the server system channel'
    }`,
    `• Poll-starter role: ${set(cfg.poll_starter_role_id, (id) => `<@&${id}>`)}${
      cfg.poll_starter_role_id ? '' : ' — anyone can start polls'
    }`,
  ];
  const missing = missingRequiredSettings(cfg);
  if (missing.length > 0) {
    lines.push('', `⚠️ Polls can't start yet — still needed: ${missing.map((m) => `\`/ttdb-config ${m}\``).join(', ')}.`);
  }
  return lines.join('\n');
}

export async function handleConfigCommand(ctx, interaction) {
  const { db } = ctx;
  const guildId = interaction.guildId;
  const sub = interaction.options.getSubcommand();
  const lines = [];
  let saved = false;

  switch (sub) {
    case 'poll-channel': {
      const channel = interaction.options.getChannel('channel', true);
      setConfig(db, guildId, { poll_channel_id: channel.id });
      lines.push(`Poll channel set to <#${channel.id}>.`);
      lines.push(...permissionWarnings(interaction, channel, POLL_CHANNEL_PERMS, 'in that channel'));
      saved = true;
      break;
    }
    case 'hard-no-weight': {
      const weight = interaction.options.getString('weight', true);
      if (!HARD_NO_WEIGHTS.includes(weight)) {
        return replyEphemeral(interaction, `⚠️ Invalid weight: ${weight}.`);
      }
      setConfig(db, guildId, { hard_no_weight: weight });
      lines.push(
        weight === 'veto'
          ? 'A single "Hard no" vote now vetoes (fails) a poll.'
          : `A "Hard no" vote now counts as ${weight} toward the vote total.`
      );
      saved = true;
      break;
    }
    case 'pass-threshold': {
      const value = interaction.options.getNumber('value', true);
      const unit = interaction.options.getString('unit', true);
      if (value < 0) {
        return replyEphemeral(interaction, '⚠️ The threshold value must be 0 or higher.');
      }
      if (unit === 'percent' && value > 100) {
        return replyEphemeral(
          interaction,
          '⚠️ A percent threshold above 100 can never pass (the vote total can never exceed the member count). Nothing was saved.'
        );
      }
      setConfig(db, guildId, {
        threshold_type: unit === 'percent' ? 'percent' : 'count',
        threshold_value: value,
      });
      lines.push(`Polls now pass when the vote total reaches ${formatThreshold(getConfig(db, guildId))}.`);
      saved = true;
      break;
    }
    case 'permanent-category': {
      const category = interaction.options.getChannel('category', true);
      setConfig(db, guildId, { permanent_category_id: category.id });
      lines.push(`Channels voted permanent will move into <#${category.id}>.`);
      lines.push(...permissionWarnings(interaction, category, CATEGORY_PERMS, 'on that category'));
      saved = true;
      break;
    }
    case 'invite-channel': {
      const channel = interaction.options.getChannel('channel', true);
      setConfig(db, guildId, { invite_channel_id: channel.id });
      lines.push(`Invite links from passed polls will land in <#${channel.id}>.`);
      lines.push(...permissionWarnings(interaction, channel, INVITE_PERMS, 'in that channel'));
      saved = true;
      break;
    }
    case 'poll-starter-role': {
      const role = interaction.options.getRole('role', true);
      setConfig(db, guildId, { poll_starter_role_id: role.id });
      lines.push(`Only members with <@&${role.id}> can start polls now (voting stays open to everyone).`);
      saved = true;
      break;
    }
    case 'show':
      return replyEphemeral(interaction, renderShow(getConfig(db, guildId)));
    default:
      return replyEphemeral(interaction, `⚠️ Unknown subcommand: ${sub}.`);
  }

  if (saved) {
    const cfg = getConfig(db, guildId);
    const missing = missingRequiredSettings(cfg);
    if (missing.length > 0) {
      lines.push(
        `Still needed before polls can start: ${missing.map((m) => `\`/ttdb-config ${m}\``).join(', ')}.`
      );
    } else if (ctx.ensureInitMessage) {
      try {
        await ctx.ensureInitMessage(interaction.guild);
        lines.push('All required settings are in place — the poll-buttons message is up to date.');
      } catch (err) {
        lines.push(`⚠️ Settings saved, but updating the poll-buttons message failed: ${err.message}`);
      }
    } else {
      lines.push('All required settings are in place.');
    }
  }
  return replyEphemeral(interaction, lines.join('\n'));
}
