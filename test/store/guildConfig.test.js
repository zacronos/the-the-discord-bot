import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getConfig, setConfig } from '../../src/store/guildConfig.js';
import { tempDb } from './helpers.js';

test('getConfig returns undefined for an unconfigured guild', (t) => {
  const db = tempDb(t);
  assert.equal(getConfig(db, 'g1'), undefined);
});

test('setConfig inserts, then later patches only the provided fields', (t) => {
  const db = tempDb(t);

  setConfig(db, 'g1', { poll_channel_id: 'chan-1' }, 1000);
  setConfig(db, 'g1', { hard_no_weight: 'veto', threshold_type: 'percent', threshold_value: 50 }, 2000);

  const cfg = getConfig(db, 'g1');
  assert.equal(cfg.poll_channel_id, 'chan-1', 'earlier field survives later patches');
  assert.equal(cfg.hard_no_weight, 'veto');
  assert.equal(cfg.threshold_type, 'percent');
  assert.equal(cfg.threshold_value, 50);
  assert.equal(cfg.permanent_category_id, null, 'untouched fields stay null');
  assert.equal(cfg.updated_at, 2000, 'updated_at reflects the latest change');
});

test('setConfig returns the resulting row', (t) => {
  const db = tempDb(t);
  const cfg = setConfig(db, 'g1', { invite_channel_id: 'chan-9', poll_starter_role_id: 'role-1' }, 1000);
  assert.equal(cfg.invite_channel_id, 'chan-9');
  assert.equal(cfg.poll_starter_role_id, 'role-1');
});

test('setConfig rejects unknown fields', (t) => {
  const db = tempDb(t);
  assert.throws(() => setConfig(db, 'g1', { bogus_field: 1 }), /Unknown config field: bogus_field/);
});

test('configs are isolated per guild', (t) => {
  const db = tempDb(t);
  setConfig(db, 'g1', { poll_channel_id: 'chan-1' }, 1000);
  setConfig(db, 'g2', { poll_channel_id: 'chan-2' }, 1000);
  assert.equal(getConfig(db, 'g1').poll_channel_id, 'chan-1');
  assert.equal(getConfig(db, 'g2').poll_channel_id, 'chan-2');
});
