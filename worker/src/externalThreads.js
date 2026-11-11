import { getSession, getUserByGithubId, isMember } from "./db.js";
import { handleExternalFiles } from "./externalFiles.js";
import { redeemExternalAppInvite } from "./externalApps.js";
import { redeemExternalFileInvite } from "./harness/externalFileGrants.js";
import { getMode } from "./harness/mode.js";
import { resolveChannel, asksTheAI, getMessage, cleanEmoji, viewOf } from "./channels.js";
import { byteRange, deleteFileObject, getFileObject, MAX_FILES_PER_MESSAGE, sendable, UNSATISFIABLE, uploadFile } from "./files.js";
import { audienceOf } from "./access.js";
import { listMembers } from "./team.js";
import { answerAsAI, broadcastStored } from "./channelRoutes.js";
import { sha256Hex } from "./auth.js";
import { deliverExternalInvite } from "./externalInviteMail.js";
import { audit } from "./audit.js";
import { enforce } from "./ratelimit.js";
import {
  cleanThreadAudienceInput, externalThreadPermission, listThreadAudienceRooms,
  readThreadAudience, threadAudienceAccessSql, writeThreadAudience,
} from "./harness/externalThreadAudience.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const fail = (message, status) => json({ message }, status);
const keyId = () => `xmsg_${crypto.randomUUID().replaceAll("-", "")}`;
const requestId = () => `xreq_${crypto.randomUUID().replaceAll("-", "")}`;
const activeGrantSql = threadAudienceAccessSql({ org: "?2", root: "?3", user: "?4", now: "?5", requiredPermission: "edit" });
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
  // Stored DMs and Agent threads use canonical keys, while resolveChannel
  // accepts the viewer-specific handle. Convert only those keys after loading
  // current workspace members; this also makes a removed DM participant fail.
  const members = root.channel.startsWith("dm:") || root.channel.startsWith("ag:")
    ? await listMembers(db, orgId, user.github_id) : undefined;
  const viewerChannel = members ? viewOf(root.channel, user.login, members) : root.channel;
  // A workspace role alone cannot reveal a private Room's thread.
  if (!viewerChannel || !(await resolveChannel(db, orgId, user, viewerChannel, members))) return null;
  return root;
}

