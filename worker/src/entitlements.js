import { readEntitlement, writeEntitlement } from "./db.js";
import { hasComplimentaryAccess } from "./complimentary.js";

const PRO_ENTITLEMENT = "honmaruai Pro";
const CACHE_MS = 60 * 60 * 1000;

// Cache active access for an hour. Recheck free accounts on every request
// so a purchase or restore becomes available without a stale negative cache.
export async function isPro(env, githubId) {
  if (await hasComplimentaryAccess(env, githubId)) return true;
  if (!env.REVENUECAT_SECRET_KEY) return false;

  const cached = await readEntitlement(env.DB, githubId);
  if (cached?.is_pro === 1 && Date.now() - Date.parse(cached.checked_at) < CACHE_MS) {
    return cached.is_pro === 1;
  }

  // Three outcomes, not two. `true` and `false` are things RevenueCat said
  // about this subscriber; `null` is RevenueCat not having said anything, and
  // that is not a fact about whether somebody is paying.
  let answer = null;
  try {
    const res = await fetch(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(String(githubId))}`,
      {
        headers: { Authorization: `Bearer ${env.REVENUECAT_SECRET_KEY}` },
        signal: AbortSignal.timeout(15_000),
      }
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
