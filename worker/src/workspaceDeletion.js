// Deleting a workspace: asked for by an owner, carried out thirty days later.
//
// For thirty days the workspace is closed to everyone but its owners, who
// may take the request back; nothing is gone yet. Then a daily job claims
// it, after which it can no longer be taken back, and deletes it: every row
// stored under it, in batches, and its objects in storage (org/<id>/, and
// those kept by name: its icon, emoji, agents' pictures and Jam
// recordings). What is left is a tombstone saying when and at whose request.
//
// The audit log is the one record kept on: its rows leave D1 by the
// workspace's audit retention once sealed into the archive, as any other
// workspace's do (auditRetention.js), and the archive itself is object-
// locked. That is what a customer's auditor will ask for after the fact.

import { audit } from "./audit.js";

export const GRACE_DAYS = 30;
const DAY = 86_400_000;

/// Tables a deletion leaves alone: the audit log's, to its own retention;
/// the deletion's own bookkeeping; and anonymized upload cleanup identities
/// which must outlive late storage completions.
const SPARED = new Set(["audit_events", "audit_seals", "audit_principal_keys", "org_audit_settings", "audit_streams", "workspace_deletions", "workspace_tombstones", "hx_workspace_file_uploads"]);
/// Rows deleted per statement, and statements per workspace per run: the
/// rest is picked up the next day.
const BATCH = 2000;
const BATCHES_PER_RUN = 200;

/// Where a workspace's objects are kept by a name only its rows know: the
/// key each row names, and how the row lets go of it once it is deleted.
const NAMED_OBJECTS = [
  { table: "org_icons", column: "media_id", key: (name) => name, clear: "DELETE FROM org_icons WHERE org_id = ?1 AND rowid IN" },
  { table: "org_emoji", column: "media_id", key: (name) => name, clear: "DELETE FROM org_emoji WHERE org_id = ?1 AND rowid IN" },
  { table: "custom_agents", column: "avatar_url", key: (url) => /\/agents\/avatar\/(agent-avatar-[0-9a-f-]{36})$/.exec(String(url))?.[1] || null, clear: "UPDATE custom_agents SET avatar_url = NULL WHERE org_id = ?1 AND rowid IN" },
];
/// The Jam recordings have all been looked through.
const SCANNED = "scanned";

const cache = new Map(); // orgId -> { due, at }

/// When this workspace is to be deleted (ISO), or null. Cached for half a
/// minute: read on every request into a workspace.
export async function deletionDue(db, orgId) {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < 30_000) return hit.due;
  const row = await db.prepare("SELECT due_at FROM workspace_deletions WHERE org_id = ?1").bind(orgId).first().catch(() => null);
  const due = row?.due_at || null;
  cache.set(orgId, { due, at: Date.now() });
  return due;
}

export function forgetDeletions() { cache.clear(); }

/// Ask for the workspace to be deleted in thirty days. Asking again restarts
/// the thirty days, unless the deletion has already begun.
export async function scheduleDeletion(env, request, { orgId, by, actor, now = Date.now() }) {
  const due = new Date(now + GRACE_DAYS * DAY).toISOString();
  const out = await env.DB.prepare(
    `INSERT INTO workspace_deletions (org_id, due_at, requested_by, requested_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(org_id) DO UPDATE SET due_at = excluded.due_at, requested_by = excluded.requested_by, requested_at = excluded.requested_at
     WHERE workspace_deletions.purge_started_at IS NULL`
  ).bind(orgId, due, String(by), new Date(now).toISOString()).run();
  cache.delete(orgId);
  if (!(out?.meta?.changes > 0)) return (await env.DB.prepare("SELECT due_at FROM workspace_deletions WHERE org_id = ?1").bind(orgId).first())?.due_at || due;
  await audit(env, request, { orgId, action: "workspace.deletion_scheduled", actor, entity: { type: "workspace", id: orgId }, details: { due_at: due } });
  return due;
}

/// Take the request back: "cancelled", "started" when the daily job has
/// already claimed it and deleting has begun, or null when there was none.
export async function cancelDeletion(env, request, { orgId, actor }) {
  const out = await env.DB.prepare("DELETE FROM workspace_deletions WHERE org_id = ?1 AND purge_started_at IS NULL").bind(orgId).run();
  cache.delete(orgId);
  if (!(out?.meta?.changes > 0)) {
    const started = await env.DB.prepare("SELECT 1 FROM workspace_deletions WHERE org_id = ?1").bind(orgId).first();
    return started ? "started" : null;
  }
  await audit(env, request, { orgId, action: "workspace.deletion_cancelled", actor, entity: { type: "workspace", id: orgId } });
  return "cancelled";
}

/// Claim a due deletion for this run, before anything is deleted: only the
/// request that was selected, still due, and not taken back. A claimed one
/// stays claimed, so a run that stopped partway is picked up again.
async function claimDeletion(db, row, now) {
  const out = await db.prepare(
    "UPDATE workspace_deletions SET purge_started_at = COALESCE(purge_started_at, ?3) WHERE org_id = ?1 AND requested_at = ?2 AND due_at <= ?3"
  ).bind(row.id, row.requested_at, new Date(now).toISOString()).run();
  return out?.meta?.changes > 0;
}

