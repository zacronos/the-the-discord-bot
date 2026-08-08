// Poll creation: init-message button → modal (explanation + subject +
// duration) → validation gates → poll row + public message.
import { MessageFlags } from 'discord.js';
import { buildId } from '../discord/customId.js';
import { getConfig } from '../store/guildConfig.js';
import { createPoll, listOpen, setMessageId } from '../store/polls.js';
import {
  channelKind,
  maxOpenPolls,
  missingRequiredSettings,
  permanentCategoryFor,
  thresholdFor,
} from './configCommands.js';
import { durationSelectOptions, isAllowedDurationSeconds } from './durations.js';
import { eligibleVoterCount } from './eligibility.js';
import { pollTitle, renderPollMessage } from './pollMessage.js';
import { EPHEMERAL_TTL_MS, roundUpToNextHour, scheduleDelayed } from '../util/time.js';

// customId segment → poll type stored in the database
const POLL_TYPES = { invite: 'invite', permchan: 'permanent_channel', delchan: 'delete_channel' };

const replyEphemeral = (interaction, content) =>
  interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

// Kept intentionally short: the scoring rules and thresholds live on the
// init message members press to get here.
export function buildCreationExplanation() {
  return [
    'This starts an **anonymous** poll in the poll channel, open to everyone on the server. Nobody can see how anyone voted.',
    'The poll closes after the duration you pick, rounded up to the next hour on the clock — or as soon as everyone on the server has voted.',
    '⚠️ A shorter poll may reach a result quicker, but leaves less time for everyone to see it and vote — avoid shorter durations unless there is a real reason for urgency.',
  ].join('\n\n');
}

// Raw component payload (Components V2): 10 = Text Display, 18 = Label,
// 4 = Text Input, 3 = String Select, 8 = Channel Select (0 = text channels).
export function buildCreateModal(typePart, cfg, testMode = false) {
  const subjectLabel =
    typePart === 'invite'
      ? {
          type: 18,
          label: 'Who should we invite?',
          component: { type: 4, custom_id: 'name', style: 1, min_length: 1, max_length: 80, required: true },
        }
      : {
          type: 18,
          label:
            typePart === 'delchan'
              ? 'Which channel should be deleted?'
              : 'Which channel should become permanent?',
          component: { type: 8, custom_id: 'channel', channel_types: [0, 2], required: true },
        };
  const TITLES = {
    invite: 'Start a vote: invite someone',
    permchan: 'Start a vote: channel permanence',
    delchan: 'Start a vote: delete a channel',
  };
  return {
    custom_id: buildId('create', typePart),
    title: TITLES[typePart],
    components: [
      { type: 10, content: buildCreationExplanation() },
      subjectLabel,
      {
        type: 18,
        label: 'How long should the poll stay open?',
        description: 'Avoid shorter durations without a reason for urgency.',
        component: { type: 3, custom_id: 'duration', required: true, options: durationSelectOptions(testMode) },
      },
    ],
  };
}

// Walks a modal submission's component tree (rows, labels, raw shapes) and
// collects { customId: value | values[] }.
export function extractModalValues(interaction) {
  const out = {};
  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const id = node.customId ?? node.custom_id;
    if (id != null) {
      if (Array.isArray(node.values)) out[id] = node.values;
      else if (node.value !== undefined && node.value !== null) out[id] = node.value;
    }
    visit(node.component);
    visit(node.components);
  };
  visit(interaction.components);
  return out;
}

