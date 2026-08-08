// The close pipeline: claim → prune departed voters → tally → follow-up
// action → DMs → delete poll message → finalize + purge votes (Q5).
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { buildId } from '../discord/customId.js';
import { tallyPoll } from '../polls/tally.js';
import { getConfig } from '../store/guildConfig.js';
import { claimForClose, closePoll, getPoll, listOpen, releaseClose } from '../store/polls.js';
import {
  countByChoice,
  countVoters,
  deleteVote,
  deleteVotes,
  listVoters,
  listVotersByChoice,
} from '../store/votes.js';
import { deleteBallots } from './ballot.js';
import { thresholdFor } from './configCommands.js';
import { eligibleVoterCount } from './eligibility.js';

const describePoll = (poll) =>
  poll.type === 'invite' ? `inviting **${poll.subject}**` : `making <#${poll.subject}> permanent`;

// The initiator learns pass/fail (and the veto count when vetoed) — never
// vote totals.
export function buildResultDm(poll, outcome, vetoCount, actionNote) {
  const about = describePoll(poll);
  switch (outcome) {
    case 'vetoed':
      return (
        `Your poll about ${about} was vetoed by ${vetoCount} member(s), so it did not pass. ` +
        'Please refrain from starting this poll again unless community concerns can be alleviated through private conversation.'
      );
    case 'failed':
      return (
        `Your poll about ${about} did not pass. ` +
        'Please refrain from starting it again unless community concerns can be alleviated.'
      );
    case 'passed':
      return `🎉 Your poll about ${about} passed!${actionNote ? `\n${actionNote}` : ''}`;
    default:
      return `Your poll about ${about} was cancelled.`;
  }
}

const buildVetoerDm = (poll) =>
  `The poll about ${describePoll(poll)} failed because of your veto. ` +
  `It may be helpful to privately discuss your concerns with <@${poll.initiator_id}>, who started it.`;

async function sendDm(ctx, userId, content) {
  try {
    const user = await ctx.client.users.fetch(userId);
    await user.send(content);
    return true;
  } catch {
    return false;
  }
}

