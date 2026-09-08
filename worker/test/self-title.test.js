import { env, SELF } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";

// The onboarding screen asks what you do, and the router matches on the
// answer. That makes it a write to the memberships table from an unprivileged,
// self-directed screen — so it must not grant standing, and must not cost any
// either. Standing and description are separate columns for exactly that
// reason: they were one, and signing up alone (which makes you admin of your
// own org) then made the question unanswerable.

let member, admin;

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { signup } = await import("../src/auth.js");
  const { upsertMembership } = await import("../src/db.js");
  member = await signup(env, { email: "member@example.com", password: "password123", name: "Member" });
  admin = await signup(env, { email: "admin@example.com", password: "password123", name: "Admin" });
  // signup makes you admin of your own org; demote the first so they are an
  // ordinary member of theirs.
  await upsertMembership(env.DB, member.orgId, member.userId, "member");
});

const put = (token, body) =>
  SELF.fetch("https://example.com/me", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-session-token": token },
    body: JSON.stringify(body),
  });

const me = (token, orgId) =>
  SELF.fetch(`https://example.com/me?orgId=${encodeURIComponent(orgId)}`, {
    headers: { "x-session-token": token },
  }).then((r) => r.json());

test("a member can describe what they do", async () => {
  const res = await put(member.token, { orgId: member.orgId, role: "designer" });
  expect(res.status).toBe(200);
  expect((await res.json()).role).toBe("designer");

  const profile = await me(member.token, member.orgId);
  expect(profile.role).toBe("designer");
  expect(profile.assignableRoles).not.toContain("admin");
});

test("the person who signed up can answer it too, and stays an admin", async () => {
  // The commonest case in the product and the one that used to be refused:
  // signing up alone makes you admin of your own organization.
  const res = await put(admin.token, { orgId: admin.orgId, role: "founder" });
  expect(res.status).toBe(200);
  expect(await me(admin.token, admin.orgId)).toMatchObject({ role: "founder" });

  const row = await env.DB.prepare("SELECT role, title FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(admin.orgId, admin.userId).first();
  expect(row.title).toBe("founder");
  // Standing untouched: still able to invite, still the org's admin.
  expect(String(row.role).toLowerCase()).toBe("admin");
});

test("nobody can promote themselves", async () => {
  const res = await put(member.token, { orgId: member.orgId, role: "admin" });
  expect(res.status).toBe(400);
  const row = await env.DB.prepare("SELECT role, title FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(member.orgId, member.userId).first();
  // Storage is rolled back between tests, so this is what beforeAll set: the
  // rejected call changed nothing, and left no title behind either.
  expect(String(row.role).toLowerCase()).toBe("member");
  expect(row.title).toBeNull();
});

test("a title cannot be set in an org you are not in", async () => {
  const res = await put(member.token, { orgId: admin.orgId, role: "engineer" });
  expect(res.status).toBe(400);
  const row = await env.DB.prepare("SELECT title FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(admin.orgId, member.userId).first();
  expect(row).toBeNull();
});

test("the org graph shows the title, so the router can match on it", async () => {
  const { setOwnTitle, listOrgNodes } = await import("../src/db.js");
  await setOwnTitle(env.DB, admin.orgId, admin.userId, "designer");
  const nodes = await listOrgNodes(env.DB, admin.orgId);
  const node = nodes.find((n) => n.id === admin.login);
  expect(node.role).toBe("designer");
});
