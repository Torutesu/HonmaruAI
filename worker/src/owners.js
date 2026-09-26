// Handing a workspace on: an owner offers it, the person named accepts.
//
// docs/admin-controls.md §4.4. Nobody is made to hold a workspace they did
// not agree to hold, so a transfer is an offer until its recipient says yes.
// The one who offered chooses whether they stay an owner or step down to
// admin once it is accepted. Everything to do with owners is critical in the
// audit log, and every owner hears about it by email.

import { getSession, isMember, getUserByGithubId } from "./db.js";
import { audit, person } from "./audit.js";
import { listMembers } from "./team.js";
import { roleIn, ownersOf } from "./permissions.js";
import { sendMail, isMailConfigured } from "./mailer.js";

const OFFER_DAYS = 7;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, x-session-token, x-ai-key",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    },
  });
}

/// Tell every owner of a workspace that something about its owners changed.
/// Best effort: a mail that fails is logged by the mailer, never a failure.
export async function mailOwners(env, orgId, { subject, text }) {
  if (!isMailConfigured(env)) return 0;
  let sent = 0;
  for (const id of await ownersOf(env.DB, orgId)) {
    const user = await getUserByGithubId(env.DB, id).catch(() => null);
    if (!user?.email) continue;
    const out = await sendMail(env, { to: user.email, subject, text }).catch(() => null);
    if (out?.ok) sent += 1;
  }
  return sent;
}

async function workspaceName(db, orgId) {
  const row = await db.prepare("SELECT name FROM orgs WHERE id = ?1").bind(orgId).first().catch(() => null);
  return row?.name || "your workspace";
}

/// The offer standing in a workspace, as the viewer may see it, or null.
export async function transferFor(db, orgId, viewerId) {
  const row = await db
    .prepare("SELECT * FROM owner_transfers WHERE org_id = ?1 AND expires_at > ?2")
    .bind(orgId, new Date().toISOString())
    .first()
    .catch(() => null);
  if (!row) return null;
  const members = await listMembers(db, orgId, viewerId);
  const from = members.find((m) => m.userId === String(row.from_github_id));
  const to = members.find((m) => m.userId === String(row.to_github_id));
  if (!from || !to) return null;
  const mine = String(viewerId) === String(row.to_github_id) ? "to" : String(viewerId) === String(row.from_github_id) ? "from" : null;
  return {
    from: { name: from.name, ref: from.ref },
    to: { name: to.name, ref: to.ref },
    stepDown: Boolean(row.step_down),
    expiresAt: row.expires_at,
    mine,
  };
}

/// An owner offers the workspace to someone in it.
export async function offerTransfer(env, { orgId, actorId, ref, stepDown }) {
  if (!orgId || !ref) return { error: "Missing team or person.", status: 400 };
  if (String(orgId).includes("/")) return { error: "This workspace's owners come from a GitHub repository.", status: 400 };
  if ((await roleIn(env.DB, orgId, actorId)) !== "owner") return { error: "Only an owner can hand the workspace on.", status: 403 };
  const members = await listMembers(env.DB, orgId, actorId);
  const target = members.find((m) => m.ref === String(ref));
  if (!target) return { error: "That person is not in this workspace.", status: 404 };
  if (target.userId === String(actorId)) return { error: "You already own it.", status: 400 };
  if (target.role === "owner") return { error: "They are already an owner.", status: 400 };
  if (target.role === "guest") return { error: "A guest cannot own the workspace. Make them a member first.", status: 400 };
  const now = new Date();
  const expires = new Date(now.getTime() + OFFER_DAYS * 86_400_000).toISOString();
  // One offer at a time: a new one replaces whatever was standing.
  await env.DB
    .prepare(
      `INSERT INTO owner_transfers (org_id, from_github_id, to_github_id, step_down, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(org_id) DO UPDATE SET from_github_id = excluded.from_github_id, to_github_id = excluded.to_github_id,
         step_down = excluded.step_down, created_at = excluded.created_at, expires_at = excluded.expires_at`
    )
    .bind(orgId, String(actorId), target.userId, stepDown ? 1 : 0, now.toISOString(), expires)
    .run();
  return { ok: true, target, expiresAt: expires };
}

/// The person offered the workspace says yes: they become an owner, and the
/// one who offered steps down if they chose to.
export async function acceptTransfer(env, { orgId, userId }) {
  const row = await env.DB
    .prepare("SELECT * FROM owner_transfers WHERE org_id = ?1 AND expires_at > ?2")
    .bind(orgId, new Date().toISOString())
    .first();
  if (!row || String(row.to_github_id) !== String(userId)) return { error: "There is no offer for you to accept.", status: 404 };
  if (!(await isMember(env.DB, orgId, userId))) return { error: "You are not a member of this organization.", status: 403 };
  const fromRole = await roleIn(env.DB, orgId, row.from_github_id);
  // The one who offered has to still be an owner for it to be theirs to give.
  if (fromRole !== "owner") {
    await env.DB.prepare("DELETE FROM owner_transfers WHERE org_id = ?1").bind(orgId).run();
    return { error: "Whoever offered it is no longer an owner, so the offer lapsed.", status: 409 };
  }
  const steps = [env.DB.prepare("UPDATE memberships SET role = 'owner' WHERE org_id = ?1 AND user_github_id = ?2").bind(orgId, String(userId))];
  if (row.step_down) {
    steps.push(env.DB.prepare("UPDATE memberships SET role = 'admin' WHERE org_id = ?1 AND user_github_id = ?2 AND role = 'owner'").bind(orgId, String(row.from_github_id)));
  }
  steps.push(env.DB.prepare("DELETE FROM owner_transfers WHERE org_id = ?1").bind(orgId));
  await env.DB.batch(steps);
  return { ok: true, fromId: String(row.from_github_id), steppedDown: Boolean(row.step_down) };
}