/// The tables that keep rows by workspace, found rather than listed, so a
/// table added later is not forgotten.
async function workspaceTables(db) {
  const { results: tables = [] } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all();
  const out = [];
  for (const { name } of tables) {
    if (SPARED.has(name) || !/^[a-z_][a-z0-9_]*$/.test(name)) continue;
    const { results: cols = [] } = await db.prepare(`PRAGMA table_info(${name})`).all();
    if (cols.some((c) => c.name === "org_id")) out.push(name);
  }
  return out;
}

/// Delete one workspace's rows and objects, as far as one run goes.
/// Returns whether it is all gone.
export async function purgeWorkspace(env, orgId, { budget = BATCHES_PER_RUN } = {}) {
  let left = budget;
  // File uploads can finish after their request has disappeared. Keep only
  // their cleanup identities so recovery can remove late writes after the
  // workspace's ordinary rows and object prefix have already been deleted.
  // This table is optional until the workspace-file migration is deployed.
  const fileUploads = await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hx_workspace_file_uploads'").first();
  if (fileUploads) await env.DB.prepare("UPDATE hx_workspace_file_uploads SET status='cleanup',expires_at=0,created_by='',file_id='',expected_version=0 WHERE org_id=?").bind(orgId).run();
  if (env.MEDIA) {
    // Objects kept outside org/<id>/, named only by its rows: deleted while
    // those rows still say which they are.
    for (const { table, column, key, clear } of NAMED_OBJECTS) {
      for (;;) {
        if (left-- <= 0) return false;
        const { results: rows = [] } = await env.DB.prepare(`SELECT rowid, ${column} AS name FROM ${table} WHERE org_id = ?1 AND ${column} IS NOT NULL LIMIT 1000`).bind(orgId).all();
        if (!rows.length) break;
        const keys = rows.map((r) => key(r.name)).filter(Boolean);
        if (keys.length) await env.MEDIA.delete(keys);
        await env.DB.prepare(`${clear} (${rows.map((r) => Number(r.rowid)).join(", ")})`).bind(orgId).run();
      }
    }
    // Its Jam recordings, kept as jam/<id> with the workspace in their
    // metadata: through every one, a page a statement, from wherever the
    // last run stopped.
    const state = await env.DB.prepare("SELECT purge_cursor FROM workspace_deletions WHERE org_id = ?1").bind(orgId).first();
    let cursor = state?.purge_cursor || undefined;
    while (cursor !== SCANNED) {
      if (left-- <= 0) return false;
      const page = await env.MEDIA.list({ prefix: "jam/", limit: 1000, cursor, include: ["customMetadata"] });
      const keys = (page.objects || []).filter((o) => o.customMetadata?.orgId === orgId).map((o) => o.key);
      if (keys.length) await env.MEDIA.delete(keys);
      cursor = page.truncated ? page.cursor : SCANNED;
      await env.DB.prepare("UPDATE workspace_deletions SET purge_cursor = ?2 WHERE org_id = ?1").bind(orgId, cursor).run();
    }
  }
  for (const table of await workspaceTables(env.DB)) {
    for (;;) {
      if (left-- <= 0) return false;
      const out = await env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE org_id = ?1 LIMIT ${BATCH})`).bind(orgId).run();
      if (!(out?.meta?.changes >= BATCH)) break;
    }
  }
  // Its objects: files, videos, exports.
  if (env.MEDIA) {
    const prefix = `org/${encodeURIComponent(orgId)}/`;
    for (;;) {
      if (left-- <= 0) return false;
      const page = await env.MEDIA.list({ prefix, limit: 1000 });
      const keys = (page.objects || []).map((o) => o.key);
      if (keys.length) await env.MEDIA.delete(keys);
      if (!page.truncated) break;
    }
  }
  return true;
}

/// Daily: carry out the deletions that are due.
export async function purgeDueWorkspaces(env, { now = Date.now(), limit = 5 } = {}) {
  const { results = [] } = await env.DB.prepare(
    "SELECT org_id AS id, requested_by AS deletion_requested_by, requested_at FROM workspace_deletions WHERE due_at <= ?1 ORDER BY due_at LIMIT ?2"
  ).bind(new Date(now).toISOString(), limit).all();
  const done = [];
  for (const row of results) {
    if (!(await claimDeletion(env.DB, row, now))) continue;
    cache.delete(row.id);
    if (!(await purgeWorkspace(env, row.id))) continue;
    await audit(env, null, { orgId: row.id, action: "workspace.deleted", actor: { type: "system" }, entity: { type: "workspace", id: row.id }, details: { requested_by: row.deletion_requested_by } });
    await env.DB.prepare("INSERT OR REPLACE INTO workspace_tombstones (org_id, deleted_at, requested_by) VALUES (?1, ?2, ?3)")
      .bind(row.id, new Date(now).toISOString(), row.deletion_requested_by || null).run();
    await env.DB.prepare("DELETE FROM orgs WHERE id = ?1").bind(row.id).run();
    await env.DB.prepare("DELETE FROM workspace_deletions WHERE org_id = ?1").bind(row.id).run();
    cache.delete(row.id);
    done.push(row.id);
  }
  return done;
}
