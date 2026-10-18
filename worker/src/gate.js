import { isPro } from "./entitlements.js";
import { countAIUse, reserveAIUse, releaseAIUse } from "./db.js";
import { loadAISettings } from "./orgAI.js";

export const FREE_DAILY_ROUTES = 3;

// What a signed-in person may spend before billing exists to sell them more.
// High enough that nobody using the product normally will ever see it, low
// enough that one leaked session cannot run up an unbounded model bill.
export const UNBILLED_DAILY_ROUTES = 200;

const DENIED = { allowed: false, metered: false, quotaExceeded: true, consume: async () => {}, release: async () => {} };
const DENIED_QUOTA = { allowed: false, metered: true, quotaExceeded: true, consume: async () => {}, release: async () => {} };

function today() {
  return new Date().toISOString().slice(0, 10);
}

/// The one place that decides whether an AI call may happen on our key.
///
/// Returns `{ allowed, metered, quotaExceeded, remaining?, consume(), release() }`.
/// `remaining` is how many calls are left of a metered day, so a caller that
/// spends on the person's behalf can leave them the last one. `consume()` is
/// called only after a model call actually happened, so a failed call does not
/// burn someone's allowance. A metered allowance holds its call's place from
/// the check, so concurrent checks cannot all take the day's last call;
/// `release()` gives the place back when no call was made, and a place
/// neither consumed nor released lapses within a minute (db.js).
export async function checkAIAllowance(env, { githubId, userKey, workspaceKey }) {
  const free = { allowed: true, metered: false, quotaExceeded: false, consume: async () => {}, release: async () => {} };

  // Their key, their bill — the person's own, or the workspace's (entered
  // once from Tools). Neither is metered against our budget.
  if (userKey || workspaceKey) return free;

  // Anonymous callers cannot be metered, so they never spend our budget —
  // checked before the billing question, not after it. Ordering these the
  // other way round meant that with billing switched off (which is how this
  // ships until RevenueCat is live) the route was open to the whole internet
  // on our model key, with nothing counting the calls.
  if (!githubId) return DENIED;

  // Complimentary grants remain unlimited when the billing provider is absent.
  if (await isPro(env, githubId)) return free;

  // Billing is not configured, so there is no upgrade to sell and no
  // entitlement to read. Metering someone against a paywall that does not
  // exist would only punish them — but "not metered" is not "unlimited", so a
  // signed-in caller still gets a per-day ceiling well above normal use.
  if (!env.REVENUECAT_SECRET_KEY) return metered(env, githubId, UNBILLED_DAILY_ROUTES);

  return metered(env, githubId, FREE_DAILY_ROUTES);
}

/// A day of `limit` calls: this call's place taken now, counted by
/// `consume()` (and every further call it makes counted too), or given back
/// by `release()`.
async function metered(env, githubId, limit) {
  const day = today();
  const held = await reserveAIUse(env.DB, githubId, day, limit);
  if (!held) return DENIED_QUOTA;
  let reservation = held.id;
  const settle = async () => {
    const id = reservation;
    reservation = null;
    if (id) await releaseAIUse(env.DB, id);
  };
  return {
    allowed: true,
    metered: true,
    quotaExceeded: false,
    remaining: held.remaining,
    consume: async () => { await countAIUse(env.DB, githubId, day); await settle(); },
    release: settle,
  };
}

/// The same question, asked for a workspace: a workspace that runs on its
/// own key is never metered. Every caller that knows the workspace goes
/// through here.
export async function allowanceFor(env, orgId, { githubId, userKey }) {
  let workspaceKey = false;
  // Only someone signed in may spend a workspace's own key: the route checks
  // membership for a session alone, and a workspace id ("owner/repo") is no
  // secret, so an anonymous caller naming one would bill that team.
  if (orgId && !userKey && githubId) {
    try { workspaceKey = Boolean((await loadAISettings(env.DB, orgId)).openaiKey); } catch { workspaceKey = false; }
  }
  return checkAIAllowance(env, { githubId, userKey, workspaceKey });
}