// Recheck the exact authority that manageableRoot() checks inside each
// mutation. The initial route check provides a safe response shape; this SQL
// fence prevents a concurrent membership, role, Room, Agent, or root change
// from leaving a grant or approval behind after that check.
function threadManagerFence(orgId, rootId, user, expectedChannel, firstParameter) {
  const p = (offset) => `?${firstParameter + offset}`;
  const org = p(0), rootIdParam = p(1), userId = p(2), login = p(3), channel = p(4);
  return {
    sql: `EXISTS (
      SELECT 1 FROM channel_messages managedRoot
      JOIN memberships managerMembership ON managerMembership.org_id=managedRoot.org_id
        AND managerMembership.user_github_id=${userId}
      WHERE managedRoot.org_id=${org} AND managedRoot.id=${rootIdParam}
        AND managedRoot.channel=${channel}
        AND managedRoot.parent_id IS NULL AND managedRoot.deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM hx_room_access tombstone
          WHERE tombstone.org_id=managedRoot.org_id AND tombstone.channel=managedRoot.channel
            AND tombstone.deleted_at IS NOT NULL)
        AND (managedRoot.author_login=${login} OR LOWER(TRIM(COALESCE(managerMembership.role,''))) IN ('owner','admin'))
        AND (
          (managedRoot.channel LIKE 'b:%' AND (
            (LOWER(TRIM(COALESCE(managerMembership.role,'')))!='guest' AND COALESCE((
              SELECT business.private FROM businesses business
              WHERE business.org_id=managedRoot.org_id AND managedRoot.channel='b:'||business.slug
            ),0)=0)
            OR EXISTS(SELECT 1 FROM conversation_members roomMember
              JOIN users roomUser ON roomUser.login=roomMember.login
              WHERE roomMember.org_id=managedRoot.org_id AND roomMember.channel=managedRoot.channel
                AND roomUser.github_id=${userId})
          ))
          OR (managedRoot.channel LIKE 'g:%' AND length(managedRoot.channel)=18
            AND substr(managedRoot.channel,3) NOT GLOB '*[^0-9a-f]*'
            AND EXISTS(SELECT 1 FROM conversation_members roomMember
            JOIN users roomUser ON roomUser.login=roomMember.login
            WHERE roomMember.org_id=managedRoot.org_id AND roomMember.channel=managedRoot.channel
              AND roomUser.github_id=${userId}))
          OR (managedRoot.channel LIKE 'dm:%' AND instr(managedRoot.channel,'|')>4
            AND instr(substr(managedRoot.channel,instr(managedRoot.channel,'|')+1),'|')=0
            AND (substr(managedRoot.channel,4,instr(managedRoot.channel,'|')-4)=${login}
              OR substr(managedRoot.channel,instr(managedRoot.channel,'|')+1)=${login})
            AND EXISTS(SELECT 1 FROM users dmOther
              JOIN memberships dmOtherMembership ON dmOtherMembership.org_id=managedRoot.org_id
                AND dmOtherMembership.user_github_id=dmOther.github_id
              WHERE dmOther.login=CASE
                WHEN substr(managedRoot.channel,4,instr(managedRoot.channel,'|')-4)=${login}
                THEN substr(managedRoot.channel,instr(managedRoot.channel,'|')+1)
                ELSE substr(managedRoot.channel,4,instr(managedRoot.channel,'|')-4) END))
          OR (managedRoot.channel LIKE 'ag:%' AND EXISTS(
            SELECT 1 FROM custom_agents agent
            LEFT JOIN hx_agent_profiles profile ON profile.org_id=agent.org_id AND profile.agent_id=agent.id
            WHERE agent.org_id=managedRoot.org_id AND agent.id=substr(managedRoot.channel,4,instr(managedRoot.channel,'|')-4)
              AND agent.deleted_at IS NULL AND substr(managedRoot.channel,instr(managedRoot.channel,'|')+1)=${login}
              AND (agent.scope='team' OR agent.owner_login=${login})
              AND (agent.owner_login=${login} OR COALESCE(profile.access,'everyone')='everyone'
                OR (profile.access='people' AND EXISTS(SELECT 1 FROM json_each(COALESCE(profile.people,'[]')) allowed
                  WHERE allowed.value=${login}))
                OR (agent.scope='team' AND profile.agent_id IS NOT NULL AND agent.provider IS NULL
                  AND EXISTS(SELECT 1 FROM hx_agent_members agentMember
                    JOIN memberships activeMember ON activeMember.org_id=agentMember.org_id
                      AND activeMember.user_github_id=agentMember.user_id
                      AND activeMember.created_at=agentMember.member_since
                      AND LOWER(TRIM(COALESCE(activeMember.role,'guest')))!='guest'
                    WHERE agentMember.org_id=agent.org_id AND agentMember.agent_id=agent.id
                      AND agentMember.user_id=${userId} AND agentMember.role IN ('admin','member')))
            )))
        )
    )`,
    bindings: [orgId, rootId, user.github_id, user.login, expectedChannel],
  };
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

async function resolveRecipientInput(db, orgId, input, actorId) {
  if (typeof input?.recipientGithubId === "string") {
    const id = input.recipientGithubId.trim();
    if (!id || id.length > 200) return null;
    const recipient = await db.prepare(
      "SELECT github_id,login,name,email FROM users WHERE github_id=?1 AND email_verified_at IS NOT NULL"
    ).bind(id).first();
    if (!recipient || String(recipient.github_id) === String(actorId) || await isMember(db, orgId, recipient.github_id)) return null;
    return recipient;
  }
  return resolveRecipient(db, orgId, input?.email, actorId);
}

async function searchExternalCollaborators(request, env, url, actor) {
  const limited = await enforce(env, request, "collaborator/search");
  if (limited) return limited;
  const orgId = (url.searchParams.get("orgId") || "").trim();
  const type = url.searchParams.get("resourceType");
  const resourceId = (url.searchParams.get("resourceId") || "").trim();
  const query = (url.searchParams.get("q") || "").trim().toLocaleLowerCase();
  if (!orgId || orgId.length > 200 || !resourceId || resourceId.length > 200 || !["thread", "app", "file"].includes(type)) return fail("Invalid collaborator search scope.", 400);
  if (query.length < 3 || query.length > 100) return fail("Search with 3 to 100 characters.", 400);
  if ((await getMode(env.DB, orgId)) !== "harness" || !(await isMember(env.DB, orgId, actor.user.github_id))) return fail("No matching collaborators.", 404);

  let authorized = false;
  if (type === "thread") {
    authorized = Boolean(await manageableRoot(env.DB, orgId, resourceId, actor.user));
  } else if (type === "app") {
    authorized = Boolean(await env.DB.prepare(`SELECT 1 FROM hx_apps a JOIN memberships m ON m.org_id=a.org_id AND m.user_github_id=?3
      WHERE a.org_id=?1 AND a.id=?2 AND (a.created_by=?3 OR LOWER(TRIM(COALESCE(m.role,''))) IN ('owner','admin'))
        AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=a.org_id AND d.purge_started_at IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=a.org_id)`).bind(orgId, resourceId, actor.user.github_id).first());
  } else {
    authorized = Boolean(await env.DB.prepare(`SELECT 1 FROM hx_workspace_files f
      JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id AND v.version=f.current_version AND v.kind='content'
      JOIN memberships manager ON manager.org_id=f.org_id AND manager.user_github_id=?3
      WHERE f.org_id=?1 AND f.id=?2 AND f.current_version>0
        AND (f.created_by=?3 OR LOWER(TRIM(COALESCE(manager.role,''))) IN ('owner','admin'))
        AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=f.org_id AND p.file_id=f.id AND p.version=f.current_version)
        AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=f.org_id AND d.purge_started_at IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=f.org_id)
        AND NOT EXISTS(SELECT 1 FROM hx_room_access r WHERE r.org_id=f.org_id AND r.channel=f.scope AND r.deleted_at IS NOT NULL)`)
      .bind(orgId, resourceId, actor.user.github_id).first());
  }
  if (!authorized) return fail("No matching collaborators.", 404);
  // Escaping wildcard characters keeps the query a literal substring search.
  const escaped = query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
  try {
    const { results = [] } = await env.DB.prepare(`SELECT u.github_id AS githubId,u.login,COALESCE(NULLIF(TRIM(u.name),''),u.login) AS name
      FROM users u WHERE u.email_verified_at IS NOT NULL AND u.github_id<>?1
        AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=?2 AND m.user_github_id=u.github_id)
        AND (lower(COALESCE(u.name,'')) LIKE ?3 ESCAPE '\\' OR lower(u.login) LIKE ?3 ESCAPE '\\' OR lower(COALESCE(u.email,'')) LIKE ?3 ESCAPE '\\')
      ORDER BY lower(COALESCE(NULLIF(TRIM(u.name),''),u.login)),lower(u.login) LIMIT 8`)
      .bind(String(actor.user.github_id), orgId, `%${escaped}%`).all();
    return json({ people: results.map(person => ({ githubId: String(person.githubId), login: String(person.login), name: String(person.name) })) });
  } catch {
    return fail("Collaborator search is unavailable until the account directory migration completes.", 503);
  }
}

async function shareThread(request, env, orgId, rootId, actor) {
  if (!["GET", "POST", "DELETE"].includes(request.method)) return fail("Method not allowed.", 405);
  const root = await manageableRoot(env.DB, orgId, rootId, actor.user);
  if (!root) return fail("Thread not found or cannot be shared.", 404);
  if (request.method === "GET") {
    const now = new Date().toISOString();
    const { results = [] } = await env.DB.prepare(`SELECT g.id,g.permission,g.granted_at,g.expires_at,
        u.github_id,u.login,u.name,u.email,
        EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=g.org_id AND m.user_github_id=g.recipient_github_id) AS recipient_is_member
      FROM hx_external_resource_grants g JOIN users u ON u.github_id=g.recipient_github_id
      WHERE g.org_id=?1 AND g.resource_type='thread' AND g.resource_id=?2
        AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?3)
      ORDER BY g.granted_at DESC,g.id LIMIT 100`).bind(orgId,rootId,now).all();
    return json({shares:results.map(row=>({
      id:row.id,permission:row.permission,grantedAt:row.granted_at,expiresAt:row.expires_at||null,
      recipient:{name:row.name||row.login,email:row.email},recipientIsMember:Boolean(row.recipient_is_member),
      suspended:Boolean(row.recipient_is_member),
    }))});
  }
  const input = await request.json().catch(() => null);
  if (!input) return fail("Invalid JSON body.", 400);
  if (request.method === "POST") {
    const recipient = await resolveRecipientInput(env.DB, orgId, input, actor.user.github_id);
    if (!recipient) return fail("A verified account outside this Workspace is required.", 404);
    const permission = input.permission === "edit" ? "edit" : input.permission === "view" ? "view" : null;
    if (!permission) return fail("Permission must be view or edit.", 400);
    let grant;
    try {
      const now = new Date().toISOString();
      const expiry = input.expiresAt == null ? null : String(input.expiresAt).trim();
      if (expiry != null && (!expiry || expiry.length > 200 || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now())) {
        return fail("Expiry must be a future timestamp", 400);
      }
      const id = `xg_${crypto.randomUUID().replaceAll("-", "")}`;
      const updateFence = threadManagerFence(orgId, rootId, actor.user, root.channel, 6);
      const insertFence = threadManagerFence(orgId, rootId, actor.user, root.channel, 9);
      const [revoked, inserted] = await env.DB.batch([
        env.DB.prepare(`UPDATE hx_external_resource_grants SET revoked_at=?1,revoked_by=?2
          WHERE org_id=?3 AND resource_type='thread' AND resource_id=?4
            AND recipient_github_id=?5 AND revoked_at IS NULL
            AND EXISTS(SELECT 1 FROM users eligible WHERE eligible.github_id=?5 AND eligible.email_verified_at IS NOT NULL)
            AND NOT EXISTS(SELECT 1 FROM memberships recipientMember WHERE recipientMember.org_id=?3 AND recipientMember.user_github_id=?5)
            AND ${updateFence.sql}`)
          .bind(now, actor.user.github_id, orgId, rootId, recipient.github_id,
            ...updateFence.bindings),
        env.DB.prepare(`INSERT INTO hx_external_resource_grants
          (id,org_id,resource_type,resource_id,recipient_github_id,permission,granted_by,granted_at,expires_at)
          SELECT ?1,?2,'thread',?3,?4,?5,?6,?7,?8 WHERE EXISTS(SELECT 1 FROM users eligible WHERE eligible.github_id=?4 AND eligible.email_verified_at IS NOT NULL)
            AND NOT EXISTS(SELECT 1 FROM memberships recipientMember WHERE recipientMember.org_id=?2 AND recipientMember.user_github_id=?4)
            AND ${insertFence.sql}`)
          .bind(id, orgId, rootId, recipient.github_id, permission, actor.user.github_id, now, expiry,
            ...insertFence.bindings),
      ]);
      if (!inserted?.meta?.changes) return fail("Thread not found or cannot be shared.", 404);
      grant = { id, permission, expiresAt: expiry };
    } catch (error) {
      return fail(error instanceof TypeError ? error.message : "Could not share this Thread.", error instanceof TypeError ? 400 : 503);
    }
    return json({ shared: true, grant: { id: grant.id, permission, expiresAt: grant.expiresAt },
      recipient: { name: recipient.name || recipient.login, email: recipient.email } }, 201);
  }
  const now = new Date().toISOString();
  let revoked = 0;
  if (typeof input.grantId === "string" && input.grantId) {
    const fence = threadManagerFence(orgId, rootId, actor.user, root.channel, 6);
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE hx_external_resource_grants SET revoked_at=?1,revoked_by=?2
        WHERE id=?3 AND org_id=?4 AND resource_type='thread' AND resource_id=?5
          AND revoked_at IS NULL AND ${fence.sql}`)
        .bind(now,actor.user.github_id,input.grantId,orgId,rootId,...fence.bindings),
      env.DB.prepare(`UPDATE hx_external_thread_send_requests SET status='cancelled',decided_at=?1,decided_by=?2
        WHERE org_id=?3 AND root_message_id=?4 AND status='pending'
          AND guest_github_id=(SELECT recipient_github_id FROM hx_external_resource_grants WHERE org_id=?3 AND id=?5)
          AND EXISTS(SELECT 1 FROM hx_external_resource_grants changed WHERE changed.id=?5
            AND changed.revoked_at=?1 AND changed.revoked_by=?2)
          AND ${threadManagerFence(orgId,rootId,actor.user,root.channel,6).sql}`)
        .bind(now,actor.user.github_id,orgId,rootId,input.grantId,...fence.bindings),
    ]);
    revoked = Number(results?.[0]?.meta?.changes || 0);
  } else {
    const recipient = await resolveRecipientInput(env.DB, orgId, input, actor.user.github_id);
    if (!recipient) return fail("Recipient not found.", 404);
    const fence = threadManagerFence(orgId,rootId,actor.user,root.channel,6);
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE hx_external_resource_grants SET revoked_at=?1,revoked_by=?2
        WHERE org_id=?3 AND resource_type='thread' AND resource_id=?4
          AND recipient_github_id=?5 AND revoked_at IS NULL AND ${fence.sql}`)
        .bind(now,actor.user.github_id,orgId,rootId,recipient.github_id,...fence.bindings),
      env.DB.prepare(`UPDATE hx_external_thread_send_requests SET status='cancelled',decided_at=?1,decided_by=?2
        WHERE org_id=?3 AND root_message_id=?4 AND guest_github_id=?5 AND status='pending'
          AND EXISTS(SELECT 1 FROM hx_external_resource_grants changed WHERE changed.org_id=?3
            AND changed.resource_type='thread' AND changed.resource_id=?4
            AND changed.recipient_github_id=?5 AND changed.revoked_at=?1 AND changed.revoked_by=?2)
          AND ${threadManagerFence(orgId,rootId,actor.user,root.channel,6).sql}`)
        .bind(now,actor.user.github_id,orgId,rootId,recipient.github_id,
          ...threadManagerFence(orgId,rootId,actor.user,root.channel,6).bindings),
    ]);
    revoked = Number(results?.[0]?.meta?.changes || 0);
  }
  return json({ revoked: revoked > 0 });
}

