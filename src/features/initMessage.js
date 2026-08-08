// The per-guild "start a poll" message: one embed plus a button per poll
// feature. The footer carries a marker + short hash of the current content,
// so the message can be re-found after a database loss AND edited in place
// whenever the code's version of the message changes. Only exists once the
// four required settings are complete (Q8).
import { createHash } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { buildId } from '../discord/customId.js';
import { getConfig, setConfig } from '../store/guildConfig.js';
import {
  formatThreshold,
  missingRequiredSettings,
  thresholdFor,
} from './configCommands.js';

export const INIT_MARKER = 'ttdb-init-v1';

const TITLE = 'Start a community poll';
const DESCRIPTION = [
  [
    'Use the buttons below to put a question to the whole server. Votes are',
    '**anonymous** — nobody can see how anyone voted. While a poll runs, only',
    'who started it, what it asks, response counts, and the closing time are',
    'public.',
  ].join(' '),
  'Results are delivered privately to whoever started the poll, and then the poll is deleted.',
].join('\n\n');
const BUTTONS = [
  { customId: buildId('start', 'invite'), label: 'Start a vote on inviting someone', style: ButtonStyle.Primary },
  {
    customId: buildId('start', 'permchan'),
    label: 'Start a vote on making a channel permanent',
    style: ButtonStyle.Secondary,
  },
];

// How votes become points. Config-derived: changing hard-no-weight changes
// this text, which changes the content hash, which edits stored messages.
function pointsParagraph(cfg) {
  const hardNo =
    cfg?.hard_no_weight == null || cfg.hard_no_weight === 'veto'
      ? '• Hard no  =>  **vetoes the poll** (it fails outright if there are any vetoes at closing)'
      : `• Hard no  =>  **${cfg.hard_no_weight.replace('-', '−')}**`;
  return [
    '__When a poll closes, votes are totaled as points__',
    '• Yes  =>  **+1**',
    '• No  =>  **−1**',
    '• Abstain  =>  **0**',
    hardNo,
  ].join('\n');
}

// The currently-configured pass thresholds, one bullet per poll type.
function thresholdList(cfg) {
  const line = (label, spec) => `• ${label}: ${spec ? `_${formatThreshold(spec)}_` : '_not set_'}`;
  return [
    '__Current pass thresholds__',
    'The point total at poll closing must be at least:',
    line('Invite polls', thresholdFor(cfg, 'invite')),
    line('Channel-permanence polls', thresholdFor(cfg, 'permanent_channel')),
  ].join('\n');
}

// Deterministic fingerprint of everything user-visible in the message. The
// footer itself is excluded (it contains this hash).
const contentHash = (description) =>
  createHash('sha256')
    .update(JSON.stringify([TITLE, description, BUTTONS.map((b) => [b.customId, b.label, b.style])]))
    .digest('hex')
    .slice(0, 8);

export function buildInitMessage(cfg = {}) {
  const description = [DESCRIPTION, pointsParagraph(cfg), thresholdList(cfg)].join('\n\n');
  const embed = new EmbedBuilder()
    .setTitle(TITLE)
    .setDescription(description)
    .setFooter({ text: `${INIT_MARKER} ${contentHash(description)}` });
  const row = new ActionRowBuilder().addComponents(
    BUTTONS.map((b) =>
      new ButtonBuilder().setCustomId(b.customId).setLabel(b.label).setStyle(b.style)
    )
  );
  return { embeds: [embed], components: [row] };
}

// Idempotent: (1) keep the stored message if it still exists; (2) adopt an
// orphaned marker message (survives db loss); (3) post fresh. When the poll
// channel changed, the old channel's message is deleted best-effort first.
// Any found message whose content differs from what the code currently
// sends (footer hash mismatch) is edited in place.
export async function ensureInitMessage(ctx, guild) {
  const { db } = ctx;
  let cfg = getConfig(db, guild.id);
  if (!cfg || missingRequiredSettings(cfg).length > 0) return null;

  const desired = buildInitMessage(cfg);
  const desiredFooter = desired.embeds[0].data.footer.text;
  const footerOf = (message) => message.embeds?.[0]?.footer?.text ?? '';
  const syncContent = async (message) => {
    if (footerOf(message) !== desiredFooter) await message.edit(desired);
    return message;
  };

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
    if (existing) return syncContent(existing);
  }

  const botId = guild.client.user.id;
  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (recent) {
    for (const message of recent.values()) {
      if (message.author?.id === botId && footerOf(message).startsWith(INIT_MARKER)) {
        setConfig(db, guild.id, { init_message_id: message.id, init_channel_id: channel.id });
        return syncContent(message);
      }
    }
  }

  const sent = await channel.send(desired);
  setConfig(db, guild.id, { init_message_id: sent.id, init_channel_id: channel.id });
  return sent;
}
