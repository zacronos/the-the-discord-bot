import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db.js';

// Scratch directory removed after the test. Databases opened inside it must
// be passed to `track` so the single cleanup hook closes them before the
// removal (Windows refuses to delete open files).
export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ttdb-test-'));
  const dbs = [];
  t.after(() => {
    for (const db of dbs) {
      try {
        db.close();
      } catch {
        // already closed by the test itself
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    track: (db) => {
      dbs.push(db);
      return db;
    },
  };
}

// Fresh database in a scratch directory; closed and removed after the test.
export function tempDb(t) {
  const { dir, track } = tempDir(t);
  return track(openDb(join(dir, 'data', 'test.sqlite3')));
}
