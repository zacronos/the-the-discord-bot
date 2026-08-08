// Application-global key/value state (e.g. the last-pushed app icon hash).

export function getAppState(db, key) {
  return db.prepare('SELECT value FROM app_state WHERE key = ?').get(key)?.value;
}

export function setAppState(db, key, value) {
  db.prepare(
    'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}
