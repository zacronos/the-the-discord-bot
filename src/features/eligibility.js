// Guild member data, shared and cached. The gateway command behind
// guild.members.fetch() (opcode 8) is aggressively rate limited, so every
// consumer — departed-voter pruning, eligible-voter counting, embed
// refreshes — must share ONE fetch. The 10-minute TTL trades a slightly
// stale count (membership changes are rare) for staying far inside the
// rate budget even with minute-level test-mode sweeps.
const cache = new Map(); // guildId -> { members, count, at }
const DEFAULT_TTL_MS = 10 * 60_000;

export async function fetchGuildMembers(guild, { ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  const hit = cache.get(guild.id);
  if (hit && now - hit.at < ttlMs) return hit.members;
  const members = await guild.members.fetch();
  let count = 0;
  for (const member of members.values()) {
    if (!member.user?.bot) count += 1;
  }
  cache.set(guild.id, { members, count, at: now });
  return members;
}

// Eligible voters = current non-bot members (Q2).
export async function eligibleVoterCount(guild, opts = {}) {
  await fetchGuildMembers(guild, opts);
  return cache.get(guild.id).count;
}

export function clearEligibilityCache() {
  cache.clear();
}
