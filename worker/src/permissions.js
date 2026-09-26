// Who may do what in a workspace: one table, read by every route.
//
// docs/admin-controls.md §4 is the design. An Owner holds the workspace —
// its security, its keys, its existence — and there is always at least one.
// An Admin runs it day to day. Each action names the lowest role that may
// take it, and a route asks `allowed(db, orgId, userId, action)` rather than
// comparing ranks of its own.

import { ROLE_RANK } from "./auth.js";

/// The lowest role that may take each action.
export const PERMISSIONS = {
  "workspace.rename": "admin",
  "workspace.icon": "admin",
  "workspace.delete": "owner",
  "workspace.ai_settings": "admin",
  "workspace.integrations": "admin",
  "billing.manage": "owner",
  "owner.add": "owner",
  "owner.remove": "owner",
  "owner.transfer": "owner",
  "member.invite": "member",
  "member.invite_admin": "owner",
  "member.role_change": "admin",
  "member.role_change_admin": "owner",
  "member.remove": "admin",
  "member.remove_admin": "owner",
  "member.sign_out_everywhere": "admin",
  "domain.manage": "owner",
  "sso.manage": "owner",
  "session_policy.manage": "owner",
  "org_key.manage": "owner",
  "audit.read": "admin",
  "audit.export": "admin",
  "audit.stream.manage": "owner",
  "dlp.manage": "admin",
  "join_request.decide": "admin",
  "webhook.create": "member",
  "webhook.delete_others": "admin",
  "api_token.create": "member",
  "emoji.add": "member",
  "emoji.remove_others": "admin",
  "usergroup.edit": "member",
  "usergroup.delete_others": "admin",
  "bookmark.remove_others": "admin",
  "channel.create": "member",
  "playbook.manage": "admin",
  "agent.manage_others": "admin",
};

export const rankOf = (role) => ROLE_RANK.get(String(role || "member").toLowerCase()) ?? 0;

/// Whether a role may take an action. An action the table does not name is
/// refused: a new route has to be written into it to be allowed at all.
export function can(role, action) {
  const needed = PERMISSIONS[action];
  if (!needed || role == null) return false;
  return rankOf(role) >= rankOf(needed);
}

/// Whether a workspace's membership is kept here, or read from a GitHub
/// repository's collaborators.
const ours = (orgId) => !String(orgId || "").includes("/");

/// Someone's role in a workspace as the table reads it, or null when they are
/// not in it. A repository's admins are its owners: GitHub decides who they
/// are, and the next sync would undo an Owner written here.
export async function roleIn(db, orgId, userId) {
  if (!orgId || userId == null) return null;
  const row = await db
    .prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(orgId, String(userId))
    .first();
  if (!row) return null;
  const role = String(row.role || "member").toLowerCase();
  if (!ours(orgId)) return role === "admin" ? "owner" : role;
  if (role === "admin") await ensureOwner(db, orgId);
  // Read again: ensureOwner may just have made this admin the owner.
  if (role === "admin") {
    const again = await db.prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2").bind(orgId, String(userId)).first();
    return String(again?.role || role).toLowerCase();
  }
  return role;
}

/// Whether this person may take this action in this workspace.
export async function allowed(db, orgId, userId, action) {
  return can(await roleIn(db, orgId, userId), action);
}

/// The owners of a workspace, earliest first.
export async function ownersOf(db, orgId) {
  const { results } = await db
    .prepare("SELECT user_github_id AS userId FROM memberships WHERE org_id = ?1 AND role = 'owner' ORDER BY created_at ASC, user_github_id ASC")
    .bind(orgId)
    .all();
  return (results || []).map((r) => String(r.userId));
}

/// A workspace kept here that has no owner — one made before owners existed —
/// gets one: the admin who has been in it longest, who made it in all but the
/// oddest case. Returns the new owner's id, or null when nothing changed.
export async function ensureOwner(db, orgId) {
  if (!orgId || !ours(orgId)) return null;
  const has = await db.prepare("SELECT 1 FROM memberships WHERE org_id = ?1 AND role = 'owner' LIMIT 1").bind(orgId).first();
  if (has) return null;
  const first = await db
    .prepare("SELECT user_github_id AS userId FROM memberships WHERE org_id = ?1 AND role = 'admin' ORDER BY created_at ASC, user_github_id ASC LIMIT 1")
    .bind(orgId)
    .first();
  if (!first) return null;
  // Guarded, so two requests racing here make one owner, not two.
  const done = await db
    .prepare(
      `UPDATE memberships SET role = 'owner' WHERE org_id = ?1 AND user_github_id = ?2 AND role = 'admin'
         AND NOT EXISTS (SELECT 1 FROM memberships WHERE org_id = ?1 AND role = 'owner')`
    )
    .bind(orgId, String(first.userId))
    .run();
  return done?.meta?.changes ? String(first.userId) : null;
}

/// The workspaces this person is the only owner of, that still have somebody
/// else in them. They cannot delete their account, or leave, until each has
/// another owner: a workspace nobody holds cannot be run.
export async function soleOwnerships(db, userId) {
  const { results } = await db
    .prepare(
      `SELECT m.org_id AS orgId, o.name AS name,
              (SELECT COUNT(*) FROM memberships x WHERE x.org_id = m.org_id AND x.role = 'owner') AS owners,
              (SELECT COUNT(*) FROM memberships y WHERE y.org_id = m.org_id) AS members
         FROM memberships m LEFT JOIN orgs o ON o.id = m.org_id
        WHERE m.user_github_id = ?1 AND m.role = 'owner'`
    )
    .bind(String(userId))
    .all();
  return (results || []).filter((r) => Number(r.owners) === 1 && Number(r.members) > 1)
    .map((r) => ({ orgId: r.orgId, name: r.name || null }));
}
