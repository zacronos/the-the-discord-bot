// Poll rows. All functions take the open db handle as their first argument.
// Rows are returned as stored (snake_case columns).

const TYPES = new Set(['invite', 'permanent_channel']);
const FINAL_STATUSES = new Set(['passed', 'failed', 'vetoed', 'aborted']);

export function createPoll(
  db,
  { guildId, type, subject, initiatorId, channelId, closesAt, createdAt = Date.now() }
) {
  if (!TYPES.has(type)) throw new Error(`Unknown poll type: ${type}`);
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO polls (guild_id, type, subject, initiator_id, channel_id, created_at, closes_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(guildId, type, subject, initiatorId, channelId, createdAt, closesAt);
  return getPoll(db, Number(lastInsertRowid));
}

export function getPoll(db, id) {
  return db.prepare('SELECT * FROM polls WHERE id = ?').get(id);
}

export function setMessageId(db, id, messageId) {
  db.prepare('UPDATE polls SET message_id = ? WHERE id = ?').run(messageId, id);
}

export function listDue(db, now) {
  return db
    .prepare("SELECT * FROM polls WHERE status = 'open' AND closes_at <= ? ORDER BY closes_at, id")
    .all(now);
}

export function listOpen(db, guildId) {
  return db.prepare("SELECT * FROM polls WHERE status = 'open' AND guild_id = ? ORDER BY id").all(guildId);
}

// Moves a poll to a final status. Returns false if the poll was already
// closed (so double-closing is a harmless no-op). The 'closing' state is the
// close pipeline's in-flight claim (Phase 4).
export function closePoll(db, id, status, vetoCount = null, closedAt = Date.now()) {
  if (!FINAL_STATUSES.has(status)) throw new Error(`Invalid poll close status: ${status}`);
  const { changes } = db
    .prepare(
      `UPDATE polls SET status = ?, veto_count = ?, closed_at = ?
       WHERE id = ? AND status IN ('open', 'closing')`
    )
    .run(status, vetoCount, closedAt, id);
  return changes > 0;
}
