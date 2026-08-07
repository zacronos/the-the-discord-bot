// Eligible voters = current non-bot members (Q2). Fetching the full member
// list is expensive, so counts are cached briefly per guild.
const cache = new Map();

export async function eligibleVoterCount(guild, { ttlMs = 60_000, now = Date.now() } = {}) {
  const hit = cache.get(guild.id);
  if (hit && now - hit.at < ttlMs) return hit.count;
  const members = await guild.members.fetch();
  let count = 0;
  for (const member of members.values()) {
    if (!member.user?.bot) count += 1;
  }
  cache.set(guild.id, { count, at: now });
  return count;
}

export function clearEligibilityCache() {
  cache.clear();
}
