// Central environment configuration. Values come from the gitignored .env
// file in the repo root (plain KEY=value lines) -- the npm scripts and the
// startup launcher load it natively via node's --env-file support.

const DEFAULT_REQUIRED = ['DISCORD_TOKEN', 'DISCORD_APP_ID'];

export function loadEnv({ env = process.env, required = DEFAULT_REQUIRED } = {}) {
  const missing = required.filter((name) => !env[name] || env[name].trim() === '');
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Add them to the gitignored .env file in the repo root. ' +
        'See the "Development" section of README.md.'
    );
  }
  return {
    token: env.DISCORD_TOKEN,
    appId: env.DISCORD_APP_ID,
    dbPath: env.TTDB_DB_PATH ?? './data/the-the.sqlite3',
    testMode: env.TTDB_TEST_MODE === '1',
    guildId: env.TTDB_GUILD_ID,
  };
}
