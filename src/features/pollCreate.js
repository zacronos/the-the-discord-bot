// Poll creation: init-message button → modal (explanation + subject +
// duration) → validation gates → poll row + public message.
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { buildId } from '../discord/customId.js';
import { getConfig } from '../store/guildConfig.js';
import { closePoll, createPoll, listOpen, setMessageId } from '../store/polls.js';
import {
  allPermanentCategoryIds,
  channelKind,
  deletionThresholdFor,
  managedPermanentCategoryIds,
  maxOpenPolls,
  missingRequiredSettings,
  otherPermanentCategoryIds,
  permanentCategoryFor,
} from './configCommands.js';
import { durationSelectOptions, isAllowedDurationSeconds } from './durations.js';
import { channelViewerCount, eligibleVoterCount, isPrivateChannel } from './eligibility.js';
import { scheduleEphemeralCleanup } from './ephemeralCleanup.js';
import { pollRulesFor, pollTitle, renderPollMessage } from './pollMessage.js';
import { roundUpToNextHour } from '../util/time.js';

// customId segment → poll type stored in the database
const POLL_TYPES = { invite: 'invite', permchan: 'permanent_channel', delchan: 'delete_channel' };

const replyEphemeral = (interaction, content) =>
  interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

// Response delivery for the shared creation tail: the modal path replies
// with a fresh ephemeral; the ack-button path edits the warning message in
// place (and strips its button unless the payload carries new components).
const ephemeralResponder = (interaction, payload) =>
  interaction.reply({
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
    ...(typeof payload === 'string' ? { content: payload } : payload),
  });
const updateResponder = (interaction, payload) =>
  interaction.update({
    allowedMentions: { parse: [] },
    components: [],
    ...(typeof payload === 'string' ? { content: payload } : payload),
  });

// Kept intentionally short: the scoring rules and thresholds live on the
// init message members press to get here.
export function buildCreationExplanation() {
  return [
    'This starts an **anonymous** poll in the poll channel, open to everyone on the server. Nobody can see how anyone voted.',
    'The poll closes after the duration you pick, rounded up to the next hour on the clock — or as soon as everyone on the server has voted.',
    '⚠️ A shorter poll may reach a result quicker, but leaves less time for everyone to see it and vote — avoid shorter durations unless there is a real reason for urgency.',
  ].join('\n\n');
}

const channelOption = (channel) => ({
  label: channel.type === 2 ? `🔊 ${channel.name}` : `#${channel.name}`,
  value: channel.id,
});

// Per-user visibility: never offer (or accept) a channel the initiating
// member cannot see. Real channels always have permissionsFor; its absence
// only occurs in test fakes, which default to visible.
export function memberCanView(channel, member) {
  if (typeof channel?.permissionsFor !== 'function') return true;
  const perms = channel.permissionsFor(member);
  return perms ? perms.has(PermissionFlagsBits.ViewChannel) : false;
}

// Sort and enforce Discord's 25-option select limit.
function finalizeChannelOptions(options, what) {
  options.sort((a, b) => a.label.localeCompare(b.label));
  if (options.length > 25) {
    console.warn(`[ttdb] ${what} dropdown truncated to 25 of ${options.length} eligible channels`);
    return options.slice(0, 25);
  }
  return options;
}

// Deletion candidates: every text/voice channel the initiator can see.
// "Other" permanent groups are protected and never offered, and each
// deletion kind (permanent-category vs other channels) is offered only
// while its own threshold is configured — no dead-end options. Discord's
// channel select cannot filter by category, so the dropdown is a bot-built
// string select of exactly these channels.
// The channels the bot itself operates through — deleting them would break
// the polls that deleted them.
const infrastructureChannelIds = (cfg) =>
  new Set([cfg?.poll_channel_id, cfg?.invite_channel_id].filter(Boolean));

