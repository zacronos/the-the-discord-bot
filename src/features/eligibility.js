// Guild member data, shared and cached. The gateway command behind
// guild.members.fetch() (opcode 8) is aggressively rate limited, so every
// consumer — departed-voter pruning, eligible-voter counting, embed
// refreshes — shares ONE fetch, cached for an hour and persisted to sqlite
// (with its expiration timestamp) so restarts don't re-spend the budget.
// The trade-off is a member count up to an hour stale; membership changes
// are rare and the sweep cadence is hourly anyway.
import { PermissionFlagsBits } from 'discord.js';
import { HOUR_MS } from '../util/time.js';
import { clearMemberCache, getMemberCache, setMemberCache } from '../store/memberCache.js';

const memory = new Map(); // guildId -> { members, count, expiresAt }

export async function fetchGuildMembers(db, guild, { ttlMs = HOUR_MS, now = Date.now() } = {}) {
  const hit = memory.get(guild.id);
  if (hit && now < hit.expiresAt) return hit.members;

  const stored = getMemberCache(db, guild.id, now);
  if (stored) {
    memory.set(guild.id, stored);
    return stored.members;
  }

  const fetched = await guild.members.fetch();
  const members = new Map();
  const entries = [];
  let count = 0;
  for (const [id, member] of fetched) {
    const bot = Boolean(member.user?.bot);
    members.set(id, { user: { bot } });
    entries.push([id, bot]);
    if (!bot) count += 1;
  }
  const expiresAt = now + ttlMs;
  memory.set(guild.id, { members, count, expiresAt });
  setMemberCache(db, guild.id, entries, count, expiresAt);
  return members;
}

// Eligible voters = current non-bot members (Q2).
export async function eligibleVoterCount(db, guild, opts = {}) {
  await fetchGuildMembers(db, guild, opts);
  return memory.get(guild.id).count;
}

// Clears the in-memory cache; pass the db to also drop persisted snapshots.
export function clearEligibilityCache(db) {
  memory.clear();
  if (db) clearMemberCache(db);
}

// A channel is private when the @everyone role cannot view it. Fail-public
// when the permission surface is missing (test fakes; real channels always
// have permissionsFor).
export function isPrivateChannel(guild, channel) {
  const everyone = guild.roles?.everyone;
  if (!everyone || typeof channel?.permissionsFor !== 'function') return false;
  const perms = channel.permissionsFor(everyone);
  return perms ? !perms.has(PermissionFlagsBits.ViewChannel) : true;
}

// Non-bot members who can view the channel. Needs real member objects (role
// data) so it reads the gateway cache, falling back to one real fetch when
// the cache is empty — private-channel polls are rare enough that this
// stays far inside the op8 rate budget.
export async function channelViewerCount(guild, channel) {
  let members = guild.members.cache;
  if (!members || members.size === 0) {
    members = await guild.members.fetch();
  }
  let count = 0;
  for (const member of members.values()) {
    if (member.user?.bot) continue;
    if (channel.permissionsFor?.(member)?.has(PermissionFlagsBits.ViewChannel)) count += 1;
  }
  return count;
}

// The voting population for a poll: the whole guild for public polls, the
// subject channel's viewers for private ones (null when the channel is gone
// and the population is therefore unknowable).
export async function pollPopulation(db, guild, poll, opts = {}) {
  if (!poll.is_private) return eligibleVoterCount(db, guild, opts);
  const channel = await guild.channels.fetch(poll.subject).catch(() => null);
  if (!channel) return null;
  return channelViewerCount(guild, channel);
}
