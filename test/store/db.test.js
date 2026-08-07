import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../../src/db.js';
import { tempDir } from './helpers.js';

test('openDb creates parent directories, the file, and the schema', (t) => {
  const { dir, track } = tempDir(t);
  const path = join(dir, 'nested', 'data', 'ttdb.sqlite3');
  const db = track(openDb(path));

  assert.ok(existsSync(path), 'database file should exist');
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  for (const expected of ['guild_config', 'polls', 'votes']) {
    assert.ok(tables.includes(expected), `missing table: ${expected}`);
  }
});

test('openDb is idempotent: reopening the same file keeps data intact', (t) => {
  const { dir, track } = tempDir(t);
  const path = join(dir, 'ttdb.sqlite3');

  const first = track(openDb(path));
  first.prepare('INSERT INTO guild_config (guild_id, updated_at) VALUES (?, ?)').run('g1', 111);
  first.close();

  const second = track(openDb(path));
  const row = second.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get('g1');
  assert.equal(row.updated_at, 111);
});
