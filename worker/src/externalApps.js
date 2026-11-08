import { getSession, getUserByGithubId } from "./db.js";
import { getMode } from "./harness/mode.js";
import { sha256Hex } from "./auth.js";
import { addRow, updateRow, deleteRow } from "./harness/tables.js";
import { deliverExternalInvite } from "./externalInviteMail.js";
import { MAX_PREVIEW_SOURCE, validateSource } from "./harness/customApps.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const fail = (message = "App not found.", status = 404) => json({ message }, status);
const MAX_PAGE = 100;
const MAX_OFFSET = 10000;

function pathParts(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "external" || parts[1] !== "apps" || parts.length < 4) return null;
  try {
    const decoded = parts.map((part) => decodeURIComponent(part));
    const [,, orgId, appId] = decoded;
    if (!orgId || orgId.length > 200 || !appId || appId.length > 200) return null;
    return { parts: decoded, orgId, appId };
  } catch {
    return null;
  }
}

async function actorFor(request, db) {
  const session = await getSession(db, request.headers.get("x-session-token"));
  if (!session) return null;
  const user = await getUserByGithubId(db, session.github_id);
  return user ? { session, user } : null;
}

function isCustomApp(definition) {
  try { return Boolean(JSON.parse(definition || "{}")?.custom); } catch { return false; }
}

function publishedCustomSource(definition) {
  try {
    const html = JSON.parse(definition || "{}").custom?.published;
    return validateSource(html) && html.length <= MAX_PREVIEW_SOURCE ? html : null;
  } catch { return null; }
}

export function externalAppWriteGuard(orgId, appId, userId, tableId) {
  return {
    binds: [orgId, appId, userId, tableId],
    sql(start) {
      return `EXISTS(SELECT 1 FROM hx_apps a JOIN hx_external_resource_grants g ON g.org_id=a.org_id AND g.resource_type='app' AND g.resource_id=a.id WHERE a.org_id=?${start} AND a.id=?${start+1} AND g.recipient_github_id=?${start+2} AND g.permission='edit' AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND (a.table_id=?${start+3} OR EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=a.org_id AND e.app_id=a.id AND e.table_id=?${start+3})) AND EXISTS(SELECT 1 FROM org_settings s WHERE s.org_id=a.org_id AND s.mode='harness') AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=a.org_id AND m.user_github_id=?${start+2}) AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=a.org_id AND d.purge_started_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=a.org_id))`;
    },
  };
}

async function liveEditGrant(db, orgId, appId, userId) {
  const row = await db.prepare("SELECT 1 FROM hx_external_resource_grants g JOIN hx_apps a ON a.org_id=g.org_id AND a.id=g.resource_id WHERE g.org_id=?1 AND g.resource_type='app' AND g.resource_id=?2 AND g.recipient_github_id=?3 AND g.permission='edit' AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?4) AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=?1 AND m.user_github_id=?3) AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=?1 AND d.purge_started_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=?1)")
    .bind(orgId, appId, userId, new Date().toISOString()).first();
  return Boolean(row);
}
async function appAccess(db, env, orgId, appId, userId) {
  if ((await getMode(db, orgId)) !== "harness") return null;
  const row = await db.prepare(`SELECT a.id,a.name,a.description,a.icon,a.table_id,a.version,a.definition,a.created_at,a.updated_at,g.permission
    FROM hx_apps a
    JOIN hx_external_resource_grants g ON g.org_id=a.org_id AND g.resource_type='app' AND g.resource_id=a.id
      AND g.recipient_github_id=?3 AND g.revoked_at IS NULL
      AND (g.expires_at IS NULL OR g.expires_at>?4)
    WHERE a.org_id=?1 AND a.id=?2
      AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=a.org_id AND member.user_github_id=?3)
      AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=a.org_id AND d.purge_started_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=a.org_id)`)
    .bind(orgId, appId, userId, new Date().toISOString()).first();
  return row ? { app: row, permission: row.permission } : null;
}

async function linkedTable(db, orgId, appId, tableId, userId) {
  return db.prepare(`SELECT t.id,t.name,t.columns,t.created_at,t.updated_at
    FROM hx_tables t JOIN hx_apps a ON a.org_id=t.org_id AND a.id=?2
    WHERE t.org_id=?1 AND t.id=?3
      AND (a.table_id=t.id OR EXISTS(
        SELECT 1 FROM hx_app_entities e WHERE e.org_id=a.org_id AND e.app_id=a.id AND e.table_id=t.id))
      AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=a.org_id AND g.resource_type='app'
        AND g.resource_id=a.id AND g.recipient_github_id=?4 AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at>?5)
        AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=a.org_id AND m.user_github_id=?4))
      AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=a.org_id AND d.purge_started_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=a.org_id)`)
    .bind(orgId, appId, tableId, userId, new Date().toISOString()).first();
}