export function deletableChannelOptions(cfg, allChannels, member) {
  const protectedIds = new Set(otherPermanentCategoryIds(cfg));
  const managedIds = managedPermanentCategoryIds(cfg);
  const infrastructure = infrastructureChannelIds(cfg);
  const kindEnabled = {
    permanent: Boolean(deletionThresholdFor(cfg, 'permanent')),
    other: Boolean(deletionThresholdFor(cfg, 'other')),
  };
  const options = [];
  for (const channel of allChannels.values()) {
    if (!channel) continue;
    const type = channel.type ?? 0;
    if (type !== 0 && type !== 2) continue; // text and voice only
    if (protectedIds.has(channel.parentId)) continue;
    if (infrastructure.has(channel.id)) continue;
    if (!kindEnabled[managedIds.has(channel.parentId) ? 'permanent' : 'other']) continue;
    if (!memberCanView(channel, member)) continue;
    options.push(channelOption(channel));
  }
  return finalizeChannelOptions(options, 'deletion');
}

// Permanence candidates: text/voice channels NOT already inside any
// permanent group (managed categories, legacy, or other permanent groups).
// Voice channels are only offered once a voice category exists — otherwise
// they would be dead-end options refused at submit.
export function permanentizableChannelOptions(cfg, allChannels, member) {
  const excluded = allPermanentCategoryIds(cfg);
  const voiceConfigured = Boolean(permanentCategoryFor(cfg, 'voice'));
  const options = [];
  for (const channel of allChannels.values()) {
    if (!channel) continue;
    const kind = channel.type ?? 0;
    if (kind !== 0 && kind !== 2) continue; // text and voice only
    if (kind === 2 && !voiceConfigured) continue;
    if (excluded.has(channel.parentId)) continue;
    if (!memberCanView(channel, member)) continue;
    options.push(channelOption(channel));
  }
  return finalizeChannelOptions(options, 'permanence');
}

// Raw component payload (Components V2): 10 = Text Display, 18 = Label,
// 4 = Text Input, 3 = String Select, 8 = Channel Select (0 = text channels).
export function buildCreateModal(typePart, cfg, testMode = false, { channelOptions = [] } = {}) {
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
          component: { type: 3, custom_id: 'channel', required: true, options: channelOptions },
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
  if (
    typePart === 'delchan' &&
    !deletionThresholdFor(cfg, 'permanent') &&
    !deletionThresholdFor(cfg, 'other')
  ) {
    return replyEphemeral(
      interaction,
      "⚠️ Channel-deletion polls aren't configured yet — an admin must set `/ttdb-config pass-threshold` for them first (poll-type:channel-deletion covers permanent-category channels; poll-type:channel-deletion-other covers the rest)."
    );
  }
  if (typePart === 'delchan' || typePart === 'permchan') {
    const allChannels = await interaction.guild.channels.fetch();
    const channelOptions =
      typePart === 'delchan'
        ? deletableChannelOptions(cfg, allChannels, interaction.member)
        : permanentizableChannelOptions(cfg, allChannels, interaction.member);
    if (channelOptions.length === 0) {
      return replyEphemeral(
        interaction,
        typePart === 'delchan'
          ? '⚠️ There are no channels you can see that can be nominated for deletion.'
          : '⚠️ Every text and voice channel is already in a permanent group.'
      );
    }
    return interaction.showModal(buildCreateModal(typePart, cfg, ctx.env?.testMode, { channelOptions }));
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
  let subjectName = null;
  let nominatedChannel = null;
  if (type === 'invite') {
    subject = collapseWhitespace(values.name);
    if (subject.length < 1 || subject.length > 80) {
      return replyEphemeral(interaction, '⚠️ The name must be between 1 and 80 characters.');
    }
  } else if (type === 'delete_channel') {
    const channelId = first(values.channel);
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      return replyEphemeral(interaction, '⚠️ I could not find that channel.');
    }
    if (!memberCanView(channel, interaction.member)) {
      return replyEphemeral(interaction, '⚠️ You can only nominate channels you can see.');
    }
    const kind = channel.type ?? 0;
    if (kind !== 0 && kind !== 2) {
      return replyEphemeral(interaction, '⚠️ Only text and voice channels can be voted for deletion.');
    }
    if (new Set(otherPermanentCategoryIds(cfg)).has(channel.parentId)) {
      return replyEphemeral(
        interaction,
        "⚠️ That channel is in a protected permanent group and can't be voted for deletion."
      );
    }
    if (infrastructureChannelIds(cfg).has(channel.id)) {
      return replyEphemeral(
        interaction,
        "⚠️ The poll channel and invite channel keep the polls running — they can't be voted for deletion."
      );
    }
    const isPermanentKind = managedPermanentCategoryIds(cfg).has(channel.parentId);
    if (!deletionThresholdFor(cfg, isPermanentKind ? 'permanent' : 'other')) {
      return replyEphemeral(
        interaction,
        isPermanentKind
          ? "⚠️ Deletion polls for permanent-category channels aren't configured yet — an admin must set `/ttdb-config pass-threshold poll-type:channel-deletion` first."
          : "⚠️ Deletion polls for channels outside the permanent categories aren't configured yet — an admin must set `/ttdb-config pass-threshold poll-type:channel-deletion-other` first."
      );
    }
    subject = channelId;
    subjectName = channel.name ?? null;
    nominatedChannel = channel;
  } else {
    const channel = await validatePermanenceTarget(ctx, interaction, cfg, first(values.channel));
    if (!channel) return;
    subject = channel.id;
    subjectName = channel.name ?? null;
    nominatedChannel = channel;
  }

  return openPollAndConfirm(ctx, interaction, {
    cfg,
    type,
    subject,
    subjectName,
    nominatedChannel,
    durationSeconds,
  });
}

