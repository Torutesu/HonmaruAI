// How long the chat's own waits take, from the apps (#845, findings 6–7).
//
// Two things the issue asks to measure before changing: how long a message
// waits in its conversation's send queue behind the one before it, against
// how long its own POST takes; and how often reopening the chat or a
// reconnect reads messages again instead of using what was kept.
//
// A sample is a kind and a number, the app it came from, the Cloudflare
// data centre that answered (a city's airport code, so a slow app can be
// told from a far one), and when. Nothing else: no person, no workspace,
// no conversation, no words. Kept fourteen
// days, then swept. Read by worker/scripts/perf-report.mjs.

import { getSession } from "./db.js";
import { enforce } from "./ratelimit.js";

/// What may be sent, and the largest value each can take.
export const PERF_KINDS = {
  "send.queue": 600_000, // ms from Send to its POST starting (waiting behind earlier ones)
  "send.depth": 100, // how many were ahead of it in its conversation
  "send.http": 600_000, // ms its POST took, to the answer
  "send.server": 600_000, // the server's own total for it (Server-Timing)
  "open.fresh": 1, // a conversation opened from what was kept, no read
  "open.revalidate": 600_000, // opened from what was kept, read again: ms of the read
  "open.cold": 600_000, // opened with nothing kept: ms of the read
  "open.remount": 600_000, // read again because the chat screen was left and re-entered: ms
  "thread.pages": 100, // pages read to refresh a thread after a reconnect
  "read.server": 600_000, // the server's own total for a page of messages (Server-Timing)
};
const CLIENTS = new Set(["web", "desktop", "mobile"]);
const MAX_SAMPLES = 50;
const KEEP_MS = 14 * 86_400_000;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" },
});

/// Only the samples this endpoint takes: known kinds, finite numbers in
/// range, at most MAX_SAMPLES. Anything else is dropped, not stored.
export function cleanSamples(input) {
  const out = [];
  for (const s of Array.isArray(input) ? input.slice(0, MAX_SAMPLES) : []) {
    const max = PERF_KINDS[s?.k];
    const v = Number(s?.v);
    if (max === undefined || !Number.isFinite(v) || v < 0 || v > max) continue;
    out.push({ kind: s.k, value: Math.round(v) });
  }
  return out;
}

/// POST /perf { client, samples: [{ k, v }] } from a signed-in app.
export async function handlePerf(request, env, url) {
  if (url.pathname !== "/perf" || request.method !== "POST") return null;
  const limited = await enforce(env, request, "perf");
  if (limited) return limited;
  const session = await getSession(env.DB, request.headers.get("x-session-token"));
  if (!session) return json({ message: "Please sign in." }, 401);
  const text = await request.text().catch(() => "");
  if (text.length > 16_384) return json({ message: "Too large." }, 413);
  let body = null;
  try { body = JSON.parse(text); } catch { /* nothing kept */ }
  const client = CLIENTS.has(body?.client) ? body.client : "web";
  const samples = cleanSamples(body?.samples);
  if (samples.length) {
    const at = new Date().toISOString();
    const colo = /^[A-Z]{3}$/.test(String(request.cf?.colo || "")) ? request.cf.colo : null;
    await env.DB.batch(samples.map((s) => env.DB.prepare("INSERT INTO perf_samples (kind, value, client, colo, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(s.kind, s.value, client, colo, at)));
  }
  return json({ kept: samples.length });
}

/// Samples past their fortnight, from the cron.
export async function sweepPerfSamples(env, now = Date.now()) {
  await env.DB.prepare("DELETE FROM perf_samples WHERE rowid IN (SELECT rowid FROM perf_samples WHERE created_at < ?1 LIMIT 5000)").bind(new Date(now - KEEP_MS).toISOString()).run();
}