async function scopeFor(db, orgId, appId, tableId, rowId, userId) {
  if (Boolean(tableId) !== Boolean(rowId) && !tableId) return null;
  let table = null;
  if (tableId) {
    table = await linkedTable(db, orgId, appId, tableId, userId);
    if (!table) return null;
  }
  if (rowId) {
    const row = await db.prepare("SELECT id FROM hx_rows WHERE org_id=?1 AND table_id=?2 AND id=?3")
      .bind(orgId, tableId, rowId).first();
    if (!row) return null;
  }
  return { tableId, rowId, table };
}

function parseColumns(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    // Column definitions are part of the linked table's schema. Strip any
    // future internal or execution-only fields before returning them to guests.
    return parsed.map((column) => ({
      id: String(column?.id || ""),
      name: String(column?.name || ""),
      type: String(column?.type || "text"),
      ...(column?.options ? { options: column.options } : {}),
      ...(typeof column?.targetEntity === "string" ? { targetEntity: column.targetEntity } : {}),
      ...(column?.multiple != null ? { multiple: Boolean(column.multiple) } : {}),
      ...(column?.required != null ? { required: Boolean(column.required) } : {}),
    })).filter((column) => column.id && column.name);
  } catch {
    return [];
  }
}

async function readRows(db, orgId, appId, table, url, userId, rowId = null) {
  const columns = parseColumns(table.columns);
  if (rowId) {
    const row = await db.prepare(`SELECT id,data,position,created_at,updated_at FROM hx_rows
      WHERE org_id=?1 AND table_id=?2 AND id=?3
        AND EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=?1 AND a.id=?4
          AND (a.table_id=?2 OR EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=?1 AND e.app_id=?4 AND e.table_id=?2)))
        AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=?1 AND d.purge_started_at IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=?1)
        AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=?1 AND g.resource_type='app'
          AND g.resource_id=?4 AND g.recipient_github_id=?5 AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at>?6)
          AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=?1 AND m.user_github_id=?5))`)
      .bind(orgId, table.id, rowId, appId, userId, new Date().toISOString()).first();
    return row ? [formatRow(row, columns)] : null;
  }
  const requestedLimit = Number(url.searchParams.get("limit") || 50);
  const requestedOffset = Number(url.searchParams.get("offset") || 0);
  const limit = Number.isSafeInteger(requestedLimit) ? Math.min(MAX_PAGE, Math.max(1, requestedLimit)) : 50;
  const offset = Number.isSafeInteger(requestedOffset) ? Math.min(MAX_OFFSET, Math.max(0, requestedOffset)) : 0;
  const { results = [] } = await db.prepare(`SELECT id,data,position,created_at,updated_at FROM hx_rows
    WHERE org_id=?1 AND table_id=?2
      AND EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=?1 AND a.id=?3
        AND (a.table_id=?2 OR EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=?1 AND e.app_id=?3 AND e.table_id=?2)))
      AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=?1 AND d.purge_started_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=?1)
      AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=?1 AND g.resource_type='app'
        AND g.resource_id=?3 AND g.recipient_github_id=?6 AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at>?7)
        AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=?1 AND m.user_github_id=?6))
    ORDER BY position,id LIMIT ?4 OFFSET ?5`)
    .bind(orgId, table.id, appId, limit, offset, userId, new Date().toISOString()).all();
  return results.map((row) => formatRow(row, columns));
}

function formatRow(row, columns) {
  let data = {};
  try { data = JSON.parse(row.data || "{}"); } catch {}
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  const allowed = new Set(columns.map((column) => column.id));
  data = Object.fromEntries(Object.entries(data).filter(([key]) => allowed.has(key)));
  return { id: row.id, data, position: row.position, createdAt: row.created_at, updatedAt: row.updated_at };
}

function conversationScope(input) {
  const tableId = typeof input?.tableId === "string" ? input.tableId : "";
  const rowId = typeof input?.rowId === "string" ? input.rowId : "";
  if (tableId.length > 200 || rowId.length > 200 || Boolean(tableId) !== Boolean(rowId)) return null;
  return { tableId, rowId };
}

