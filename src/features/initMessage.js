// The per-guild "start a poll" message: one embed (marked by a footer so it
// can be re-found after a database loss) plus a button per poll feature.
// Only exists once the four required settings are complete (Q8).
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { buildId } from '../discord/customId.js';
import { getConfig, setConfig } from '../store/guildConfig.js';
import { missingRequiredSettings } from './configCommands.js';

export const INIT_MARKER = 'ttdb-init-v1';

export function buildInitMessage() {
  const embed = new EmbedBuilder()
    .setTitle('Start a community poll')
    .setDescription(
      [
        'Use the buttons below to put a question to the whole server. Votes are',
        '**anonymous** — nobody can see how anyone voted. While a poll runs, only',
        'who started it, what it asks, response counts, and the closing time are',
        'public. Results are delivered privately to whoever started the poll.',
      ].join('\n')
    )
    .setFooter({ text: INIT_MARKER });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildId('start', 'invite'))
      .setLabel('Start a vote on inviting someone')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(buildId('start', 'permchan'))
      .setLabel('Start a vote on making a channel permanent')
      .setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row] };
}

// Idempotent: (1) keep the stored message if it still exists; (2) adopt an
// orphaned marker message (survives db loss); (3) post fresh. When the poll
// channel changed, the old channel's message is deleted best-effort first.
export async function ensureInitMessage(ctx, guild) {
  const { db } = ctx;
  let cfg = getConfig(db, guild.id);
  if (!cfg || missingRequiredSettings(cfg).length > 0) return null;

  if (cfg.init_message_id && cfg.init_channel_id && cfg.init_channel_id !== cfg.poll_channel_id) {
    try {
      const oldChannel = await guild.channels.fetch(cfg.init_channel_id);
      const oldMessage = await oldChannel?.messages.fetch(cfg.init_message_id);
      await oldMessage?.delete();
    } catch {
      // old channel or message already gone
    }
    cfg = setConfig(db, guild.id, { init_message_id: null, init_channel_id: null });
  }

  const channel = await guild.channels.fetch(cfg.poll_channel_id).catch(() => null);
  if (!channel) {
    throw new Error(
      `The configured poll channel no longer exists — set a new one with /ttdb-config poll-channel.`
    );
  }

  if (cfg.init_message_id) {
    const existing = await channel.messages.fetch(cfg.init_message_id).catch(() => null);
    if (existing) return existing;
  }

  const botId = guild.client.user.id;
  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (recent) {
    for (const message of recent.values()) {
      if (message.author?.id === botId && message.embeds?.[0]?.footer?.text === INIT_MARKER) {
        setConfig(db, guild.id, { init_message_id: message.id, init_channel_id: channel.id });
        return message;
      }
    }
  }

  const sent = await channel.send(buildInitMessage());
  setConfig(db, guild.id, { init_message_id: sent.id, init_channel_id: channel.id });
  return sent;
}
