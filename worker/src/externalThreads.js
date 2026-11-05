import { getSession, getUserByGithubId, isMember } from "./db.js";
import { getMode } from "./harness/mode.js";
import { resolveChannel } from "./channels.js";
import {
  externalResourcePermission,
  grantExternalResource,
  revokeExternalResource,
} from "./harness/externalCollaborators.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const fail = (message, status) => json({ message }, status);
const keyId = () => `xmsg_${crypto.randomUUID().replaceAll("-", "")}`;
const requestId = () => `xreq_${crypto.randomUUID().replaceAll("-", "")}`;
const activeGrantSql = `EXISTS(
  SELECT 1 FROM hx_external_resource_grants g
   WHERE g.org_id = ?2 AND g.resource_type = 'thread' AND g.resource_id = ?3
     AND g.recipient_github_id = ?4 AND g.revoked_at IS NULL
     AND (g.expires_at IS NULL OR g.expires_at > ?5)
     AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id = ?2 AND member.user_github_id = ?4))`;
async function signedIn(request, env) {
  const session = await getSession(env.DB, request.headers.get("x-session-token"));
  if (!session) return null;
  const user = await getUserByGithubId(env.DB, session.github_id);
  return user ? { session, user } : null;
}

async function rootFor(db, orgId, rootId) {
  return db.prepare(`SELECT id, org_id, channel, author_login, kind, created_at
      FROM channel_messages
     WHERE org_id = ?1 AND id = ?2 AND parent_id IS NULL AND deleted_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM hx_room_access tombstone
         WHERE tombstone.org_id = channel_messages.org_id AND tombstone.channel = channel_messages.channel
           AND tombstone.deleted_at IS NOT NULL)`)
    .bind(orgId, rootId).first();
}

async function manageableRoot(db, orgId, rootId, user) {
  if (!(await isMember(db, orgId, user.github_id))) return null;
  const root = await rootFor(db, orgId, rootId);
  if (!root) return null;
  const membership = await db.prepare(
    "SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2"
  ).bind(orgId, user.github_id).first();
  const role = String(membership?.role || "").toLowerCase();
  if (root.author_login !== user.login && !["owner", "admin"].includes(role)) return null;
  // A workspace role alone cannot reveal a private Room's thread.
  if (!(await resolveChannel(db, orgId, user, root.channel))) return null;
  return root;
}

async function resolveRecipient(db, orgId, email, actorId) {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!normalized || normalized.length > 320 || !normalized.includes("@")) return null;
  const recipient = await db.prepare(
    "SELECT github_id, login, name, email FROM users WHERE lower(email) = ?1 AND email_verified_at IS NOT NULL"
  ).bind(normalized).first();
  if (!recipient || recipient.github_id === actorId || await isMember(db, orgId, recipient.github_id)) return null;
  return recipient;
}

async function shareThread(request, env, orgId, rootId, actor) {
  if (request.method !== "POST" && request.method !== "DELETE") return fail("Method not allowed.", 405);
  const input = await request.json().catch(() => null);
  if (!input) return fail("Invalid JSON body.", 400);
  const root = await manageableRoot(env.DB, orgId, rootId, actor.user);
  if (!root) return fail("Thread not found or cannot be shared.", 404);
  if (request.method === "POST") {
    const recipient = await resolveRecipient(env.DB, orgId, input.email, actor.user.github_id);
    if (!recipient) return fail("A verified account outside this Workspace is required.", 404);
    const permission = input.permission === "edit" ? "edit" : input.permission === "view" ? "view" : null;
    if (!permission) return fail("Permission must be view or edit.", 400);
    let grant;
    try {
      grant = await grantExternalResource(env.DB, {
        orgId, resourceType: "thread", resourceId: rootId,
        recipientGithubId: recipient.github_id, permission,
        grantedBy: actor.user.github_id, expiresAt: input.expiresAt ?? null,
      });
    } catch (error) {
      return fail(error instanceof TypeError ? error.message : "Could not share this Thread.", error instanceof TypeError ? 400 : 503);
    }
    return json({ shared: true, grant: { id: grant.id, permission, expiresAt: grant.expiresAt },
      recipient: { name: recipient.name || recipient.login, email: recipient.email } }, 201);
  }
  const recipient = await resolveRecipient(env.DB, orgId, input.email, actor.user.github_id);
  if (!recipient) return fail("Recipient not found.", 404);
  const revoked = await revokeExternalResource(env.DB, {
    orgId, resourceType: "thread", resourceId: rootId,
    recipientGithubId: recipient.github_id, revokedBy: actor.user.github_id,
  });
  await env.DB.prepare(`UPDATE hx_external_thread_send_requests
      SET status = 'cancelled', decided_at = ?1, decided_by = ?2
    WHERE org_id = ?3 AND root_message_id = ?4 AND guest_github_id = ?5 AND status = 'pending'`)
    .bind(new Date().toISOString(), actor.user.github_id, orgId, rootId, recipient.github_id).run();
  return json({ revoked: revoked > 0 });
}

