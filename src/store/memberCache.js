// Persisted snapshot of a guild's member list (ids + bot flags) with its
// expiration timestamp, so the rate-limited REQUEST_GUILD_MEMBERS gateway
// command doesn't have to be re-spent after a bot restart.

export function setMemberCache(db, guildId, entries, eligibleCount, expiresAt) {
  db.prepare(
    `INSERT INTO member_cache (guild_id, members_json, eligible_count, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET members_json = excluded.members_json,
       eligible_count = excluded.eligible_count, expires_at = excluded.expires_at`
  ).run(guildId, JSON.stringify(entries), eligibleCount, expiresAt);
}

// Returns { members: Map<id, {user:{bot}}>, count, expiresAt } or null when
// absent/expired.
export function getMemberCache(db, guildId, now) {
  const row = db
    .prepare('SELECT members_json, eligible_count, expires_at FROM member_cache WHERE guild_id = ? AND expires_at > ?')
    .get(guildId, now);
  if (!row) return null;
  const members = new Map();
  for (const [id, bot] of JSON.parse(row.members_json)) {
    members.set(id, { user: { bot: Boolean(bot) } });
  }
  return { members, count: row.eligible_count, expiresAt: row.expires_at };
}

export function clearMemberCache(db) {
  db.prepare('DELETE FROM member_cache').run();
}
