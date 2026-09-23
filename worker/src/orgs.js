// A team with a name.
//
// Every workspace used to be one of two things: the `personal:<hash>` org a
// sign-up hands out, which has no name and is shown as "Toru's team", or a
// GitHub repository, which is named by the repository. There was no way to
// start a second team, and no way to call the one you had anything. This is
// the third kind — `team:<random>` — made on purpose, named by the person who
// made it, and renamed by any admin of it. The `orgs` table has carried a
// `name` column since the first schema; this is the first thing to write it.

import { ROLE_RANK } from "./auth.js";
import { upsertMembership } from "./db.js";
import { membershipIsOurs } from "./team.js";

export const MAX_TEAM_NAME_CHARS = 60;
/// How many teams one account may start. Enough for anyone using the product;
/// small enough that a script cannot fill the table.
export const MAX_TEAMS_PER_PERSON = 20;

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/// A name a person typed, made safe to show: trimmed, one line, bounded.
export function normalizeTeamName(name) {
  if (typeof name !== "string") return null;
  const clean = name.replace(/\s+/g, " ").trim().slice(0, MAX_TEAM_NAME_CHARS);
  return clean.length ? clean : null;
}

/// Start a team. The maker is its first admin.
export async function createTeam(db, { name, createdBy }) {
  const clean = normalizeTeamName(name);
  if (!clean) return { error: "Give the team a name." };
  const made = await db
    .prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_github_id = ?1 AND org_id LIKE 'team:%' AND role = 'admin'")
    .bind(String(createdBy))
    .first();
  if (Number(made?.n || 0) >= MAX_TEAMS_PER_PERSON) return { error: "That is as many teams as one account can start." };
  const id = `team:${toHex(crypto.getRandomValues(new Uint8Array(9)))}`;
  await db
    .prepare("INSERT INTO orgs (id, name, created_at) VALUES (?1, ?2, ?3)")
    .bind(id, clean, new Date().toISOString())
    .run();
  await upsertMembership(db, id, createdBy, "admin");
  return { orgId: id, name: clean };
}

/// Give a workspace a name, or a new one. Admins only, and only for a
/// workspace whose membership is ours: a repository is named by GitHub.
export async function renameTeam(db, { orgId, actorId, name }) {
  if (!orgId) return { error: "Missing team.", status: 400 };
  if (!membershipIsOurs(orgId)) return { error: "A repository's name is set on GitHub.", status: 400 };
  const clean = normalizeTeamName(name);
  if (!clean) return { error: "Give the team a name.", status: 400 };
  const row = await db
    .prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(orgId, String(actorId))
    .first();
  if (!row) return { error: "You are not a member of this organization.", status: 403 };
  if ((ROLE_RANK.get(String(row.role || "member").toLowerCase()) ?? 0) < ROLE_RANK.get("admin")) {
    return { error: "Only an admin can rename the team.", status: 403 };
  }
  await db
    .prepare(
      `INSERT INTO orgs (id, name, created_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`
    )
    .bind(orgId, clean, new Date().toISOString())
    .run();
  return { orgId, name: clean };
}

/// The name a workspace was given, or null for one that has none — a
/// personal workspace nobody renamed, a repository (whose id is its name).
export async function teamName(db, orgId) {
  const row = await db.prepare("SELECT name FROM orgs WHERE id = ?1").bind(orgId).first();
  return row?.name || null;
}

/// Whether this person may rename this workspace: an admin of one whose
/// membership is ours.
export async function canRename(db, orgId, userId) {
  if (!membershipIsOurs(orgId)) return false;
  const row = await db
    .prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(orgId, String(userId))
    .first();
  return Boolean(row) && (ROLE_RANK.get(String(row.role || "member").toLowerCase()) ?? 0) >= ROLE_RANK.get("admin");
}
