// Pending self-dismissals of ephemeral replies. Persisted so a bot restart
// inside the 14-minute window cannot lose the timer while the interaction
// token is still deletable.

export function addCleanup(db, { token, deleteAt, expiresAt }) {
  db.prepare(
    `INSERT INTO ephemeral_cleanups (token, delete_at, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET delete_at = excluded.delete_at, expires_at = excluded.expires_at`
  ).run(token, deleteAt, expiresAt);
}

export function listCleanups(db) {
  return db.prepare('SELECT * FROM ephemeral_cleanups ORDER BY delete_at').all();
}

export function removeCleanup(db, token) {
  return db.prepare('DELETE FROM ephemeral_cleanups WHERE token = ?').run(token).changes;
}