function configGate(ctx, interaction) {
  const cfg = getConfig(ctx.db, interaction.guildId);
  const missing = missingRequiredSettings(cfg);
  if (missing.length > 0) {
    replyEphemeral(
      interaction,
      `⚠️ Polls can't start until the server is configured. Still needed: ${missing
        .map((m) => `\`/ttdb-config ${m}\``)
        .join(', ')} (an admin can run these).`
    );
    return null;
  }
  return cfg;
}

export async function handleStartButton(ctx, interaction, [typePart]) {
  if (!POLL_TYPES[typePart]) return;
  const cfg = configGate(ctx, interaction);
  if (!cfg) return;
  if (cfg.poll_starter_role_id && !interaction.member?.roles?.cache?.has(cfg.poll_starter_role_id)) {
    return replyEphemeral(
      interaction,
      `⚠️ Only members with <@&${cfg.poll_starter_role_id}> can start polls on this server.`
    );
  }
  if (typePart === 'delchan' && !thresholdFor(cfg, 'delete_channel')) {
    return replyEphemeral(
      interaction,
      '⚠️ Channel-deletion polls aren\'t configured yet — an admin must run `/ttdb-config pass-threshold poll-type:channel-deletion` first.'
    );
  }
  await interaction.showModal(buildCreateModal(typePart, cfg, ctx.env?.testMode));
}

// 7.5 input hygiene: strip control/invisible characters, collapse whitespace.
const collapseWhitespace = (text) =>
  String(text ?? '')
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, '')
    .replaceAll(/\s+/g, ' ')
    .trim();
const first = (value) => (Array.isArray(value) ? value[0] : value);
const duplicateKey = (type, subject) => (type === 'invite' ? subject.toLowerCase() : subject);

export async function handleCreateModal(ctx, interaction, [typePart]) {
  const type = POLL_TYPES[typePart];
  if (!type) return;
  const cfg = configGate(ctx, interaction);
  if (!cfg) return;

  const values = extractModalValues(interaction);
  const durationSeconds = Number(first(values.duration));
  if (!isAllowedDurationSeconds(durationSeconds, ctx.env?.testMode)) {
    return replyEphemeral(interaction, '⚠️ Please pick a poll duration from the list.');
  }

  const openPolls = listOpen(ctx.db, interaction.guildId);
  const cap = maxOpenPolls(cfg);
  if (openPolls.length >= cap) {
    return replyEphemeral(
      interaction,
      `⚠️ There are already ${openPolls.length} open poll(s) — this server allows at most ${cap} at a time. Please wait for one to close.`
    );
  }

  let subject;
  if (type === 'invite') {
    subject = collapseWhitespace(values.name);
    if (subject.length < 1 || subject.length > 80) {
      return replyEphemeral(interaction, '⚠️ The name must be between 1 and 80 characters.');
    }
  } else if (type === 'delete_channel') {
    if (!thresholdFor(cfg, 'delete_channel')) {
      return replyEphemeral(
        interaction,
        '⚠️ Channel-deletion polls aren\'t configured yet — an admin must run `/ttdb-config pass-threshold poll-type:channel-deletion` first.'
      );
    }
    const channelId = first(values.channel);
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      return replyEphemeral(interaction, '⚠️ I could not find that channel.');
    }
    const permanentCategories = new Set(
      [cfg.permanent_category_id, cfg.permanent_category_text_id, cfg.permanent_category_voice_id].filter(Boolean)
    );
    if (!permanentCategories.has(channel.parentId)) {
      return replyEphemeral(
        interaction,
        '⚠️ Only channels inside the permanent categories can be voted for deletion.'
      );
    }
    subject = channelId;
  } else {
    const channelId = first(values.channel);
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      return replyEphemeral(interaction, '⚠️ I could not find that channel.');
    }
    const kind = channelKind(channel);
    const categoryId = permanentCategoryFor(cfg, kind);
    if (!categoryId) {
      return replyEphemeral(
        interaction,
        kind === 'voice'
          ? '⚠️ Voice channels can\'t be nominated yet — an admin must set `/ttdb-config permanent-category kind:voice` first.'
          : '⚠️ No permanent category is configured — an admin must run `/ttdb-config permanent-category`.'
      );
    }
    if (channel.parentId === categoryId) {
      return replyEphemeral(interaction, `⚠️ <#${channelId}> is already in the permanent category.`);
    }
    subject = channelId;
  }

  const key = duplicateKey(type, subject);
  const duplicate = openPolls.find(
    (poll) => poll.type === type && duplicateKey(poll.type, poll.subject) === key
  );
  if (duplicate) {
    return replyEphemeral(
      interaction,
      '⚠️ There is already an open poll about this — please wait for it to close.'
    );
  }

  const now = ctx.now?.() ?? Date.now();
  const poll = createPoll(ctx.db, {
    guildId: interaction.guildId,
    type,
    subject,
    initiatorId: interaction.user.id,
    channelId: cfg.poll_channel_id,
    createdAt: now,
    closesAt: roundUpToNextHour(now + durationSeconds * 1000, { testMode: ctx.env?.testMode }),
  });

  const pollChannel = await interaction.guild.channels.fetch(cfg.poll_channel_id).catch(() => null);
  if (!pollChannel) {
    return replyEphemeral(
      interaction,
      '⚠️ The configured poll channel no longer exists — an admin needs to run `/ttdb-config poll-channel`.'
    );
  }
  const eligible = await eligibleVoterCount(interaction.guild).catch(() => null);
  const message = await pollChannel.send(renderPollMessage(poll, { responded: 0, eligible }));
  setMessageId(ctx.db, poll.id, message.id);
  poll.message_id = message.id;

  await replyEphemeral(
    interaction,
    `✅ Your poll is live: **${pollTitle(poll)}**\nhttps://discord.com/channels/${interaction.guildId}/${pollChannel.id}/${message.id}\nYou'll get the result by DM when it closes.`
  );
  // The confirmation cleans itself up just inside the interaction-token window.
  scheduleDelayed(ctx, async () => {
    try {
      await interaction.deleteReply();
    } catch {
      // already dismissed
    }
  }, EPHEMERAL_TTL_MS);
}