// Permanence-nomination gates, shared by the modal submit and the ack
// button (which must re-check everything — the world may have changed since
// its warning was shown). Delivers the refusal and returns null when the
// nomination is invalid.
async function validatePermanenceTarget(ctx, interaction, cfg, channelId, respond = ephemeralResponder) {
  const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    await respond(interaction, '⚠️ I could not find that channel.');
    return null;
  }
  if (!memberCanView(channel, interaction.member)) {
    await respond(interaction, '⚠️ You can only nominate channels you can see.');
    return null;
  }
  const kind = channelKind(channel);
  const categoryId = permanentCategoryFor(cfg, kind);
  if (!categoryId) {
    await respond(
      interaction,
      kind === 'voice'
        ? '⚠️ Voice channels can\'t be nominated yet — an admin must set `/ttdb-config permanent-category kind:voice` first.'
        : '⚠️ No permanent category is configured — an admin must run `/ttdb-config permanent-category`.'
    );
    return null;
  }
  if (allPermanentCategoryIds(cfg).has(channel.parentId)) {
    await respond(interaction, `⚠️ <#${channelId}> is already in a permanent group.`);
    return null;
  }
  return channel;
}

// Everything from the duplicate gate to the live-poll confirmation, shared
// by the modal submit and the make-it-public acknowledgement button.
async function openPollAndConfirm(
  ctx,
  interaction,
  {
    cfg,
    type,
    subject,
    subjectName,
    nominatedChannel,
    durationSeconds,
    acknowledgedPublic = false,
    respond = ephemeralResponder,
  }
) {
  const openPolls = listOpen(ctx.db, interaction.guildId);
  const key = duplicateKey(type, subject);
  const duplicate = openPolls.find(
    (poll) => poll.type === type && duplicateKey(poll.type, poll.subject) === key
  );
  if (duplicate) {
    return respond(
      interaction,
      '⚠️ There is already an open poll about this — please wait for it to close.'
    );
  }

  // Private channels keep their polls to themselves: the poll message is
  // posted inside the nominated channel (a voice channel's built-in text
  // chat is the channel itself), so the channel's name never reaches
  // members who can't already see it.
  const isPrivate = nominatedChannel ? isPrivateChannel(interaction.guild, nominatedChannel) : false;

  // Permanence makes a private channel public (the promotion lifts its view
  // deny) — the initiator must acknowledge that before the poll opens.
  if (type === 'permanent_channel' && isPrivate && !acknowledgedPublic) {
    const warning = await respond(interaction, {
      content: [
        `⚠️ <#${subject}> is a **private channel**. If this poll passes, making it permanent will also make it **public** — everyone on the server will be able to see it and its full message history.`,
        'Press the button to acknowledge that and start the poll, or dismiss this message to cancel.',
      ].join('\n'),
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 4,
              label: 'I understand — the channel will become public',
              custom_id: buildId('pubok', subject, durationSeconds),
            },
          ],
        },
      ],
    });
    scheduleEphemeralCleanup(ctx, interaction, { now: ctx.now?.() ?? Date.now() });
    return warning;
  }

  let destination = isPrivate ? nominatedChannel : null;
  if (!destination) {
    destination = await interaction.guild.channels.fetch(cfg.poll_channel_id).catch(() => null);
    if (!destination) {
      return respond(
        interaction,
        '⚠️ The configured poll channel no longer exists — an admin needs to run `/ttdb-config poll-channel`.'
      );
    }
  }

  const now = ctx.now?.() ?? Date.now();
  const poll = createPoll(ctx.db, {
    guildId: interaction.guildId,
    type,
    subject,
    subjectName,
    initiatorId: interaction.user.id,
    channelId: destination.id,
    createdAt: now,
    closesAt: roundUpToNextHour(now + durationSeconds * 1000, { testMode: ctx.env?.testMode }),
    isPrivate,
  });

  const eligible = isPrivate
    ? await channelViewerCount(interaction.guild, nominatedChannel).catch(() => null)
    : await eligibleVoterCount(ctx.db, interaction.guild).catch(() => null);
  const rules = await pollRulesFor(ctx, interaction.guild, poll).catch(() => null);
  let message;
  try {
    message = await destination.send(renderPollMessage(poll, { responded: 0, eligible, rules }));
  } catch {
    closePoll(ctx.db, poll.id, 'aborted', null, now);
    return respond(
      interaction,
      `⚠️ I couldn't post in <#${destination.id}> — for a private channel, make sure I have access and Send Messages there, then try again.`
    );
  }
  setMessageId(ctx.db, poll.id, message.id);
  poll.message_id = message.id;

  await respond(
    interaction,
    `✅ Your poll is live: **${pollTitle(poll)}**\nhttps://discord.com/channels/${interaction.guildId}/${destination.id}/${message.id}\nYou'll get the result by DM when it closes.`
  );
  // The confirmation cleans itself up just inside the interaction-token
  // window — persisted, so a bot restart cannot lose the timer.
  scheduleEphemeralCleanup(ctx, interaction, { now: ctx.now?.() ?? Date.now() });
}

