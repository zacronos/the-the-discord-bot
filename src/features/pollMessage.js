// The public poll message. Per spec it reveals only: who started the poll,
// what it asks, response counts, and when it closes. Voting happens through
// the single button; the options never appear publicly. User-supplied
// subjects render inside the embed only, where mentions cannot ping — the
// content pings @everyone intentionally and allows nothing else.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { buildId } from '../discord/customId.js';
import { getConfig } from '../store/guildConfig.js';
import { deletionKind } from '../polls/threshold.js';
import { countVoters } from '../store/votes.js';
import {
  deletionThresholdFor,
  formatThreshold,
  hardNoDescription,
  thresholdFor,
} from './configCommands.js';
import { pollPopulation } from './eligibility.js';

export function pollTitle(poll) {
  if (poll.type === 'invite') return `Should we invite ${poll.subject} to the server?`;
  if (poll.type === 'delete_channel') return `Should <#${poll.subject}> be deleted?`;
  return `Should <#${poll.subject}> be made permanent?`;
}

// The scoring a voter is signing up for, kept current by every refresh so
// a mid-poll config change is visible instead of silent. Resolved with the
// same logic the close pipeline uses.
export async function pollRulesFor(ctx, guild, poll) {
  const cfg = getConfig(ctx.db, guild.id) ?? {};
  let threshold;
  let hardNoPart = `Hard no ${hardNoDescription(cfg)}`;
  if (poll.type === 'delete_channel') {
    const kind = await deletionKind(guild, cfg, poll.subject);
    threshold = deletionThresholdFor(cfg, kind);
    // Hard no is reserved for permanent-category deletions.
    if (kind === 'other') hardNoPart = 'Hard no **not available** on this poll';
  } else {
    threshold = thresholdFor(cfg, poll.type);
  }
  const votesLine = `Yes **+1** · No **−1** · Abstain **0** · ${hardNoPart}`;
  const passLine = threshold
    ? `Passes when the point total at close is at least **${formatThreshold(threshold)}**.`
    : "Can't pass yet — this poll type's pass threshold is not configured.";
  return `${votesLine}\n${passLine}`;
}

export function renderPollMessage(poll, { responded = 0, eligible = null, rules = null } = {}) {
  const awaiting = eligible == null ? null : Math.max(0, eligible - responded);
  const closesSec = Math.floor(poll.closes_at / 1000);
  const paragraphs = [
    'Vote privately with the button below — votes are anonymous, and you can change yours until the poll closes.',
  ];
  // Permanence lifts a private channel's view deny — voters must know.
  if (poll.is_private && poll.type === 'permanent_channel') {
    paragraphs.push(
      '⚠️ **If this poll passes, this channel will become public** — visible to everyone on the server.'
    );
  }
  const embed = new EmbedBuilder()
    .setTitle(pollTitle(poll))
    .setDescription(paragraphs.join('\n\n'))
    .addFields(
      { name: 'Started by', value: `<@${poll.initiator_id}>`, inline: true },
      {
        name: 'Responses',
        value: awaiting == null ? `${responded} voted` : `${responded} voted · ${awaiting} awaiting`,
        inline: true,
      },
      { name: 'Closes', value: `<t:${closesSec}:F> (<t:${closesSec}:R>)`, inline: true }
    )
    .setFooter({ text: `ttdb-poll-${poll.id}` });
  if (rules) embed.addFields({ name: 'Pass rules', value: rules });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildId('vote', poll.id))
      .setLabel('Vote / change my vote')
      .setStyle(ButtonStyle.Primary)
  );
  return { content: '@everyone', allowedMentions: { parse: ['everyone'] }, embeds: [embed], components: [row] };
}

// Public count refreshes are throttled per poll so vote bursts don't hammer
// the edit endpoint. Edits touch only the embed: no re-ping, no content churn.
const lastRefresh = new Map();
const THROTTLE_MS = 5_000;

export async function refreshPollCounts(ctx, guild, poll, { force = false, now = Date.now() } = {}) {
  const last = lastRefresh.get(poll.id) ?? 0;
  if (!force && now - last < THROTTLE_MS) return false;
  lastRefresh.set(poll.id, now);

  const channel = await guild.channels.fetch(poll.channel_id ?? poll.channelId);
  const message = await channel.messages.fetch(poll.message_id);
  const responded = countVoters(ctx.db, poll.id);
  const eligible = await pollPopulation(ctx.db, guild, poll).catch(() => null);
  const rules = await pollRulesFor(ctx, guild, poll).catch(() => null);
  await message.edit({ embeds: renderPollMessage(poll, { responded, eligible, rules }).embeds });
  return true;
}

export function clearRefreshThrottle() {
  lastRefresh.clear();
}
