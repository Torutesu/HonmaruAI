// Seeing a team, not only adding to it.
//
// Inviting someone was the whole of team management: there was no way to see
// who was in a workspace, no way to take anyone out of one, and no way to
// find or cancel a code you had already handed out. `/orgs/:owner/:repo/graph`
// answered the first question for a repository-backed org and needed a GitHub
// session to do it — so for everyone who signed in with an email address, in
// the `personal:` workspace they were given, it answered nothing at all.

import { ROLE_RANK, sha256Hex } from "./auth.js";
import { saveCard, removeCard, getUserByLogin } from "./db.js";
import { appendCardEvent } from "./events.js";
import { announceCards } from "./announce.js";
import { notifyCard } from "./notify.js";
import { cardText } from "./cardCopy.js";

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
/// that is not yours to hold.
export async function inviteRef(code) {
  return (await sha256Hex(String(code))).slice(0, 16);
}

/// A stable, non-secret name for a member of one workspace.
///
/// The obvious handle is the login, and the login is `u:<their email address>`
/// for every account that signed in with one — `user_github_id` is
/// `email:<the same address>`. A member list is read by everybody on the team,
/// so naming people by the address they sign in with puts it in every one of
/// their browsers to serve a Remove button.
///
/// Scoped to the org so the same person carries a different handle in each
/// workspace, and one list cannot be used to recognise them in another.
///
/// This is defence in depth and not a fix for the whole problem: a card's
/// `recipientUserID` *is* the login, and the relay broadcasts cards to the
/// org, so the address still reaches the browser of anyone you exchange one
/// with. Changing that means changing the routing key.
export function memberRef(orgId, userId) {
  return sha256Hex(`${orgId}\u0000${userId}`).then((hex) => hex.slice(0, 16));
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
  return Promise.all(
    (results || []).map(async (r) => ({
      userId: String(r.userId),
      login: r.login,
      // The handle a client may hold. Everything a screen needs — show `name`,
      // remove by `ref` — and nothing that names an inbox.
      ref: await memberRef(orgId, String(r.userId)),
      name: r.name,
      role: String(r.role || "member").toLowerCase(),
      // What they say they do, when that differs from the standing they hold.
      title: r.title || null,
      joinedAt: r.joinedAt,
      mine: String(r.userId) === String(viewerId),
    }))
  );
}

/// The member list as a client may see it: no `userId`, no `login`.
///
/// `listMembers` keeps both because the server routes and evicts by them. This
/// is the same list with the two fields that are somebody's email address
/// taken off it.
export async function listMembersForClient(db, orgId, viewerId) {
  const members = await listMembers(db, orgId, viewerId);
  return members.map(({ userId, login, ...shown }) => shown);
}

