// How long the audit log stays readable here, and the holds that keep it.
//
// docs/audit-log-phase2.md §5. Rows older than a workspace's retention leave
// D1 once — and only once — they are sealed in the archive, where the bucket
// lock keeps them for its own, longer, period. A legal hold keeps everything,
// and can keep a single person's key through the deletion of their account.
// Holds and retention are the operator's to set, on a customer's request:
// an owner cannot shorten what the contract or the law says to keep.

import { audit } from "./audit.js";
import { principalOf } from "./auditCrypto.js";

/// The retention a workspace gets when nobody has said otherwise. Plans are
/// per person today, so there is one default until workspaces have plans.
export const DEFAULT_RETENTION_DAYS = 180;
const DAY = 86_400_000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "cache-control": "no-store", "content-type": "application/json" } });
}

export async function auditSettings(db, orgId) {
  const row = await db.prepare("SELECT * FROM org_audit_settings WHERE org_id = ?1").bind(orgId).first().catch(() => null);
  return {
    retentionDays: row?.retention_days || DEFAULT_RETENTION_DAYS,
    legalHold: Boolean(row?.legal_hold),
    legalHoldReason: row?.legal_hold_reason || null,
  };
}

/// Take sealed rows past their retention out of D1. The only place this app
/// deletes from the audit log (test/audit-immutable.test.js keeps it so).
export async function pruneAudit(env, { now = Date.now(), orgLimit = 50 } = {}) {
  const { results } = await env.DB.prepare(
    "SELECT org_id, MAX(to_seq) AS sealed FROM audit_seals GROUP BY org_id LIMIT ?1"
  ).bind(orgLimit).all();
  const pruned = [];
  for (const r of results || []) {
    const settings = await auditSettings(env.DB, r.org_id);
    if (settings.legalHold) continue;
    const cutoff = Math.floor((now - settings.retentionDays * DAY) / 1000);
    const range = await env.DB.prepare(
      "SELECT MIN(seq) AS lo, MAX(seq) AS hi, COUNT(*) AS n FROM audit_events WHERE org_id = ?1 AND created_at < ?2 AND seq <= ?3"
    ).bind(r.org_id, cutoff, r.sealed).first();
    if (!range?.n) continue;
    await env.DB.prepare("DELETE FROM audit_events WHERE org_id = ?1 AND created_at < ?2 AND seq <= ?3").bind(r.org_id, cutoff, r.sealed).run();
    await audit(env, null, { orgId: r.org_id, action: "audit.pruned", actor: { type: "system" }, details: { from_seq: range.lo, through_seq: range.hi, count: range.n, retention_days: settings.retentionDays } });
    pruned.push({ orgId: r.org_id, count: range.n });
  }
  return pruned;
}

/// The operator's door: retention, and holds, on a customer's request.
/// POST /ops/audit/settings {orgId, retentionDays?, legalHold?, reason}
/// POST /ops/audit/principal-hold {orgId, login | principal, hold, reason}
/// Both need the OPS_TOKEN secret, and both are recorded as critical.
export async function handleOps(request, env, url) {
  if (!url.pathname.startsWith("/ops/audit/")) return null;
  const token = request.headers.get("x-ops-token") || "";
  if (!env.OPS_TOKEN || token.length !== env.OPS_TOKEN.length || token !== env.OPS_TOKEN) return json({ message: "not found" }, 404);
  if (request.method !== "POST") return json({ message: "not found" }, 404);
  const body = await request.json().catch(() => ({}));
  const orgId = String(body.orgId || "");
  if (!orgId) return json({ message: "orgId is required" }, 400);
  const reason = String(body.reason || "").trim().slice(0, 500);
  if (!reason) return json({ message: "Say why." }, 400);
  const operator = { type: "operator", id: "ops", name: "Honmaru operations" };

  if (url.pathname === "/ops/audit/settings") {
    const before = await auditSettings(env.DB, orgId);
    const retention = body.retentionDays === undefined ? before.retentionDays : Number(body.retentionDays);
    if (!Number.isInteger(retention) || retention < 30 || retention > 3650) return json({ message: "Retention is 30 to 3650 days." }, 400);
    const hold = body.legalHold === undefined ? before.legalHold : Boolean(body.legalHold);
    await env.DB.prepare(
      `INSERT INTO org_audit_settings (org_id, retention_days, legal_hold, legal_hold_reason, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4, 'ops', ?5)
       ON CONFLICT(org_id) DO UPDATE SET retention_days = excluded.retention_days, legal_hold = excluded.legal_hold,
         legal_hold_reason = excluded.legal_hold_reason, updated_by = 'ops', updated_at = excluded.updated_at`
    ).bind(orgId, retention, hold ? 1 : 0, hold ? reason : null, new Date().toISOString()).run();
    if (hold !== before.legalHold) await audit(env, request, { orgId, action: "audit.legal_hold_changed", actor: operator, details: { legal_hold: hold, reason } });
    if (retention !== before.retentionDays) await audit(env, request, { orgId, action: "audit.retention_changed", actor: operator, details: { from: before.retentionDays, to: retention, reason } });
    return json(await auditSettings(env.DB, orgId));
  }
  if (url.pathname === "/ops/audit/principal-hold") {
    const principal = body.principal && /^p_[0-9a-f]{16}$/.test(body.principal) ? body.principal : body.login ? await principalOf(env, orgId, String(body.login)) : null;
    if (!principal) return json({ message: "Say whose: a login or a p_ pseudonym." }, 400);
    const hold = body.hold !== false;
    const done = await env.DB.prepare("UPDATE audit_principal_keys SET hold = ?3 WHERE org_id = ?1 AND principal = ?2").bind(orgId, principal, hold ? 1 : 0).run();
    if (!done?.meta?.changes) return json({ message: "No key for that person in this workspace." }, 404);
    // Lifted from someone who deleted their account meanwhile: their key goes now.
    if (!hold) {
      const row = await env.DB.prepare("SELECT shred_pending FROM audit_principal_keys WHERE org_id = ?1 AND principal = ?2").bind(orgId, principal).first();
      if (row?.shred_pending) {
        const { shredPrincipal } = await import("./auditCrypto.js");
        await shredPrincipal(env, orgId, principal);
        await env.DB.prepare("UPDATE audit_principal_keys SET shred_pending = 0 WHERE org_id = ?1 AND principal = ?2").bind(orgId, principal).run();
        await audit(env, request, { orgId, action: "audit.principal_shredded", actor: { type: "system" }, details: { principal } });
      }
    }
    await audit(env, request, { orgId, action: "audit.principal_hold_changed", actor: operator, details: { principal, hold, reason } });
    return json({ principal, hold });
  }
  return json({ message: "not found" }, 404);
}
