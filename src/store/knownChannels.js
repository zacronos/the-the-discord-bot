// Every channel the bot has seen, with its creator when knowable. Rows are
// added by the ChannelCreate listener and the startup scan, and drive the
// creator-only-deletion permission enforcement.

export function recordKnownChannel(db, { channelId, guildId, creatorId = null, recordedAt }) {
  db.prepare(
    `INSERT INTO known_channels (channel_id, guild_id, creator_id, recorded_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET
       guild_id = excluded.guild_id,
       creator_id = COALESCE(excluded.creator_id, known_channels.creator_id)`
  ).run(channelId, guildId, creatorId, recordedAt);
}

export function getKnownChannel(db, channelId) {
  return db.prepare('SELECT * FROM known_channels WHERE channel_id = ?').get(channelId);
}

export function listKnownChannels(db, guildId) {
  return db
    .prepare('SELECT * FROM known_channels WHERE guild_id = ? ORDER BY recorded_at, channel_id')
    .all(guildId);
}

export function removeKnownChannel(db, channelId) {
  return db.prepare('DELETE FROM known_channels WHERE channel_id = ?').run(channelId).changes;
}
