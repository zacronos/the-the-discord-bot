// Daily database backup: a dated VACUUM INTO snapshot next to the live
// file (data/backups/), pruned to the newest 7. Called from every hourly
// sweep; the app_state stamp gates it to once per day (hourly in test
// mode). VACUUM INTO produces a compact, consistent copy even while the
// bot is running mid-WAL — no need to stop anything.
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DAY_MS, HOUR_MS } from '../util/time.js';
import { getAppState, setAppState } from '../store/appState.js';

const KEEP = 7;
const BACKUP_NAME = /^the-the-\d{4}-\d{2}-\d{2}\.sqlite3$/;

export function runDailyBackup(ctx, now = Date.now()) {
  const dbPath = ctx.env?.dbPath;
  if (!dbPath || dbPath === ':memory:') return false;
  const unit = ctx.env?.testMode ? HOUR_MS : DAY_MS;
  const last = Number(getAppState(ctx.db, 'backup_at') ?? 0);
  if (now - last < unit) return false;
  setAppState(ctx.db, 'backup_at', String(now));

  const dir = join(dirname(dbPath), 'backups');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `the-the-${new Date(now).toISOString().slice(0, 10)}.sqlite3`);
  if (!existsSync(target)) {
    ctx.db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
    console.log(`[ttdb] database backed up to ${target}`);
  }
  const stale = readdirSync(dir)
    .filter((name) => BACKUP_NAME.test(name))
    .sort()
    .slice(0, -KEEP);
  for (const name of stale) {
    unlinkSync(join(dir, name));
  }
  return true;
}
