// The private ballot: an ephemeral message only the voter sees, showing
// their current vote and the four choices. Votes can change until close.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { buildId } from '../discord/customId.js';
import { getPoll } from '../store/polls.js';
import { castVote, countVoters, getVote } from '../store/votes.js';
import { pollPopulation } from './eligibility.js';
import { memberCanView } from './pollCreate.js';
import { pollTitle, refreshPollCounts } from './pollMessage.js';
import { EPHEMERAL_TTL_MS, scheduleDelayed } from '../util/time.js';

const NO_LABELS = {
  invite: "No, I'd rather not invite them, but I won't object if enough people want to",
  permanent_channel: "No, I'd rather not, but I won't object if enough people want to",
  delete_channel: "No, I'd rather not, but I won't object if enough people want to",
};

export function choiceLabel(type, choice) {
  switch (choice) {
    case 'yes':
      return 'Yes!';
    case 'no':
      return NO_LABELS[type];
    case 'hard_no':
      return "Hard no, I really don't want this";
    case 'abstain':
      return 'I abstain from voting';
    default:
      return choice;
  }
}

// Live ballot interactions per poll, so casting, the 14-minute timer, or
// the close pipeline can dismiss them. Ephemeral messages are only
// deletable through their interaction token (valid ~15 minutes) — hence
// the timer, and best-effort deletion everywhere else. In-memory by
// design: after a restart the old tokens would be expired anyway.
const liveBallots = new Map(); // pollId -> Map<userId, { interaction, at, timer }>

// Exported for the withdraw flow, which turns the initiator's panel into
// its confirmation and must keep it out of the close pipeline's cleanup.
export function untrackBallot(pollId, userId) {
  const perUser = liveBallots.get(pollId);
  if (!perUser) return;
  const entry = perUser.get(userId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  perUser.delete(userId);
  if (perUser.size === 0) liveBallots.delete(pollId);
}

function trackBallot(ctx, poll, interaction, at) {
  let perUser = liveBallots.get(poll.id);
  if (!perUser) {
    perUser = new Map();
    liveBallots.set(poll.id, perUser);
  }
  const existing = perUser.get(interaction.user.id);
  if (existing?.timer) clearTimeout(existing.timer);
  const timer = scheduleDelayed(ctx, async () => {
    untrackBallot(poll.id, interaction.user.id);
    try {
      await interaction.deleteReply();
    } catch {
      // already dismissed or token just expired
    }
  }, EPHEMERAL_TTL_MS);
  perUser.set(interaction.user.id, { interaction, at, timer });
}

// Deletes every still-deletable ballot for the poll and forgets the rest.
export async function deleteBallots(pollId, now = Date.now()) {
  const perUser = liveBallots.get(pollId);
  liveBallots.delete(pollId);
  if (!perUser) return 0;
  let deleted = 0;
  for (const { interaction, at, timer } of perUser.values()) {
    if (timer) clearTimeout(timer);
    if (now - at > EPHEMERAL_TTL_MS) continue;
    try {
      await interaction.deleteReply();
      deleted += 1;
    } catch {
      // token expired early or message already dismissed
    }
  }
  return deleted;
}

export function clearBallotTracking() {
  for (const perUser of liveBallots.values()) {
    for (const { timer } of perUser.values()) {
      if (timer) clearTimeout(timer);
    }
  }
  liveBallots.clear();
}

const CHOICE_STYLES = {
  yes: ButtonStyle.Success,
  no: ButtonStyle.Secondary,
  hard_no: ButtonStyle.Danger,
  abstain: ButtonStyle.Secondary,
};

export function buildBallot(poll, currentChoice, { isInitiator = false } = {}) {
  const status = currentChoice
    ? `Your current vote: **${choiceLabel(poll.type, currentChoice)}**\nOnly you can see this. You can change your vote until the poll closes.`
    : "You haven't voted yet. Only you can see this ballot — pick an option:";
  // The subject is user-supplied and sits in message content: never let it ping.
  const content = `**${pollTitle(poll)}**\n\n${status}`;
  const rows = ['yes', 'no', 'hard_no', 'abstain'].map((choice) =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(buildId('cast', poll.id, choice))
        .setLabel(choiceLabel(poll.type, choice))
        .setStyle(CHOICE_STYLES[choice])
    )
  );
  // The initiator's own ballot doubles as the place to call the poll off.
  if (isInitiator) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(buildId('withdraw', poll.id))
          .setLabel('Withdraw this poll (cancels it for everyone)')
          .setStyle(ButtonStyle.Danger)
      )
    );
  }
  return { content, components: rows, allowedMentions: { parse: [] } };
}

// Private polls only accept interactions from members who can see the
// subject channel — a forged customId must not leak or count.
async function canParticipate(ctx, interaction, poll) {
  if (!poll.is_private) return true;
  const channel = await interaction.guild.channels.fetch(poll.subject).catch(() => null);
  return channel ? memberCanView(channel, interaction.member) : false;
}

export async function handleVoteButton(ctx, interaction, [pollIdRaw]) {
  const poll = getPoll(ctx.db, Number(pollIdRaw));
  if (
    !poll ||
    poll.status !== 'open' ||
    poll.guild_id !== interaction.guildId ||
    !(await canParticipate(ctx, interaction, poll))
  ) {
    return interaction.reply({ content: 'This poll has closed.', flags: MessageFlags.Ephemeral });
  }
  const current = getVote(ctx.db, poll.id, interaction.user.id);
  await interaction.reply({
    ...buildBallot(poll, current, { isInitiator: interaction.user.id === poll.initiator_id }),
    flags: MessageFlags.Ephemeral,
  });
  trackBallot(ctx, poll, interaction, ctx.now?.() ?? Date.now());
}

export async function handleCastButton(ctx, interaction, [pollIdRaw, choice]) {
  const poll = getPoll(ctx.db, Number(pollIdRaw));
  if (
    !poll ||
    poll.status !== 'open' ||
    poll.guild_id !== interaction.guildId ||
    !(await canParticipate(ctx, interaction, poll))
  ) {
    return interaction.update({ content: 'This poll has closed.', components: [] });
  }
  castVote(ctx.db, poll.id, interaction.user.id, choice);
  // The ballot disappears once the vote is cast; the Vote button re-opens
  // it to view or change the vote.
  untrackBallot(poll.id, interaction.user.id);
  try {
    await interaction.deferUpdate?.();
    await interaction.deleteReply();
  } catch {
    try {
      await interaction.update({
        content: 'Vote recorded — use "Vote / change my vote" to see or change it.',
        components: [],
      });
    } catch {
      // interaction already acknowledged elsewhere; the vote is recorded
    }
  }

  // Public counts + everyone-has-voted early close. The population is the
  // whole guild for public polls, the channel's viewers for private ones.
  await refreshPollCounts(ctx, interaction.guild, poll).catch(() => {});
  const population = await pollPopulation(ctx.db, interaction.guild, poll).catch(() => null);
  if (population != null && countVoters(ctx.db, poll.id) >= population && ctx.closeDuePoll) {
    await ctx.closeDuePoll(poll);
  }
}
