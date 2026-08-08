import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Idempotent schema; every statement tolerates re-running on an existing file.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id TEXT PRIMARY KEY,
  poll_channel_id TEXT,
  init_message_id TEXT,
  init_channel_id TEXT,           -- where the init message actually lives

  hard_no_weight TEXT,            -- '-2'|'-3'|'-5'|'-10'|'veto'
  threshold_type TEXT,            -- legacy shared threshold: 'count'|'percent'
  threshold_value REAL,           -- (per-type columns below take precedence)
  threshold_type_invite TEXT,
  threshold_value_invite REAL,
  threshold_type_permchan TEXT,
  threshold_value_permchan REAL,
  threshold_type_delchan TEXT,
  threshold_value_delchan REAL,
  permanent_category_id TEXT,     -- legacy; text channels fall back to it
  permanent_category_text_id TEXT,
  permanent_category_voice_id TEXT,
  invite_channel_id TEXT,         -- optional (Q3); default landing = system channel
  poll_starter_role_id TEXT,      -- optional (Q6); null = anyone may start polls
  max_open_polls INTEGER,         -- optional; null = default cap of 10
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  type TEXT NOT NULL,             -- 'invite'|'permanent_channel'
  subject TEXT NOT NULL,          -- invitee name or channel id
  initiator_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  created_at INTEGER NOT NULL,
  closes_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- 'open'|'closing'|'passed'|'failed'|'vetoed'|'aborted'
  closed_at INTEGER,
  veto_count INTEGER
);
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS member_cache (
  guild_id TEXT PRIMARY KEY,
  members_json TEXT NOT NULL,  -- [[memberId, isBot], ...]
  eligible_count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS scheduled_deletions (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  poll_id INTEGER,
  delete_at INTEGER NOT NULL   -- executed by the sweep at/after this time
);
CREATE TABLE IF NOT EXISTS votes (
  poll_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  choice TEXT NOT NULL,           -- 'yes'|'no'|'hard_no'|'abstain'
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (poll_id, user_id)
);
`;

// Opens (creating if needed) the SQLite database at `path` and applies the
// schema. Callers pass the configured location (env.dbPath).
export function openDb(path) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  // Column additions for databases created by older schema versions.
  for (const alter of [
    'ALTER TABLE guild_config ADD COLUMN init_channel_id TEXT',
    'ALTER TABLE guild_config ADD COLUMN threshold_type_invite TEXT',
    'ALTER TABLE guild_config ADD COLUMN threshold_value_invite REAL',
    'ALTER TABLE guild_config ADD COLUMN threshold_type_permchan TEXT',
    'ALTER TABLE guild_config ADD COLUMN threshold_value_permchan REAL',
    'ALTER TABLE guild_config ADD COLUMN permanent_category_text_id TEXT',
    'ALTER TABLE guild_config ADD COLUMN permanent_category_voice_id TEXT',
    'ALTER TABLE guild_config ADD COLUMN max_open_polls INTEGER',
    'ALTER TABLE guild_config ADD COLUMN threshold_type_delchan TEXT',
    'ALTER TABLE guild_config ADD COLUMN threshold_value_delchan REAL',
  ]) {
    try {
      db.exec(alter);
    } catch {
      // column already exists (fresh schema or previously migrated)
    }
  }
  return db;
}
