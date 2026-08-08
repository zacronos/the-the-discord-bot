// Channels awaiting deletion after a passed deletion poll. One row per
// channel; the sweep executes rows whose delete_at has passed (including at
// startup, covering time the bot spent offline).

export function scheduleDeletion(db, { channelId, guildId, deleteAt, pollId = null }) {
  db.prepare(
    `INSERT INTO scheduled_deletions (channel_id, guild_id, poll_id, delete_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET guild_id = excluded.guild_id, poll_id = excluded.poll_id, delete_at = excluded.delete_at`
  ).run(channelId, guildId, pollId, deleteAt);
}

export function listDueDeletions(db, now) {
  return db.prepare('SELECT * FROM scheduled_deletions WHERE delete_at <= ? ORDER BY delete_at').all(now);
}

export function removeScheduledDeletion(db, channelId) {
  return db.prepare('DELETE FROM scheduled_deletions WHERE channel_id = ?').run(channelId).changes;
}
