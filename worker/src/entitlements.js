import { readEntitlement, writeEntitlement } from "./db.js";

const PRO_ENTITLEMENT = "honmaruai Pro";
const CACHE_MS = 60 * 60 * 1000;

// Asked on demand and cached for an hour. Webhooks would be more immediate but
// need an endpoint to secure and can be missed; one call per user per hour is
// cheaper than either failure mode.
export async function isPro(env, githubId) {
  if (!env.REVENUECAT_SECRET_KEY) return false;

  const cached = await readEntitlement(env.DB, githubId);
  if (cached && Date.now() - Date.parse(cached.checked_at) < CACHE_MS) {
    return cached.is_pro === 1;
  }

  // Three outcomes, not two. `true` and `false` are things RevenueCat said
  // about this subscriber; `null` is RevenueCat not having said anything, and
  // that is not a fact about whether somebody is paying.
  let answer = null;
  try {
    const res = await fetch(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(String(githubId))}`,
      { headers: { Authorization: `Bearer ${env.REVENUECAT_SECRET_KEY}` } }
    );
    if (res.status === 404) {
      // An answer about the subscriber: never heard of them, so not Pro.
      answer = false;
    } else if (res.ok) {
      const body = await res.json();
      const entitlement = body?.subscriber?.entitlements?.[PRO_ENTITLEMENT];
      answer = Boolean(entitlement) &&
        (!entitlement.expires_date || Date.parse(entitlement.expires_date) > Date.now());
    }
  } catch {
    // A network failure, or a body that would not parse. Either way nothing
    // was learned.
    answer = null;
  }

  if (answer === null) {
    // A billing outage must never block the product — and writing `false` here
    // is exactly how it did. One failed request downgraded a paying subscriber
    // to the free tier's three routes a day, and the cache write was what
    // stopped it retrying for the next hour. Say what was last known, and
    // leave the cache alone so the next request asks again.
    return cached?.is_pro === 1;
  }

  await writeEntitlement(env.DB, githubId, answer);
  return answer;
}
