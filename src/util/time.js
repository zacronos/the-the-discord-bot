export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

// Lifetime for self-destructing ephemeral replies: one minute under
// Discord's 15-minute interaction-token limit, after which deletion becomes
// impossible anyway.
export const EPHEMERAL_TTL_MS = 14 * MINUTE_MS;

// setTimeout wrapper: tests inject ctx.schedule to capture (fn, ms); the
// default timer is unref'd so it never holds the process open.
export function scheduleDelayed(ctx, fn, ms) {
  if (ctx?.schedule) return ctx.schedule(fn, ms);
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return timer;
}

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