// Q4 fallback: a notice that reveals nothing about the outcome.
async function postDmFallback(ctx, guild, poll) {
  try {
    const channel = await guild.channels.fetch(poll.channel_id);
    await channel.send({
      content:
        `<@${poll.initiator_id}> I couldn't DM you the result of your poll — enable ` +
        `"Direct Messages from server members" for this server, then press the button.`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(buildId('resend', poll.id))
            .setLabel('Resend result')
            .setStyle(ButtonStyle.Primary)
        ),
      ],
      allowedMentions: { users: [poll.initiator_id] },
    });
  } catch {
    // channel gone; nothing else we can do
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function closePollPipeline(ctx, poll) {
  if (!claimForClose(ctx.db, poll.id)) return false;
  const sleep = ctx.sleep ?? defaultSleep;
  const now = ctx.now?.() ?? Date.now();

  const guild = await ctx.client.guilds.fetch(poll.guild_id).catch(() => null);
  if (!guild) {
    closePoll(ctx.db, poll.id, 'aborted', null, now);
    deleteVotes(ctx.db, poll.id);
    return true;
  }
  const cfg = getConfig(ctx.db, guild.id) ?? {};

  // Q2: only current members count — drop votes from anyone who left.
  const members = await guild.members.fetch().catch(() => null);
  if (members) {
    for (const userId of listVoters(ctx.db, poll.id)) {
      if (!members.has(userId)) deleteVote(ctx.db, poll.id, userId);
    }
  }

  const eligible = await eligibleVoterCount(guild, { now }).catch(() => null);
  const threshold = thresholdFor(cfg, poll.type) ?? { type: 'count', value: Number.POSITIVE_INFINITY };
  if (eligible == null && threshold.type === 'percent') {
    // A transient member-count failure must not decide a percent-threshold
    // poll either way — put it back and let the next sweep retry.
    releaseClose(ctx.db, poll.id);
    console.warn(`[ttdb] poll ${poll.id}: member count unavailable; deferring close to the next sweep`);
    return false;
  }
  const votersCount = countVoters(ctx.db, poll.id);
  const counts = countByChoice(ctx.db, poll.id);
  const result = tallyPoll({
    counts,
    hardNoWeight: cfg.hard_no_weight,
    threshold,
    eligibleCount: eligible ?? 0,
  });
  console.log(
    `[ttdb] poll ${poll.id} (${poll.type}) closed: ${result.outcome} — ${votersCount} voter(s), total ${result.total}, target ${result.target}, eligible ${eligible ?? 'unknown'}`
  );
  const vetoerIds = result.outcome === 'vetoed' ? listVotersByChoice(ctx.db, poll.id, 'hard_no') : [];

  let actionNote = null;
  if (result.outcome === 'passed') {
    const action = ctx.actions?.[poll.type];
    if (action) {
      try {
        actionNote = await action(ctx, guild, poll);
      } catch (err) {
        actionNote = `⚠️ The follow-up action failed: ${err.message}. An admin may need to do it manually.`;
      }
    }
  }

  const delivered = await sendDm(ctx, poll.initiator_id, buildResultDm(poll, result.outcome, result.vetoCount, actionNote));
  if (!delivered) await postDmFallback(ctx, guild, poll);
  for (const vetoerId of vetoerIds) {
    await sleep(500);
    await sendDm(ctx, vetoerId, buildVetoerDm(poll));
  }

  try {
    const channel = await guild.channels.fetch(poll.channel_id);
    const message = await channel.messages.fetch(poll.message_id);
    await message.delete();
  } catch {
    // message or channel already gone
  }
  await deleteBallots(poll.id, now); // best-effort: only recent tokens are still deletable

  closePoll(ctx.db, poll.id, result.outcome, result.vetoCount, now);
  deleteVotes(ctx.db, poll.id); // Q5: no per-user data survives the close
  return true;
}

// 4.4: an open poll whose message/channel vanished is cancelled, not tallied.
export async function abortPoll(ctx, poll, reason) {
  if (!claimForClose(ctx.db, poll.id)) return false;
  const now = ctx.now?.() ?? Date.now();
  closePoll(ctx.db, poll.id, 'aborted', null, now);
  deleteVotes(ctx.db, poll.id);
  await deleteBallots(poll.id, now);
  await sendDm(
    ctx,
    poll.initiator_id,
    `Your poll about ${describePoll(poll)} was cancelled because ${reason}. You can start a new one from the poll channel.`
  );
  return true;
}

// 7.3: the bot was removed from a guild — its open polls can never conclude.
export async function handleGuildLeave(ctx, guild) {
  for (const poll of listOpen(ctx.db, guild.id)) {
    await abortPoll(ctx, poll, 'the bot was removed from the server');
  }
}

// Q4: the fallback notice's button — usable only by the initiator; replays
// the stored outcome (the poll row keeps status + veto_count).
export async function handleResendButton(ctx, interaction, [pollIdRaw]) {
  const poll = getPoll(ctx.db, Number(pollIdRaw));
  if (!poll) {
    return interaction.reply({ content: 'That poll no longer exists.', flags: MessageFlags.Ephemeral });
  }
  if (interaction.user.id !== poll.initiator_id) {
    return interaction.reply({
      content: 'Only the poll initiator can use this button.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const delivered = await sendDm(
    ctx,
    poll.initiator_id,
    buildResultDm(poll, poll.status, poll.veto_count ?? 0, null)
  );
  return interaction.reply({
    content: delivered
      ? '✅ Result re-sent — check your DMs.'
      : '⚠️ I still can\'t DM you — check that "Direct Messages from server members" is enabled for this server.',
    flags: MessageFlags.Ephemeral,
  });
}