/// Take someone out of a workspace, or leave it yourself.
///
/// Standing decides: you may remove anyone ranked below you, and you may
/// always let yourself out. Rank alone is what stops a plain member removing
/// another plain member — 0 is not greater than 0 — without a second rule
/// saying so.
export async function removeMember(env, { orgId, actorId, targetId, ref }) {
  targetId = targetId || ref;
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
  // By ref, which is what a client was given, or by id, which is what the
  // server itself holds. Both name one row; only one of them is an address.
  const target = members.find((m) => m.userId === String(targetId) || m.ref === String(targetId));
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
    .bind(orgId, target.userId)
    .run();
  // After the row is gone, never before: what comes next asks who is still
  // here, and the answer has to have stopped including them.
  const orphans = await returnOrphanedCards(env, orgId, target.login);
  // Their decisions stay. What was decided is the organization's record, not
  // the decider's belongings — account deletion draws the same line.
  //
  // `login` travels back because the relay stamps that on a socket, and the
  // caller has to close the one they are holding: the row is gone, but nothing
  // re-reads it for a connection that is already open.
  return { ok: true, removed: target.userId, login: target.login, left: leaving, ...orphans };
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
              i.ref,
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
      // A code minted before the column existed has no ref stored. Derive it
      // and write it back, so the set that needs the fallback only shrinks.
      let ref = r.ref;
      if (!ref) {
        ref = await inviteRef(r.code);
        await env.DB.prepare("UPDATE invites SET ref = ?1 WHERE code = ?2").bind(ref, r.code).run();
      }
      return {
        ref,
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
  // One indexed lookup. This used to read every invite in the workspace and
  // hash each one until a ref matched — a scan and a SHA per row, for a value
  // the mint already knew.
  let row = null;
  if (code) {
    row = await env.DB
      .prepare("SELECT code, role, created_by FROM invites WHERE org_id = ?1 AND code = ?2")
      .bind(orgId, String(code).trim())
      .first();
  }
  if (!row && ref) {
    row = await env.DB
      .prepare("SELECT code, role, created_by FROM invites WHERE org_id = ?1 AND ref = ?2")
      .bind(orgId, String(ref).trim())
      .first();
    // A code minted before `ref` was stored has none to match on. Listing the
    // team writes them back, so this is the window between the deploy and the
    // first person opening that screen, not a permanent second path.
    if (!row) {
      const { results } = await env.DB
        .prepare("SELECT code, role, created_by FROM invites WHERE org_id = ?1 AND ref IS NULL")
        .bind(orgId)
        .all();
      for (const candidate of results || []) {
        if ((await inviteRef(candidate.code)) === String(ref).trim()) { row = candidate; break; }
      }
    }
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


/// Pending decisions the person leaving was the only one who could make.
///
/// A card is a request from one person to another. When the person it was for
/// walks out of the workspace, nothing else in this product can move it: only
/// the recipient may decide, so it sits in a feed nobody opens, and the sender
/// is never told the answer is not coming.
///
/// So it goes back where it came from. The sender asked the question and is
/// the one who can ask it again of somebody else — that is a decision for a
/// person, not for this function, which is why the card returns as `pending`
/// rather than being closed on their behalf.
///
/// When the sender is gone too — or was the person leaving — there is nobody
/// left to hand it to, and it is removed. The snapshot stays in `card_events`,
/// because a decision that was pending is still something the organization
/// asked for.
export async function returnOrphanedCards(env, orgId, login) {
  if (!login) return { returned: 0, dropped: 0 };
  const { results } = await env.DB
    .prepare("SELECT data FROM cards WHERE org_id = ?1 AND recipient_user_id = ?2 AND status = 'pending'")
    .bind(orgId, login)
    .all();
  const cards = (results || [])
    .map((row) => { try { return JSON.parse(row.data); } catch { return null; } })
    .filter(Boolean);
  if (!cards.length) return { returned: 0, dropped: 0 };

  const here = new Set((await listMembers(env.DB, orgId, null)).map((m) => m.login));
  // What to call the person who left. Their stored display name, because that
  // is what everyone on this team has been reading on every card they sent —
  // the login is an id, and for an email account it is the whole address.
  const leaver = await getUserByLogin(env.DB, login);
  const leaverName = leaver?.name || displayName(login);
  const returned = [];
  let dropped = 0;

  for (const card of cards) {
    const sender = card.senderUserID;
    if (sender && sender !== login && here.has(sender)) {
      // In the language the sender reads, like every other sentence this
      // product writes for somebody. A card coming back explains itself or it
      // is just a decision that mysteriously moved.
      const reader = await getUserByLogin(env.DB, sender);
      const said = cardText(reader?.locale, "{name} has left this workspace, so this came back to you.", {
        name: leaverName,
      });
      card.recipientUserID = sender;
      card.context = [card.context, said].filter(Boolean).join("\n");
      card.returnedFrom = login;
      await saveCard(env.DB, orgId, card);
      await appendCardEvent(env.DB, orgId, {
        cardId: card.id, type: "returned", actorUserId: login, note: said, snapshot: card,
      });
      returned.push(card);
    } else {
      await appendCardEvent(env.DB, orgId, {
        cardId: card.id, type: "deleted", actorUserId: login, snapshot: card,
      });
      await removeCard(env.DB, orgId, card.id);
      dropped += 1;
    }
  }

  if (returned.length) {
    // The cards were written straight to D1, so the sockets in the Durable
    // Object know nothing about it — the same reason a connector sync
    // announces what it produced.
    await announceCards(env, orgId, returned);
    for (const card of returned) {
      await notifyCard(env, { card, kind: "created", excludeLogin: login }).catch(() => {});
    }
  }
  return { returned: returned.length, dropped };
}

/// The name a card should call somebody, from the id the relay routes by.
///
/// An account id carries a prefix and, for an email account, the whole
/// address. The clients each strip it for display; a sentence written on the
/// server has to do the same or the address is what lands on the card.
function displayName(login) {
  return String(login || "").replace(/^(u:|email:)/, "").split("@")[0];
}
