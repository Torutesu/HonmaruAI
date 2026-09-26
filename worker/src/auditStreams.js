// The audit log, streamed to the company's SIEM as it is written.
//
// docs/audit-log-phase2.md §4. A stream is an endpoint (HTTPS with our
// signature, Splunk's HTTP Event Collector, or Datadog's log intake), a
// secret, and the place in the log it has reached. The minute cron sends each
// active stream what is new, in order, up to 500 at a time; a failure backs
// off and retries, and after a day of failing the stream says so and every
// owner hears. Nothing is lost meanwhile: the stream picks up where it was.

import { getSession, getUserByGithubId } from "./db.js";
import { audit, person, presentEntry, AUDIT_ACTIONS, SEVERITIES } from "./audit.js";
import { decryptBody } from "./auditCrypto.js";
import { allowed } from "./permissions.js";
import { memberGate, reauthDenial } from "./policy.js";
import { sealSecret } from "./sso.js";
import { sign, validEndpoint } from "./webhooks.js";
import { listMembers } from "./team.js";
import { safe } from "./log.js";

export const STREAM_KINDS = ["https", "splunk_hec", "datadog"];
export const DATADOG_SITES = { us1: "datadoghq.com", us3: "us3.datadoghq.com", us5: "us5.datadoghq.com", eu1: "datadoghq.eu", ap1: "ap1.datadoghq.com", us1_fed: "ddog-gov.com" };
const BATCH = 500;
const FAILING_AFTER_MS = 24 * 3_600_000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store", "content-type": "application/json", "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, x-session-token, x-ai-key", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    },
  });
}

async function openSecret(env, sealed) {
  const [, iv, ct] = String(sealed || "").split(":");
  if (!env.SSO_SECRET_KEY || !iv || !ct) return null;
  const unb64 = (t) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", unb64(env.SSO_SECRET_KEY), { name: "AES-GCM" }, false, ["decrypt"]);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ct)));
}

function present(row) {
  return {
    id: row.id, kind: row.kind, endpoint: row.endpoint, region: row.region, minSeverity: row.min_severity,
    categories: row.categories ? JSON.parse(row.categories) : null, deliveredSeq: row.delivered_seq, status: row.status,
    failures: row.failures, nextTryAt: row.next_try_at, lastError: row.last_error, lastSentAt: row.last_sent_at, createdAt: row.created_at,
  };
}

/// Where each kind is sent, and how.
export function requestFor(stream, secret, events, { now = Date.now() } = {}) {
  if (stream.kind === "splunk_hec") {
    const body = events.map((e) => JSON.stringify({ time: e.date_create, host: "honmaru", source: "honmaru:audit", sourcetype: "_json", event: e })).join("\n");
    return { url: `${stream.endpoint.replace(/\/$/, "")}/services/collector/event`, headers: { authorization: `Splunk ${secret}`, "content-type": "application/json" }, body };
  }
  if (stream.kind === "datadog") {
    const site = DATADOG_SITES[stream.region] || DATADOG_SITES.us1;
    const body = JSON.stringify(events.map((e) => ({ ddsource: "honmaru", service: "audit", hostname: "honmaru", ddtags: `org:${stream.org_id},severity:${e.severity}`, message: JSON.stringify(e) })));
    return { url: `https://http-intake.logs.${site}/api/v2/logs`, headers: { "dd-api-key": secret, "content-type": "application/json" }, body };
  }
  const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  return { url: stream.endpoint, headers: { "content-type": "application/x-ndjson" }, body, sign: true, now };
}

