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

  let active = false;
  try {
    const res = await fetch(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(String(githubId))}`,
      { headers: { Authorization: `Bearer ${env.REVENUECAT_SECRET_KEY}` } }
    );
    if (res.ok) {
      const body = await res.json();
      const entitlement = body?.subscriber?.entitlements?.[PRO_ENTITLEMENT];
      active = Boolean(entitlement) &&
        (!entitlement.expires_date || Date.parse(entitlement.expires_date) > Date.now());
    }
  } catch {
    // Fall through: a billing outage must never block the product.
    active = false;
  }

  await writeEntitlement(env.DB, githubId, active);
  return active;
}
