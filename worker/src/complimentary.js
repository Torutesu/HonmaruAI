// Private, account-bound Pro access. The shared code is a Worker secret, never
// a client constant, database value, URL parameter or log field.
const WINDOW_SECONDS = 300;
const PRO_ENTITLEMENT = "honmaruai Pro";
// A fixed two-century grant works with RevenueCat's current end_time_ms API.
// Repeating the same end time is deduplicated by RevenueCat. D1 access itself
// never expires; this bridge lets the already-published iOS app recognize it.
export const COMPLIMENTARY_PROMO_END_MS = Date.parse("2226-01-01T00:00:00Z");
const OPERATION_LEASE_MS = 60_000;

export function complimentaryAvailable(env) {
  return typeof env.COMPLIMENTARY_ACCESS_CODE === "string" &&
    env.COMPLIMENTARY_ACCESS_CODE.trim().length >= 8;
}

export async function hasComplimentaryAccess(env, userID) {
  if (!userID) return false;
  const row = await env.DB.prepare(
    "SELECT user_github_id FROM complimentary_access WHERE user_github_id = ?1 AND deletion_requested_at IS NULL"
  ).bind(String(userID)).first();
  return Boolean(row);
}

async function grantRecord(env, userID) {
  return env.DB.prepare("SELECT * FROM complimentary_access WHERE user_github_id = ?1")
    .bind(String(userID)).first();
}

function customerURL(userID) {
  return `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(String(userID))}`;
}

