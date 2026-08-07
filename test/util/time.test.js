import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUR_MS, MINUTE_MS, msUntilNextBoundary, roundUpToNextHour } from '../../src/util/time.js';

test('roundUpToNextHour rounds mid-hour times up to the next clock hour', () => {
  assert.equal(roundUpToNextHour(5 * HOUR_MS + 1), 6 * HOUR_MS);
  assert.equal(roundUpToNextHour(5 * HOUR_MS + 59 * MINUTE_MS), 6 * HOUR_MS);
});

test('roundUpToNextHour leaves exact hour boundaries unchanged', () => {
  assert.equal(roundUpToNextHour(6 * HOUR_MS), 6 * HOUR_MS);
});

test('roundUpToNextHour rounds to the next minute in test mode', () => {
  assert.equal(roundUpToNextHour(MINUTE_MS + 1, { testMode: true }), 2 * MINUTE_MS);
  assert.equal(roundUpToNextHour(2 * MINUTE_MS, { testMode: true }), 2 * MINUTE_MS);
});

test('msUntilNextBoundary returns the delay to the next boundary, never zero', () => {
  assert.equal(msUntilNextBoundary(HOUR_MS, 5 * HOUR_MS + 1), HOUR_MS - 1);
  assert.equal(msUntilNextBoundary(HOUR_MS, 6 * HOUR_MS), HOUR_MS);
});
