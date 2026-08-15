// Fixed-window counters in D1.
//
// A sliding window would be fairer and a token bucket smoother, but both need
// state per request that D1 makes expensive. A fixed window lets a burst of at
// most 2x the budget straddle a boundary, and that is a price worth paying for
// one INSERT … ON CONFLICT per request.
//
// The limiter fails OPEN. A limiter outage taking the product down with it would
// be a worse failure than the abuse it exists to stop.

export const LIMITS = {
  // The expensive one: every call spends money on someone's model.
  "ai/route": { max: 30, windowSeconds: 300 },
  // Guessing an authorization code should not be cheap.
  "oauth/token": { max: 10, windowSeconds: 300 },
  // A sync walks an inbox and can trigger many model calls.
  "connectors/sync": { max: 6, windowSeconds: 300 },
  // Storage is the thing R2 bills for, and each of these is up to 12 MB.
  media: { max: 20, windowSeconds: 3600 },
  // Minting a nonce is cheap, but not free, and it writes a row.
  "oauth/state": { max: 30, windowSeconds: 300 },
};

/// Who this request counts against.
///
/// A session token first: a signed-in person keeps one budget as they move
/// between wifi and cellular, and cannot buy a fresh one by changing networks.
/// Otherwise the connecting IP, which is all an anonymous caller has.
export function subjectOf(request) {
  const token = request.headers.get("x-session-token");
  if (token) return `s:${token}`;
  return `i:${request.headers.get("CF-Connecting-IP") || "unknown"}`;
}

/// Returns null when the caller may proceed, or a 429 Response when they may not.
export async function enforce(env, request, bucket) {
  const limit = LIMITS[bucket];
  if (!limit) return null;

  const subject = subjectOf(request);
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % limit.windowSeconds);

  let count;
  try {
    const row = await env.DB
      .prepare(
        `INSERT INTO rate_limits (bucket, subject, window_start, count) VALUES (?1, ?2, ?3, 1)
         ON CONFLICT(bucket, subject, window_start) DO UPDATE SET count = count + 1
         RETURNING count`
      )
      .bind(bucket, subject, windowStart)
      .first();
    count = Number(row?.count ?? 0);
  } catch (err) {
    console.error("rate limit check failed", err?.message || err);
    return null;
  }

  if (count <= limit.max) return null;

  const retryAfter = windowStart + limit.windowSeconds - now;
  return new Response(
    JSON.stringify({ message: "Too many requests. Try again shortly.", retryAfter }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(Math.max(1, retryAfter)),
      },
    }
  );
}

/// Windows older than an hour can never be consulted again. Called from the
/// scheduled handler rather than per request — sweeping on the hot path would
/// make every caller pay for the tidiness of the table.
export async function sweepRateLimits(env) {
  const cutoff = Math.floor(Date.now() / 1000) - 3600;
  try {
    await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?1").bind(cutoff).run();
    await env.DB
      .prepare("DELETE FROM oauth_states WHERE expires_at < ?1")
      .bind(new Date().toISOString())
      .run();
  } catch (err) {
    console.error("rate limit sweep failed", err?.message || err);
  }
}