async function readConversation(db, orgId, appId, userId, scope) {
  const { results = [] } = await db.prepare(`SELECT m.sequence,m.author_id,m.body,m.created_at,u.name,u.login
    FROM hx_app_messages m JOIN users u ON u.github_id=m.author_id
    WHERE m.org_id=?1 AND m.app_id=?2 AND m.table_id=?3 AND m.row_id=?4
      AND EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=?1 AND a.id=?2
        AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=?1 AND d.purge_started_at IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=?1))
      AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=?1 AND g.resource_type='app'
        AND g.resource_id=?2 AND g.recipient_github_id=?5 AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at>?6)
        AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=?1 AND member.user_github_id=?5))
      AND (?3='' OR EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=?1 AND a.id=?2 AND a.table_id=?3)
        OR EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=?1 AND e.app_id=?2 AND e.table_id=?3))
      AND (?4='' OR EXISTS(SELECT 1 FROM hx_rows r WHERE r.org_id=?1 AND r.table_id=?3 AND r.id=?4))
    ORDER BY m.sequence LIMIT 200`)
    .bind(orgId, appId, scope.tableId, scope.rowId, userId, new Date().toISOString()).all();
  return results.map((row) => ({
    id: String(row.sequence), body: row.body, createdAt: row.created_at,
    authorName: row.name || row.login, mine: String(row.author_id) === String(userId),
  }));
}

