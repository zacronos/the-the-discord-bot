// Success action for invite polls: a single-use invite link, valid 7 days,
// delivered to the initiator via the result DM. Landing channel (Q3):
// configured invite-channel → server system channel → poll channel.
import { getConfig } from '../../store/guildConfig.js';

export async function inviteAction(ctx, guild, poll) {
  const cfg = getConfig(ctx.db, guild.id) ?? {};
  const candidates = [cfg.invite_channel_id, guild.systemChannelId, cfg.poll_channel_id].filter(Boolean);
  let channel = null;
  for (const id of candidates) {
    channel = await guild.channels.fetch(id).catch(() => null);
    if (channel) break;
  }
  if (!channel) {
    throw new Error('no usable channel found to attach the invite link to');
  }
  const invite = await channel.createInvite({
    maxUses: 1,
    maxAge: 604_800, // 7 days — the API maximum for a finite expiry
    unique: true,
    reason: `The The Bot: invite poll ${poll.id} passed`,
  });
  return `Here is a single-use invite link, valid for 7 days, to send to ${poll.subject}: ${invite.url}`;
}
