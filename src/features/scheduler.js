// The sweep runs once per hour, on the hour (D5) — every minute in test
// mode. Each sweep: close due polls, then refresh (or abort) the remaining
// open ones. Startup runs an immediate catch-up sweep for downtime.
import { HOUR_MS, MINUTE_MS, msUntilNextBoundary } from '../util/time.js';
import { getConfig } from '../store/guildConfig.js';
import { listDue, listOpenAll } from '../store/polls.js';
import { listDueDeletions, removeScheduledDeletion } from '../store/scheduledDeletions.js';
import { runDailyPermissionSweep } from './channelRegistry.js';
import { allPermanentCategoryIds } from './configCommands.js';
import { abortPoll } from './pollClose.js';
import { refreshPollCounts } from './pollMessage.js';

export async function runSweep(ctx, now = Date.now()) {
  for (const poll of listDue(ctx.db, now)) {
    try {
      await ctx.closeDuePoll(poll);
    } catch (err) {
      console.error(`[ttdb] closing poll ${poll.id} failed:`, err);
    }
  }
  for (const poll of listOpenAll(ctx.db)) {
    try {
      const guild = await ctx.client.guilds.fetch(poll.guild_id);
      const channel = await guild.channels.fetch(poll.channel_id).catch(() => null);
      const message = poll.message_id
        ? await channel?.messages.fetch(poll.message_id).catch(() => null)
        : null;
      if (!channel || !message) {
        await abortPoll(ctx, poll, 'its message was deleted');
        continue;
      }
      await refreshPollCounts(ctx, guild, poll, { force: true, now });
    } catch (err) {
      console.error(`[ttdb] sweep refresh for poll ${poll.id} failed:`, err);
    }
  }
  // Scheduled channel deletions (from passed deletion polls). A failed
  // delete keeps its row and is retried every sweep; a vanished channel
  // just clears the row.
  for (const row of listDueDeletions(ctx.db, now)) {
    try {
      const guild = await ctx.client.guilds.fetch(row.guild_id).catch(() => null);
      const channel = await guild?.channels.fetch(row.channel_id).catch(() => null);
      if (channel) {
        // Last look before the axe: a channel that has joined a permanent
        // group since its poll passed (promotion or a manual move) is spared.
        const cfg = getConfig(ctx.db, row.guild_id);
        if (allPermanentCategoryIds(cfg).has(channel.parentId)) {
          console.log(
            `[ttdb] dropping scheduled deletion of channel ${row.channel_id}: it now lives in a permanent group`
          );
          removeScheduledDeletion(ctx.db, row.channel_id);
          continue;
        }
        await channel.delete(`The The Bot: deletion poll ${row.poll_id ?? '?'} passed`);
        console.log(`[ttdb] deleted channel ${row.channel_id} (scheduled by poll ${row.poll_id ?? '?'})`);
      }
      removeScheduledDeletion(ctx.db, row.channel_id);
    } catch (err) {
      console.error(`[ttdb] scheduled deletion of channel ${row.channel_id} failed:`, err);
    }
  }
  // Creator-only-deletion drift correction; internally gated to once a day.
  try {
    await runDailyPermissionSweep(ctx, now);
  } catch (err) {
    console.error('[ttdb] daily permission sweep failed:', err);
  }
}

export function startScheduler(ctx) {
  const unit = ctx.env?.testMode ? MINUTE_MS : HOUR_MS;
  const tick = () => runSweep(ctx).catch((err) => console.error('[ttdb] sweep failed:', err));
  tick(); // startup catch-up for polls that came due while the bot was down
  let interval = null;
  const alignment = setTimeout(() => {
    tick();
    interval = setInterval(tick, unit);
  }, msUntilNextBoundary(unit, Date.now()));
  return {
    stop() {
      clearTimeout(alignment);
      if (interval) clearInterval(interval);
    },
  };
}
