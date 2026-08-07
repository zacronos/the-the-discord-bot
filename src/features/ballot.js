// The private ballot: an ephemeral message only the voter sees, showing
// their current vote and the four choices. Votes can change until close.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { buildId } from '../discord/customId.js';
import { getPoll } from '../store/polls.js';
import { castVote, countVoters, getVote } from '../store/votes.js';
import { eligibleVoterCount } from './eligibility.js';
import { refreshPollCounts } from './pollMessage.js';

const NO_LABELS = {
  invite: "No, I'd rather not invite them, but I won't object if enough people want to",
  permanent_channel: "No, I'd rather not, but I won't object if enough people want to",
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

const CHOICE_STYLES = {
  yes: ButtonStyle.Success,
  no: ButtonStyle.Secondary,
  hard_no: ButtonStyle.Danger,
  abstain: ButtonStyle.Secondary,
};

export function buildBallot(poll, currentChoice) {
  const content = currentChoice
    ? `Your current vote: **${choiceLabel(poll.type, currentChoice)}**\nOnly you can see this. You can change your vote until the poll closes.`
    : "You haven't voted yet. Only you can see this ballot — pick an option:";
  const rows = ['yes', 'no', 'hard_no', 'abstain'].map((choice) =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(buildId('cast', poll.id, choice))
        .setLabel(choiceLabel(poll.type, choice))
        .setStyle(CHOICE_STYLES[choice])
    )
  );
  return { content, components: rows };
}

export async function handleVoteButton(ctx, interaction, [pollIdRaw]) {
  const poll = getPoll(ctx.db, Number(pollIdRaw));
  if (!poll || poll.status !== 'open') {
    return interaction.reply({ content: 'This poll has closed.', flags: MessageFlags.Ephemeral });
  }
  const current = getVote(ctx.db, poll.id, interaction.user.id);
  return interaction.reply({ ...buildBallot(poll, current), flags: MessageFlags.Ephemeral });
}

export async function handleCastButton(ctx, interaction, [pollIdRaw, choice]) {
  const poll = getPoll(ctx.db, Number(pollIdRaw));
  if (!poll || poll.status !== 'open') {
    return interaction.update({ content: 'This poll has closed.', components: [] });
  }
  castVote(ctx.db, poll.id, interaction.user.id, choice);
  await interaction.update(buildBallot(poll, choice));

  // Public counts + everyone-has-voted early close (Q2: non-bot members).
  await refreshPollCounts(ctx, interaction.guild, poll).catch(() => {});
  const eligible = await eligibleVoterCount(interaction.guild).catch(() => null);
  if (eligible != null && countVoters(ctx.db, poll.id) >= eligible && ctx.closeDuePoll) {
    await ctx.closeDuePoll(poll);
  }
}
