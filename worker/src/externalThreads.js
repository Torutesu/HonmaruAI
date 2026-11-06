import { getSession, getUserByGithubId, isMember } from "./db.js";
import { handleExternalFiles } from "./externalFiles.js";
import { getMode } from "./harness/mode.js";
import { resolveChannel, asksTheAI, getMessage, cleanEmoji } from "./channels.js";
import { byteRange, deleteFileObject, getFileObject, MAX_FILES_PER_MESSAGE, sendable, UNSATISFIABLE, uploadFile } from "./files.js";
import { audienceOf } from "./access.js";
import { listMembers } from "./team.js";
import { answerAsAI, broadcastStored } from "./channelRoutes.js";
import { sha256Hex } from "./auth.js";
import { enforce } from "./ratelimit.js";
import {
  externalResourcePermission,
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

// Recheck the exact authority that manageableRoot() checks inside each
// mutation. The initial route check provides a safe response shape; this SQL
// fence prevents a concurrent membership, role, Room, Agent, or root change
// from leaving a grant or approval behind after that check.
function threadManagerFence(orgId, rootId, user, firstParameter) {
  const p = (offset) => `?${firstParameter + offset}`;
  const org = p(0), rootIdParam = p(1), userId = p(2), login = p(3);
  return {
    sql: `EXISTS (
      SELECT 1 FROM channel_messages managedRoot
      JOIN memberships managerMembership ON managerMembership.org_id=managedRoot.org_id
        AND managerMembership.user_github_id=${userId}
      WHERE managedRoot.org_id=${org} AND managedRoot.id=${rootIdParam}
        AND managedRoot.parent_id IS NULL AND managedRoot.deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM hx_room_access tombstone
          WHERE tombstone.org_id=managedRoot.org_id AND tombstone.channel=managedRoot.channel
            AND tombstone.deleted_at IS NOT NULL)
        AND (managedRoot.author_login=${login} OR LOWER(COALESCE(managerMembership.role,'')) IN ('owner','admin'))
        AND (
          (managedRoot.channel LIKE 'b:%' AND (
            (LOWER(COALESCE(managerMembership.role,''))!='guest' AND COALESCE((
              SELECT business.private FROM businesses business
              WHERE business.org_id=managedRoot.org_id AND managedRoot.channel='b:'||business.slug
            ),0)=0)
            OR EXISTS(SELECT 1 FROM conversation_members roomMember
              JOIN users roomUser ON roomUser.login=roomMember.login
              WHERE roomMember.org_id=managedRoot.org_id AND roomMember.channel=managedRoot.channel
                AND roomUser.github_id=${userId})
          ))
          OR (managedRoot.channel LIKE 'g:%' AND EXISTS(SELECT 1 FROM conversation_members roomMember
            JOIN users roomUser ON roomUser.login=roomMember.login
            WHERE roomMember.org_id=managedRoot.org_id AND roomMember.channel=managedRoot.channel
              AND roomUser.github_id=${userId}))
          OR (managedRoot.channel LIKE 'dm:%' AND instr('|'||substr(managedRoot.channel,4)||'|','|'||${login}||'|')>0)
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
                      AND LOWER(COALESCE(activeMember.role,'guest'))!='guest'
                    WHERE agentMember.org_id=agent.org_id AND agentMember.agent_id=agent.id
                      AND agentMember.user_id=${userId} AND agentMember.role IN ('admin','member')))
            )))
        )
    )`,
    bindings: [orgId, rootId, user.github_id, user.login],
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
    const recipient = await resolveRecipient(env.DB, orgId, input.email, actor.user.github_id);
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
      const updateFence = threadManagerFence(orgId, rootId, actor.user, 6);
      const insertFence = threadManagerFence(orgId, rootId, actor.user, 9);
      const [revoked, inserted] = await env.DB.batch([
        env.DB.prepare(`UPDATE hx_external_resource_grants SET revoked_at=?1,revoked_by=?2
          WHERE org_id=?3 AND resource_type='thread' AND resource_id=?4
            AND recipient_github_id=?5 AND revoked_at IS NULL AND ${updateFence.sql}`)
          .bind(now, actor.user.github_id, orgId, rootId, recipient.github_id,
            ...updateFence.bindings),
        env.DB.prepare(`INSERT INTO hx_external_resource_grants
          (id,org_id,resource_type,resource_id,recipient_github_id,permission,granted_by,granted_at,expires_at)
          SELECT ?1,?2,'thread',?3,?4,?5,?6,?7,?8 WHERE ${insertFence.sql}`)
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
    const fence = threadManagerFence(orgId, rootId, actor.user, 6);
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE hx_external_resource_grants SET revoked_at=?1,revoked_by=?2
        WHERE id=?3 AND org_id=?4 AND resource_type='thread' AND resource_id=?5
          AND revoked_at IS NULL AND ${fence.sql}`)
        .bind(now,actor.user.github_id,input.grantId,orgId,rootId,...fence.bindings),
      env.DB.prepare(`UPDATE hx_external_thread_send_requests SET status='cancelled',decided_at=?1,decided_by=?2
        WHERE org_id=?3 AND root_message_id=?4 AND status='pending'
          AND guest_github_id=(SELECT recipient_github_id FROM hx_external_resource_grants WHERE id=?5)
          AND EXISTS(SELECT 1 FROM hx_external_resource_grants changed WHERE changed.id=?5
            AND changed.revoked_at=?1 AND changed.revoked_by=?2)
          AND ${threadManagerFence(orgId,rootId,actor.user,6).sql}`)
        .bind(now,actor.user.github_id,orgId,rootId,input.grantId,...fence.bindings),
    ]);
    revoked = Number(results?.[0]?.meta?.changes || 0);
  } else {
    const recipient = await resolveRecipient(env.DB, orgId, input.email, actor.user.github_id);
    if (!recipient) return fail("Recipient not found.", 404);
    const fence = threadManagerFence(orgId,rootId,actor.user,6);
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
          AND ${threadManagerFence(orgId,rootId,actor.user,6).sql}`)
        .bind(now,actor.user.github_id,orgId,rootId,recipient.github_id,
          ...threadManagerFence(orgId,rootId,actor.user,6).bindings),
    ]);
    revoked = Number(results?.[0]?.meta?.changes || 0);
  }
  return json({ revoked: revoked > 0 });
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
  if (inviteRef && request.method !== "DELETE") return fail("Method not allowed.", 405);
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
      const fence = threadManagerFence(orgId,rootId,actor.user,11);
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
    // No account lookup or email is sent here. The inviter shares this one-time
    // URL with the named address; redemption proves the address through OTP.
    const inviteUrl = externalInviteLink(env, code);
    return json({ invited: true, invitationId: id, inviteUrl, ...(!inviteUrl ? { token: code } : {}), expiresAt }, 201);
  }
  if (inviteRef && request.method === "DELETE") {
    const now = new Date().toISOString();
    // Fence redemption and revoke its exact grant in one D1 batch transaction.
    // Whichever transaction wins, the invite cannot be left revoked with a
    // live grant: a later redemption sees revoked_at; an earlier one exposes
    // created_grant_id to the following statement in this same batch.
    const fence = threadManagerFence(orgId,rootId,actor.user,6);
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
          AND status='pending' AND ${threadManagerFence(orgId,rootId,actor.user,6).sql}`)
        .bind(now,actor.user.github_id,orgId,rootId,inviteRef,...fence.bindings),
    ]);
    return json({ revoked: Number(results?.[0]?.meta?.changes || 0) > 0 });
  }
  return fail("Method not allowed.", 405);
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
  const member = await isMember(env.DB,invite.org_id,String(userId));
  const redemptionId = `xtr_${crypto.randomUUID().replaceAll("-", "")}`;
  const grantId = `xg_${crypto.randomUUID().replaceAll("-", "")}`;
  const claim = env.DB.prepare(`UPDATE hx_external_thread_invites
      SET redeemed_at=?1,redeemed_by=?2,redemption_id=?3
    WHERE id=?4 AND token_hash=?5 AND redeemed_at IS NULL AND revoked_at IS NULL
      AND expires_at>?1 AND (access_expires_at IS NULL OR access_expires_at>?1)
      AND invited_email=?6
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
  if (member) {
    const result = await claim.run();
    return result.meta?.changes ? { redeemed: true, alreadyMember: true, orgId: invite.org_id } : deny;
  }
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
  return { redeemed: true, alreadyMember: true, orgId: invite.org_id };
}

