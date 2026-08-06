import type { Member, Org, OrgEdge, OrgEdgeKind, Team } from "@honmaru/protocol";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import { newId, newSecret, now } from "./ids.js";

export class OrgError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

interface MemberRow {
  org_id: string;
  user_id: string;
  title: string;
  is_admin: number;
  team_id: string | null;
  name: string;
  github_username: string | null;
}

function toMember(row: MemberRow): Member {
  return {
    userId: row.user_id,
    name: row.name,
    title: row.title,
    isAdmin: row.is_admin === 1,
    teamId: row.team_id,
    githubUsername: row.github_username,
  };
}

export function getOrg(db: Db, orgId: string): Org | null {
  const row = db.prepare("SELECT * FROM orgs WHERE id = ?").get(orgId) as
    | { id: string; name: string; created_at: string }
    | undefined;
  return row ? { id: row.id, name: row.name, createdAt: row.created_at } : null;
}

export function listOrgsForUser(db: Db, userId: string): Org[] {
  const rows = db
    .prepare(
      `SELECT o.* FROM orgs o JOIN memberships m ON m.org_id = o.id
       WHERE m.user_id = ? ORDER BY o.created_at ASC`
    )
    .all(userId) as { id: string; name: string; created_at: string }[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
  }));
}

export function getMember(db: Db, orgId: string, userId: string): Member | null {
  const row = db
    .prepare(
      `SELECT m.*, u.name, u.github_username FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.org_id = ? AND m.user_id = ?`
    )
    .get(orgId, userId) as MemberRow | undefined;
  return row ? toMember(row) : null;
}

export function requireMember(db: Db, orgId: string, userId: string): Member {
  const member = getMember(db, orgId, userId);
  if (!member) {
    throw new OrgError("not_a_member", "You are not a member of this org.");
  }
  return member;
}

export function requireAdmin(db: Db, orgId: string, userId: string): Member {
  const member = requireMember(db, orgId, userId);
  if (!member.isAdmin) {
    throw new OrgError("admin_required", "Org admin permission required.");
  }
  return member;
}

export function listMembers(db: Db, orgId: string): Member[] {
  const rows = db
    .prepare(
      `SELECT m.*, u.name, u.github_username FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.org_id = ? ORDER BY m.created_at ASC`
    )
    .all(orgId) as MemberRow[];
  return rows.map(toMember);
}

export function listTeams(db: Db, orgId: string): Team[] {
  const rows = db
    .prepare("SELECT * FROM teams WHERE org_id = ? ORDER BY name ASC")
    .all(orgId) as { id: string; org_id: string; name: string }[];
  return rows.map((row) => ({ id: row.id, orgId: row.org_id, name: row.name }));
}

export function listEdges(db: Db, orgId: string): OrgEdge[] {
  const rows = db
    .prepare("SELECT * FROM org_edges WHERE org_id = ?")
    .all(orgId) as {
    id: string;
    org_id: string;
    kind: OrgEdgeKind;
    from_id: string;
    to_id: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    orgId: row.org_id,
    kind: row.kind,
    fromId: row.from_id,
    toId: row.to_id,
  }));
}

export function createOrg(
  db: Db,
  userId: string,
  name: string,
  title: string
): Org {
  const org: Org = { id: newId("org"), name, createdAt: now() };
  db.transaction(() => {
    db.prepare("INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)").run(
      org.id,
      org.name,
      org.createdAt
    );
    db.prepare(
      `INSERT INTO memberships (org_id, user_id, title, is_admin, created_at)
       VALUES (?, ?, ?, 1, ?)`
    ).run(org.id, userId, title, now());
    const member = getMember(db, org.id, userId)!;
    appendEvent(db, org.id, "member_joined", userId, { member });
  })();
  return org;
}

