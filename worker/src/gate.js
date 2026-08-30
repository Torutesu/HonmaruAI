import { isPro } from "./entitlements.js";
import { usedToday, countAIUse } from "./db.js";

export const FREE_DAILY_ROUTES = 3;

// What a signed-in person may spend before billing exists to sell them more.
// High enough that nobody using the product normally will ever see it, low
// enough that one leaked session cannot run up an unbounded model bill.
export const UNBILLED_DAILY_ROUTES = 200;

const DENIED = { allowed: false, metered: false, quotaExceeded: true, consume: async () => {} };
const DENIED_QUOTA = { allowed: false, metered: true, quotaExceeded: true, consume: async () => {} };

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

  // Anonymous callers cannot be metered, so they never spend our budget —
  // checked before the billing question, not after it. Ordering these the
  // other way round meant that with billing switched off (which is how this
  // ships until RevenueCat is live) the route was open to the whole internet
  // on our model key, with nothing counting the calls.
  if (!githubId) return DENIED;

  // Billing is not configured, so there is no upgrade to sell and no
  // entitlement to read. Metering someone against a paywall that does not
  // exist would only punish them — but "not metered" is not "unlimited", so a
  // signed-in caller still gets a per-day ceiling well above normal use.
  if (!env.REVENUECAT_SECRET_KEY) {
    const day = today();
    const used = await usedToday(env.DB, githubId, day);
    if (used >= UNBILLED_DAILY_ROUTES) return DENIED_QUOTA;
    return {
      allowed: true,
      metered: true,
      quotaExceeded: false,
      consume: async () => countAIUse(env.DB, githubId, day),
    };
  }

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