async function readThread(env, orgId, rootId, user) {
  const now = new Date().toISOString();
  // One SELECT proves the active exact-resource grant and reads only the root
  // plus its direct replies. It never traverses into the containing Room.
  const { results = [] } = await env.DB.prepare(`SELECT m.id, m.kind, m.body, m.author_login, m.created_at, m.edited_at,
      m.parent_id, u.name AS author_name, a.name AS agent_name, g.permission
    FROM channel_messages m
    JOIN hx_external_resource_grants g
      ON g.org_id = m.org_id AND g.resource_type = 'thread' AND g.resource_id = ?3
     AND g.recipient_github_id = ?4 AND g.revoked_at IS NULL
     AND (g.expires_at IS NULL OR g.expires_at > ?5)
     AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id = m.org_id AND member.user_github_id = g.recipient_github_id)
    JOIN channel_messages root ON root.org_id = m.org_id AND root.id = ?3
      AND root.parent_id IS NULL AND root.deleted_at IS NULL AND root.channel = m.channel
    LEFT JOIN users u ON u.login = m.author_login
    LEFT JOIN custom_agents a ON 'agent:' || a.id = m.author_login AND a.org_id = m.org_id
    WHERE m.org_id = ?2 AND (m.id = ?3 OR m.parent_id = ?3) AND m.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM hx_room_access tombstone
        WHERE tombstone.org_id = root.org_id AND tombstone.channel = root.channel AND tombstone.deleted_at IS NOT NULL)
    ORDER BY m.created_at, m.rowid`)
    .bind(orgId, orgId, rootId, user.github_id, now).all();
  if (!results.length) return null;
  const permission = results[0].permission;
  const messages = results.map(row => ({
    id: row.id,
    channel: `external-thread:${rootId}`,
    kind: row.kind,
    body: row.body,
    authorName: row.kind === "ai" ? null : (row.agent_name || row.author_name || "Teammate"),
    mine: row.author_login === user.login,
    createdAt: row.created_at,
    editedAt: row.edited_at || null,
    parentId: row.parent_id || null,
    files: [],
    reactions: [],
  }));
  return {
    permission,
    thread: {
      parent: messages.find(message => message.id === rootId),
      replies: messages.filter(message => message.id !== rootId),
    },
  };
}

async function insertReply(env, orgId, rootId, user, body) {
  const id = keyId();
  const now = new Date().toISOString();
  const put = await env.DB.prepare(`INSERT INTO channel_messages
      (id, org_id, channel, author_login, kind, body, created_at, parent_id)
    SELECT ?1, root.org_id, root.channel, ?6, 'message', ?7, ?8, root.id
      FROM channel_messages root
     WHERE root.org_id = ?2 AND root.id = ?3 AND root.parent_id IS NULL AND root.deleted_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM hx_room_access tombstone
         WHERE tombstone.org_id = root.org_id AND tombstone.channel = root.channel AND tombstone.deleted_at IS NOT NULL)
       AND ${activeGrantSql} AND EXISTS(
         SELECT 1 FROM hx_external_resource_grants g
          WHERE g.org_id = ?2 AND g.resource_type = 'thread' AND g.resource_id = ?3
            AND g.recipient_github_id = ?4 AND g.revoked_at IS NULL AND g.permission = 'edit'
            AND (g.expires_at IS NULL OR g.expires_at > ?5))`)
    .bind(id, orgId, rootId, user.github_id, now, user.login, body, now).run();
  return put.meta?.changes ? id : null;
}

