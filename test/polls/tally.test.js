import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tallyPoll } from '../../src/polls/tally.js';

const counts = (over = {}) => ({ yes: 0, no: 0, hard_no: 0, abstain: 0, ...over });

test('a single veto fails the poll no matter how many yes votes', () => {
  const result = tallyPoll({
    counts: counts({ yes: 99, hard_no: 1 }),
    hardNoWeight: 'veto',
    threshold: { type: 'count', value: 1 },
    eligibleCount: 100,
  });
  assert.equal(result.outcome, 'vetoed');
  assert.equal(result.vetoCount, 1);
});

test('numeric hard-no weights subtract from the total', () => {
  for (const [weight, expectedTotal] of [
    ['-2', 10 - 1 - 2 * 2], // 5
    ['-3', 10 - 1 - 2 * 3], // 3
    ['-5', 10 - 1 - 2 * 5], // -1
    ['-10', 10 - 1 - 2 * 10], // -11
  ]) {
    const result = tallyPoll({
      counts: counts({ yes: 10, no: 1, hard_no: 2, abstain: 4 }),
      hardNoWeight: weight,
      threshold: { type: 'count', value: 100 },
      eligibleCount: 20,
    });
    assert.equal(result.total, expectedTotal, `weight ${weight}`);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.vetoCount, 2, 'hard-no count still reported');
  }
});

test('abstain votes count zero', () => {
  const result = tallyPoll({
    counts: counts({ yes: 2, abstain: 50 }),
    hardNoWeight: '-2',
    threshold: { type: 'count', value: 2 },
    eligibleCount: 60,
  });
  assert.equal(result.total, 2);
  assert.equal(result.outcome, 'passed');
});

test('count threshold: exact boundary passes, one below fails', () => {
  const base = {
    counts: counts({ yes: 3 }),
    hardNoWeight: '-2',
    eligibleCount: 10,
  };
  assert.equal(tallyPoll({ ...base, threshold: { type: 'count', value: 3 } }).outcome, 'passed');
  assert.equal(tallyPoll({ ...base, threshold: { type: 'count', value: 4 } }).outcome, 'failed');
});

test('percent threshold scales with the member count, boundary inclusive', () => {
  const base = { counts: counts({ yes: 5 }), hardNoWeight: '-2', threshold: { type: 'percent', value: 50 } };
  assert.equal(tallyPoll({ ...base, eligibleCount: 10 }).outcome, 'passed'); // target 5
  assert.equal(tallyPoll({ ...base, eligibleCount: 11 }).outcome, 'failed'); // target 5.5
  assert.equal(tallyPoll({ ...base, eligibleCount: 10 }).target, 5);
});

test('a zero threshold passes an all-abstain poll but a positive one fails an empty poll', () => {
  const allAbstain = tallyPoll({
    counts: counts({ abstain: 4 }),
    hardNoWeight: '-2',
    threshold: { type: 'count', value: 0 },
    eligibleCount: 4,
  });
  assert.equal(allAbstain.outcome, 'passed');

  const empty = tallyPoll({
    counts: counts(),
    hardNoWeight: 'veto',
    threshold: { type: 'count', value: 1 },
    eligibleCount: 4,
  });
  assert.equal(empty.outcome, 'failed');
  assert.equal(empty.vetoCount, 0);
});
