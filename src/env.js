// Central environment configuration. Secrets are read from the environment
// only -- set them in your shell, or keep KEY=value lines in a gitignored
// .env and run commands via `node --env-file=.env ...` (Node >= 20.6).

const DEFAULT_REQUIRED = ['DISCORD_TOKEN', 'DISCORD_APP_ID'];

export function loadEnv({ env = process.env, required = DEFAULT_REQUIRED } = {}) {
  const missing = required.filter((name) => !env[name] || env[name].trim() === '');
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Set them in your shell, or in a gitignored .env file used with ' +
        '`node --env-file=.env ...`. See the "Development" section of README.md.'
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
