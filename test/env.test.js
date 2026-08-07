import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../src/env.js';

test('loadEnv throws a clear error naming every missing required var', () => {
  assert.throws(
    () => loadEnv({ env: {} }),
    /Missing required environment variable\(s\): DISCORD_TOKEN, DISCORD_APP_ID/
  );
});

test('loadEnv treats empty/whitespace values as missing', () => {
  assert.throws(
    () => loadEnv({ env: { DISCORD_TOKEN: '   ', DISCORD_APP_ID: 'x' } }),
    /Missing required environment variable\(s\): DISCORD_TOKEN/
  );
});

test('loadEnv returns values and defaults when required vars are present', () => {
  const cfg = loadEnv({ env: { DISCORD_TOKEN: 'tok', DISCORD_APP_ID: '123' } });
  assert.equal(cfg.token, 'tok');
  assert.equal(cfg.appId, '123');
  assert.equal(cfg.dbPath, './data/the-the.sqlite3');
  assert.equal(cfg.testMode, false);
  assert.equal(cfg.guildId, undefined);
});

test('loadEnv honors the optional TTDB_* overrides', () => {
  const cfg = loadEnv({
    env: {
      DISCORD_TOKEN: 'tok',
      DISCORD_APP_ID: '123',
      TTDB_DB_PATH: 'elsewhere.sqlite3',
      TTDB_TEST_MODE: '1',
      TTDB_GUILD_ID: '456',
    },
  });
  assert.equal(cfg.dbPath, 'elsewhere.sqlite3');
  assert.equal(cfg.testMode, true);
  assert.equal(cfg.guildId, '456');
});

test('loadEnv can require a subset (invite-url only needs the app id)', () => {
  const cfg = loadEnv({ env: { DISCORD_APP_ID: '123' }, required: ['DISCORD_APP_ID'] });
  assert.equal(cfg.appId, '123');
  assert.equal(cfg.token, undefined);
});
