// RevenueCat hosts checkout and synchronizes the same Pro entitlement used by
// StoreKit. Enable only after the production provider and products are tested.
import { hasComplimentaryAccess } from './complimentary.js';

export function webPurchaseBase(env) {
  if (env.REVENUECAT_WEB_BILLING_ENABLED !== 'true' || !env.REVENUECAT_SECRET_KEY) return null;
  try {
    const url = new URL(env.REVENUECAT_WEB_PURCHASE_URL);
    if (url.origin !== 'https://pay.rev.cat' || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return null;
    return url.href.replace(/\/$/, '');
  } catch { return null; }
}

function managementURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (!['billing.stripe.com', 'billing.revenuecat.com', 'apps.apple.com', 'play.google.com'].includes(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

export async function webBillingLink(env, userID, action) {
  const base = webPurchaseBase(env);
  if (!base) return { status: 503 };
  // Never let a request's body supply the billing identity. The caller passes
  // only the identity from a validated Honmaru session.
  if (action === 'checkout' && await hasComplimentaryAccess(env, userID)) return { status: 409 };
  let subscriber;
  try {
    const response = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(String(userID))}`, {
      headers: { Authorization: `Bearer ${env.REVENUECAT_SECRET_KEY}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) subscriber = { entitlements: {} };
    else if (response.ok) {
      subscriber = (await response.json()).subscriber;
      if (!subscriber?.entitlements || typeof subscriber.entitlements !== 'object' || Array.isArray(subscriber.entitlements)) return { status: 503 };
    } else return { status: 503 };
  } catch { return { status: 503 }; }
  const pro = subscriber.entitlements['honmaruai Pro'];
  // Unknown/invalid expiry must not allow a duplicate purchase.
  const active = pro && (!pro.expires_date || !Number.isFinite(Date.parse(pro.expires_date)) || Date.parse(pro.expires_date) > Date.now());
  if (action === 'manage') {
    const url = managementURL(subscriber.management_url);
    return url ? { status: 200, url } : { status: 409 };
  }
  if (active) return { status: 409 };
  return { status: 200, url: `${base}/${encodeURIComponent(String(userID))}` };
}