async function manageThreadAudience(request, env, orgId, rootId, actor) {
  if (request.method !== "GET" && request.method !== "PUT") return fail("Method not allowed.", 405);
  const root = await manageableRoot(env.DB, orgId, rootId, actor.user);
  if (!root) return fail("Thread not found or cannot be shared.", 404);
  if (request.method === "GET") {
    return json(await readThreadAudience(env.DB, { orgId, rootId, userId: actor.user.github_id }));
  }
  const input = await request.json().catch(() => null);
  let audience;
  try { audience = cleanThreadAudienceInput(input); }
  catch (error) { return fail(error.message || "Invalid audience.", 400); }
  if (audience.type === "room") {
    const rooms = await listThreadAudienceRooms(env.DB, orgId, actor.user.github_id);
    if (!rooms.some(room => room.id === audience.roomId)) return fail("Choose an accessible Room.", 400);
  }
  const updated = await writeThreadAudience(env.DB, {
    orgId, rootId, actorId: actor.user.github_id, audience,
    managerFence: first => threadManagerFence(orgId, rootId, actor.user, root.channel, first),
  });
  if (!updated) return fail("Audience changed or access revoked. Reload and retry.", 409);
  return json(await readThreadAudience(env.DB, { orgId, rootId, userId: actor.user.github_id }));
}


const inviteId = () => `xti_${crypto.randomUUID().replaceAll("-", "")}`;
function randomInviteToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function externalInviteLink(env, token) {
  if (!env.APP_WEB_URL) return null;
  try {
    const url = new URL(env.APP_WEB_URL);
    url.hash = `#/external-invite/${token}`;
    return url.toString();
  } catch { return null; }
}
function validInviteEmail(email) {
  return typeof email === "string" && email.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

async function manageThreadInvites(request, env, orgId, rootId, actor, inviteRef = null) {
  const root = await manageableRoot(env.DB, orgId, rootId, actor.user);
  if (!root) return fail("Thread not found or cannot be shared.", 404);
  if (inviteRef && !["DELETE", "PATCH"].includes(request.method)) return fail("Method not allowed.", 405);
  if (!inviteRef && request.method === "GET") {
    const now = new Date().toISOString();
    const { results = [] } = await env.DB.prepare(`SELECT id, invited_email, permission, created_at, expires_at, access_expires_at
      FROM hx_external_thread_invites
      WHERE org_id=?1 AND resource_id=?2 AND redeemed_at IS NULL AND revoked_at IS NULL
        AND expires_at>?3 AND (access_expires_at IS NULL OR access_expires_at>?3)
      ORDER BY created_at DESC,id LIMIT 100`).bind(orgId,rootId,now).all();
    return json({ invitations: results.map(row => ({
      id: row.id, email: row.invited_email, permission: row.permission,
      createdAt: row.created_at, expiresAt: row.expires_at,
      accessExpiresAt: row.access_expires_at || null,
    })) });
  }
  if (!inviteRef && request.method === "POST") {
    const limited = await enforce(env, request, "team");
    if (limited) return limited;
    const input = await request.json().catch(() => null);
    if (!input) return fail("Invalid JSON body.", 400);
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    if (!validInviteEmail(email)) return fail("Enter a valid email address.", 400);
    const permission = input.permission === "edit" || input.permission === "view" ? input.permission : null;
    if (!permission) return fail("Permission must be view or edit.", 400);
    const now = new Date();
    const nowIso = now.toISOString();
    let accessExpiresAt = input.accessExpiresAt == null ? null : String(input.accessExpiresAt);
    if (accessExpiresAt && (!Number.isFinite(Date.parse(accessExpiresAt)) || Date.parse(accessExpiresAt) <= now.getTime())) {
      return fail("Access expiry must be a future timestamp.", 400);
    }
    if (accessExpiresAt) accessExpiresAt = new Date(accessExpiresAt).toISOString();
    const lifetimeEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const expiresAt = accessExpiresAt && Date.parse(accessExpiresAt) < lifetimeEnd.getTime()
      ? accessExpiresAt : lifetimeEnd.toISOString();
    const code = randomInviteToken();
    const id = inviteId();
    try {
      const fence = threadManagerFence(orgId,rootId,actor.user,root.channel,11);
      const inserted = await env.DB.prepare(`INSERT INTO hx_external_thread_invites
          (id,org_id,resource_type,resource_id,invited_email,permission,access_expires_at,token_hash,created_by,created_at,expires_at)
        SELECT ?1,?2,'thread',?3,?4,?5,?6,?7,?8,?9,?10 WHERE ${fence.sql}`)
        .bind(id,orgId,rootId,email,permission,accessExpiresAt,await sha256Hex(code),actor.user.github_id,nowIso,expiresAt,
          ...fence.bindings).run();
      if (!inserted?.meta?.changes) return fail("Thread not found or cannot be shared.",404);
    } catch (error) {
      console.error("external Thread invitation create failed", error?.message || error);
      return fail("Could not create this invitation.", 503);
    }
    // The one-time URL is safe to send to the invited address: redemption still
    // proves that identity through OTP. If mail is unavailable, the UI exposes
    // the same URL for manual sharing.
    const inviteUrl = externalInviteLink(env, code);
    const emailDelivery = inviteUrl ? await deliverExternalInvite(env, { id, to: email, resource: "a Thread", inviteUrl, expiresAt }) : { status: "not_configured" };
    return json({ invited: true, invitationId: id, inviteUrl, emailDelivery, ...(!inviteUrl ? { token: code } : {}), expiresAt }, 201);
  }
  if (inviteRef && request.method === "PATCH") {
    const input = await request.json().catch(() => null);
    const permission = input?.permission === "edit" || input?.permission === "view" ? input.permission : null;
    if (!permission) return fail("Permission must be view or edit.", 400);
    if (!input || !Object.hasOwn(input, "accessExpiresAt")) return fail("Choose an access expiry.", 400);
    let accessExpiresAt = null;
    if (input.accessExpiresAt !== null) {
      const parsed = typeof input.accessExpiresAt === "string" ? Date.parse(input.accessExpiresAt) : NaN;
      if (!Number.isFinite(parsed) || parsed <= Date.now()) return fail("Access expiry must be a future timestamp or no expiry.", 400);
      accessExpiresAt = new Date(parsed).toISOString();
    }
    const now = new Date().toISOString();
    const fence = threadManagerFence(orgId, rootId, actor.user, root.channel, 7);
    const updated = await env.DB.prepare(`UPDATE hx_external_thread_invites
      SET permission=?1,access_expires_at=?2
      WHERE org_id=?3 AND resource_id=?4 AND id=?5 AND redeemed_at IS NULL AND redemption_id IS NULL
        AND revoked_at IS NULL AND expires_at>?6 AND (access_expires_at IS NULL OR access_expires_at>?6)
        AND NOT EXISTS(SELECT 1 FROM users recipient JOIN memberships workspaceMembership
          ON workspaceMembership.org_id=?3 AND workspaceMembership.user_github_id=recipient.github_id
          WHERE lower(trim(coalesce(recipient.email,'')))=lower(trim(hx_external_thread_invites.invited_email)))
        AND EXISTS(SELECT 1 FROM org_settings settings WHERE settings.org_id=?3 AND settings.mode='harness')
        AND ${fence.sql}`)
      .bind(permission, accessExpiresAt, orgId, rootId, inviteRef, now, ...fence.bindings).run();
    if (Number(updated?.meta?.changes || 0) !== 1) return fail("An eligible unredeemed Thread invitation was not found.", 404);
    await audit(env, request, {
      orgId,
      action: "external.thread_invite_updated",
      actor: { type: "user", id: String(actor.user.github_id), name: actor.user.name || actor.user.login },
      entity: { type: "thread", id: rootId },
      details: { invitationId: inviteRef, permission, accessExpiresAt },
    });
    return json({ updated: true });
  }
  if (inviteRef && request.method === "DELETE") {
    const now = new Date().toISOString();
    // Fence redemption and revoke its exact grant in one D1 batch transaction.
    // Whichever transaction wins, the invite cannot be left revoked with a
    // live grant: a later redemption sees revoked_at; an earlier one exposes
    // created_grant_id to the following statement in this same batch.
    const fence = threadManagerFence(orgId,rootId,actor.user,root.channel,6);
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE hx_external_thread_invites SET revoked_at=?1,revoked_by=?2
        WHERE id=?3 AND org_id=?4 AND resource_id=?5 AND revoked_at IS NULL AND ${fence.sql}`)
        .bind(now,actor.user.github_id,inviteRef,orgId,rootId,...fence.bindings),
      env.DB.prepare(`UPDATE hx_external_resource_grants SET revoked_at=?1,revoked_by=?2
        WHERE id=(SELECT created_grant_id FROM hx_external_thread_invites
          WHERE id=?3 AND org_id=?4 AND resource_id=?5 AND revoked_at=?1 AND revoked_by=?2)
          AND org_id=?4 AND resource_type='thread' AND resource_id=?5 AND revoked_at IS NULL`)
        .bind(now,actor.user.github_id,inviteRef,orgId,rootId),
      env.DB.prepare(`UPDATE hx_external_thread_send_requests
        SET status='cancelled',decided_at=?1,decided_by=?2
        WHERE org_id=?3 AND root_message_id=?4
          AND guest_github_id=(SELECT redeemed_by FROM hx_external_thread_invites
            WHERE id=?5 AND org_id=?3 AND resource_id=?4 AND revoked_at=?1 AND revoked_by=?2)
          AND status='pending' AND ${threadManagerFence(orgId,rootId,actor.user,root.channel,6).sql}`)
        .bind(now,actor.user.github_id,orgId,rootId,inviteRef,...fence.bindings),
    ]);
    return json({ revoked: Number(results?.[0]?.meta?.changes || 0) > 0 });
  }
  return fail("Method not allowed.", 405);
}

async function manageThreadLinkShares(request, env, orgId, rootId, actor, linkRef = null) {
  const root = await manageableRoot(env.DB, orgId, rootId, actor.user);
  if (!root) return fail("Thread not found or cannot be shared.", 404);
  if (!linkRef && request.method === "GET") {
    const now = new Date().toISOString();
    const { results = [] } = await env.DB.prepare(`SELECT id,permission,created_at,expires_at
      FROM hx_external_thread_link_shares WHERE org_id=?1 AND resource_id=?2 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at>?3) ORDER BY created_at DESC,id LIMIT 100`)
      .bind(orgId,rootId,now).all();
    return json({ links: results.map(row => ({id:row.id,permission:row.permission,createdAt:row.created_at,expiresAt:row.expires_at||null})) });
  }
  if (!linkRef && request.method === "POST") {
    const limited = await enforce(env,request,"team");
    if (limited) return limited;
    const input = await request.json().catch(() => null);
    if (!input) return fail("Invalid JSON body.",400);
    const permission = input.permission === "view" || input.permission === "edit" ? input.permission : null;
    if (!permission) return fail("Permission must be view or edit.",400);
    const now = new Date();
    let expiresAt = input.expiresAt == null ? null : String(input.expiresAt).trim();
    if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now.getTime())) return fail("Expiry must be a future timestamp.",400);
    if (expiresAt) expiresAt = new Date(expiresAt).toISOString();
    const token = randomInviteToken();
    const id = `xtl_${crypto.randomUUID().replaceAll("-","")}`;
    const fence = threadManagerFence(orgId,rootId,actor.user,root.channel,9);
    try {
      const inserted = await env.DB.prepare(`INSERT INTO hx_external_thread_link_shares
        (id,org_id,resource_id,permission,token_hash,created_by,created_at,expires_at)
        SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE ${fence.sql}`)
        .bind(id,orgId,rootId,permission,await sha256Hex(token),actor.user.github_id,now.toISOString(),expiresAt,...fence.bindings).run();
      if (!inserted?.meta?.changes) return fail("Thread not found or cannot be shared.",404);
    } catch (error) {
      console.error("external Thread link create failed",error?.message||error);
      return fail("Could not create this share link.",503);
    }
    return json({created:true,link:{id,permission,createdAt:now.toISOString(),expiresAt},token,inviteUrl:externalInviteLink(env,token)},201);
  }
  if (linkRef && request.method === "DELETE") {
    const now = new Date().toISOString();
    const fence = threadManagerFence(orgId,rootId,actor.user,root.channel,6);
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE hx_external_thread_link_shares SET revoked_at=?1,revoked_by=?2
        WHERE id=?3 AND org_id=?4 AND resource_id=?5 AND revoked_at IS NULL AND ${fence.sql}`)
        .bind(now,actor.user.github_id,linkRef,orgId,rootId,...fence.bindings),
      env.DB.prepare(`UPDATE hx_external_resource_grants SET revoked_at=?1,revoked_by=?2
        WHERE id IN (SELECT grant_id FROM hx_external_thread_link_redemptions WHERE link_id=?3)
          AND org_id=?4 AND resource_type='thread' AND resource_id=?5 AND revoked_at IS NULL
          AND EXISTS(SELECT 1 FROM hx_external_thread_link_shares l WHERE l.id=?3 AND l.org_id=?4
            AND l.resource_id=?5 AND l.revoked_at=?1 AND l.revoked_by=?2)`)
        .bind(now,actor.user.github_id,linkRef,orgId,rootId),
    ]);
    return json({revoked:Number(results?.[0]?.meta?.changes||0)>0});
  }
  return fail("Method not allowed.",405);
}

