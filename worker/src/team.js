// Seeing a team, not only adding to it.
//
// Inviting someone was the whole of team management: there was no way to see
// who was in a workspace, no way to take anyone out of one, and no way to
// find or cancel a code you had already handed out. `/orgs/:owner/:repo/graph`
// answered the first question for a repository-backed org and needed a GitHub
// session to do it — so for everyone who signed in with an email address, in
// the `personal:` workspace they were given, it answered nothing at all.

import { ROLE_RANK, sha256Hex } from "./auth.js";

/// Whether an org's membership is ours to change.
///
/// A repository-backed org's members are its collaborators, and the org graph
/// re-derives them from GitHub on every load — `retainMemberships` deletes
/// anyone GitHub no longer lists. Removing a row here would be undone by the
/// next person to open the team, so it is refused with the reason rather than
/// appearing to work.
export function membershipIsOurs(orgId) {
  return !String(orgId).includes("/");
}

const rank = (role) => ROLE_RANK.get(String(role || "member").toLowerCase()) ?? 0;

/// A stable, non-secret name for an invite code.
///
/// A code is a credential, so it cannot be the handle used to talk about one
/// that is not yours to hold. This is derived rather than stored: there is no
/// column for it, and one more column on `invites` is a migration for a string
/// that can be computed.
export async function inviteRef(code) {
  return (await sha256Hex(String(code))).slice(0, 16);
}

/// Everyone in a workspace, in the order they arrived.
///
/// Deliberately available to any member: a team you cannot see is a team you
/// cannot reason about, and the router already routes to these people by name.
export async function listMembers(db, orgId, viewerId) {
  const { results } = await db
    .prepare(
      `SELECT m.user_github_id                              AS userId,
              COALESCE(u.login, m.user_github_id)           AS login,
              COALESCE(u.name, u.login, m.user_github_id)   AS name,
              m.role                                        AS role,
              m.title                                       AS title,
              m.created_at                                  AS joinedAt
         FROM memberships m
         LEFT JOIN users u ON u.github_id = m.user_github_id
        WHERE m.org_id = ?1
        ORDER BY m.created_at ASC, m.user_github_id ASC`
    )
    .bind(orgId)
    .all();
  return (results || []).map((r) => ({
    userId: String(r.userId),
    login: r.login,
    name: r.name,
    role: String(r.role || "member").toLowerCase(),
    // What they say they do, when that differs from the standing they hold.
    title: r.title || null,
    joinedAt: r.joinedAt,
    mine: String(r.userId) === String(viewerId),
  }));
}

/// Take someone out of a workspace, or leave it yourself.
///
/// Standing decides: you may remove anyone ranked below you, and you may
/// always let yourself out. Rank alone is what stops a plain member removing
/// another plain member — 0 is not greater than 0 — without a second rule
/// saying so.
export async function removeMember(env, { orgId, actorId, targetId }) {
  if (!orgId || !targetId) return { error: "Missing team or person.", status: 400 };
  if (!membershipIsOurs(orgId)) {
    return {
      error: "This workspace's members come from a GitHub repository. Change who can push to it there.",
      status: 400,
    };
  }
  const members = await listMembers(env.DB, orgId, actorId);
  const actor = members.find((m) => m.userId === String(actorId));
  if (!actor) return { error: "You are not a member of this organization.", status: 403 };
  const target = members.find((m) => m.userId === String(targetId));
  // The same answer for "no such person" and "already gone": the caller wanted
  // them out of the org and they are.
  if (!target) return { error: "That person is not in this workspace.", status: 404 };

  const leaving = target.userId === actor.userId;
  if (leaving) {
    // An org with nobody in it is a row nothing can ever reach again — its
    // cards included. Somebody has to be able to let the next person in.
    if (members.length === 1) {
      return { error: "You are the only person here, so there is nothing to leave.", status: 400 };
    }
  } else if (rank(actor.role) <= rank(target.role)) {
    return { error: "You cannot remove someone at or above your own role.", status: 403 };
  }

  await env.DB
    .prepare("DELETE FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(orgId, String(targetId))
    .run();
  // Their decisions stay. What was decided is the organization's record, not
  // the decider's belongings — account deletion draws the same line.
  //
  // `login` travels back because the relay stamps that on a socket, and the
  // caller has to close the one they are holding: the row is gone, but nothing
  // re-reads it for a connection that is already open.
  return { ok: true, removed: target.userId, login: target.login, left: leaving };
}

/// The codes this workspace has out, and which of them you may read.
///
/// A code is a credential, and one minted at a role above yours is a promotion
/// you could not otherwise grant — so it is listed by reference, not in full.
/// A code at or below your own role you could mint yourself, so showing it
/// hands you nothing you did not already have.
export async function listInvites(env, { orgId, viewerId }) {
  const now = new Date().toISOString();
  const { results } = await env.DB
    .prepare(
      `SELECT i.code, i.role, i.created_by, i.created_at, i.expires_at, i.max_uses, i.uses,
              COALESCE(u.name, u.login, i.created_by) AS creator
         FROM invites i
         LEFT JOIN users u ON u.github_id = i.created_by
        WHERE i.org_id = ?1 AND i.uses < i.max_uses AND (i.expires_at IS NULL OR i.expires_at > ?2)
        ORDER BY i.created_at DESC`
    )
    .bind(orgId, now)
    .all();

  const viewer = await env.DB
    .prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(orgId, String(viewerId))
    .first();
  const viewerRank = rank(viewer?.role);

  return Promise.all(
    (results || []).map(async (r) => {
      const mine = String(r.created_by) === String(viewerId);
      const readable = mine || rank(r.role) <= viewerRank;
      return {
        ref: await inviteRef(r.code),
        code: readable ? r.code : null,
        role: String(r.role || "member").toLowerCase(),
        creator: r.creator,
        mine,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        uses: Number(r.uses || 0),
        maxUses: Number(r.max_uses || 1),
      };
    })
  );
}

/// Cancel a code. By `code` when you are holding one, by `ref` when you are
/// looking at a list.
///
/// Yours always. Somebody else's needs standing — at or above what the code
/// grants, and enough to be administering the team at all — or a member could
/// quietly close the door on everyone their colleagues had invited.
export async function revokeInvite(env, { orgId, viewerId, code, ref }) {
  if (!orgId) return { error: "Missing team.", status: 400 };
  const all = await env.DB
    .prepare("SELECT code, role, created_by FROM invites WHERE org_id = ?1")
    .bind(orgId)
    .all();
  let row = null;
  for (const candidate of all?.results || []) {
    if (code && candidate.code === String(code).trim()) { row = candidate; break; }
    if (ref && (await inviteRef(candidate.code)) === String(ref).trim()) { row = candidate; break; }
  }
  if (!row) return { error: "That invite code is not valid.", status: 404 };

  const viewer = await env.DB
    .prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(orgId, String(viewerId))
    .first();
  const mine = String(row.created_by) === String(viewerId);
  const viewerRank = rank(viewer?.role);
  if (!mine && !(viewerRank >= rank(row.role) && viewerRank >= 1)) {
    return { error: "That invite is not yours to cancel.", status: 403 };
  }

  await env.DB
    .prepare("DELETE FROM invites WHERE org_id = ?1 AND code = ?2")
    .bind(orgId, row.code)
    .run();
  return { ok: true };
}
