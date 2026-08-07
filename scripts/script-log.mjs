// Shared logging for helper scripts: everything said is mirrored to
// logs/<ts>__<name>/run.log with the secret (if registered) redacted.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function makeScriptLog(name) {
  const lines = [];
  let secret = null;
  const scrub = (value) => {
    const text = String(value);
    return secret ? text.split(secret).join('[REDACTED]') : text;
  };
  const say = (line) => {
    lines.push(scrub(line));
    console.log(scrub(line));
  };
  const ts = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
  const logDir = join('logs', `${ts}__${name}`);
  const finish = (code) => {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'run.log'), lines.join('\n') + '\n');
    console.log(`(log written to ${logDir})`);
    process.exit(code);
  };
  return { say, finish, scrub, setSecret: (value) => (secret = value) };
}