export function createInvite(
  db: Db,
  orgId: string,
  createdBy: string,
  ttlHours = 72
): { code: string; expiresAt: string } {
  const code = newSecret(9);
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
  db.prepare(
    `INSERT INTO invites (code, org_id, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(code, orgId, createdBy, now(), expiresAt);
  return { code, expiresAt };
}

export function acceptInvite(
  db: Db,
  userId: string,
  code: string,
  title: string
): Org {
  const invite = db
    .prepare("SELECT * FROM invites WHERE code = ? AND expires_at > ?")
    .get(code, now()) as { org_id: string } | undefined;
  if (!invite) {
    throw new OrgError("invalid_invite", "Invite code is invalid or expired.");
  }
  const org = getOrg(db, invite.org_id);
  if (!org) {
    throw new OrgError("invalid_invite", "Org no longer exists.");
  }
  if (getMember(db, org.id, userId)) {
    return org;
  }
  db.transaction(() => {
    db.prepare(
      `INSERT INTO memberships (org_id, user_id, title, is_admin, created_at)
       VALUES (?, ?, ?, 0, ?)`
    ).run(org.id, userId, title, now());
    const member = getMember(db, org.id, userId)!;
    appendEvent(db, org.id, "member_joined", userId, { member });
  })();
  return org;
}

export function updateMember(
  db: Db,
  orgId: string,
  targetUserId: string,
  actorUserId: string,
  patch: { title?: string; teamId?: string | null; isAdmin?: boolean }
): Member {
  const existing = getMember(db, orgId, targetUserId);
  if (!existing) {
    throw new OrgError("not_a_member", "Target user is not a member.");
  }
  db.transaction(() => {
    db.prepare(
      `UPDATE memberships SET
         title = COALESCE(?, title),
         team_id = CASE WHEN ? THEN ? ELSE team_id END,
         is_admin = COALESCE(?, is_admin)
       WHERE org_id = ? AND user_id = ?`
    ).run(
      patch.title ?? null,
      patch.teamId !== undefined ? 1 : 0,
      patch.teamId ?? null,
      patch.isAdmin === undefined ? null : patch.isAdmin ? 1 : 0,
      orgId,
      targetUserId
    );
    const member = getMember(db, orgId, targetUserId)!;
    appendEvent(db, orgId, "member_updated", actorUserId, { member });
  })();
  return getMember(db, orgId, targetUserId)!;
}

// Replaces the org graph atomically. Fine-grained edge editing can come
// later; a whole-graph PUT keeps clients and server trivially consistent.
export function replaceGraph(
  db: Db,
  orgId: string,
  actorUserId: string,
  teams: { id: string; name: string }[],
  edges: { kind: OrgEdgeKind; fromId: string; toId: string }[]
): { teams: Team[]; edges: OrgEdge[] } {
  db.transaction(() => {
    db.prepare("DELETE FROM teams WHERE org_id = ?").run(orgId);
    db.prepare("DELETE FROM org_edges WHERE org_id = ?").run(orgId);
    const insertTeam = db.prepare(
      "INSERT INTO teams (id, org_id, name) VALUES (?, ?, ?)"
    );
    for (const team of teams) {
      insertTeam.run(team.id || newId("team"), orgId, team.name);
    }
    const insertEdge = db.prepare(
      "INSERT INTO org_edges (id, org_id, kind, from_id, to_id) VALUES (?, ?, ?, ?, ?)"
    );
    for (const edge of edges) {
      insertEdge.run(newId("edge"), orgId, edge.kind, edge.fromId, edge.toId);
    }
    appendEvent(db, orgId, "org_graph_updated", actorUserId, {
      teams: listTeams(db, orgId),
      edges: listEdges(db, orgId),
    });
  })();
  return { teams: listTeams(db, orgId), edges: listEdges(db, orgId) };
}

export function managerOf(db: Db, orgId: string, userId: string): string | null {
  const row = db
    .prepare(
      `SELECT from_id FROM org_edges
       WHERE org_id = ? AND to_id = ? AND kind = 'manages' LIMIT 1`
    )
    .get(orgId, userId) as { from_id: string } | undefined;
  return row?.from_id ?? null;
}
