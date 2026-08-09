// Channel registry: every text/voice channel the bot can see, with its
// creator (from the audit log) when knowable. Recorded channels outside the
// managed permanent categories are locked so that only their creator — and
// administrators, whom channel overwrites cannot restrict — can delete
// them. Discord has no delete-only permission, so the lock is the Manage
// Channels bit: an @everyone deny plus a creator-only allow.
import { AuditLogEvent, ChannelType, PermissionFlagsBits } from 'discord.js';
import { DAY_MS, HOUR_MS } from '../util/time.js';
import { getConfig } from '../store/guildConfig.js';
import { getAppState, setAppState } from '../store/appState.js';
import {
  getKnownChannel,
  listKnownChannels,
  recordKnownChannel,
  removeKnownChannel,
} from '../store/knownChannels.js';
import { managedPermanentCategoryIds, otherPermanentCategoryIds } from './configCommands.js';

const ENFORCE_REASON = 'The The Bot: only the channel creator (and admins) may delete this channel';
const CREATE_LOOKUP_ATTEMPTS = 3;
const CREATE_LOOKUP_RETRY_MS = 1_500;
const BACKSCAN_PAGE_LIMIT = 10; // 10 × 100 entries ≫ the 45-day audit-log retention on a small server
const OVERWRITE_ROLE = 0;
const OVERWRITE_MEMBER = 1;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Tracked = a text or voice channel outside every "other" permanent group
// (those categories are externally managed — hands off entirely).
export function isTrackedChannel(cfg, channel) {
  if (!channel) return false;
  const type = channel.type ?? ChannelType.GuildText;
  if (type !== ChannelType.GuildText && type !== ChannelType.GuildVoice) return false;
  return !new Set(otherPermanentCategoryIds(cfg)).has(channel.parentId);
}

const entryTarget = (entry) => entry.targetId ?? entry.target?.id ?? null;
const entryExecutor = (entry) => entry.executorId ?? entry.executor?.id ?? null;

async function fetchCreateEntries(guild, { limit, before } = {}) {
  const logs = await guild
    .fetchAuditLogs({ type: AuditLogEvent.ChannelCreate, limit, before })
    .catch(() => null);
  return logs?.entries ?? new Map();
}

// One creation entry for a just-created channel. The audit-log write can lag
// the gateway event, so a miss is retried briefly before giving up.
async function creatorFromAuditLog(ctx, guild, channelId) {
  const sleep = ctx.sleep ?? defaultSleep;
  for (let attempt = 0; attempt < CREATE_LOOKUP_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(CREATE_LOOKUP_RETRY_MS);
    for (const entry of (await fetchCreateEntries(guild, { limit: 25 })).values()) {
      if (entryTarget(entry) === channelId) return entryExecutor(entry);
    }
  }
  return null;
}

// channelId -> executorId for every creation entry still in the audit log
// (retention ~45 days; older channels simply come back unknowable).
async function auditLogCreatorMap(guild) {
  const creators = new Map();
  let before;
  for (let page = 0; page < BACKSCAN_PAGE_LIMIT; page += 1) {
    const entries = await fetchCreateEntries(guild, { limit: 100, before });
    if (entries.size === 0) break;
    let oldest = null;
    for (const entry of entries.values()) {
      const target = entryTarget(entry);
      const executor = entryExecutor(entry);
      if (target && executor && !creators.has(target)) creators.set(target, executor);
      if (oldest === null || BigInt(entry.id) < BigInt(oldest)) oldest = entry.id;
    }
    if (entries.size < 100) break;
    before = oldest;
  }
  return creators;
}

// Aligns one channel with the creator-only-deletion policy, touching only
// the Manage Channels bit of each overwrite: @everyone gets a deny, the
// creator (while still a member) gets an allow, and every other allow is
// cleared. Returns a description of each correction made (empty = aligned).
// Exported for /ttdb-set-creator, which re-runs it after a transfer.
export async function enforceCreatorOnlyDeletion(guild, channel, creatorId) {
  const overwrites = channel.permissionOverwrites;
  if (!overwrites?.edit) return [];
  const everyoneId = guild.roles?.everyone?.id ?? guild.id;
  const cache = overwrites.cache ?? new Map();
  const changes = [];

  if (!cache.get(everyoneId)?.deny?.has(PermissionFlagsBits.ManageChannels)) {
    await overwrites.edit(everyoneId, { ManageChannels: false }, { reason: ENFORCE_REASON });
    changes.push('denied Manage Channels for @everyone');
  }

  if (creatorId && (await guild.members.fetch(creatorId).catch(() => null))) {
    if (!cache.get(creatorId)?.allow?.has(PermissionFlagsBits.ManageChannels)) {
      await overwrites.edit(
        creatorId,
        { ManageChannels: true },
        { type: OVERWRITE_MEMBER, reason: ENFORCE_REASON }
      );
      changes.push(`allowed Manage Channels for creator ${creatorId}`);
    }
  }

  for (const overwrite of cache.values()) {
    if (overwrite.id === everyoneId || overwrite.id === creatorId) continue;
    if (overwrite.allow?.has(PermissionFlagsBits.ManageChannels)) {
      await overwrites.edit(
        overwrite.id,
        { ManageChannels: null },
        { type: overwrite.type ?? OVERWRITE_ROLE, reason: ENFORCE_REASON }
      );
      changes.push(`cleared a foreign Manage Channels allow (${overwrite.id})`);
    }
  }
  return changes;
}

