// Per-guild settings, one row per guild. All functions take the open db
// handle as their first argument.

const FIELDS = new Set([
  'poll_channel_id',
  'init_message_id',
  'init_channel_id',
  'hard_no_weight',
  'threshold_type',
  'threshold_value',
  'threshold_type_invite',
  'threshold_value_invite',
  'threshold_type_permchan',
  'threshold_value_permchan',
  'permanent_category_id',
  'permanent_category_text_id',
  'permanent_category_voice_id',
  'invite_channel_id',
  'poll_starter_role_id',
]);

export function getConfig(db, guildId) {
  return db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(guildId);
}

// Upserts the guild row, changing only the fields present in `patch`.
// Returns the resulting row.
export function setConfig(db, guildId, patch, now = Date.now()) {
  const keys = Object.keys(patch);
  for (const key of keys) {
    if (!FIELDS.has(key)) throw new Error(`Unknown config field: ${key}`);
  }
  const columns = ['guild_id', ...keys, 'updated_at'];
  const placeholders = columns.map(() => '?').join(', ');
  const updates = [...keys, 'updated_at'].map((key) => `${key} = excluded.${key}`).join(', ');
  db.prepare(
    `INSERT INTO guild_config (${columns.join(', ')}) VALUES (${placeholders})
     ON CONFLICT(guild_id) DO UPDATE SET ${updates}`
  ).run(guildId, ...keys.map((key) => patch[key]), now);
  return getConfig(db, guildId);
}