async function conversation(request, env, url, orgId, appId, actor, access) {
  if (!["GET", "POST"].includes(request.method)) return fail("Method not allowed.", 405);
  const input = request.method === "GET" ? Object.fromEntries(url.searchParams) : await request.json().catch(() => null);
  if (!input || typeof input !== "object") return fail("Invalid conversation request.", 400);
  const scope = conversationScope(input);
  if (!scope) return fail("Invalid conversation scope.", 400);
  const validated = await scopeFor(env.DB, orgId, appId, scope.tableId, scope.rowId, actor.user.github_id);
  if (!validated) return fail();
  if (request.method === "GET") {
    return json({ messages: await readConversation(env.DB, orgId, appId, actor.user.github_id, scope) });
  }
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (input.requestSend === true) {
    if (access.permission !== "view") return fail("Only view guests need an approval to send.", 400);
    if (!body || body.length > 4000) return fail("A message must be 1–4000 characters.", 400);
    const at = new Date().toISOString();
    const id = "xas_" + crypto.randomUUID().replaceAll("-", "");
    const inserted = await env.DB.prepare("INSERT OR IGNORE INTO hx_external_app_send_requests (id,org_id,app_id,table_id,row_id,guest_github_id,body,status,requested_at) SELECT ?1,?2,?3,?4,?5,?6,?7,'pending',?8 WHERE EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=?2 AND g.resource_type='app' AND g.resource_id=?3 AND g.recipient_github_id=?6 AND g.permission='view' AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?8)) AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=?2 AND m.user_github_id=?6) AND EXISTS(SELECT 1 FROM org_settings s WHERE s.org_id=?2 AND s.mode='harness') AND EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=?2 AND a.id=?3 AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=?2 AND d.purge_started_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=?2)) AND (?4='' OR EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=?2 AND a.id=?3 AND a.table_id=?4) OR EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=?2 AND e.app_id=?3 AND e.table_id=?4)) AND (?5='' OR EXISTS(SELECT 1 FROM hx_rows r WHERE r.org_id=?2 AND r.table_id=?4 AND r.id=?5))")
      .bind(id, orgId, appId, scope.tableId, scope.rowId, actor.user.github_id, body, at).run();
    const request = Number(inserted.meta?.changes || 0)
      ? { id }
      : await env.DB.prepare("SELECT id FROM hx_external_app_send_requests WHERE org_id=?1 AND app_id=?2 AND table_id=?3 AND row_id=?4 AND guest_github_id=?5 AND status='pending'")
        .bind(orgId, appId, scope.tableId, scope.rowId, actor.user.github_id).first();
    return request?.id ? json({ requestId: request.id, status: "pending" }, inserted.meta?.changes ? 201 : 200) : fail("App access was revoked.", 404);
  }
  if (access.permission !== "edit") return fail("An edit grant is required to send a message.", 403);

  const requestId = typeof input.requestId === "string" ? input.requestId : "";
  if (!body || body.length > 4000 || !/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)) {
    return fail("A message and valid requestId are required.", 400);
  }
  const at = new Date().toISOString();
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO hx_app_messages
      (org_id,app_id,table_id,row_id,author_id,request_id,body,created_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8
    WHERE EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=?1 AND g.resource_type='app'
      AND g.resource_id=?2 AND g.recipient_github_id=?5 AND g.permission='edit' AND g.revoked_at IS NULL
      AND (g.expires_at IS NULL OR g.expires_at>?8)
      AND EXISTS(SELECT 1 FROM org_settings s WHERE s.org_id=?1 AND s.mode='harness')
      AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=?1 AND member.user_github_id=?5))
      AND EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=?1 AND a.id=?2
        AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=?1 AND d.purge_started_at IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=?1))
      AND (?3='' OR EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=?1 AND a.id=?2 AND a.table_id=?3)
        OR EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=?1 AND e.app_id=?2 AND e.table_id=?3))
      AND (?4='' OR EXISTS(SELECT 1 FROM hx_rows r WHERE r.org_id=?1 AND r.table_id=?3 AND r.id=?4))`)
    .bind(orgId, appId, scope.tableId, scope.rowId, actor.user.github_id, requestId, body, at).run();
  const message = await env.DB.prepare(`SELECT m.sequence,m.body,m.created_at FROM hx_app_messages m
    WHERE m.org_id=?1 AND m.app_id=?2 AND m.table_id=?3 AND m.row_id=?4 AND m.author_id=?5 AND m.request_id=?6
      AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=m.org_id AND g.resource_type='app'
        AND g.resource_id=m.app_id AND g.recipient_github_id=?5 AND g.permission='edit' AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at>?7)
        AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=m.org_id AND member.user_github_id=?5))
      AND EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=m.org_id AND a.id=m.app_id
        AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=m.org_id AND d.purge_started_at IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=m.org_id))
      AND (?3='' OR EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=m.org_id AND a.id=m.app_id AND a.table_id=?3)
        OR EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=m.org_id AND e.app_id=m.app_id AND e.table_id=?3))
      AND (?4='' OR EXISTS(SELECT 1 FROM hx_rows r WHERE r.org_id=m.org_id AND r.table_id=?3 AND r.id=?4))`)
    .bind(orgId, appId, scope.tableId, scope.rowId, actor.user.github_id, requestId, new Date().toISOString()).first();
  if (!message || !(Number(inserted.meta?.changes || 0) || message.body === body)) return fail("App not found or access was revoked.", 404);
  return json({ message: { id: String(message.sequence), body: message.body, createdAt: message.created_at, mine: true }, created: Number(inserted.meta?.changes || 0) > 0 }, Number(inserted.meta?.changes || 0) ? 201 : 200);
}


function sharingManagerWriteGuard(orgParam, appParam, actorParam) {
  // Re-evaluate the manager capability in the same statement as each
  // mutation. A route-entry check alone is stale if membership is revoked
  // while the request is parsing or hashing an invite token.
  return `EXISTS(SELECT 1 FROM hx_apps a JOIN memberships m
    ON m.org_id=a.org_id AND m.user_github_id=${actorParam}
    WHERE a.org_id=${orgParam} AND a.id=${appParam}
      AND (a.created_by=${actorParam} OR LOWER(TRIM(COALESCE(m.role,''))) IN ('owner','admin'))
      AND EXISTS(SELECT 1 FROM org_settings s WHERE s.org_id=a.org_id AND s.mode='harness')
      AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=a.org_id AND d.purge_started_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=a.org_id))`;
}

async function appSharingAccess(db, orgId, appId, userId) {
  if ((await getMode(db, orgId)) !== "harness") return null;
  return db.prepare("SELECT a.id,a.org_id,a.created_by,a.definition,m.role FROM hx_apps a JOIN memberships m ON m.org_id=a.org_id AND m.user_github_id=?3 WHERE a.org_id=?1 AND a.id=?2 AND (a.created_by=?3 OR LOWER(TRIM(COALESCE(m.role,''))) IN ('owner','admin')) AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=a.org_id AND d.purge_started_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=a.org_id)")
    .bind(orgId, appId, userId).first();
}

async function appSharing(request, env, url, orgId, appId, actor, parts) {
  if ((await getMode(env.DB, orgId)) !== "harness") return fail();
  const manager = await appSharingAccess(env.DB, orgId, appId, actor.user.github_id);
  if (!manager) return fail();
  const customUnsupported = isCustomApp(manager.definition) && !publishedCustomSource(manager.definition);
  if (parts.length === 6 && parts[5] === "requests" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT r.id,r.table_id AS tableId,r.row_id AS rowId,r.guest_github_id AS guestGithubId,u.name,u.login,u.email,r.body,r.requested_at AS requestedAt FROM hx_external_app_send_requests r JOIN users u ON u.github_id=r.guest_github_id WHERE r.org_id=?1 AND r.app_id=?2 AND r.status='pending' ORDER BY r.requested_at")
      .bind(orgId, appId).all();
    return json({ requests: rows.results || [] });
  }
  if (parts.length === 7 && parts[5] === "requests" && request.method === "POST") {
    const input = await request.json().catch(() => null);
    if (!["approve", "reject"].includes(input?.decision)) return json({ message: "Choose approve or reject." }, 400);
    const row = await env.DB.prepare("SELECT id,table_id,row_id,guest_github_id,body,status FROM hx_external_app_send_requests WHERE org_id=?1 AND app_id=?2 AND id=?3")
      .bind(orgId, appId, parts[6]).first();
    if (!row || row.status !== "pending") return fail("Request not found or already decided.");
    if (input.decision === "reject") {
      const result = await env.DB.prepare(`UPDATE hx_external_app_send_requests SET status='rejected',decided_at=?1,decided_by=?2 WHERE org_id=?3 AND app_id=?4 AND id=?5 AND status='pending' AND ${sharingManagerWriteGuard('?3','?4','?2')}`)
        .bind(new Date().toISOString(), actor.user.github_id, orgId, appId, row.id).run();
      return Number(result.meta?.changes || 0) ? json({ rejected: true }) : fail("Request not found or already decided.");
    }
    const scope = await scopeFor(env.DB, orgId, appId, row.table_id, row.row_id, row.guest_github_id);
    if (!scope) return fail("Request is no longer in the allowed App scope.");
    const at = new Date().toISOString();
    const messageId = "xappr_" + crypto.randomUUID().replaceAll("-", "");
    const requestId = "xasr_" + row.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
    const writes = await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO hx_app_messages (org_id,app_id,table_id,row_id,author_id,request_id,body,created_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE EXISTS(SELECT 1 FROM hx_external_app_send_requests r WHERE r.org_id=?1 AND r.app_id=?2 AND r.id=?9 AND r.status='pending') AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=?1 AND g.resource_type='app' AND g.resource_id=?2 AND g.recipient_github_id=?5 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?8) AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=?1 AND m.user_github_id=?5)) AND (?3='' OR EXISTS(SELECT 1 FROM hx_apps scoped WHERE scoped.org_id=?1 AND scoped.id=?2 AND scoped.table_id=?3) OR EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=?1 AND e.app_id=?2 AND e.table_id=?3)) AND (?4='' OR EXISTS(SELECT 1 FROM hx_rows r WHERE r.org_id=?1 AND r.table_id=?3 AND r.id=?4)) AND EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=?1 AND a.id=?2 AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=?1 AND d.purge_started_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=?1) AND ${sharingManagerWriteGuard('?1','?2','?10')})`)
        .bind(orgId, appId, row.table_id, row.row_id, row.guest_github_id, requestId, row.body, at, row.id, actor.user.github_id),
      env.DB.prepare(`UPDATE hx_external_app_send_requests SET status='approved',decided_at=?1,decided_by=?2,message_id=?3 WHERE org_id=?4 AND app_id=?5 AND id=?6 AND status='pending' AND EXISTS(SELECT 1 FROM hx_app_messages m WHERE m.org_id=?4 AND m.app_id=?5 AND m.table_id=?7 AND m.row_id=?8 AND m.author_id=?9 AND m.request_id=?10) AND ${sharingManagerWriteGuard('?4','?5','?2')}`)
        .bind(at, actor.user.github_id, messageId, orgId, appId, row.id, row.table_id, row.row_id, row.guest_github_id, requestId),
    ]);
    const approved = Number(writes?.[1]?.meta?.changes || 0);
    return approved ? json({ approved: true, messageId }) : fail("Request is no longer available.");
  }
  if (parts.length === 5 && request.method === "GET") {
    const now = new Date().toISOString();
    const [grants, invites] = await Promise.all([
      env.DB.prepare("SELECT g.recipient_github_id AS githubId,u.login,u.name,u.email,g.permission,g.expires_at AS expiresAt,g.granted_at AS grantedAt FROM hx_external_resource_grants g LEFT JOIN users u ON u.github_id=g.recipient_github_id WHERE g.org_id=?1 AND g.resource_type='app' AND g.resource_id=?2 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?3) AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=g.org_id AND m.user_github_id=g.recipient_github_id) ORDER BY g.granted_at DESC")
        .bind(orgId, appId, now).all(),
      env.DB.prepare("SELECT id,invited_email AS invitedEmail,permission,access_expires_at AS accessExpiresAt,created_at AS createdAt,expires_at AS inviteExpiresAt FROM hx_external_app_invites WHERE org_id=?1 AND resource_id=?2 AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at>?3 ORDER BY created_at DESC")
        .bind(orgId, appId, now).all(),
    ]);
    return json({ guests: grants.results || [], invites: invites.results || [], canManage: true, customUnsupported });
  }
  if (parts.length === 5 && request.method === "POST") {
    if (customUnsupported) return json({ message: "Custom Apps are not available to external guests yet. Share a Database App instead." }, 409);
    const input = await request.json().catch(() => null);
    const email = typeof input?.email === "string" ? input.email.trim().toLowerCase() : "";
    const permission = input?.permission;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !["view", "edit"].includes(permission)) return json({ message: "Enter a valid email and permission." }, 400);
    let accessExpiresAt = null;
    if (input.expiresAt) {
      const parsed = Date.parse(input.expiresAt);
      if (!Number.isFinite(parsed) || parsed <= Date.now()) return json({ message: "Access expiry must be in the future." }, 400);
      accessExpiresAt = new Date(parsed).toISOString();
    }
    const now = new Date().toISOString();
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const tokenHash = await sha256Hex(token);
    const id = "xai_" + crypto.randomUUID().replaceAll("-", "");
    const inserted = await env.DB.prepare(`INSERT INTO hx_external_app_invites (id,org_id,resource_id,invited_email,permission,access_expires_at,token_hash,created_by,created_at,expires_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10 WHERE ${sharingManagerWriteGuard('?2','?3','?8')}`)
      .bind(id, orgId, appId, email, permission, accessExpiresAt, tokenHash, actor.user.github_id, now, new Date(Date.now() + 7 * 86400000).toISOString()).run();
    if (!Number(inserted.meta?.changes || 0)) return fail("Sharing manager access was revoked.", 403);
    const inviteBase = env.APP_WEB_URL || url.origin;
    const inviteUrl = new URL("/#/external-invite/" + token, inviteBase).toString();
    const emailDelivery = await deliverExternalInvite(env, { id, to: email, resource: "an App", inviteUrl, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() });
    return json({ invite: { id, invitedEmail: email, permission, accessExpiresAt, token, inviteUrl, emailDelivery } }, 201);
  }
  if (parts.length === 6 && parts[5] === "invites" && request.method === "DELETE") {
    return fail("Invalid invite route.");
  }
  if (parts.length === 6 && request.method === "PATCH") {
    const githubId = parts[5];
    const input = await request.json().catch(() => null);
    if (!["view", "edit"].includes(input?.permission)) return json({ message: "Choose view or edit." }, 400);
    let expiresAt = null;
    if (input.expiresAt) {
      const parsed = Date.parse(input.expiresAt);
      if (!Number.isFinite(parsed) || parsed <= Date.now()) return json({ message: "Access expiry must be in the future." }, 400);
      expiresAt = new Date(parsed).toISOString();
    }
    const result = await env.DB.prepare(`UPDATE hx_external_resource_grants SET permission=?1,expires_at=?2 WHERE org_id=?3 AND resource_type='app' AND resource_id=?4 AND recipient_github_id=?5 AND revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=?3 AND m.user_github_id=?5) AND ${sharingManagerWriteGuard('?3','?4','?6')}`)
      .bind(input.permission, expiresAt, orgId, appId, githubId, actor.user.github_id).run();
    return Number(result.meta?.changes || 0) ? json({ updated: true }) : fail();
  }
  if (parts.length === 6 && request.method === "DELETE") {
    const result = await env.DB.prepare(`UPDATE hx_external_resource_grants SET revoked_at=?1,revoked_by=?2 WHERE org_id=?3 AND resource_type='app' AND resource_id=?4 AND recipient_github_id=?5 AND revoked_at IS NULL AND ${sharingManagerWriteGuard('?3','?4','?2')}`)
      .bind(new Date().toISOString(), actor.user.github_id, orgId, appId, parts[5]).run();
    return Number(result.meta?.changes || 0) ? json({ revoked: true }) : fail();
  }
  if (parts.length === 7 && parts[5] === "invites" && request.method === "DELETE") {
    const result = await env.DB.prepare(`UPDATE hx_external_app_invites SET revoked_at=?1,revoked_by=?2 WHERE org_id=?3 AND resource_id=?4 AND id=?5 AND redeemed_at IS NULL AND revoked_at IS NULL AND ${sharingManagerWriteGuard('?3','?4','?2')}`)
      .bind(new Date().toISOString(), actor.user.github_id, orgId, appId, parts[6]).run();
    return Number(result.meta?.changes || 0) ? json({ revoked: true }) : fail();
  }
  return fail("Method not allowed.", 405);
}