/** Redeem reusable anyone-with-link capability into an exact Thread grant. */
async function redeemExternalThreadLink(env,{token,userId}) {
  const deny={error:"This share link is not valid, or has expired.",status:404};
  if(typeof token!=="string"||!/^[a-f0-9]{64}$/i.test(token)||!userId) return deny;
  const tokenHash=await sha256Hex(token.toLowerCase());
  const now=new Date().toISOString();
  const link=await env.DB.prepare(`SELECT l.* FROM hx_external_thread_link_shares l
    WHERE l.token_hash=?1 AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at>?2)`)
    .bind(tokenHash,now).first();
  if(!link||(await getMode(env.DB,link.org_id))!=="harness") return deny;
  const person=await env.DB.prepare("SELECT github_id FROM users WHERE github_id=?1").bind(String(userId)).first();
  if(!person||await isMember(env.DB,link.org_id,String(userId))) return deny;
  const root=await rootFor(env.DB,link.org_id,link.resource_id);
  const owner=await getUserByGithubId(env.DB,link.created_by);
  if(!root||!owner||!(await manageableRoot(env.DB,link.org_id,link.resource_id,owner))) return deny;
  const existing=await env.DB.prepare(`SELECT g.id,g.permission FROM hx_external_thread_link_redemptions r
    JOIN hx_external_resource_grants g ON g.id=r.grant_id
    WHERE r.link_id=?1 AND r.recipient_github_id=?2 AND g.org_id=?4 AND g.revoked_at IS NULL
      AND (g.expires_at IS NULL OR g.expires_at>?3)`).bind(link.id,String(userId),now,link.org_id).first();
  if(existing) return {redeemed:true,orgId:link.org_id,resourceType:"thread",resourceId:link.resource_id,permission:existing.permission};
  // Preserve direct shares and grants minted through other links. Never replace
  // a stronger or weaker existing grant as a side effect of redeeming a link.
  const priorGrant=await env.DB.prepare(`SELECT permission FROM hx_external_resource_grants
    WHERE org_id=?1 AND resource_type='thread' AND resource_id=?2 AND recipient_github_id=?3
      AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?4)
    ORDER BY granted_at DESC LIMIT 1`).bind(link.org_id,link.resource_id,String(userId),now).first();
  if(priorGrant) return {redeemed:true,orgId:link.org_id,resourceType:"thread",resourceId:link.resource_id,permission:priorGrant.permission};
  const redemption=env.DB.prepare(`INSERT OR IGNORE INTO hx_external_thread_link_redemptions(link_id,recipient_github_id,redeemed_at)
    SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM hx_external_thread_link_shares l WHERE l.id=?1
      AND l.token_hash=?4 AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at>?3))
      AND EXISTS(SELECT 1 FROM channel_messages root WHERE root.org_id=?5 AND root.id=?6 AND root.parent_id IS NULL AND root.deleted_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=?5 AND m.user_github_id=?2)`)
    .bind(link.id,String(userId),now,tokenHash,link.org_id,link.resource_id);
  const grantId=`xg_${crypto.randomUUID().replaceAll("-","")}`;
  const ownerFence=threadManagerFence(link.org_id,link.resource_id,owner,root.channel,5);
  const grant=env.DB.prepare(`INSERT INTO hx_external_resource_grants(id,org_id,resource_type,resource_id,recipient_github_id,permission,granted_by,granted_at,expires_at)
    SELECT ?1,l.org_id,'thread',l.resource_id,?2,l.permission,l.created_by,?3,l.expires_at
    FROM hx_external_thread_link_shares l JOIN hx_external_thread_link_redemptions r ON r.link_id=l.id AND r.recipient_github_id=?2
    WHERE l.id=?4 AND r.grant_id IS NULL AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at>?3)
      AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=l.org_id AND m.user_github_id=?2)
      AND EXISTS(SELECT 1 FROM channel_messages root WHERE root.org_id=l.org_id AND root.id=l.resource_id AND root.parent_id IS NULL AND root.deleted_at IS NULL)
      AND ${ownerFence.sql}`)
    .bind(grantId,String(userId),now,link.id,...ownerFence.bindings);
  const remember=env.DB.prepare(`UPDATE hx_external_thread_link_redemptions SET grant_id=?1
    WHERE link_id=?2 AND recipient_github_id=?3 AND grant_id IS NULL
      AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.id=?1 AND g.org_id=?4 AND g.resource_type='thread' AND g.resource_id=?5 AND g.recipient_github_id=?3)`)
    .bind(grantId,link.id,String(userId),link.org_id,link.resource_id);
  const results=await env.DB.batch([redemption,grant,remember]);
  if(results?.[1]?.meta?.changes&&results?.[2]?.meta?.changes) return {redeemed:true,orgId:link.org_id,resourceType:"thread",resourceId:link.resource_id,permission:link.permission};
  return deny;
}