async function requestSend(env, orgId, rootId, user, body) {
  const id = requestId();
  const now = new Date().toISOString();
  const put = await env.DB.prepare(`INSERT OR IGNORE INTO hx_external_thread_send_requests
      (id, org_id, root_message_id, guest_github_id, body, status, requested_at)
    SELECT ?1, ?2, ?3, ?4, ?5, 'pending', ?6
     WHERE EXISTS(SELECT 1 FROM channel_messages root WHERE root.org_id = ?2 AND root.id = ?3
       AND root.parent_id IS NULL AND root.deleted_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM hx_room_access tombstone WHERE tombstone.org_id=root.org_id
         AND tombstone.channel=root.channel AND tombstone.deleted_at IS NOT NULL))
       AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=?2
         AND g.resource_type='thread' AND g.resource_id=?3 AND g.recipient_github_id=?4
         AND g.revoked_at IS NULL AND g.permission='view' AND (g.expires_at IS NULL OR g.expires_at>?6)
         AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=?2 AND member.user_github_id=?4))`)
    .bind(id, orgId, rootId, user.github_id, body, now).run();
  if (put.meta?.changes) return { id, created: true };
  const existing = await env.DB.prepare(`SELECT r.id FROM hx_external_thread_send_requests r
      JOIN hx_external_resource_grants g ON g.org_id=r.org_id AND g.resource_type='thread'
        AND g.resource_id=r.root_message_id AND g.recipient_github_id=r.guest_github_id
        AND g.revoked_at IS NULL AND g.permission='view' AND (g.expires_at IS NULL OR g.expires_at>?5)
        AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=r.org_id AND member.user_github_id=r.guest_github_id)
     WHERE r.org_id=?1 AND r.root_message_id=?2 AND r.guest_github_id=?3 AND r.status='pending'`)
    .bind(orgId, rootId, user.github_id, body, now).first();
  return existing ? { id: existing.id, created: false } : null;
}

async function pendingRequests(env, orgId, rootId, owner) {
  return env.DB.prepare(`SELECT r.id, r.body, r.requested_at, u.name AS guest_name, u.email AS guest_email
    FROM hx_external_thread_send_requests r
    JOIN users u ON u.github_id = r.guest_github_id
    WHERE r.org_id=?1 AND r.root_message_id=?2 AND r.status='pending'
      AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=r.org_id
        AND g.resource_type='thread' AND g.resource_id=r.root_message_id
        AND g.recipient_github_id=r.guest_github_id AND g.granted_by=?3
        AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?4))
    ORDER BY r.requested_at, r.id`).bind(orgId, rootId, owner.user.github_id, new Date().toISOString()).all();
}