/** Redeem only after the signed-in user has verified the invited email. */
export async function redeemExternalAppInvite(env, { token, userId }) {
  const deny = { error: "This invitation is not valid, or has expired.", status: 404 };
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/i.test(token) || !userId) return deny;
  const tokenHash = await sha256Hex(token.toLowerCase());
  const now = new Date().toISOString();
  // token_hash is globally unique; the joined App and every follow-up check stay workspace-scoped.
  const invite = await env.DB.prepare("SELECT i.*,a.id AS app_id FROM hx_external_app_invites i JOIN hx_apps a ON a.org_id=i.org_id AND a.id=i.resource_id WHERE i.token_hash=?1 AND i.redeemed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>?2 AND (i.access_expires_at IS NULL OR i.access_expires_at>?2) AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=i.org_id AND m.user_github_id=?3) AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=i.org_id AND d.purge_started_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=i.org_id)")
    .bind(tokenHash, now, userId).first();
  if (!invite || (await getMode(env.DB, invite.org_id)) !== "harness") return deny;
  const person = await env.DB.prepare("SELECT email,email_verified_at FROM users WHERE github_id=?1").bind(userId).first();
  if (!person?.email_verified_at || String(person.email || "").trim().toLowerCase() !== String(invite.invited_email).toLowerCase()) return { error: "Sign in with the verified email address that received this invitation.", status: 403 };
  const grantId = "xg_" + crypto.randomUUID().replaceAll("-", "");
  const redemptionId = "xar_" + crypto.randomUUID().replaceAll("-", "");
  const inserted = await env.DB.prepare(`INSERT INTO hx_external_resource_grants (id,org_id,resource_type,resource_id,recipient_github_id,permission,granted_by,granted_at,expires_at) SELECT ?1,i.org_id,'app',i.resource_id,?2,i.permission,i.created_by,?3,i.access_expires_at FROM hx_external_app_invites i WHERE i.id=?4 AND i.redeemed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>?3 AND (i.access_expires_at IS NULL OR i.access_expires_at>?3) AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=i.org_id AND m.user_github_id=?2)
       AND EXISTS(SELECT 1 FROM users u WHERE u.github_id=?2 AND u.email_verified_at IS NOT NULL AND lower(trim(coalesce(u.email,'')))=lower(trim(i.invited_email)))
       AND EXISTS(SELECT 1 FROM org_settings s WHERE s.org_id=i.org_id AND s.mode='harness')
       AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=i.org_id AND d.purge_started_at IS NOT NULL)
       AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=i.org_id)`)
    .bind(grantId, userId, now, invite.id).run();
  if (!Number(inserted.meta?.changes || 0)) return deny;
  const updated = await env.DB.prepare(`UPDATE hx_external_app_invites SET redeemed_at=?1,redeemed_by=?2,created_grant_id=?3,redemption_id=?4 WHERE id=?5 AND redeemed_at IS NULL AND revoked_at IS NULL
       AND expires_at>?1 AND (access_expires_at IS NULL OR access_expires_at>?1)
       AND EXISTS(SELECT 1 FROM users u WHERE u.github_id=?2 AND u.email_verified_at IS NOT NULL AND lower(trim(coalesce(u.email,'')))=lower(trim(hx_external_app_invites.invited_email)))
       AND EXISTS(SELECT 1 FROM org_settings s WHERE s.org_id=hx_external_app_invites.org_id AND s.mode='harness')
       AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=hx_external_app_invites.org_id AND d.purge_started_at IS NOT NULL)
       AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=hx_external_app_invites.org_id)`)
    .bind(now, userId, grantId, redemptionId, invite.id).run();
  if (!Number(updated.meta?.changes || 0)) {
    await env.DB.prepare("UPDATE hx_external_resource_grants SET revoked_at=?1 WHERE id=?2 AND revoked_at IS NULL").bind(now, grantId).run();
    return deny;
  }
  return { ok: true, resourceType: "app", orgId: invite.org_id, appId: invite.app_id };
}