async function revenueCat(env, url, signal, body) {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${env.REVENUECAT_SECRET_KEY}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("RevenueCat request unavailable");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 512 * 1024) {
        await reader.cancel();
        throw new Error("RevenueCat response too large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const result = JSON.parse(new TextDecoder().decode(bytes));
  if (!result?.subscriber || typeof result.subscriber.entitlements !== "object" || Array.isArray(result.subscriber.entitlements) ||
      !result.subscriber.entitlements || typeof result.subscriber.subscriptions !== "object" ||
      !result.subscriber.subscriptions || Array.isArray(result.subscriber.subscriptions)) throw new Error("RevenueCat response invalid");
  return result.subscriber;
}

function activePromotions(subscriber) {
  return Object.entries(subscriber.subscriptions).filter(([, product]) =>
    product?.store === "promotional" && !product.refunded_at &&
    (product.expires_date === null || Date.parse(product.expires_date) > Date.now()));
}

function ownsTargetPromotion(subscriber) {
  const entitlement = subscriber.entitlements[PRO_ENTITLEMENT];
  if (!entitlement || Date.parse(entitlement.expires_date) !== COMPLIMENTARY_PROMO_END_MS) return false;
  const product = subscriber.subscriptions[entitlement.product_identifier];
  return product?.store === "promotional" && !product.refunded_at &&
    Date.parse(product.expires_date) === COMPLIMENTARY_PROMO_END_MS;
}

async function releaseOperation(env, userID, lease) {
  await env.DB.prepare(
    "UPDATE complimentary_access SET rc_operation_until = 0 WHERE user_github_id = ?1 AND rc_operation_until = ?2"
  ).bind(String(userID), lease).run();
}

// The grant is the durable work item. A failed request leaves it pending, so
// authenticated status refreshes can finish it without asking for the code.
export async function ensureComplimentarySynced(env, userID) {
  const existing = await grantRecord(env, userID);
  if (!existing || existing.deletion_requested_at) return false;
  if (existing.rc_synced_at) return true;
  if (!env.REVENUECAT_SECRET_KEY) return false;
  const now = Date.now(), lease = now + OPERATION_LEASE_MS;
  const claimed = await env.DB.prepare(
    `UPDATE complimentary_access SET rc_operation_until = ?2
     WHERE user_github_id = ?1 AND rc_synced_at IS NULL AND deletion_requested_at IS NULL
       AND rc_operation_until < ?3 RETURNING *`
  ).bind(String(userID), lease, now).first();
  if (!claimed) {
    const current = await grantRecord(env, userID);
    return Boolean(current?.rc_synced_at && !current.deletion_requested_at);
  }
  try {
    const signal = AbortSignal.timeout(15_000);
    const base = customerURL(userID);
    let subscriber = await revenueCat(env, base, signal);
    if (ownsTargetPromotion(subscriber) && !claimed.rc_attempted_at) return false;
    if (!ownsTargetPromotion(subscriber)) {
      // The v1 revocation endpoint later removes every promo for this
      // entitlement. Avoid taking ownership of somebody else's promotion.
      if (activePromotions(subscriber).length) return false;
      await env.DB.prepare(
        "UPDATE complimentary_access SET rc_attempted_at = ?2 WHERE user_github_id = ?1 AND rc_operation_until = ?3"
      ).bind(String(userID), new Date().toISOString(), lease).run();
      subscriber = await revenueCat(env,
        `${base}/entitlements/${encodeURIComponent(PRO_ENTITLEMENT)}/promotional`, signal,
        { end_time_ms: COMPLIMENTARY_PROMO_END_MS });
    }
    if (!ownsTargetPromotion(subscriber)) return false;
    const updated = await env.DB.prepare(
      `UPDATE complimentary_access SET rc_synced_at = ?2
       WHERE user_github_id = ?1 AND rc_operation_until = ?3 AND deletion_requested_at IS NULL
       RETURNING user_github_id`
    ).bind(String(userID), new Date().toISOString(), lease).first();
    return Boolean(updated);
  } catch {
    // A timeout can happen after the provider commits. The next attempt
    // reads the customer first, recognizes our expiry, and avoids another POST.
    return false;
  } finally { await releaseOperation(env, userID, lease); }
}

// Complete provider cleanup before reporting account deletion. Persist the
// deletion marker so a status/redeem race cannot re-grant after revocation.
export async function prepareComplimentaryDeletion(env, userID) {
  // Insert a tombstone even when no grant exists yet. Otherwise a redemption
  // that already authenticated could insert its grant while deletion is
  // removing the user and create an orphan RevenueCat promotion afterward.
  const deletionTime = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO complimentary_access (user_github_id, granted_at, deletion_requested_at)
     SELECT ?1, ?2, ?2 WHERE EXISTS (SELECT 1 FROM users WHERE github_id = ?1)
     ON CONFLICT(user_github_id) DO NOTHING`
  ).bind(String(userID), deletionTime).run();
  const existing = await grantRecord(env, userID);
  if (!existing) return true;
  const now = Date.now(), lease = now + OPERATION_LEASE_MS;
  const claimed = await env.DB.prepare(
    `UPDATE complimentary_access SET rc_operation_until = ?2,
       deletion_requested_at = COALESCE(deletion_requested_at, ?4)
     WHERE user_github_id = ?1 AND rc_operation_until < ?3 RETURNING *`
  ).bind(String(userID), lease, now, new Date().toISOString()).first();
  if (!claimed) return false;
  try {
    if (!claimed.rc_attempted_at && !claimed.rc_synced_at) return true;
    if (!env.REVENUECAT_SECRET_KEY) return false;
    const signal = AbortSignal.timeout(15_000);
    const base = customerURL(userID);
    let subscriber = await revenueCat(env, base, signal);
    if (ownsTargetPromotion(subscriber)) {
      const productID = subscriber.entitlements[PRO_ENTITLEMENT].product_identifier;
      // Refuse v1's broad revocation when another active promo might be
      // affected. Ordinary paid App Store subscriptions are never revoked.
      if (activePromotions(subscriber).some(([id]) => id !== productID)) return false;
      subscriber = await revenueCat(env,
        `${base}/entitlements/${encodeURIComponent(PRO_ENTITLEMENT)}/revoke_promotionals`, signal, {});
      if (ownsTargetPromotion(subscriber)) return false;
    } else if (activePromotions(subscriber).some(([, product]) =>
      Date.parse(product.expires_date) === COMPLIMENTARY_PROMO_END_MS)) {
      // A different entitlement wins the aggregate view. Do not guess which
      // promotional transaction belongs to this grant.
      return false;
    }
    await env.DB.prepare(
      "UPDATE complimentary_access SET rc_synced_at = NULL, rc_attempted_at = NULL WHERE user_github_id = ?1 AND rc_operation_until = ?2"
    ).bind(String(userID), lease).run();
    return true;
  } catch { return false; }
  finally { await releaseOperation(env, userID, lease); }
}

// Unlike general request throttling, a failure here must prevent redemption.
// Account + IP budgets stop session rotation and bulk account guessing.
export async function limitRedemption(env, request, userID) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - now % WINDOW_SECONDS;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  for (const [subject, max] of [[`u:${userID}`, 10], [`i:${ip}`, 30]]) {
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits (bucket, subject, window_start, count)
       VALUES ('billing/redeem', ?1, ?2, 1)
       ON CONFLICT(bucket, subject, window_start) DO UPDATE SET count = count + 1
       RETURNING count`
    ).bind(subject, start).first();
    if (!row) throw new Error("Redemption rate limit unavailable");
    if (Number(row.count) > max) return start + WINDOW_SECONDS - now;
  }
  return 0;
}

// Bound the actual streamed body, not the caller's Content-Length claim.
export async function readRedemptionCode(request) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1024) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    return typeof body?.code === "string" ? body.code.trim() : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export async function redeemComplimentaryAccess(env, userID, code) {
  if (!complimentaryAvailable(env)) return false;
  if (typeof code !== "string" || !code.length || code.length > 128) return false;
  const encoder = new TextEncoder();
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(code)),
    crypto.subtle.digest("SHA-256", encoder.encode(env.COMPLIMENTARY_ACCESS_CODE.trim())),
  ]);
  if (!crypto.subtle.timingSafeEqual(actual, expected)) return false;
  // Repeating redemption is idempotent; it never starts a subscription or
  // changes workspace membership. Existing grants survive code rotation.
  await env.DB.prepare(
    `INSERT INTO complimentary_access (user_github_id, granted_at)
     SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM users WHERE github_id = ?1)
     ON CONFLICT(user_github_id) DO NOTHING`
  ).bind(String(userID), new Date().toISOString()).run();
  return hasComplimentaryAccess(env, userID);
}