/** Redeem a link only after the signed-in identity has proved its email address. */
export async function redeemExternalThreadInvite(env, { token, userId }) {
  const deny = { error: "This invitation is not valid, or has expired.", status: 404 };
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/i.test(token) || !userId) return deny;
  const tokenHash = await sha256Hex(token.toLowerCase());
  const now = new Date().toISOString();
  const invite = await env.DB.prepare(`SELECT i.* FROM hx_external_thread_invites i
    WHERE i.token_hash=?1 AND i.redeemed_at IS NULL AND i.revoked_at IS NULL
      AND i.expires_at>?2 AND (i.access_expires_at IS NULL OR i.access_expires_at>?2)`)
    .bind(tokenHash,now).first();
  if (!invite || (await getMode(env.DB,invite.org_id)) !== "harness") return deny;
  const person = await env.DB.prepare("SELECT github_id,email,email_verified_at FROM users WHERE github_id=?1")
    .bind(String(userId)).first();
  if (!person?.email_verified_at || String(person.email || "").trim().toLowerCase() !== invite.invited_email) return deny;
  const inviter = await getUserByGithubId(env.DB,invite.created_by);
  if (!inviter || !(await manageableRoot(env.DB,invite.org_id,invite.resource_id,inviter))) return deny;
  const redemptionId = `xtr_${crypto.randomUUID().replaceAll("-", "")}`;
  const grantId = `xg_${crypto.randomUUID().replaceAll("-", "")}`;
  const claim = env.DB.prepare(`UPDATE hx_external_thread_invites
      SET redeemed_at=?1,redeemed_by=?2,redemption_id=?3
    WHERE id=?4 AND token_hash=?5 AND redeemed_at IS NULL AND revoked_at IS NULL
      AND expires_at>?1 AND (access_expires_at IS NULL OR access_expires_at>?1)
      AND invited_email=?6
      AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=?7 AND member.user_github_id=?2)
      AND EXISTS(SELECT 1 FROM channel_messages root WHERE root.org_id=?7 AND root.id=?8
        AND root.parent_id IS NULL AND root.deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM hx_room_access tombstone WHERE tombstone.org_id=root.org_id
          AND tombstone.channel=root.channel AND tombstone.deleted_at IS NOT NULL))
      AND EXISTS(SELECT 1 FROM memberships grantor WHERE grantor.org_id=?7 AND grantor.user_github_id=created_by)
      AND EXISTS(SELECT 1 FROM channel_messages root JOIN users grantor ON grantor.github_id=created_by
        WHERE root.org_id=?7 AND root.id=?8 AND
          (root.author_login=grantor.login OR EXISTS(SELECT 1 FROM memberships rolecheck
            WHERE rolecheck.org_id=?7 AND rolecheck.user_github_id=created_by AND lower(rolecheck.role) IN ('owner','admin'))))`)
    .bind(now,String(userId),redemptionId,invite.id,tokenHash,invite.invited_email,invite.org_id,invite.resource_id);
  const previous = env.DB.prepare(`UPDATE hx_external_resource_grants SET revoked_at=?1,revoked_by=?2
    WHERE org_id=?3 AND resource_type='thread' AND resource_id=?4 AND recipient_github_id=?5 AND revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM hx_external_thread_invites i WHERE i.id=?6 AND i.redemption_id=?7)
      AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=?3 AND m.user_github_id=?5)`)
    .bind(now,invite.created_by,invite.org_id,invite.resource_id,String(userId),invite.id,redemptionId);
  const insert = env.DB.prepare(`INSERT INTO hx_external_resource_grants
      (id,org_id,resource_type,resource_id,recipient_github_id,permission,granted_by,granted_at,expires_at)
    SELECT ?1,i.org_id,'thread',i.resource_id,?2,i.permission,i.created_by,?3,i.access_expires_at
      FROM hx_external_thread_invites i
      WHERE i.id=?4 AND i.redemption_id=?5 AND i.redeemed_by=?2 AND i.revoked_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=i.org_id AND m.user_github_id=?2)
        AND EXISTS(SELECT 1 FROM channel_messages root WHERE root.org_id=i.org_id AND root.id=i.resource_id
          AND root.parent_id IS NULL AND root.deleted_at IS NULL)`)
    .bind(grantId,String(userId),now,invite.id,redemptionId);
  const rememberGrant = env.DB.prepare(`UPDATE hx_external_thread_invites SET created_grant_id=?1
    WHERE id=?2 AND redemption_id=?3 AND redeemed_by=?4 AND EXISTS(
      SELECT 1 FROM hx_external_resource_grants g WHERE g.id=?1 AND g.org_id=?5 AND g.resource_type='thread'
        AND g.resource_id=?6 AND g.recipient_github_id=?4 AND g.revoked_at IS NULL)`)
    .bind(grantId,invite.id,redemptionId,String(userId),invite.org_id,invite.resource_id);
  const results = await env.DB.batch([claim,previous,insert,rememberGrant]);
  if (!(results?.[0]?.meta?.changes > 0)) return deny;
  if (results?.[2]?.meta?.changes > 0 && results?.[3]?.meta?.changes > 0) {
    return { redeemed: true, orgId: invite.org_id, resourceType: "thread", resourceId: invite.resource_id, permission: invite.permission };
  }
  return deny;
}

async function uploadExternalAttachment(request, env, url, orgId, root, actor) {
  const access = await externalThreadPermission(env.DB, { orgId, rootId: root.id, githubId: actor.user.github_id });
  if (!access) return fail("Thread not found or access revoked.", 404);
  if (access.permission !== "edit") return fail("An edit grant is required to upload a Thread attachment.", 403);
  const uploaded = await uploadFile(request, env, url, {
    orgId, resolved: { key: root.channel }, login: actor.user.login,
  });
  if (!uploaded.ok) return uploaded;
  const result = await uploaded.json().catch(() => null);
  const file = result?.file;
  if (!file?.id) return fail("Could not save this attachment.", 503);

  // The upload streams to R2 after the initial authorization check. Recheck
  // the exact Thread grant once the stream completes; clean up if it changed.
  const currentRoot = await rootFor(env.DB, orgId, root.id);
  const currentPermission = currentRoot && await externalThreadPermission(env.DB, { orgId, rootId: root.id, githubId: actor.user.github_id });
  if (!currentRoot || currentRoot.channel !== root.channel || currentPermission?.permission !== "edit") {
    const deleted = await env.DB.prepare(
      "DELETE FROM message_files WHERE org_id=?1 AND id=?2 AND message_id IS NULL"
    ).bind(orgId, file.id).run();
    if (deleted.meta?.changes) await deleteFileObject(env, orgId, file.id);
    return fail("Thread not found or access revoked.", 404);
  }
  // Never return the regular signed media URL: every guest read uses the
  // session and exact-resource grant checked by readExternalAttachment.
  return json({ file: {
    id: file.id, name: file.name, type: file.type, size: file.size,
    width: file.width || null, height: file.height || null,
  } }, 201);
}

async function readExternalAttachment(request, env, orgId, root, fileId, user) {
  if (request.method !== "GET" || !/^f_[0-9a-f]{24}$/.test(fileId)) return fail("Not found.", 404);
  const now = new Date().toISOString();
  const row = await env.DB.prepare(`SELECT f.*
    FROM message_files f
    JOIN channel_messages m ON m.org_id=f.org_id AND m.id=f.message_id
    JOIN channel_messages root ON root.org_id=m.org_id AND root.id=?2
      AND root.parent_id IS NULL AND root.deleted_at IS NULL AND root.channel=m.channel
    WHERE f.org_id=?1 AND f.id=?3 AND (m.id=root.id OR m.parent_id=root.id)
      AND m.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM hx_room_access tombstone
        WHERE tombstone.org_id=root.org_id AND tombstone.channel=root.channel AND tombstone.deleted_at IS NOT NULL)
      AND ${threadAudienceAccessSql({ org: "?1", root: "?2", user: "?4", now: "?5" })}`)
    .bind(orgId, root.id, fileId, user.github_id, now).first();
  if (!row) return fail("Not found.", 404);

  const headers = {
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "no-store",
    "accept-ranges": "bytes",
    "content-type": row.type,
    "content-disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(row.name || "file").replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`),
  };
  const range = request.headers.has("if-range") ? null : byteRange(request.headers.get("range"), Number(row.size) || 0);
  if (range === UNSATISFIABLE) {
    return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${row.size}` } });
  }
  // Authorization is checked for every request, including each media range.
  const object = await getFileObject(env, orgId, fileId, range ? { range } : undefined);
  if (!object) return fail("Not found.", 404);
  return new Response(object.body, {
    status: range ? 206 : 200,
    headers: {
      ...headers,
      "content-length": String(range ? range.length : row.size),
      ...(range ? { "content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/${row.size}` } : {}),
    },
  });
}

