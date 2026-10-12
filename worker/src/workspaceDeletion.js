// Deleting a workspace: asked for by an owner, carried out thirty days later.
//
// For thirty days the workspace is closed to everyone but its owners, who
// may take the request back; nothing is gone yet. Then a daily job deletes
// it: every row stored under it, in batches, and its objects in storage
// (org/<id>/). What is left is a tombstone saying when and at whose request.
//
// The audit log is the one record kept on: its rows leave D1 by the
// workspace's audit retention once sealed into the archive, as any other
// workspace's do (auditRetention.js), and the archive itself is object-
// locked. That is what a customer's auditor will ask for after the fact.

import { audit } from "./audit.js";

export const GRACE_DAYS = 30;
const DAY = 86_400_000;

/// Tables a deletion leaves alone: the audit log's, to its own retention;
/// and the deletion's own bookkeeping.
const SPARED = new Set(["audit_events", "audit_seals", "audit_principal_keys", "org_audit_settings", "audit_streams", "workspace_deletions", "workspace_tombstones"]);
/// Rows deleted per statement, and statements per workspace per run: the
/// rest is picked up the next day.
const BATCH = 2000;
const BATCHES_PER_RUN = 200;

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

/// Ask for the workspace to be deleted in thirty days.
export async function scheduleDeletion(env, request, { orgId, by, actor, now = Date.now() }) {
  const due = new Date(now + GRACE_DAYS * DAY).toISOString();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO workspace_deletions (org_id, due_at, requested_by, requested_at) VALUES (?1, ?2, ?3, ?4)"
  ).bind(orgId, due, String(by), new Date(now).toISOString()).run();
  cache.delete(orgId);
  await audit(env, request, { orgId, action: "workspace.deletion_scheduled", actor, entity: { type: "workspace", id: orgId }, details: { due_at: due } });
  return due;
}

export async function cancelDeletion(env, request, { orgId, actor }) {
  const out = await env.DB.prepare("DELETE FROM workspace_deletions WHERE org_id = ?1").bind(orgId).run();
  cache.delete(orgId);
  if (!(out?.meta?.changes > 0)) return false;
  await audit(env, request, { orgId, action: "workspace.deletion_cancelled", actor, entity: { type: "workspace", id: orgId } });
  return true;
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
  for (const table of await workspaceTables(env.DB)) {
    for (;;) {
      if (left-- <= 0) return false;
      const out = await env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE org_id = ?1 LIMIT ${BATCH})`).bind(orgId).run();
      if (!(out?.meta?.changes >= BATCH)) break;
    }
  }
  // Its objects: files, videos, exports, icons.
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
    "SELECT org_id AS id, requested_by AS deletion_requested_by FROM workspace_deletions WHERE due_at <= ?1 ORDER BY due_at LIMIT ?2"
  ).bind(new Date(now).toISOString(), limit).all();
  const done = [];
  for (const row of results) {
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
