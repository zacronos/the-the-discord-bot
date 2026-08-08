// Pure vote-counting rules. Yes = +1, Abstain = 0, No = -1, Hard no =
// configured weight ('-2'|'-3'|'-5'|'-10') or 'veto' (any hard no fails the
// poll outright). A poll passes when the total REACHES the target:
// a literal vote total, or value% of the eligible (non-bot) member count at
// evaluation time. Boundary equality passes.
export function tallyPoll({ counts, hardNoWeight, threshold, eligibleCount }) {
  const vetoCount = counts.hard_no ?? 0;
  if (hardNoWeight === 'veto' && vetoCount > 0) {
    return { outcome: 'vetoed', vetoCount, total: null, target: null };
  }
  const weight = hardNoWeight === 'veto' ? 0 : Number(hardNoWeight);
  const total = (counts.yes ?? 0) - (counts.no ?? 0) + vetoCount * weight;
  // Percent targets need a real member count; without one, fail safe rather
  // than letting the target collapse to zero.
  const target =
    threshold.type === 'percent'
      ? Number.isFinite(eligibleCount) && eligibleCount > 0
        ? (threshold.value / 100) * eligibleCount
        : Number.POSITIVE_INFINITY
      : threshold.value;
  // A poll nobody voted on never passes, no matter how low the target is.
  const totalVotes = (counts.yes ?? 0) + (counts.no ?? 0) + (counts.abstain ?? 0) + vetoCount;
  const passed = totalVotes > 0 && total >= target;
  return { outcome: passed ? 'passed' : 'failed', vetoCount, total, target };
}