async function reactionRows(env, orgId, rootId, user, messageIds) {
  if (!messageIds.length) return [];
  const { results = [] } = await env.DB.prepare(`SELECT r.message_id, r.emoji, COUNT(*) AS count,
      MAX(CASE WHEN r.login=?3 THEN 1 ELSE 0 END) AS mine
    FROM message_reactions r
    JOIN channel_messages m ON m.org_id=r.org_id AND m.id=r.message_id
    JOIN channel_messages root ON root.org_id=m.org_id AND root.id=?2
      AND root.parent_id IS NULL AND root.deleted_at IS NULL AND root.channel=m.channel
    WHERE r.org_id=?1 AND (m.id=root.id OR m.parent_id=root.id) AND m.deleted_at IS NULL
      AND ${threadAudienceAccessSql({ org: "?1", root: "?2", user: "?4", now: "?5" })}
    GROUP BY r.message_id, r.emoji ORDER BY r.emoji`)
    .bind(orgId, rootId, user.login, user.github_id, new Date().toISOString()).all();
  // Workspace shortcodes resolve to workspace assets that are not delivered to external guests.
  // Keep them out of the guest payload until a resource-authorized asset route exists.
  return results.filter((row) => !/^:[a-z0-9_+-]{1,30}:$/i.test(String(row.emoji || "")));
}

async function toggleExternalReaction(env, orgId, rootId, user, input) {
  if (!input || typeof input.messageId !== "string") return fail("messageId is required.", 400);
  const emoji = cleanEmoji(input.emoji);
  if (!emoji) return fail("That is not an emoji.", 400);
  if (/^:[a-z0-9_+-]{1,30}:$/i.test(emoji)) return fail("Workspace emoji are not available to external collaborators.", 400);
  const now = new Date().toISOString();
  const target = await env.DB.prepare(`SELECT m.id FROM channel_messages m
    JOIN channel_messages root ON root.org_id=m.org_id AND root.id=?2
      AND root.parent_id IS NULL AND root.deleted_at IS NULL AND root.channel=m.channel
    WHERE m.org_id=?1 AND m.id=?3 AND (m.id=root.id OR m.parent_id=root.id) AND m.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM hx_room_access tombstone WHERE tombstone.org_id=root.org_id
        AND tombstone.channel=root.channel AND tombstone.deleted_at IS NOT NULL)
      AND ${threadAudienceAccessSql({ org: "?1", root: "?2", user: "?4", now: "?5" })}`)
    .bind(orgId, rootId, input.messageId, user.github_id, now).first();
  if (!target) return fail("Thread not found or access revoked.", 404);
  const had = await env.DB.prepare(
    "SELECT 1 FROM message_reactions WHERE org_id=?1 AND message_id=?2 AND emoji=?3 AND login=?4"
  ).bind(orgId, target.id, emoji, user.login).first();
  if (had) {
    await env.DB.prepare(`DELETE FROM message_reactions
      WHERE org_id=?1 AND message_id=?2 AND emoji=?3 AND login=?4
        AND EXISTS(SELECT 1 FROM channel_messages m JOIN channel_messages root
          ON root.org_id=m.org_id AND root.id=?5 AND root.parent_id IS NULL
            AND root.deleted_at IS NULL AND root.channel=m.channel
          WHERE m.org_id=?1 AND m.id=?2 AND (m.id=root.id OR m.parent_id=root.id) AND m.deleted_at IS NULL)
        AND ${threadAudienceAccessSql({ org: "?1", root: "?5", user: "?6", now: "?7" })}`)
      .bind(orgId, target.id, emoji, user.login, rootId, user.github_id, now).run();
  } else {
    await env.DB.prepare(`INSERT INTO message_reactions (org_id,message_id,emoji,login,created_at)
      SELECT ?1,?2,?3,?4,?7
      WHERE EXISTS(SELECT 1 FROM channel_messages m JOIN channel_messages root
        ON root.org_id=m.org_id AND root.id=?5 AND root.parent_id IS NULL
          AND root.deleted_at IS NULL AND root.channel=m.channel
        WHERE m.org_id=?1 AND m.id=?2 AND (m.id=root.id OR m.parent_id=root.id) AND m.deleted_at IS NULL)
        AND ${threadAudienceAccessSql({ org: "?1", root: "?5", user: "?6", now: "?7" })}
        AND (EXISTS(SELECT 1 FROM message_reactions WHERE message_id=?2 AND emoji=?3)
          OR (SELECT COUNT(DISTINCT emoji) FROM message_reactions WHERE message_id=?2)<20)
      ON CONFLICT DO NOTHING`)
      .bind(orgId, target.id, emoji, user.login, rootId, user.github_id, now).run();
  }
  const permission = await externalThreadPermission(env.DB, { orgId, rootId, githubId: user.github_id });
  if (!permission) return fail("Thread not found or access revoked.", 404);
  const reactions = await reactionRows(env, orgId, rootId, user, [target.id]);
  return json({ messageId: target.id, reactions: reactions.map(({ emoji: name, count, mine }) => ({
    emoji: name, count: Number(count), mine: Boolean(mine),
  })) });
}

async function readThread(env, orgId, rootId, user) {
  const now = new Date().toISOString();
  const access = await externalThreadPermission(env.DB, { orgId, rootId, githubId: user.github_id, now });
  if (!access) return null;
  const { results = [] } = await env.DB.prepare(`SELECT m.id, m.kind, m.body, m.author_login, m.created_at, m.edited_at,
      m.parent_id, u.name AS author_name, a.name AS agent_name, ?4 AS permission
    FROM channel_messages m
    JOIN channel_messages root ON root.org_id=m.org_id AND root.id=?3
      AND root.parent_id IS NULL AND root.deleted_at IS NULL AND root.channel=m.channel
    LEFT JOIN users u ON u.login=m.author_login
    LEFT JOIN custom_agents a ON 'agent:' || a.id=m.author_login AND a.org_id=m.org_id
    WHERE m.org_id=?2 AND (m.id=?3 OR m.parent_id=?3) AND m.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM hx_room_access tombstone
        WHERE tombstone.org_id=root.org_id AND tombstone.channel=root.channel AND tombstone.deleted_at IS NOT NULL)
      AND ${threadAudienceAccessSql({ org: 'm.org_id', root: '?3', user: '?5', now: '?6' })}
    ORDER BY m.created_at,m.rowid`)
    .bind(orgId, orgId, rootId, access.permission, user.github_id, now).all();
  if (!results.length) return null;

  const { results: fileRows = [] } = await env.DB.prepare(`SELECT f.id, f.name, f.type, f.size,
      f.width, f.height, f.message_id
    FROM message_files f
    JOIN channel_messages m ON m.org_id=f.org_id AND m.id=f.message_id
    JOIN channel_messages root ON root.org_id=m.org_id AND root.id=?2
      AND root.parent_id IS NULL AND root.deleted_at IS NULL AND root.channel=m.channel
    WHERE f.org_id=?1 AND (m.id=root.id OR m.parent_id=root.id) AND m.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM hx_room_access tombstone
        WHERE tombstone.org_id=root.org_id AND tombstone.channel=root.channel AND tombstone.deleted_at IS NOT NULL)
      AND ${threadAudienceAccessSql({ org: 'f.org_id', root: '?2', user: '?3', now: '?4' })}
    ORDER BY f.created_at,f.rowid`)
    .bind(orgId, rootId, user.github_id, new Date().toISOString()).all();
  const filesByMessage = new Map();
  for (const file of fileRows) {
    const files = filesByMessage.get(file.message_id) || [];
    files.push({
      id: file.id, name: file.name, type: file.type, size: file.size,
      width: file.width || null, height: file.height || null,
      url: `/external/threads/${encodeURIComponent(orgId)}/${encodeURIComponent(rootId)}/files/${file.id}`,
    });
    filesByMessage.set(file.message_id, files);
  }
  const reactions = await reactionRows(env, orgId, rootId, user, results.map(row => row.id));
  const currentRoot = await rootFor(env.DB, orgId, rootId);
  const currentPermission = currentRoot && await externalThreadPermission(env.DB, { orgId, rootId, githubId: user.github_id });
  if (!currentRoot || !currentPermission) return null;
  const reactionsByMessage = new Map();
  for (const reaction of reactions) {
    const items = reactionsByMessage.get(reaction.message_id) || [];
    items.push({ emoji: reaction.emoji, count: Number(reaction.count), mine: Boolean(reaction.mine) });
    reactionsByMessage.set(reaction.message_id, items);
  }
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
    files: filesByMessage.get(row.id) || [],
    reactions: reactionsByMessage.get(row.id) || [],
  }));
  return {
    permission,
    thread: {
      parent: messages.find(message => message.id === rootId),
      replies: messages.filter(message => message.id !== rootId),
    },
  };
}