// The make-it-public acknowledgement button. Its customId carries the
// nominated channel and duration; the presser is necessarily the warned
// initiator (the warning is ephemeral to them).
export async function handleConfirmPublicButton(ctx, interaction, [channelId, durationRaw]) {
  const cfg = configGate(ctx, interaction);
  if (!cfg) return;
  if (cfg.poll_starter_role_id && !interaction.member?.roles?.cache?.has(cfg.poll_starter_role_id)) {
    return replyEphemeral(
      interaction,
      `⚠️ Only members with <@&${cfg.poll_starter_role_id}> can start polls on this server.`
    );
  }
  const durationSeconds = Number(durationRaw);
  if (!isAllowedDurationSeconds(durationSeconds, ctx.env?.testMode)) {
    return replyEphemeral(interaction, '⚠️ Please pick a poll duration from the list.');
  }
  const openPolls = listOpen(ctx.db, interaction.guildId);
  const cap = maxOpenPolls(cfg);
  if (openPolls.length >= cap) {
    return updateResponder(
      interaction,
      `⚠️ There are already ${openPolls.length} open poll(s) — this server allows at most ${cap} at a time. Please wait for one to close.`
    );
  }
  const channel = await validatePermanenceTarget(ctx, interaction, cfg, channelId, updateResponder);
  if (!channel) return;
  return openPollAndConfirm(ctx, interaction, {
    cfg,
    type: 'permanent_channel',
    subject: channel.id,
    subjectName: channel.name ?? null,
    nominatedChannel: channel,
    durationSeconds,
    acknowledgedPublic: true,
    respond: updateResponder,
  });
}
