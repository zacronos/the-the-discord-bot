// Success action for permanence polls: move the voted-on channel into the
// configured category and sync its permission overwrites with it (spec).
import { getConfig } from '../../store/guildConfig.js';

export async function permanentChannelAction(ctx, guild, poll) {
  const cfg = getConfig(ctx.db, guild.id) ?? {};
  const channel = await guild.channels.fetch(poll.subject).catch(() => null);
  if (!channel) {
    throw new Error('the voted-on channel no longer exists');
  }
  const category = cfg.permanent_category_id
    ? await guild.channels.fetch(cfg.permanent_category_id).catch(() => null)
    : null;
  if (!category) {
    throw new Error('the configured permanent category no longer exists — an admin should re-run /ttdb-config permanent-category');
  }
  await channel.setParent(category.id, {
    lockPermissions: true,
    reason: `The The Bot: permanence poll ${poll.id} passed`,
  });
  return `<#${channel.id}> has been moved into <#${category.id}> with its permissions synced to the category.`;
}