async function uploadExternalAttachment(request, env, url, orgId, root, actor) {
  const permission = await externalResourcePermission(env.DB, {
    orgId, resourceType: "thread", resourceId: root.id, githubId: actor.user.github_id,
  });
  if (!permission) return fail("Thread not found or access revoked.", 404);
  if (permission !== "edit") return fail("An edit grant is required to upload a Thread attachment.", 403);
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
  const currentPermission = currentRoot && await externalResourcePermission(env.DB, {
    orgId, resourceType: "thread", resourceId: root.id, githubId: actor.user.github_id,
  });
  if (!currentRoot || currentRoot.channel !== root.channel || currentPermission !== "edit") {
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
      AND EXISTS(SELECT 1 FROM hx_external_resource_grants g
        WHERE g.org_id=?1 AND g.resource_type='thread' AND g.resource_id=?2
          AND g.recipient_github_id=?4 AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at>?5))
      AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=?1 AND member.user_github_id=?4)`)
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
      AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=?1
        AND g.resource_type='thread' AND g.resource_id=?2 AND g.recipient_github_id=?4
        AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?5))
      AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=?1 AND member.user_github_id=?4)
    GROUP BY r.message_id, r.emoji ORDER BY r.emoji`)
    .bind(orgId, rootId, user.login, user.github_id, new Date().toISOString()).all();
  return results;
}