async function decideRequest(env, orgId, rootId, id, owner, action) {
  const now = new Date().toISOString();
  if (action === "reject") {
    const result = await env.DB.prepare(`UPDATE hx_external_thread_send_requests
       SET status='rejected', decided_at=?1, decided_by=?2
     WHERE org_id=?3 AND root_message_id=?4 AND id=?5 AND status='pending'
       AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=?3
         AND g.resource_type='thread' AND g.resource_id=?4 AND g.recipient_github_id=guest_github_id
         AND g.granted_by=?2 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?1)
         AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=?3 AND member.user_github_id=guest_github_id))`)
      .bind(now, owner.user.github_id, orgId, rootId, id).run();
    return result.meta?.changes ? { rejected: true } : null;
  }

  const messageId = keyId();
  const [insert, update] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO channel_messages
        (id, org_id, channel, author_login, kind, body, created_at, parent_id)
      SELECT ?1, root.org_id, root.channel, guest.login, 'message', r.body, ?8, root.id
        FROM hx_external_thread_send_requests r
        JOIN users guest ON guest.github_id=r.guest_github_id
        JOIN channel_messages root ON root.org_id=r.org_id AND root.id=r.root_message_id
          AND root.parent_id IS NULL AND root.deleted_at IS NULL
       WHERE r.org_id=?2 AND r.root_message_id=?3 AND r.id=?4 AND r.status='pending'
         AND NOT EXISTS(SELECT 1 FROM hx_room_access tombstone WHERE tombstone.org_id=root.org_id
           AND tombstone.channel=root.channel AND tombstone.deleted_at IS NOT NULL)
         AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=?2
           AND g.resource_type='thread' AND g.resource_id=?3 AND g.recipient_github_id=r.guest_github_id
           AND g.granted_by=?5 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?8)
           AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=?2 AND member.user_github_id=r.guest_github_id))`)
      .bind(messageId, orgId, rootId, id, owner.user.github_id, owner.user.github_id, now, now),
    env.DB.prepare(`UPDATE hx_external_thread_send_requests
        SET status='approved', decided_at=?1, decided_by=?2, message_id=?3
      WHERE org_id=?4 AND root_message_id=?5 AND id=?6 AND status='pending'
        AND EXISTS(SELECT 1 FROM channel_messages m WHERE m.org_id=?4 AND m.id=?3 AND m.parent_id=?5)`)
      .bind(now, owner.user.github_id, messageId, orgId, rootId, id),
  ]);
  return insert.meta?.changes && update.meta?.changes ? { approved: true, messageId } : null;
}

export async function handleExternalThreads(request, env, url) {
  if (!url.pathname.startsWith("/external/threads/")) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4) return fail("Not found.", 404);
  const [, , rawOrgId, rawRootId] = parts;
  let orgId, rootId;
  try { orgId = decodeURIComponent(rawOrgId); rootId = decodeURIComponent(rawRootId); }
  catch { return fail("Not found.", 404); }
  if (!orgId || !rootId || orgId.length > 200 || rootId.length > 200) return fail("Not found.", 404);
  if ((await getMode(env.DB, orgId)) !== "harness") return fail("External Thread sharing is unavailable in Simple mode.", 404);
  const actor = await signedIn(request, env);
  if (!actor) return fail("Sign in to continue.", 401);
  if (parts.length === 5 && parts[4] === "shares") return shareThread(request, env, orgId, rootId, actor);
  const root = await rootFor(env.DB, orgId, rootId);
  if (!root) return fail("Thread not found.", 404);

  if (parts.length === 5 && parts[4] === "requests" && request.method === "GET") {
    const manageable = await manageableRoot(env.DB, orgId, rootId, actor.user);
    if (!manageable) return fail("Thread not found or cannot manage requests.", 404);
    const result = await pendingRequests(env, orgId, rootId, actor);
    return json({ requests: result.results || [] });
  }
  if (parts.length === 6 && parts[4] === "requests" && request.method === "POST") {
    const manageable = await manageableRoot(env.DB, orgId, rootId, actor.user);
    if (!manageable) return fail("Thread not found or cannot manage requests.", 404);
    const action = parts[5];
    if (action !== "approve" && action !== "reject") return fail("Not found.", 404);
    const input = await request.json().catch(() => ({}));
    if (typeof input.requestId !== "string" || !input.requestId) return fail("requestId is required.", 400);
    const decided = await decideRequest(env, orgId, rootId, input.requestId, actor, action);
    return decided ? json(decided) : fail("Request is no longer available.", 409);
  }
  if (parts.length !== 4) return fail("Not found.", 404);

  if (request.method === "GET") {
    const thread = await readThread(env, orgId, rootId, actor.user);
    return thread ? json(thread) : fail("Thread not found.", 404);
  }
  if (request.method === "POST") {
    const input = await request.json().catch(() => null);
    if (!input || typeof input.body !== "string") return fail("Invalid message.", 400);
    const body = input.body.replace(/\r\n/g, "\n").trim();
    if (!body || body.length > 4000) return fail("Message must be 1–4000 characters.", 400);
    if (input.requestSend === true) {
      const requested = await requestSend(env, orgId, rootId, actor.user, body);
      return requested ? json({ requestId: requested.id, created: requested.created, status: "pending" }, requested.created ? 201 : 200)
        : fail("Thread not found or access revoked.", 404);
    }
    const permission = await externalResourcePermission(env.DB, {
      orgId, resourceType: "thread", resourceId: rootId, githubId: actor.user.github_id,
    });
    if (!permission) return fail("Thread not found or access revoked.", 404);
    if (permission !== "edit") return fail("Ask the Thread owner to approve a send request.", 403);
    const messageId = await insertReply(env, orgId, rootId, actor.user, body);
    return messageId ? json({ messageId, sent: true }, 201) : fail("Thread not found or access revoked.", 404);
  }
  return fail("Method not allowed.", 405);
}
