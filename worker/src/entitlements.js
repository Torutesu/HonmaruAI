import { readEntitlement, writeEntitlement } from "./db.js";
import { hasComplimentaryAccess } from "./complimentary.js";

const PRO_ENTITLEMENT = "honmaruai Pro";
const CACHE_MS = 60 * 60 * 1000;

function periodType(value) {
  const normalized = String(value || "").toLowerCase();
  return ["trial", "intro", "normal", "promotional"].includes(normalized) ? normalized : null;
}

function isoDate(value) {
  if (typeof value !== "string" || !value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function subscriptionSummary(subscriber, entitlement) {
  const product = entitlement?.product_identifier;
  const detail = product && subscriber?.subscriptions && typeof subscriber.subscriptions === "object"
    ? subscriber.subscriptions[product]
    : null;
  const period = periodType(entitlement?.period_type || detail?.period_type);
  return {
    periodType: period,
    expiresAt: isoDate(entitlement?.expires_date || detail?.expires_date),
    purchaseDate: isoDate(entitlement?.purchase_date || detail?.purchase_date),
    cancellationDetectedAt: isoDate(detail?.unsubscribe_detected_at),
    billingIssueDetectedAt: isoDate(entitlement?.billing_issue_detected_at || detail?.billing_issues_detected_at),
    gracePeriodExpiresAt: isoDate(detail?.grace_period_expires_date),
    sandbox: detail?.is_sandbox === true,
  };
}

async function lookupSubscription(env, githubId) {
  try {
    const res = await fetch(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(String(githubId))}`,
      {
        headers: { Authorization: `Bearer ${env.REVENUECAT_SECRET_KEY}` },
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (res.status === 404) {
      await writeEntitlement(env.DB, githubId, false);
      return { pro: false, subscription: null };
    }
    if (!res.ok) return null;
    const body = await res.json();
    const subscriber = body?.subscriber;
    if (!subscriber || !subscriber.entitlements || typeof subscriber.entitlements !== "object" || Array.isArray(subscriber.entitlements)) return null;
    const entitlement = subscriber.entitlements[PRO_ENTITLEMENT];
    const active = Boolean(entitlement) && (!entitlement.expires_date || Date.parse(entitlement.expires_date) > Date.now());
    await writeEntitlement(env.DB, githubId, active);
    return { pro: active, subscription: active ? subscriptionSummary(subscriber, entitlement) : null };
  } catch {
    return null;
  }
}

// Cache active access for an hour. Recheck free accounts on every request
// so a purchase or restore becomes available without a stale negative cache.
export async function isPro(env, githubId) {
  if (await hasComplimentaryAccess(env, githubId)) return true;
  if (!env.REVENUECAT_SECRET_KEY) return false;

  const cached = await readEntitlement(env.DB, githubId);
  if (cached?.is_pro === 1 && Date.now() - Date.parse(cached.checked_at) < CACHE_MS) {
    return cached.is_pro === 1;
  }

  const answer = await lookupSubscription(env, githubId);
  if (answer === null) {
    // A billing outage must never block the product — and writing `false` here
    // is exactly how it did. One failed request downgraded a paying subscriber
    // to the free tier's three routes a day, and the cache write was what
    // stopped it retrying for the next hour. Say what was last known, and
    // leave the cache alone so the next request asks again.
    return cached?.is_pro === 1;
  }
  return answer.pro;
}

/// The Plans screen asks once when opened so it can show the current StoreKit
/// period without caching a stale renewal date. On provider failure, access
/// falls back to the same last-known positive entitlement as `isPro`.
export async function proSubscription(env, githubId) {
  if (await hasComplimentaryAccess(env, githubId)) return { pro: true, subscription: null };
  if (!env.REVENUECAT_SECRET_KEY) return { pro: false, subscription: null };
  const answer = await lookupSubscription(env, githubId);
  if (answer !== null) return answer;
  const cached = await readEntitlement(env.DB, githubId);
  return { pro: cached?.is_pro === 1, subscription: null };
}