// Records the channel, then locks it unless it lives in a managed permanent
// category (community-owned channels are deletable via polls instead).
async function recordAndProtect(ctx, guild, channel, creatorId, now) {
  recordKnownChannel(ctx.db, {
    channelId: channel.id,
    guildId: guild.id,
    creatorId,
    recordedAt: now,
  });
  const cfg = getConfig(ctx.db, guild.id);
  if (managedPermanentCategoryIds(cfg).has(channel.parentId)) return;
  const stored = getKnownChannel(ctx.db, channel.id); // an earlier record may know the creator
  try {
    await enforceCreatorOnlyDeletion(guild, channel, stored?.creator_id ?? creatorId);
  } catch (err) {
    console.error(`[ttdb] creator-only lock for channel ${channel.id} failed:`, err);
  }
}

// Gateway ChannelCreate: record and lock immediately.
export async function handleChannelCreate(ctx, channel) {
  const guild = channel?.guild;
  if (!guild) return;
  const cfg = getConfig(ctx.db, guild.id);
  if (!isTrackedChannel(cfg, channel)) return;
  const creatorId = await creatorFromAuditLog(ctx, guild, channel.id);
  await recordAndProtect(ctx, guild, channel, creatorId, ctx.now?.() ?? Date.now());
}

// Gateway ChannelDelete: the row would only go stale.
export async function handleChannelDelete(ctx, channel) {
  if (!channel?.guild) return;
  removeKnownChannel(ctx.db, channel.id);
}

// Startup: record (and lock) every visible tracked channel the database
// does not know yet, resolving creators from one audit-log backscan.
export async function scanGuildChannels(ctx, guild, now = Date.now()) {
  const cfg = getConfig(ctx.db, guild.id);
  const channels = await guild.channels.fetch().catch(() => null);
  if (!channels) return { recorded: 0 };
  const unrecorded = [];
  for (const channel of channels.values()) {
    if (!isTrackedChannel(cfg, channel)) continue;
    if (getKnownChannel(ctx.db, channel.id)) continue;
    unrecorded.push(channel);
  }
  if (unrecorded.length === 0) return { recorded: 0 };
  const creators = await auditLogCreatorMap(guild);
  for (const channel of unrecorded) {
    await recordAndProtect(ctx, guild, channel, creators.get(channel.id) ?? null, now);
  }
  return { recorded: unrecorded.length };
}

// Re-aligns every recorded, still-existing, non-permanent channel; forgets
// vanished ones. Returns the channels corrected (for logging).
export async function sweepChannelPermissions(ctx, guild, now = Date.now()) {
  const cfg = getConfig(ctx.db, guild.id);
  const corrections = [];
  for (const row of listKnownChannels(ctx.db, guild.id)) {
    const channel = await guild.channels.fetch(row.channel_id).catch(() => null);
    if (!channel) {
      removeKnownChannel(ctx.db, row.channel_id);
      continue;
    }
    if (!isTrackedChannel(cfg, channel)) continue;
    if (managedPermanentCategoryIds(cfg).has(channel.parentId)) continue;
    try {
      const changes = await enforceCreatorOnlyDeletion(guild, channel, row.creator_id);
      if (changes.length > 0) corrections.push({ channelId: row.channel_id, changes });
    } catch (err) {
      console.error(`[ttdb] permission sweep for channel ${row.channel_id} failed:`, err);
    }
  }
  return corrections;
}

// Called from every hourly sweep; actually runs once per day (per hour in
// test mode). The timestamp is stamped up front so a failing guild cannot
// turn the daily sweep into an hourly retry storm.
export async function runDailyPermissionSweep(ctx, now = Date.now()) {
  const unit = ctx.env?.testMode ? HOUR_MS : DAY_MS;
  const last = Number(getAppState(ctx.db, 'perm_sweep_at') ?? 0);
  if (now - last < unit) return false;
  setAppState(ctx.db, 'perm_sweep_at', String(now));
  for (const guild of ctx.client?.guilds?.cache?.values?.() ?? []) {
    try {
      const corrections = await sweepChannelPermissions(ctx, guild, now);
      for (const { channelId, changes } of corrections) {
        console.log(`[ttdb] permission sweep corrected channel ${channelId}: ${changes.join('; ')}`);
      }
    } catch (err) {
      console.error(`[ttdb] permission sweep for guild ${guild.id} failed:`, err);
    }
  }
  return true;
}
