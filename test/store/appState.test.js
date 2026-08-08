import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAppState, setAppState } from '../../src/store/appState.js';
import { tempDb } from './helpers.js';

test('getAppState returns undefined for unknown keys', (t) => {
  const db = tempDb(t);
  assert.equal(getAppState(db, 'nope'), undefined);
});

test('setAppState stores and overwrites values', (t) => {
  const db = tempDb(t);
  setAppState(db, 'app_icon_hash', 'aaa');
  assert.equal(getAppState(db, 'app_icon_hash'), 'aaa');
  setAppState(db, 'app_icon_hash', 'bbb');
  assert.equal(getAppState(db, 'app_icon_hash'), 'bbb');
});
