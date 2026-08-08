// Success action for deletion polls: schedule the channel for deletion 24
// hours out (rounded up to the next wall-clock hour; 5 minutes and minute
// rounding in test mode) and warn the channel with the exact day/time. The
// sweep performs the deletion — at the scheduled hour, or at the next
// startup if the bot was offline then.
import { scheduleDeletion } from '../../store/scheduledDeletions.js';
import { HOUR_MS, MINUTE_MS, roundUpToNextHour } from '../../util/time.js';

export async function deleteChannelAction(ctx, guild, poll) {
  const channel = await guild.channels.fetch(poll.subject).catch(() => null);
  if (!channel) {
    throw new Error('the voted-on channel no longer exists');
  }
  const now = ctx.now?.() ?? Date.now();
  const testMode = ctx.env?.testMode;
  const delay = testMode ? 5 * MINUTE_MS : 24 * HOUR_MS;
  const deleteAt = roundUpToNextHour(now + delay, { testMode });
  scheduleDeletion(ctx.db, { channelId: channel.id, guildId: guild.id, deleteAt, pollId: poll.id });

  const sec = Math.floor(deleteAt / 1000);
  try {
    await channel.send({
      content: `⚠️ Following a community vote, this channel is scheduled for deletion on <t:${sec}:F> (<t:${sec}:R>).`,
      allowedMentions: { parse: [] },
    });
  } catch {
    // can't announce in the channel; the deletion is scheduled regardless
  }
  return `#${channel.name} (<#${channel.id}>) is scheduled for deletion on <t:${sec}:F> (<t:${sec}:R>).`;
}
