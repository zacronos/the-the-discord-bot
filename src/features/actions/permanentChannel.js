// Success action for permanence polls: move the voted-on channel into the
// category for its kind (text vs voice, autodetected) and sync its
// permission overwrites with it (spec).
import { getConfig } from '../../store/guildConfig.js';
import { channelKind, permanentCategoryFor } from '../configCommands.js';

export async function permanentChannelAction(ctx, guild, poll) {
  const cfg = getConfig(ctx.db, guild.id) ?? {};
  const channel = await guild.channels.fetch(poll.subject).catch(() => null);
  if (!channel) {
    throw new Error('the voted-on channel no longer exists');
  }
  const kind = channelKind(channel);
  const categoryId = permanentCategoryFor(cfg, kind);
  if (!categoryId) {
    throw new Error(
      'no permanent category is configured for voice channels — an admin should run /ttdb-config permanent-category kind:voice'
    );
  }
  const category = await guild.channels.fetch(categoryId).catch(() => null);
  if (!category) {
    throw new Error(
      `the configured ${kind}-channel permanent category no longer exists — an admin should re-run /ttdb-config permanent-category`
    );
  }
  await channel.setParent(category.id, {
    lockPermissions: true,
    reason: `The The Bot: permanence poll ${poll.id} passed`,
  });
  return `<#${channel.id}> has been moved into <#${category.id}> with its permissions synced to the category.`;
}
