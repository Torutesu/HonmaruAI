import { isPro } from "./entitlements.js";
import { usedToday, countAIUse } from "./db.js";

export const FREE_DAILY_ROUTES = 3;

function today() {
  return new Date().toISOString().slice(0, 10);
}

/// The one place that decides whether an AI call may happen on our key.
///
/// Returns `{ allowed, metered, quotaExceeded, consume() }`. `consume()` is
/// called only after a model call actually happened, so a failed call does not
/// burn someone's allowance.
export async function checkAIAllowance(env, { githubId, userKey }) {
  const free = { allowed: true, metered: false, quotaExceeded: false, consume: async () => {} };

  // Their key, their bill.
  if (userKey) return free;
  // Billing is not configured, so metering would only punish people with no way
  // to upgrade.
  if (!env.REVENUECAT_SECRET_KEY) return free;
  // Anonymous callers cannot be metered; they also should not spend our budget.
  if (!githubId) return { allowed: false, metered: false, quotaExceeded: true, consume: async () => {} };

  if (await isPro(env, githubId)) return free;

  const day = today();
  const used = await usedToday(env.DB, githubId, day);
  if (used >= FREE_DAILY_ROUTES) {
    return { allowed: false, metered: true, quotaExceeded: true, consume: async () => {} };
  }
  return {
    allowed: true,
    metered: true,
    quotaExceeded: false,
    consume: async () => countAIUse(env.DB, githubId, day),
  };
}