export async function handleExternalApps(request, env, url) {
  const parsed = pathParts(url);
  if (!parsed) return null;
  const actor = await actorFor(request, env.DB);
  if (!actor) return fail("Sign in to open this shared App.", 401);
  const { parts, orgId, appId } = parsed;
  if (parts[4] === "sharing") return appSharing(request, env, url, orgId, appId, actor, parts);
  const access = await appAccess(env.DB, env, orgId, appId, actor.user.github_id);
  if (!access) return fail();
  const customHtml = publishedCustomSource(access.app.definition);
  if (isCustomApp(access.app.definition) && !customHtml) return json({ code: "CUSTOM_APP_NOT_PUBLISHED", message: "This Custom App has no published version to share." }, 409);
  if (parts.length === 5 && parts[4] === "conversation") {
    return conversation(request, env, url, orgId, appId, actor, access);
  }
  if (request.method !== "GET" && !(parts.length >= 5 && parts[4] === "tables")) return fail("Method not allowed.", 405);
  if (parts.length === 4) {
    return json({ app: {
      id: access.app.id, name: access.app.name, description: access.app.description || "",
      icon: access.app.icon || null, tableId: access.app.table_id, version: access.app.version, permission: access.permission,
      ...(customHtml ? { customHtml } : {}),
      createdAt: access.app.created_at, updatedAt: access.app.updated_at,
    } });
  }
  if (parts.length === 5 && parts[4] === "tables") {
    if (request.method !== "GET") return fail("Method not allowed.", 405);
    const tables = await env.DB.prepare("SELECT t.id,t.name,t.columns,t.created_at AS createdAt,t.updated_at AS updatedAt,CASE WHEN t.id=a.table_id THEN 'primary' ELSE COALESCE((SELECT e.entity_key FROM hx_app_entities e WHERE e.org_id=a.org_id AND e.app_id=a.id AND e.table_id=t.id ORDER BY e.entity_key LIMIT 1),'') END AS key FROM hx_tables t JOIN hx_apps a ON a.org_id=t.org_id AND a.id=?2 WHERE t.org_id=?1 AND (a.table_id=t.id OR EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=a.org_id AND e.app_id=a.id AND e.table_id=t.id)) AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=a.org_id AND g.resource_type='app' AND g.resource_id=a.id AND g.recipient_github_id=?3 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?4)) AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=a.org_id AND m.user_github_id=?3) AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=a.org_id AND d.purge_started_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM workspace_tombstones tombstone WHERE tombstone.org_id=a.org_id) ORDER BY CASE WHEN t.id=a.table_id THEN 0 ELSE 1 END,t.name")
      .bind(orgId, appId, actor.user.github_id, new Date().toISOString()).all();
    return json({ tables: (tables.results || []).map(table => ({ ...table, columns: parseColumns(table.columns) })) });
  }
  if (parts.length >= 5 && parts[4] === "tables") {
    if (parts.length !== 7 && parts.length !== 8) return fail();
    if (parts[6] !== "rows") return fail();
    const tableId = parts[5];
    const rowId = parts.length === 8 ? parts[7] : null;
    const table = await linkedTable(env.DB, orgId, appId, tableId, actor.user.github_id);
    if (!table || (rowId && !(await scopeFor(env.DB, orgId, appId, tableId, rowId, actor.user.github_id)))) return fail();
    if (request.method === "GET") {
      const rows = await readRows(env.DB, orgId, appId, table, url, actor.user.github_id, rowId);
      if (rows === null) return fail();
      return json({ table: { id: table.id, name: table.name, columns: parseColumns(table.columns) }, rows });
    }
    if (!await liveEditGrant(env.DB, orgId, appId, actor.user.github_id)) return fail("An active edit grant is required.", 403);
    const input = await request.json().catch(() => null);
    if (request.method === "POST" && !rowId) {
      const result = await addRow(env.DB, orgId, tableId, input?.values, actor.user.github_id, "strict", null, externalAppWriteGuard(orgId, appId, actor.user.github_id, tableId));
      return result.error ? json({ message: result.error, fields: result.fields }, result.status || 400)
        : json({ row: result.row }, 201);
    }
    if (request.method === "PATCH" && rowId) {
      const result = await updateRow(env.DB, orgId, tableId, rowId, input?.values, actor.user.github_id, input?.expectedUpdatedAt, "strict", null, externalAppWriteGuard(orgId, appId, actor.user.github_id, tableId));
      return result.error ? json({ message: result.error, fields: result.fields }, result.status || 400)
        : json({ row: result.row });
    }
    if (request.method === "DELETE" && rowId) {
      const result = await deleteRow(env.DB, orgId, tableId, rowId, input?.expectedUpdatedAt, null, externalAppWriteGuard(orgId, appId, actor.user.github_id, tableId));
      return result.error ? json({ message: result.error }, result.status || 400) : json({ deleted: true });
    }
    return fail("Method not allowed.", 405);
  }
  return fail();
}
