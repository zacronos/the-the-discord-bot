// The threshold a poll must beat, resolved the same way everywhere it is
// shown or judged. Deletion polls have two bars, picked by where the
// channel lives right now — a vanished channel resolves as 'other' (the
// outcome is moot; the follow-up action reports the missing channel).
import {
  deletionThresholdFor,
  managedPermanentCategoryIds,
  thresholdFor,
} from '../features/configCommands.js';

// Which deletion bar applies to this subject channel, right now.
export async function deletionKind(guild, cfg, channelId) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  return channel && managedPermanentCategoryIds(cfg).has(channel.parentId) ? 'permanent' : 'other';
}

export async function resolvePollThreshold(guild, cfg, poll) {
  if (poll.type !== 'delete_channel') return thresholdFor(cfg, poll.type);
  return deletionThresholdFor(cfg, await deletionKind(guild, cfg, poll.subject));
}
