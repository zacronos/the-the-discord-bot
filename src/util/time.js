export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

// Epoch-hour ceiling: an instant already exactly on the boundary is
// unchanged. Test mode rounds to minutes so short test polls stay usable.
export function roundUpToNextHour(at, { testMode = false } = {}) {
  const unit = testMode ? MINUTE_MS : HOUR_MS;
  return Math.ceil(at / unit) * unit;
}

// Delay from `now` to the next strict boundary (never 0: on the boundary it
// returns a full unit, which is what an on-the-hour scheduler wants).
export function msUntilNextBoundary(unitMs, now) {
  return unitMs - (now % unitMs) || unitMs;
}