/// The one who offered withdraws it, or the one offered declines.
export async function cancelTransfer(env, { orgId, userId }) {
  const row = await env.DB.prepare("SELECT * FROM owner_transfers WHERE org_id = ?1").bind(orgId).first();
  if (!row) return { error: "There is no offer standing.", status: 404 };
  const who = String(userId);
  if (who !== String(row.from_github_id) && who !== String(row.to_github_id) && (await roleIn(env.DB, orgId, userId)) !== "owner") {
    return { error: "Only an owner, or the person offered it, can call this off.", status: 403 };
  }
  await env.DB.prepare("DELETE FROM owner_transfers WHERE org_id = ?1").bind(orgId).run();
  return { ok: true, declined: who === String(row.to_github_id) };
}

/// /members/owner-transfer and /members/owner-transfer/accept.
export async function handleOwners(request, env, url) {
  if (!url.pathname.startsWith("/members/owner-transfer")) return null;
  const session = await getSession(env.DB, request.headers.get("x-session-token"));
  if (!session) return json({ message: "Please sign in." }, 401);
  const body = request.method === "GET" ? null : await request.json().catch(() => ({}));
  const orgId = request.method === "GET" ? url.searchParams.get("orgId") : body?.orgId;
  if (!orgId) return json({ message: "orgId is required" }, 400);
  if (!(await isMember(env.DB, orgId, session.github_id))) return json({ message: "not a member of this org" }, 403);
  const actorUser = await getUserByGithubId(env.DB, session.github_id);
  const actor = person(actorUser);
  const name = await workspaceName(env.DB, orgId);

  if (url.pathname === "/members/owner-transfer" && request.method === "GET") {
    return json({ transfer: await transferFor(env.DB, orgId, session.github_id) });
  }
  if (url.pathname === "/members/owner-transfer" && request.method === "POST") {
    const out = await offerTransfer(env, { orgId, actorId: session.github_id, ref: body.ref, stepDown: Boolean(body.stepDown) });
    if (out.error) {
      if (out.status === 403) await audit(env, request, { orgId, action: "security.permission_denied", actor, entity: { type: "resource", id: "owner_transfer", name: "handing the workspace on" }, outcome: "denied" });
      return json({ message: out.error }, out.status || 400);
    }
    await audit(env, request, { orgId, action: "owner.transfer_offered", actor, entity: { type: "user", id: out.target.login, name: out.target.name }, details: { step_down: Boolean(body.stepDown) } });
    const target = await getUserByGithubId(env.DB, out.target.userId).catch(() => null);
    if (target?.email && isMailConfigured(env)) {
      await sendMail(env, {
        to: target.email,
        subject: `${actorUser?.name || "An owner"} offered you ${name}`,
        text: `${actorUser?.name || "An owner"} would like you to become an owner of ${name}. Open the team screen to accept or decline. The offer lasts ${OFFER_DAYS} days.`,
      }).catch(() => null);
    }
    return json({ ok: true, transfer: await transferFor(env.DB, orgId, session.github_id) });
  }
  if (url.pathname === "/members/owner-transfer/accept" && request.method === "POST") {
    const out = await acceptTransfer(env, { orgId, userId: session.github_id });
    if (out.error) return json({ message: out.error }, out.status || 400);
    const from = await getUserByGithubId(env.DB, out.fromId).catch(() => null);
    await audit(env, request, { orgId, action: "owner.transferred", actor, entity: { type: "user", id: from?.login || null, name: from?.name || null }, details: { stepped_down: out.steppedDown } });
    await mailOwners(env, orgId, {
      subject: `${actorUser?.name || "Someone"} is now an owner of ${name}`,
      text: `${actorUser?.name || "Someone"} accepted ${from?.name || "an owner"}'s offer and is now an owner of ${name}.${out.steppedDown ? ` ${from?.name || "The previous owner"} is now an admin.` : ""}`,
    });
    const { evictMember } = await import("./announce.js");
    if (out.steppedDown && from?.login) await evictMember(env, orgId, from.login).catch(() => {});
    return json({ ok: true, role: "owner" });
  }
  if (url.pathname === "/members/owner-transfer" && request.method === "DELETE") {
    const out = await cancelTransfer(env, { orgId, userId: session.github_id });
    if (out.error) return json({ message: out.error }, out.status || 400);
    await audit(env, request, { orgId, action: "owner.transfer_cancelled", actor, details: { declined: out.declined } });
    return json({ ok: true });
  }
  return json({ message: "Not found" }, 404);
}
