import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../../src/db.js';
import { runDailyBackup } from '../../src/features/backup.js';
import { getAppState } from '../../src/store/appState.js';
import { tempDir } from '../store/helpers.js';

const DAY = 24 * 3_600_000;

function world(t) {
  const { dir, track } = tempDir(t);
  const dbPath = join(dir, 'data', 'live.sqlite3');
  const db = track(openDb(dbPath));
  return { db, track, backupsDir: join(dir, 'data', 'backups'), ctx: { db, env: { dbPath } } };
}

test('runDailyBackup writes a dated copy once per day and stamps app_state', (t) => {
  const { db, backupsDir, ctx } = world(t);
  assert.equal(runDailyBackup(ctx, DAY), true);
  assert.deepEqual(readdirSync(backupsDir), ['the-the-1970-01-02.sqlite3']);
  assert.equal(getAppState(db, 'backup_at'), String(DAY));

  assert.equal(runDailyBackup(ctx, DAY + 3_600_000), false, 'an hour later: skipped');
  assert.equal(readdirSync(backupsDir).length, 1);

  assert.equal(runDailyBackup(ctx, DAY + DAY), true, 'a day later: a second copy');
  assert.equal(readdirSync(backupsDir).length, 2);
});

test('the backup is a readable database snapshot', (t) => {
  const { db, track, backupsDir, ctx } = world(t);
  db.prepare("INSERT INTO app_state (key, value) VALUES ('probe', 'hello')").run();
  runDailyBackup(ctx, DAY);
  const copy = track(openDb(join(backupsDir, 'the-the-1970-01-02.sqlite3')));
  assert.equal(
    copy.prepare("SELECT value FROM app_state WHERE key = 'probe'").get().value,
    'hello',
    'the snapshot carries the live data'
  );
});

test('retention keeps only the newest seven backups', (t) => {
  const { backupsDir, ctx } = world(t);
  for (let day = 1; day <= 9; day += 1) {
    runDailyBackup(ctx, day * DAY);
  }
  const files = readdirSync(backupsDir).sort();
  assert.equal(files.length, 7);
  assert.equal(files[0], 'the-the-1970-01-04.sqlite3', 'the two oldest were pruned');
  assert.equal(files.at(-1), 'the-the-1970-01-10.sqlite3');
});

test('an in-memory or unconfigured database is never backed up', (t) => {
  const { db } = world(t);
  assert.equal(runDailyBackup({ db, env: { dbPath: ':memory:' } }, DAY), false);
  assert.equal(runDailyBackup({ db, env: {} }, DAY), false);
});
