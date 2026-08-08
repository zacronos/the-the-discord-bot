// The public poll message. Per spec it reveals only: who started the poll,
// what it asks, response counts, and when it closes. Voting happens through
// the single button; the options never appear publicly. User-supplied
// subjects render inside the embed only, where mentions cannot ping — the
// content pings @everyone intentionally and allows nothing else.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { buildId } from '../discord/customId.js';
import { countVoters } from '../store/votes.js';
import { eligibleVoterCount } from './eligibility.js';

export function pollTitle(poll) {
  if (poll.type === 'invite') return `Should we invite ${poll.subject} to the server?`;
  if (poll.type === 'delete_channel') return `Should <#${poll.subject}> be deleted?`;
  return `Should <#${poll.subject}> be made permanent?`;
}

export function renderPollMessage(poll, { responded = 0, eligible = null } = {}) {
  const awaiting = eligible == null ? null : Math.max(0, eligible - responded);
  const closesSec = Math.floor(poll.closes_at / 1000);
  const embed = new EmbedBuilder()
    .setTitle(pollTitle(poll))
    .setDescription(
      'Vote privately with the button below — votes are anonymous, and you can change yours until the poll closes.'
    )
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
  const eligible = await eligibleVoterCount(ctx.db, guild).catch(() => null);
  await message.edit({ embeds: renderPollMessage(poll, { responded, eligible }).embeds });
  return true;
}

export function clearRefreshThrottle() {
  lastRefresh.clear();
}