async function deliverExternalReply(env, { orgId, root, row, guest }) {
  // Reuse the normal channel delivery pipeline so existing members receive
  // mention notifications and live updates. The guest still reads only via
  // the exact-resource external Thread endpoint.
  await broadcastStored(env, orgId, root.channel, row);

  // External collaborators can ask the workspace AI explicitly. Custom Agent
  // dispatch remains unavailable here: a Thread grant does not grant Agent
  // access. Recheck the grant and root after the asynchronous message insert.
  if (!asksTheAI(row.body) || await getMode(env.DB, orgId) !== "harness") return;
  const currentRoot = await rootFor(env.DB, orgId, root.id);
  if (!currentRoot || currentRoot.channel !== root.channel) return;
  if (!await externalThreadPermission(env.DB, { orgId, rootId: root.id, githubId: guest.user.github_id })) return;

  const logins = await audienceOf(env.DB, orgId, root.channel);
  const key = root.channel;
  const kind = key.startsWith("b:") ? "business"
    : key.startsWith("dm:") ? "dm"
    : key.startsWith("g:") ? "group"
    : key.startsWith("ag:") ? "agent" : null;
  if (!kind) return;
  const resolved = { key, kind, logins };
  if (kind === "business") resolved.slug = key.slice(2);
  const members = await listMembers(env.DB, orgId, null);
  await answerAsAI(env, {
    orgId, session: guest.session, user: guest.user, resolved, row, members,
    locale: guest.user.locale || "en", threadOnly: true,
  });
}

function deferExternalReply(ctx, env, input) {
  const task = deliverExternalReply(env, input).catch((error) => {
    console.error("external Thread delivery failed", error?.message || error);
  });
  if (ctx?.waitUntil) ctx.waitUntil(task);
  else return task;
}

async function insertReply(env, orgId, rootId, user, body, fileIds = []) {
  const id = keyId();
  const now = new Date().toISOString();
  const insert = env.DB.prepare(`INSERT INTO channel_messages
      (id, org_id, channel, author_login, kind, body, created_at, parent_id)
    SELECT ?1, root.org_id, root.channel, ?6, 'message', ?7, ?8, root.id
      FROM channel_messages root
     WHERE root.org_id=?2 AND root.id=?3 AND root.parent_id IS NULL AND root.deleted_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM hx_room_access tombstone
         WHERE tombstone.org_id=root.org_id AND tombstone.channel=root.channel AND tombstone.deleted_at IS NOT NULL)
       AND ${activeGrantSql}`)
    .bind(id, orgId, rootId, user.github_id, now, user.login, body, now);
  if (!fileIds.length) {
    const put = await insert.run();
    return put.meta?.changes ? id : null;
  }
  const marks = fileIds.map((_, index) => `?${index + 8}`).join(",");
  const claim = env.DB.prepare(`UPDATE message_files SET message_id=?1
    WHERE org_id=?2 AND channel=?6 AND uploader=?7 AND message_id IS NULL AND id IN (${marks})
      AND EXISTS(SELECT 1 FROM channel_messages m WHERE m.org_id=?2 AND m.id=?1
        AND m.channel=?6 AND m.author_login=?7 AND m.parent_id=?3 AND m.deleted_at IS NULL)
      AND ${threadAudienceAccessSql({ org: "?2", root: "?3", user: "?4", now: "?5", requiredPermission: "edit" })}`)
    .bind(id, orgId, rootId, user.github_id, now, (await rootFor(env.DB, orgId, rootId))?.channel || "", user.login, ...fileIds);
  const [put] = await env.DB.batch([insert, claim]);
  return put.meta?.changes ? id : null;
}

async function requestSend(env, orgId, rootId, user, body) {
  const id = requestId();
  const now = new Date().toISOString();
  const access = await externalThreadPermission(env.DB, { orgId, rootId, githubId: user.github_id, now });
  if (!access || access.permission !== "view") return null;
  const audienceVersion = access.source === "audience" ? access.audienceVersion : null;
  const insert = env.DB.prepare(`INSERT OR IGNORE INTO hx_external_thread_send_requests
      (id, org_id, root_message_id, guest_github_id, body, status, requested_at)
    SELECT ?1, ?2, ?3, ?4, ?5, 'pending', ?6
     WHERE EXISTS(SELECT 1 FROM channel_messages root WHERE root.org_id=?2 AND root.id=?3
       AND root.parent_id IS NULL AND root.deleted_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM hx_room_access tombstone WHERE tombstone.org_id=root.org_id
         AND tombstone.channel=root.channel AND tombstone.deleted_at IS NOT NULL))
       AND ${threadAudienceAccessSql({ org: "?2", root: "?3", user: "?4", now: "?6", requiredPermission: "view" })}`)
    .bind(id, orgId, rootId, user.github_id, body, now);
  const statements = [insert];
  if (audienceVersion != null) {
    statements.push(env.DB.prepare(`INSERT INTO hx_external_thread_audience_requests
      (request_id,org_id,root_message_id,guest_github_id,audience_version,created_at)
      SELECT ?1,?2,?3,?4,?5,?6 WHERE EXISTS(
        SELECT 1 FROM hx_external_thread_audiences a JOIN memberships member
          ON member.org_id=a.org_id AND member.user_github_id=?4
        WHERE a.org_id=?2 AND a.root_message_id=?3 AND a.version=?5
          AND a.audience_type IS NOT NULL AND a.permission='view'
          AND (a.expires_at IS NULL OR a.expires_at>?6)
          AND (a.audience_type='workspace' OR (a.audience_type='room' AND EXISTS(
            SELECT 1 FROM conversation_members cm JOIN users roomUser ON roomUser.login=cm.login
            WHERE cm.org_id=a.org_id AND cm.channel=a.room_id AND roomUser.github_id=?4))))`)
      .bind(id, orgId, rootId, user.github_id, audienceVersion, now));
  }
  const [created] = await env.DB.batch(statements);
  if (created?.meta?.changes) {
    if (audienceVersion != null) {
      const linked = await env.DB.prepare("SELECT 1 FROM hx_external_thread_audience_requests WHERE request_id=?1 AND audience_version=?2")
        .bind(id, audienceVersion).first();
      if (!linked) {
        await env.DB.prepare("UPDATE hx_external_thread_send_requests SET status='cancelled',decided_at=?1 WHERE id=?2 AND status='pending'").bind(now,id).run();
        return null;
      }
    }
    return { id, created: true };
  }
  const existing = await env.DB.prepare(`SELECT r.id FROM hx_external_thread_send_requests r
    WHERE r.org_id=?1 AND r.root_message_id=?2 AND r.guest_github_id=?3 AND r.status='pending'
      AND ${threadAudienceAccessSql({ org: "r.org_id", root: "r.root_message_id", user: "r.guest_github_id", now: "?4", requiredPermission: "view" })}
      AND (NOT EXISTS(SELECT 1 FROM hx_external_thread_audience_requests ar WHERE ar.request_id=r.id)
        OR EXISTS(SELECT 1 FROM hx_external_thread_audience_requests ar JOIN hx_external_thread_audiences a
          ON a.org_id=ar.org_id AND a.root_message_id=ar.root_message_id AND a.version=ar.audience_version
          WHERE ar.request_id=r.id AND a.audience_type IS NOT NULL AND a.permission='view'
            AND (a.expires_at IS NULL OR a.expires_at>?4))) LIMIT 1`)
    .bind(orgId, rootId, user.github_id, now).first();
  return existing ? { id: existing.id, created: false } : null;
}

function audienceRequestAccessSql({ requestId, org, root, user, now }) {
  return `EXISTS(SELECT 1 FROM hx_external_thread_audience_requests ar
    JOIN hx_external_thread_audiences a ON a.org_id=ar.org_id AND a.root_message_id=ar.root_message_id
      AND a.version=ar.audience_version
    JOIN memberships member ON member.org_id=a.org_id AND member.user_github_id=${user}
    WHERE ar.request_id=${requestId} AND ar.org_id=${org} AND ar.root_message_id=${root}
      AND ar.guest_github_id=${user} AND a.audience_type IS NOT NULL AND a.permission='view'
      AND (a.expires_at IS NULL OR a.expires_at>${now})
      AND (a.audience_type='workspace' OR (a.audience_type='room' AND EXISTS(
        SELECT 1 FROM conversation_members cm JOIN users roomUser ON roomUser.login=cm.login
        WHERE cm.org_id=a.org_id AND cm.channel=a.room_id AND roomUser.github_id=${user}))))`;
}