async function toggleExternalReaction(env, orgId, rootId, user, input) {
  if (!input || typeof input.messageId !== "string") return fail("messageId is required.", 400);
  const emoji = cleanEmoji(input.emoji);
  if (!emoji) return fail("That is not an emoji.", 400);
  const now = new Date().toISOString();
  const target = await env.DB.prepare(`SELECT m.id FROM channel_messages m
    JOIN channel_messages root ON root.org_id=m.org_id AND root.id=?2
      AND root.parent_id IS NULL AND root.deleted_at IS NULL AND root.channel=m.channel
    WHERE m.org_id=?1 AND m.id=?3 AND (m.id=root.id OR m.parent_id=root.id) AND m.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM hx_room_access tombstone WHERE tombstone.org_id=root.org_id
        AND tombstone.channel=root.channel AND tombstone.deleted_at IS NOT NULL)
      AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=?1
        AND g.resource_type='thread' AND g.resource_id=?2 AND g.recipient_github_id=?4
        AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?5))
      AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=?1 AND member.user_github_id=?4)`)
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
        AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=?1
          AND g.resource_type='thread' AND g.resource_id=?5 AND g.recipient_github_id=?6
          AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?7))
        AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=?1 AND member.user_github_id=?6)`)
      .bind(orgId, target.id, emoji, user.login, rootId, user.github_id, now).run();
  } else {
    await env.DB.prepare(`INSERT INTO message_reactions (org_id,message_id,emoji,login,created_at)
      SELECT ?1,?2,?3,?4,?7
      WHERE EXISTS(SELECT 1 FROM channel_messages m JOIN channel_messages root
        ON root.org_id=m.org_id AND root.id=?5 AND root.parent_id IS NULL
          AND root.deleted_at IS NULL AND root.channel=m.channel
        WHERE m.org_id=?1 AND m.id=?2 AND (m.id=root.id OR m.parent_id=root.id) AND m.deleted_at IS NULL)
        AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=?1
          AND g.resource_type='thread' AND g.resource_id=?5 AND g.recipient_github_id=?6
          AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?7))
        AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=?1 AND member.user_github_id=?6)
        AND (EXISTS(SELECT 1 FROM message_reactions WHERE message_id=?2 AND emoji=?3)
          OR (SELECT COUNT(DISTINCT emoji) FROM message_reactions WHERE message_id=?2)<20)
      ON CONFLICT DO NOTHING`)
      .bind(orgId, target.id, emoji, user.login, rootId, user.github_id, now).run();
  }
  const permission = await externalResourcePermission(env.DB, {
    orgId, resourceType: "thread", resourceId: rootId, githubId: user.github_id,
  });
  if (!permission) return fail("Thread not found or access revoked.", 404);
  const reactions = await reactionRows(env, orgId, rootId, user, [target.id]);
  return json({ messageId: target.id, reactions: reactions.map(({ emoji: name, count, mine }) => ({
    emoji: name, count: Number(count), mine: Boolean(mine),
  })) });
}

async function readThread(env, orgId, rootId, user) {
  const now = new Date().toISOString();
  // The message query proves the exact active grant and never traverses the
  // containing Room. Attachment/reaction queries repeat the ACL condition.
  const { results = [] } = await env.DB.prepare(`SELECT m.id, m.kind, m.body, m.author_login, m.created_at, m.edited_at,
      m.parent_id, u.name AS author_name, a.name AS agent_name, g.permission
    FROM channel_messages m
    JOIN hx_external_resource_grants g
      ON g.org_id=m.org_id AND g.resource_type='thread' AND g.resource_id=?3
     AND g.recipient_github_id=?4 AND g.revoked_at IS NULL
     AND (g.expires_at IS NULL OR g.expires_at>?5)
     AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=m.org_id AND member.user_github_id=g.recipient_github_id)
    JOIN channel_messages root ON root.org_id=m.org_id AND root.id=?3
      AND root.parent_id IS NULL AND root.deleted_at IS NULL AND root.channel=m.channel
    LEFT JOIN users u ON u.login=m.author_login
    LEFT JOIN custom_agents a ON 'agent:' || a.id=m.author_login AND a.org_id=m.org_id
    WHERE m.org_id=?2 AND (m.id=?3 OR m.parent_id=?3) AND m.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM hx_room_access tombstone
        WHERE tombstone.org_id=root.org_id AND tombstone.channel=root.channel AND tombstone.deleted_at IS NOT NULL)
    ORDER BY m.created_at,m.rowid`)
    .bind(orgId, orgId, rootId, user.github_id, now).all();
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
      AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=?1
        AND g.resource_type='thread' AND g.resource_id=?2 AND g.recipient_github_id=?3
        AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?4))
      AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=?1 AND member.user_github_id=?3)
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
  const currentPermission = currentRoot && await externalResourcePermission(env.DB, {
    orgId, resourceType: "thread", resourceId: rootId, githubId: user.github_id,
  });
  if (!currentRoot || !["view", "edit"].includes(currentPermission)) return null;
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
  if (!await externalResourcePermission(env.DB, {
    orgId, resourceType: "thread", resourceId: root.id, githubId: guest.user.github_id,
  })) return;

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
       AND ${activeGrantSql} AND EXISTS(
         SELECT 1 FROM hx_external_resource_grants g
          WHERE g.org_id=?2 AND g.resource_type='thread' AND g.resource_id=?3
            AND g.recipient_github_id=?4 AND g.revoked_at IS NULL AND g.permission='edit'
            AND (g.expires_at IS NULL OR g.expires_at>?5))`)
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
      AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=?2
        AND g.resource_type='thread' AND g.resource_id=?3 AND g.recipient_github_id=?4
        AND g.permission='edit' AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?5))
      AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=?2 AND member.user_github_id=?4)`)
    .bind(id, orgId, rootId, user.github_id, now, (await rootFor(env.DB, orgId, rootId))?.channel || "", user.login, ...fileIds);
  const [put] = await env.DB.batch([insert, claim]);
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
    const fence = threadManagerFence(orgId,rootId,owner.user,6);
    const result = await env.DB.prepare(`UPDATE hx_external_thread_send_requests
       SET status='rejected', decided_at=?1, decided_by=?2
     WHERE org_id=?3 AND root_message_id=?4 AND id=?5 AND status='pending'
       AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.org_id=?3
         AND g.resource_type='thread' AND g.resource_id=?4 AND g.recipient_github_id=guest_github_id
         AND g.granted_by=?2 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?1)
         AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=?3 AND member.user_github_id=guest_github_id))
       AND ${fence.sql}`)
      .bind(now, owner.user.github_id, orgId, rootId, id, ...fence.bindings).run();
    return result.meta?.changes ? { rejected: true } : null;
  }

  const messageId = keyId();
  const insertFence = threadManagerFence(orgId,rootId,owner.user,9);
  const updateFence = threadManagerFence(orgId,rootId,owner.user,7);
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
           AND NOT EXISTS(SELECT 1 FROM memberships member WHERE member.org_id=?2 AND member.user_github_id=r.guest_github_id))
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
  if (url.pathname.startsWith("/external/files/")) return handleExternalFiles(request, env, url);
  if (url.pathname === "/external/invites/redeem" && request.method === "POST") {
    const limited = await enforce(env,request,"invites/peek");
    if (limited) return limited;
    const actor = await signedIn(request,env);
    if (!actor) return fail("Sign in to continue.",401);
    const input = await request.json().catch(() => ({}));
    const redeemed = await redeemExternalThreadInvite(env,{token:input.token,userId:actor.user.github_id});
    return redeemed.error ? fail(redeemed.error,redeemed.status) : json(redeemed);
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
  if (parts.length === 5 && parts[4] === "shares") return shareThread(request, env, orgId, rootId, actor);
  if (parts.length === 5 && parts[4] === "invites") return manageThreadInvites(request,env,orgId,rootId,actor);
  if (parts.length === 6 && parts[4] === "invites" && request.method === "DELETE") {
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
    const decided = await decideRequest(env, orgId, rootId, input.requestId, actor, action);
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
    const permission = await externalResourcePermission(env.DB, {
      orgId, resourceType: "thread", resourceId: rootId, githubId: actor.user.github_id,
    });
    if (!permission) return fail("Thread not found or access revoked.", 404);
    if (permission !== "edit") return fail("Ask the Thread owner to approve a send request.", 403);
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
