// Restart-proof self-dismissal for ephemeral replies (poll-creation
// confirmations). While the process lives, an in-memory timer deletes the
// reply via the interaction object; the pending cleanup is also persisted
// (token + delete-at + token-expiry) so a restart inside the window can
// rehydrate: overdue-but-deletable replies are removed immediately through
// the webhook REST route, future ones get their timer re-armed, and rows
// whose token already died are dropped.
import { Routes } from 'discord.js';
import { addCleanup, listCleanups, removeCleanup } from '../store/ephemeralCleanups.js';
import { EPHEMERAL_TTL_MS, scheduleDelayed } from '../util/time.js';

const TOKEN_LIFE_MS = 15 * 60_000;
const timers = new Map(); // token -> timer

async function deleteByToken(ctx, token) {
  const appId = ctx.client.application?.id ?? ctx.env?.appId;
  await ctx.client.rest.delete(Routes.webhookMessage(appId, token, '@original'));
}

export function scheduleEphemeralCleanup(ctx, interaction, { now = Date.now() } = {}) {
  const token = interaction.token ?? null;
  if (token) {
    addCleanup(ctx.db, { token, deleteAt: now + EPHEMERAL_TTL_MS, expiresAt: now + TOKEN_LIFE_MS });
  }
  const timer = scheduleDelayed(ctx, async () => {
    if (token) {
      timers.delete(token);
      removeCleanup(ctx.db, token);
    }
    try {
      await interaction.deleteReply();
    } catch {
      // already dismissed or token just expired
    }
  }, EPHEMERAL_TTL_MS);
  if (token) timers.set(token, timer);
  return timer;
}

export async function rehydrateEphemeralCleanups(ctx, { now = Date.now() } = {}) {
  for (const row of listCleanups(ctx.db)) {
    if (now >= row.expires_at) {
      removeCleanup(ctx.db, row.token); // nobody can delete it anymore
      continue;
    }
    const fire = async () => {
      timers.delete(row.token);
      removeCleanup(ctx.db, row.token);
      try {
        await deleteByToken(ctx, row.token);
      } catch {
        // reply already dismissed or token expired in the meantime
      }
    };
    if (now >= row.delete_at) {
      await fire();
    } else {
      timers.set(row.token, scheduleDelayed(ctx, fire, row.delete_at - now));
    }
  }
}

export function clearCleanupTimers() {
  for (const timer of timers.values()) {
    if (timer) clearTimeout(timer);
  }
  timers.clear();
}
