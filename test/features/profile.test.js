import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProfileDescription, ensureProfile } from '../../src/features/profile.js';
import { setAppState, getAppState } from '../../src/store/appState.js';
import { setConfig } from '../../src/store/guildConfig.js';
import { tempDb } from '../store/helpers.js';

const FULL_CONFIG = {
  poll_channel_id: 'chan-1',
  hard_no_weight: 'veto',
  threshold_type: 'count',
  threshold_value: 3,
  permanent_category_id: 'cat-1',
};

const UNCONFIGURED_TEXT = 'admins: use /ttdb-config to set up The The Admin-Polling Bot';
const CONFIGURED_TEXT =
  'Go to the #votes channel to start a vote! (admins: use `/ttdb-config` to configure voting rules)';

function fakeApp({ description = null, icon = null } = {}) {
  return {
    description,
    icon,
    edits: [],
    async fetch() {
      return this;
    },
    async edit(patch) {
      this.edits.push(patch);
      if (patch.description !== undefined) this.description = patch.description;
      if (patch.icon !== undefined) this.icon = 'pushed-icon-hash';
      return this;
    },
  };
}

function fakeCtx(db, app, { guilds = [] } = {}) {
  return {
    db,
    client: {
      application: app,
      guilds: { cache: new Map(guilds.map((g) => [g.id, g])) },
    },
  };
}

const guildWithChannel = (name = 'votes') => ({
  id: 'g1',
  channels: { fetch: async (id) => ({ id, name }) },
});

function tempIcon(t, contents = 'png-bytes-v1') {
  const dir = mkdtempSync(join(tmpdir(), 'ttdb-icon-'));
  const path = join(dir, 'icon.png');
  writeFileSync(path, contents);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path;
}

test('buildProfileDescription matches the specified texts exactly', () => {
  assert.equal(buildProfileDescription(null), UNCONFIGURED_TEXT);
  assert.equal(buildProfileDescription('votes'), CONFIGURED_TEXT);
});

test('unconfigured server: description set to the admin setup text, icon pushed', async (t) => {
  const db = tempDb(t);
  const app = fakeApp();
  const ctx = fakeCtx(db, app, { guilds: [guildWithChannel()] });
  const iconPath = tempIcon(t);

  await ensureProfile(ctx, { iconPath });

  assert.equal(app.edits.length, 1);
  assert.equal(app.edits[0].description, UNCONFIGURED_TEXT);
  assert.match(app.edits[0].icon, /^data:image\/png;base64,/);
  assert.ok(getAppState(db, 'app_icon_hash'), 'icon hash recorded after push');
});

test('configured server: description references the poll channel by name', async (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', FULL_CONFIG);
  const app = fakeApp();
  const ctx = fakeCtx(db, app, { guilds: [guildWithChannel('votes')] });

  await ensureProfile(ctx, { iconPath: tempIcon(t) });
  assert.equal(app.edits[0].description, CONFIGURED_TEXT);
});

test('no-op when description and icon are already current', async (t) => {
  const db = tempDb(t);
  const iconPath = tempIcon(t);
  const app = fakeApp({ description: UNCONFIGURED_TEXT, icon: 'already-set' });
  const ctx = fakeCtx(db, app);

  await ensureProfile(ctx, { iconPath }); // first run records the icon hash
  const editsAfterFirst = app.edits.length;
  await ensureProfile(ctx, { iconPath });
  assert.equal(app.edits.length, editsAfterFirst, 'second run makes no API call');
});

test('a changed icon file is pushed again; an unchanged one is not', async (t) => {
  const db = tempDb(t);
  const app = fakeApp({ description: UNCONFIGURED_TEXT, icon: 'already-set' });
  const ctx = fakeCtx(db, app);

  const first = tempIcon(t, 'png-v1');
  await ensureProfile(ctx, { iconPath: first });
  assert.equal(app.edits.length, 1, 'unknown hash: pushed');

  await ensureProfile(ctx, { iconPath: first });
  assert.equal(app.edits.length, 1, 'same hash: skipped');

  const second = tempIcon(t, 'png-v2');
  await ensureProfile(ctx, { iconPath: second });
  assert.equal(app.edits.length, 2, 'new hash: pushed again');
});

test('a missing icon file skips the icon but still syncs the description', async (t) => {
  const db = tempDb(t);
  const app = fakeApp();
  const ctx = fakeCtx(db, app);

  await ensureProfile(ctx, { iconPath: join(tmpdir(), 'ttdb-does-not-exist.png') });
  assert.equal(app.edits.length, 1);
  assert.equal(app.edits[0].description, UNCONFIGURED_TEXT);
  assert.equal(app.edits[0].icon, undefined);
});