async function pendingRequests(env, orgId, rootId, owner) {
  return env.DB.prepare(`SELECT r.id, r.body, r.requested_at, u.name AS guest_name, u.email AS guest_email
    FROM hx_external_thread_send_requests r
    JOIN users u ON u.github_id = r.guest_github_id
    WHERE r.org_id=?1 AND r.root_message_id=?2 AND r.status='pending'
      AND ((NOT EXISTS(SELECT 1 FROM hx_external_thread_audience_requests mapped WHERE mapped.request_id=r.id)
        AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=r.org_id
        AND g.resource_type='thread' AND g.resource_id=r.root_message_id
        AND g.recipient_github_id=r.guest_github_id AND g.granted_by=?3
        AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?4)
        AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=r.org_id AND member.user_github_id=r.guest_github_id)))
        OR ${audienceRequestAccessSql({ requestId: 'r.id', org: 'r.org_id', root: 'r.root_message_id', user: 'r.guest_github_id', now: '?4' })})
    ORDER BY r.requested_at, r.id`).bind(orgId, rootId, owner.user.github_id, new Date().toISOString()).all();
}

async function decideRequest(env, orgId, rootId, id, owner, action, channel) {
  const now = new Date().toISOString();
  if (action === "reject") {
    const fence = threadManagerFence(orgId,rootId,owner.user,channel,6);
    const result = await env.DB.prepare(`UPDATE hx_external_thread_send_requests
       SET status='rejected', decided_at=?1, decided_by=?2
     WHERE org_id=?3 AND root_message_id=?4 AND id=?5 AND status='pending'
       AND ((NOT EXISTS(SELECT 1 FROM hx_external_thread_audience_requests mapped WHERE mapped.request_id=hx_external_thread_send_requests.id)
         AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=?3
         AND g.resource_type='thread' AND g.resource_id=?4 AND g.recipient_github_id=guest_github_id
         AND g.granted_by=?2 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?1)
         AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=?3 AND member.user_github_id=guest_github_id)))
         OR ${audienceRequestAccessSql({ requestId: 'hx_external_thread_send_requests.id', org: '?3', root: '?4', user: 'guest_github_id', now: '?1' })})
       AND ${fence.sql}`)
      .bind(now, owner.user.github_id, orgId, rootId, id, ...fence.bindings).run();
    return result.meta?.changes ? { rejected: true } : null;
  }

  const messageId = keyId();
  const insertFence = threadManagerFence(orgId,rootId,owner.user,channel,9);
  const updateFence = threadManagerFence(orgId,rootId,owner.user,channel,7);
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
         AND ((NOT EXISTS(SELECT 1 FROM hx_external_thread_audience_requests mapped WHERE mapped.request_id=r.id)
           AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=?2
           AND g.resource_type='thread' AND g.resource_id=?3 AND g.recipient_github_id=r.guest_github_id
           AND g.granted_by=?5 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?8)
           AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=?2 AND member.user_github_id=r.guest_github_id)))
           OR ${audienceRequestAccessSql({ requestId: 'r.id', org: '?2', root: '?3', user: 'r.guest_github_id', now: '?8' })})
         AND ${insertFence.sql}`)
      .bind(messageId, orgId, rootId, id, owner.user.github_id, owner.user.github_id, now, now,
        ...insertFence.bindings),
    env.DB.prepare(`UPDATE hx_external_thread_send_requests
        SET status='approved', decided_at=?1, decided_by=?2, message_id=?3
      WHERE org_id=?4 AND root_message_id=?5 AND id=?6 AND status='pending'
        AND EXISTS(SELECT 1 FROM channel_messages m WHERE m.org_id=?4 AND m.id=?3 AND m.parent_id=?5)
        AND ${updateFence.sql}`)
      .bind(now, owner.user.github_id, messageId, orgId, rootId, id,...updateFence.bindings),
  ]);
  return insert.meta?.changes && update.meta?.changes ? { approved: true, messageId } : null;
}

export async function handleExternalThreads(request, env, url, ctx = null) {
  if (url.pathname === "/external/collaborators/search") {
    if (request.method !== "GET") return fail("Method not allowed.", 405);
    const actor = await signedIn(request, env);
    if (!actor) return fail("Sign in to continue.", 401);
    return searchExternalCollaborators(request, env, url, actor);
  }
  if (url.pathname.startsWith("/external/files/")) return handleExternalFiles(request, env, url);
  if (url.pathname === "/external/invites/redeem" && request.method === "POST") {
    const limited = await enforce(env,request,"invites/peek");
    if (limited) return limited;
    const actor = await signedIn(request,env);
    if (!actor) return fail("Sign in to continue.",401);
    const input = await request.json().catch(() => ({}));
    const appRedeemed = await redeemExternalAppInvite(env, { token: input.token, userId: actor.user.github_id });
    if (!appRedeemed.error) return json(appRedeemed);
    const fileRedeemed = await redeemExternalFileInvite(env,{token:input.token,userId:actor.user.github_id});
    if (!fileRedeemed.error) return json(fileRedeemed);
    const redeemed = await redeemExternalThreadInvite(env,{token:input.token,userId:actor.user.github_id});
    if(!redeemed.error) return json(redeemed);
    const linked=await redeemExternalThreadLink(env,{token:input.token,userId:actor.user.github_id});
    return linked.error ? fail(linked.error,linked.status) : json(linked);
  }
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
  if (parts.length === 5 && parts[4] === "audience") return manageThreadAudience(request, env, orgId, rootId, actor);
  if (parts.length === 5 && parts[4] === "shares") return shareThread(request, env, orgId, rootId, actor);
  if (parts.length === 5 && parts[4] === "invites") return manageThreadInvites(request,env,orgId,rootId,actor);
  if (parts.length === 5 && parts[4] === "links") return manageThreadLinkShares(request,env,orgId,rootId,actor);
  if (parts.length === 6 && parts[4] === "links" && request.method === "DELETE") {
    let linkRef; try { linkRef=decodeURIComponent(parts[5]); } catch { return fail("Not found.",404); }
    return manageThreadLinkShares(request,env,orgId,rootId,actor,linkRef);
  }
  if (parts.length === 6 && parts[4] === "invites" && ["DELETE", "PATCH"].includes(request.method)) {
    let inviteRef;
    try { inviteRef = decodeURIComponent(parts[5]); } catch { return fail("Not found.",404); }
    return manageThreadInvites(request,env,orgId,rootId,actor,inviteRef);
  }
  const root = await rootFor(env.DB, orgId, rootId);
  if (!root) return fail("Thread not found.", 404);

  if (parts.length === 5 && parts[4] === "files" && request.method === "POST") {
    return uploadExternalAttachment(request, env, url, orgId, root, actor);
  }
  if (parts.length === 6 && parts[4] === "files") {
    let fileId;
    try { fileId = decodeURIComponent(parts[5]); } catch { return fail("Not found.", 404); }
    return readExternalAttachment(request, env, orgId, root, fileId, actor.user);
  }
  if (parts.length === 5 && parts[4] === "reactions" && request.method === "POST") {
    const input = await request.json().catch(() => null);
    return toggleExternalReaction(env, orgId, rootId, actor.user, input);
  }

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
    const decided = await decideRequest(env, orgId, rootId, input.requestId, actor, action, manageable.channel);
    if (decided?.approved) {
      const message = await getMessage(env.DB, orgId, decided.messageId);
      const requestRow = await env.DB.prepare(
        "SELECT guest_github_id FROM hx_external_thread_send_requests WHERE org_id=?1 AND root_message_id=?2 AND id=?3"
      ).bind(orgId, rootId, input.requestId).first();
      const guestUser = requestRow ? await getUserByGithubId(env.DB, requestRow.guest_github_id) : null;
      if (message && guestUser) deferExternalReply(ctx, env, { orgId, root, row: message, guest: { session: { github_id: guestUser.github_id }, user: guestUser } });
    }
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
    const permission = await externalThreadPermission(env.DB, { orgId, rootId, githubId: actor.user.github_id });
    if (!permission) return fail("Thread not found or access revoked.", 404);
    if (permission.permission !== "edit") return fail("Ask the Thread owner to approve a send request.", 403);
    const requestedFiles = input.files === undefined ? [] : input.files;
    if (!Array.isArray(requestedFiles) || requestedFiles.length > MAX_FILES_PER_MESSAGE) {
      return fail(`A message can carry at most ${MAX_FILES_PER_MESSAGE} files.`, 400);
    }
    const uploads = await sendable(env.DB, {
      orgId, key: root.channel, login: actor.user.login, ids: requestedFiles,
    });
    if (uploads.over) return fail(`A message can carry at most ${MAX_FILES_PER_MESSAGE} files.`, 400);
    const messageId = await insertReply(env, orgId, rootId, actor.user, body, uploads.ids);
    if (!messageId) return fail("Thread not found or access revoked.", 404);
    const message = await getMessage(env.DB, orgId, messageId);
    if (message) deferExternalReply(ctx, env, { orgId, root, row: message, guest: actor });
    return json({ messageId, sent: true }, 201);
  }
  return fail("Method not allowed.", 405);
}