async function send(stream, secret, events) {
  const req = requestFor(stream, secret, events);
  const headers = { ...req.headers };
  if (req.sign) {
    const t = Math.floor(Date.now() / 1000);
    headers["honmaru-signature"] = `t=${t},v1=${await sign(secret, t, req.body)}`;
  }
  const res = await fetch(req.url, { method: "POST", headers, body: req.body, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${new URL(req.url).host} answered ${res.status}`);
}

/// The next rows for a stream, decrypted and presented as the API shows them.
async function nextEvents(env, stream, members) {
  const rank = SEVERITIES.indexOf(stream.min_severity || "info");
  const cats = stream.categories ? JSON.parse(stream.categories) : null;
  const { results } = await env.DB.prepare(
    "SELECT seq, body FROM audit_events WHERE org_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3"
  ).bind(stream.org_id, stream.delivered_seq, BATCH).all();
  const ids = new Map(members.map((m) => [m.login, m.userId]));
  const refs = new Map();
  const keys = new Map();
  const out = [];
  let lastSeq = stream.delivered_seq;
  for (const r of results || []) {
    lastSeq = r.seq;
    const body = await decryptBody(env, stream.org_id, { seq: r.seq, ...JSON.parse(r.body) }, keys);
    if (SEVERITIES.indexOf(body.severity) < rank) continue;
    if (cats && !cats.includes(body.category)) continue;
    const shown = await presentEntry(body, stream.org_id, ids, refs);
    out.push({ ...shown, seq: r.seq, org_id: stream.org_id });
  }
  return { events: out, lastSeq };
}

/// From the minute cron: every active stream that is due, one batch each.
export async function deliverStreams(env, { now = Date.now(), limit = 20 } = {}) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM audit_streams WHERE status = 'active' AND (next_try_at IS NULL OR next_try_at <= ?1) LIMIT ?2"
  ).bind(new Date(now).toISOString(), limit).all();
  const done = [];
  for (const stream of results || []) {
    const members = await listMembers(env.DB, stream.org_id, null).catch(() => []);
    const { events, lastSeq } = await nextEvents(env, stream, members);
    if (lastSeq === stream.delivered_seq) continue;
    try {
      const secret = await openSecret(env, stream.secret);
      if (events.length) await send(stream, secret, events);
      await env.DB.prepare("UPDATE audit_streams SET delivered_seq = ?2, failures = 0, next_try_at = NULL, last_error = NULL, failing_since = NULL, last_sent_at = ?3 WHERE id = ?1")
        .bind(stream.id, lastSeq, new Date(now).toISOString()).run();
      done.push({ id: stream.id, sent: events.length });
    } catch (err) {
      const failures = Number(stream.failures || 0) + 1;
      const wait = Math.min(60, 2 ** (failures - 1)) * 60_000;
      const since = stream.failing_since || new Date(now).toISOString();
      const failing = now - Date.parse(since) >= FAILING_AFTER_MS;
      await env.DB.prepare("UPDATE audit_streams SET failures = ?2, next_try_at = ?3, last_error = ?4, failing_since = ?5, status = ?6 WHERE id = ?1")
        .bind(stream.id, failures, new Date(now + wait).toISOString(), safe(err?.message).slice(0, 300), since, failing ? "failing" : "active").run();
      if (failing) {
        await audit(env, null, { orgId: stream.org_id, action: "audit.stream_failing", actor: { type: "system" }, entity: { type: "audit_stream", id: stream.id, name: stream.kind } });
        const { mailOwners } = await import("./owners.js");
        await mailOwners(env, stream.org_id, { subject: "Your audit log stream has been failing for a day", text: `Sending the audit log to your ${stream.kind} endpoint has failed for 24 hours (${safe(err?.message)}). Nothing is lost: once it works again it continues from where it stopped. Check it in Tools → Audit log.` });
      }
    }
  }
  return done;
}

/// GET/POST /audit/streams · PUT/DELETE /audit/streams/:id ·
/// POST /audit/streams/:id/test · POST /audit/streams/:id/replay
export async function handleStreams(request, env, url) {
  const m = url.pathname.match(/^\/audit\/streams(?:\/([^/]+)(\/test|\/replay)?)?$/);
  if (!m) return null;
  const session = await getSession(env.DB, request.headers.get("x-session-token"));
  if (!session) return json({ message: "Please sign in." }, 401);
  const body = ["POST", "PUT"].includes(request.method) ? await request.json().catch(() => ({})) : null;
  const orgId = body?.orgId || url.searchParams.get("orgId");
  if (!orgId) return json({ message: "orgId is required" }, 400);
  const gate = await memberGate(env, session, orgId);
  if (gate) return gate;
  const user = await getUserByGithubId(env.DB, session.github_id);
  const list = async () => {
    const { results } = await env.DB.prepare("SELECT * FROM audit_streams WHERE org_id = ?1 ORDER BY created_at").bind(orgId).all();
    const newest = await env.DB.prepare("SELECT MAX(seq) AS s FROM audit_events WHERE org_id = ?1").bind(orgId).first();
    return (results || []).map((r) => ({ ...present(r), behind: Math.max(0, Number(newest?.s || 0) - Number(r.delivered_seq || 0)) }));
  };
  const canEdit = await allowed(env.DB, orgId, session.github_id, "audit.stream.manage");
  if (request.method === "GET" && !m[1]) {
    if (!(await allowed(env.DB, orgId, session.github_id, "audit.read"))) return json({ message: "Only an admin can see where the audit log goes." }, 403);
    return json({ streams: await list(), canEdit, kinds: STREAM_KINDS, datadogSites: Object.keys(DATADOG_SITES), categories: [...new Set(Object.values(AUDIT_ACTIONS).map((a) => a.category))], ready: Boolean(env.SSO_SECRET_KEY) });
  }
  if (!canEdit) {
    await audit(env, request, { orgId, action: "security.permission_denied", actor: person(user), entity: { type: "resource", id: "audit_streams", name: "where the audit log goes" }, outcome: "denied" });
    return json({ message: "Only an owner can change where the audit log goes." }, 403);
  }
  const again = await reauthDenial(env, session, orgId, { owner: true });
  if (again) return json(again.body, again.status);

  const settings = (b) => {
    const kind = STREAM_KINDS.includes(b.kind) ? b.kind : null;
    if (!kind) return { error: "Choose https, splunk_hec or datadog." };
    const endpoint = kind === "datadog" ? "https://http-intake.logs.datadoghq.com" : validEndpoint(b.endpoint);
    if (!endpoint) return { error: "The endpoint must be an https:// address on a public host." };
    const region = kind === "datadog" ? (DATADOG_SITES[b.region] ? b.region : "us1") : null;
    const minSeverity = SEVERITIES.includes(b.minSeverity) ? b.minSeverity : "info";
    const categories = Array.isArray(b.categories) && b.categories.length ? JSON.stringify(b.categories.map(String).slice(0, 20)) : null;
    return { kind, endpoint: String(endpoint), region, minSeverity, categories };
  };

  if (request.method === "POST" && !m[1]) {
    if (!env.SSO_SECRET_KEY) return json({ message: "Streaming is not set up on this deployment yet." }, 503);
    const s = settings(body);
    if (s.error) return json({ message: s.error }, 400);
    if (!String(body.secret || "").trim()) return json({ message: "The secret or token is required." }, 400);
    const id = `as_${[...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    // From now on: what was written before it existed is replayed only on request.
    const start = await env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM audit_events WHERE org_id = ?1").bind(orgId).first();
    await env.DB.prepare(
      `INSERT INTO audit_streams (id, org_id, kind, endpoint, secret, region, min_severity, categories, delivered_seq, status, failures, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active', 0, ?10, ?11)`
    ).bind(id, orgId, s.kind, s.endpoint, await sealSecret(env, String(body.secret)), s.region, s.minSeverity, s.categories, Number(start?.s || 0), String(session.github_id), new Date().toISOString()).run();
    await audit(env, request, { orgId, action: "workspace.audit_stream_changed", actor: person(user), entity: { type: "audit_stream", id, name: s.kind }, details: { change: "created", kind: s.kind, host: new URL(s.endpoint).hostname } });
    return json({ streams: await list() }, 201);
  }
  const stream = m[1] ? await env.DB.prepare("SELECT * FROM audit_streams WHERE id = ?1 AND org_id = ?2").bind(decodeURIComponent(m[1]), orgId).first() : null;
  if (!stream) return json({ message: "No such stream." }, 404);
  const entity = { type: "audit_stream", id: stream.id, name: stream.kind };

  if (m[2] === "/test" && request.method === "POST") {
    const secret = await openSecret(env, stream.secret);
    const event = { id: `test_${Date.now()}`, action: "audit.stream_test", category: "audit", severity: "info", outcome: "success", date_create: Math.floor(Date.now() / 1000), actor: person(user) && { type: "user", name: user?.name || null }, entity: null, context: {}, details: { stream: stream.id }, text: "A test from Honmaru", seq: 0, org_id: orgId };
    try {
      await send(stream, secret, [event]);
      return json({ ok: true });
    } catch (err) {
      return json({ ok: false, message: safe(err?.message) }, 502);
    }
  }
  if (m[2] === "/replay" && request.method === "POST") {
    const from = Math.max(0, Number(body.fromSeq) || 0);
    await env.DB.prepare("UPDATE audit_streams SET delivered_seq = ?2, status = 'active', failures = 0, next_try_at = NULL, failing_since = NULL WHERE id = ?1").bind(stream.id, Math.max(0, from - 1)).run();
    await audit(env, request, { orgId, action: "audit.stream_replayed", actor: person(user), entity, details: { from_seq: from } });
    return json({ streams: await list() });
  }
  if (request.method === "PUT" && !m[2]) {
    const s = settings({ kind: stream.kind, endpoint: stream.endpoint, region: stream.region, minSeverity: stream.min_severity, ...body });
    if (s.error) return json({ message: s.error }, 400);
    const status = body.paused === true ? "paused" : body.paused === false ? "active" : stream.status;
    const secret = body.secret ? await sealSecret(env, String(body.secret)) : stream.secret;
    await env.DB.prepare("UPDATE audit_streams SET endpoint = ?2, region = ?3, min_severity = ?4, categories = ?5, secret = ?6, status = ?7, failures = 0, next_try_at = NULL WHERE id = ?1")
      .bind(stream.id, s.endpoint, s.region, s.minSeverity, s.categories, secret, status).run();
    await audit(env, request, { orgId, action: "workspace.audit_stream_changed", actor: person(user), entity, details: { change: "updated", status, secret: body.secret ? "replaced" : "kept" } });
    return json({ streams: await list() });
  }
  if (request.method === "DELETE" && !m[2]) {
    await env.DB.prepare("DELETE FROM audit_streams WHERE id = ?1").bind(stream.id).run();
    await audit(env, request, { orgId, action: "workspace.audit_stream_changed", actor: person(user), entity, details: { change: "deleted" } });
    return json({ streams: await list() });
  }
  return json({ message: "not found" }, 404);
}
