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
      .setDescription('Points total a poll needs to pass (required)')
      .addNumberOption((opt) =>
        opt
          .setName('value')
          .setDescription('The number — a points total, or a percent')
          .setMinValue(0)
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('unit')
          .setDescription('How to interpret the value')
          .setRequired(true)
          .addChoices(
            { name: 'points — literal points total', value: 'votes' },
            { name: 'percent — of current (non-bot) members', value: 'percent' }
          )
      )
      .addStringOption((opt) =>
        opt
          .setName('poll-type')
          .setDescription('Which poll type this threshold applies to (default: both)')
          .addChoices(
            { name: 'invite polls', value: 'invite' },
            { name: 'channel-permanence polls', value: 'channel-permanence' },
            { name: 'channel-deletion polls', value: 'channel-deletion' },
            { name: 'all poll types', value: 'both' }
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
      .addStringOption((opt) =>
        opt
          .setName('kind')
          .setDescription('Which channel kind moves into this category (default: text)')
          .addChoices(
            { name: 'text channels', value: 'text' },
            { name: 'voice channels', value: 'voice' }
          )
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
      .setName('other-permanent-groups')
      .setDescription('Categories protected as permanent but not managed by deletion polls (optional)')
      .addChannelOption((opt) =>
        opt
          .setName('category')
          .setDescription('The category to add or remove')
          .addChannelTypes(ChannelType.GuildCategory)
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('action')
          .setDescription('Add or remove this category (default: add)')
          .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' })
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('max-open-polls')
      .setDescription('How many polls may be open at the same time (default: 10)')
      .addIntegerOption((opt) =>
        opt
          .setName('value')
          .setDescription('The cap on simultaneous open polls')
          .setMinValue(1)
          .setMaxValue(100)
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

// Per-type threshold resolution: the per-type columns win, with the legacy
// shared columns as fallback (kept so pre-existing configs stay valid).
export function thresholdFor(cfg, pollType) {
  const [type, value] =
    pollType === 'invite'
      ? [cfg?.threshold_type_invite, cfg?.threshold_value_invite]
      : pollType === 'delete_channel'
        ? [cfg?.threshold_type_delchan, cfg?.threshold_value_delchan]
        : [cfg?.threshold_type_permchan, cfg?.threshold_value_permchan];
  if (type != null && value != null) return { type, value };
  if (cfg?.threshold_type != null && cfg?.threshold_value != null) {
    return { type: cfg.threshold_type, value: cfg.threshold_value };
  }
  return null;
}

// Per-channel-kind permanent category. Text falls back to the legacy
// column; voice has no fallback (a voice channel must not silently land in
// the text category), so voice nominations are refused until it is set.
export function permanentCategoryFor(cfg, kind) {
  if (kind === 'voice') return cfg?.permanent_category_voice_id ?? null;
  return cfg?.permanent_category_text_id ?? cfg?.permanent_category_id ?? null;
}

export const channelKind = (channel) =>
  channel?.type === ChannelType.GuildVoice ? 'voice' : 'text';

// "Other" permanent groups: categories protected as permanent (excluded
// from permanence nominations) but not managed by deletion polls.
export function otherPermanentCategoryIds(cfg) {
  try {
    const parsed = JSON.parse(cfg?.other_permanent_category_ids ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// The categories the bot itself manages: text/voice (+legacy). Channels in
// them are community-owned — deletable only via polls, never creator-locked.
export function managedPermanentCategoryIds(cfg) {
  return new Set(
    [cfg?.permanent_category_id, cfg?.permanent_category_text_id, cfg?.permanent_category_voice_id].filter(
      Boolean
    )
  );
}

// Every category considered permanent: the managed text/voice (+legacy)
// categories plus all other permanent groups.
export function allPermanentCategoryIds(cfg) {
  return new Set([...managedPermanentCategoryIds(cfg), ...otherPermanentCategoryIds(cfg)]);
}

// Required-config gate (Q8). Returns the /ttdb-config subcommand names still
// unset; empty array means polls may start. Voice categories are optional —
// they gate voice nominations, not the whole feature.
export function missingRequiredSettings(cfg) {
  const missing = [];
  if (!cfg?.poll_channel_id) missing.push('poll-channel');
  if (!cfg?.hard_no_weight) missing.push('hard-no-weight');
  if (!thresholdFor(cfg, 'invite') || !thresholdFor(cfg, 'permanent_channel')) {
    missing.push('pass-threshold');
  }
  if (!permanentCategoryFor(cfg, 'text')) missing.push('permanent-category');
  return missing;
}

// Shared "Hard no" description used by both the init message and the poll
// creation prompt, so the two never drift apart. Unset config reads as veto.
export const isVetoConfig = (cfg) => cfg?.hard_no_weight == null || cfg.hard_no_weight === 'veto';
export function hardNoDescription(cfg) {
  return isVetoConfig(cfg)
    ? '**vetoes the poll** (it fails outright if there are any vetoes)'
    : `**${cfg.hard_no_weight.replace('-', '−')}**`;
}

export const DEFAULT_MAX_OPEN_POLLS = 10;
export const maxOpenPolls = (cfg) => cfg?.max_open_polls ?? DEFAULT_MAX_OPEN_POLLS;

export function formatThreshold({ type, value }) {
  return type === 'percent' ? `${value}% of current members` : `${value} points total`;
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
  const inviteThreshold = thresholdFor(cfg, 'invite');
  const permThreshold = thresholdFor(cfg, 'permanent_channel');
  const textCategory = permanentCategoryFor(cfg, 'text');
  const voiceCategory = permanentCategoryFor(cfg, 'voice');
  const lines = [
    '**The The Bot settings for this server**',
    `• Poll channel (required): ${set(cfg.poll_channel_id, (id) => `<#${id}>`)}`,
    `• Hard-no weight (required): ${set(cfg.hard_no_weight, (w) => (w === 'veto' ? 'veto — a single hard no fails the poll' : w))}`,
    `• Pass threshold — invite polls (required): ${inviteThreshold ? formatThreshold(inviteThreshold) : '*not set*'}`,
    `• Pass threshold — channel-permanence polls (required): ${permThreshold ? formatThreshold(permThreshold) : '*not set*'}`,
    `• Pass threshold — channel-deletion polls: ${
      thresholdFor(cfg, 'delete_channel')
        ? formatThreshold(thresholdFor(cfg, 'delete_channel'))
        : "*not set* — channel-deletion polls can't start"
    }`,
    `• Permanent category — text channels (required): ${textCategory ? `<#${textCategory}>` : '*not set*'}`,
    `• Permanent category — voice channels: ${voiceCategory ? `<#${voiceCategory}>` : "*not set* — voice channels can't be nominated"}`,
    `• Other permanent groups: ${
      otherPermanentCategoryIds(cfg).length > 0
        ? otherPermanentCategoryIds(cfg)
            .map((id) => `<#${id}>`)
            .join(', ')
        : '*none*'
    }`,
    `• Invite landing channel: ${set(cfg.invite_channel_id, (id) => `<#${id}>`)}${
      cfg.invite_channel_id ? '' : ' — defaults to the server system channel'
    }`,
    `• Poll-starter role: ${set(cfg.poll_starter_role_id, (id) => `<@&${id}>`)}${
      cfg.poll_starter_role_id ? '' : ' — anyone can start polls'
    }`,
    `• Max open polls: ${cfg.max_open_polls ?? `${DEFAULT_MAX_OPEN_POLLS} (default)`}`,
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
          : `A "Hard no" vote now counts as ${weight} toward the point total.`
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
          '⚠️ A percent threshold above 100 can never pass (the point total can never exceed the member count). Nothing was saved.'
        );
      }
      const scope = interaction.options.getString('poll-type') ?? 'both';
      const type = unit === 'percent' ? 'percent' : 'count';
      const patch = {};
      if (scope === 'invite' || scope === 'both') {
        patch.threshold_type_invite = type;
        patch.threshold_value_invite = value;
      }
      if (scope === 'channel-permanence' || scope === 'both') {
        patch.threshold_type_permchan = type;
        patch.threshold_value_permchan = value;
      }
      if (scope === 'channel-deletion' || scope === 'both') {
        patch.threshold_type_delchan = type;
        patch.threshold_value_delchan = value;
      }
      setConfig(db, guildId, patch);
      const scopeText =
        scope === 'both'
          ? 'All poll types'
          : scope === 'invite'
            ? 'Invite polls'
            : scope === 'channel-deletion'
              ? 'Channel-deletion polls'
              : 'Channel-permanence polls';
      lines.push(
        `${scopeText} now pass when the point total at poll closing is at least ${formatThreshold({ type, value })}.`
      );
      saved = true;
      break;
    }
    case 'permanent-category': {
      const category = interaction.options.getChannel('category', true);
      const kind = interaction.options.getString('kind') ?? 'text';
      setConfig(
        db,
        guildId,
        kind === 'voice'
          ? { permanent_category_voice_id: category.id }
          : { permanent_category_text_id: category.id }
      );
      lines.push(
        `${kind === 'voice' ? 'Voice' : 'Text'} channels voted permanent will move into <#${category.id}>.`
      );
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
    case 'other-permanent-groups': {
      const category = interaction.options.getChannel('category', true);
      const action = interaction.options.getString('action') ?? 'add';
      const current = otherPermanentCategoryIds(getConfig(db, guildId));
      const next =
        action === 'remove'
          ? current.filter((id) => id !== category.id)
          : current.includes(category.id)
            ? current
            : [...current, category.id];
      setConfig(db, guildId, { other_permanent_category_ids: JSON.stringify(next) });
      lines.push(
        action === 'remove'
          ? `<#${category.id}> is no longer treated as an other permanent group.`
          : `<#${category.id}> is now an other permanent group — its channels are protected from permanence polls and are not offered for deletion.`
      );
      saved = true;
      break;
    }
    case 'max-open-polls': {
      const value = interaction.options.getInteger('value', true);
      if (!Number.isInteger(value) || value < 1) {
        return replyEphemeral(interaction, '⚠️ The cap must be a whole number of at least 1.');
      }
      setConfig(db, guildId, { max_open_polls: value });
      lines.push(`At most ${value} poll(s) can be open at the same time now.`);
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
    // Keep the bot's profile description in step with the config state.
    await ctx.ensureProfile?.().catch(() => {});
  }
  return replyEphemeral(interaction, lines.join('\n'));
}
