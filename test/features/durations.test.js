import { test } from 'node:test';
import assert from 'node:assert/strict';
import { durationSelectOptions, isAllowedDurationSeconds } from '../../src/features/durations.js';

test('standard durations are 3/5/7/14/30 days with 7 days pre-selected', () => {
  const options = durationSelectOptions(false);
  assert.deepEqual(
    options.map((o) => o.value),
    ['259200', '432000', '604800', '1209600', '2592000']
  );
  const selected = options.filter((o) => o.default);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].value, '604800');
  assert.match(selected[0].label, /7 days/);
});

test('test mode adds clearly-labeled short durations', () => {
  const options = durationSelectOptions(true);
  assert.equal(options.length, 7);
  const testers = options.filter((o) => /TESTING ONLY/.test(o.label));
  assert.deepEqual(testers.map((o) => o.value), ['300', '1800']);
});

test('isAllowedDurationSeconds accepts only listed values for the mode', () => {
  assert.equal(isAllowedDurationSeconds(604800, false), true);
  assert.equal(isAllowedDurationSeconds(300, false), false);
  assert.equal(isAllowedDurationSeconds(300, true), true);
  assert.equal(isAllowedDurationSeconds(12345, true), false);
});
