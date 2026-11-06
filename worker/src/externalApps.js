import { getSession, getUserByGithubId } from "./db.js";
import { getMode } from "./harness/mode.js";

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

async function appAccess(db, env, orgId, appId, userId) {
  if ((await getMode(db, orgId)) !== "harness") return null;
  const row = await db.prepare(`SELECT a.id,a.name,a.description,a.icon,a.table_id,a.version,a.created_at,a.updated_at,g.permission
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
  if (access.permission !== "edit") return fail("An edit grant is required to send a message.", 403);
  const body = typeof input.body === "string" ? input.body.trim() : "";
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

export async function handleExternalApps(request, env, url) {
  const parsed = pathParts(url);
  if (!parsed) return null;
  const actor = await actorFor(request, env.DB);
  if (!actor) return fail("Sign in to open this shared App.", 401);
  const { parts, orgId, appId } = parsed;
  const access = await appAccess(env.DB, env, orgId, appId, actor.user.github_id);
  if (!access) return fail();
  if (parts.length === 5 && parts[4] === "conversation") {
    return conversation(request, env, url, orgId, appId, actor, access);
  }
  if (request.method !== "GET") return fail("Method not allowed.", 405);
  if (parts.length === 4) {
    return json({ app: {
      id: access.app.id, name: access.app.name, description: access.app.description || "",
      icon: access.app.icon || null, version: access.app.version, permission: access.permission,
      createdAt: access.app.created_at, updatedAt: access.app.updated_at,
    } });
  }
  if (parts.length >= 5 && parts[4] === "tables") {
    if (parts.length !== 7 && parts.length !== 8) return fail();
    if (parts[6] !== "rows") return fail();
    const tableId = parts[5];
    const rowId = parts.length === 8 ? parts[7] : null;
    const table = await linkedTable(env.DB, orgId, appId, tableId, actor.user.github_id);
    if (!table || (rowId && !(await scopeFor(env.DB, orgId, appId, tableId, rowId, actor.user.github_id)))) return fail();
    const rows = await readRows(env.DB, orgId, appId, table, url, actor.user.github_id, rowId);
    if (rows === null) return fail();
    return json({
      table: { id: table.id, name: table.name, columns: parseColumns(table.columns) },
      rows,
    });
  }
  return fail();
}
