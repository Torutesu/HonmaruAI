/// Ops alerting — when something fails, a person should hear about it, not
/// just a log line. Point ALERT_WEBHOOK_URL at any endpoint that accepts a
/// JSON POST; Slack incoming webhooks take `{ text }` as-is. Unconfigured
/// means off, and an alert that fails must never take the request with it.

const ALERT_TIMEOUT_MS = 10_000;
// The same kind of failure can fire on every request; one a minute is enough
// to know it is happening without drowning the channel.
const MIN_INTERVAL_MS = 60_000;
const lastSent = new Map();

export function alert(ctx, env, kind, detail) {
  const url = env.ALERT_WEBHOOK_URL;
  if (!url) return;
  const now = Date.now();
  if (now - (lastSent.get(kind) || 0) < MIN_INTERVAL_MS) return;
  lastSent.set(kind, now);
  const text = `[honmaru] ${kind}: ${String(detail).slice(0, 400)}`;
  const send = fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
  }).catch(() => {});
  // waitUntil when a context exists so the response is not held up; bare
  // promise otherwise (scheduled runs pass their own).
  if (ctx?.waitUntil) ctx.waitUntil(send);
}
