import { env, SELF } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";

// The onboarding screen asks what you do, and the router matches on the
// answer. That makes it a write to the memberships table from an
// unprivileged, self-directed screen — so it must not be able to grant
// standing, and must not be able to take standing away either.

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

test("a member can describe what they do", async () => {
  const res = await put(member.token, { orgId: member.orgId, role: "designer" });
  expect(res.status).toBe(200);
  expect((await res.json()).role).toBe("designer");

  const me = await (await SELF.fetch(`https://example.com/me?orgId=${encodeURIComponent(member.orgId)}`, {
    headers: { "x-session-token": member.token },
  })).json();
  expect(me.role).toBe("designer");
  expect(me.assignableRoles).not.toContain("admin");
});

test("nobody can promote themselves", async () => {
  const res = await put(member.token, { orgId: member.orgId, role: "admin" });
  expect(res.status).toBe(400);
  // Storage is rolled back between tests here, so this is the role beforeAll
  // set — the point being that the rejected call changed nothing.
  const row = await env.DB.prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(member.orgId, member.userId).first();
  expect(row.role).toBe("member");
});

test("an admin picking a role on an onboarding screen is not demoted by it", async () => {
  const res = await put(admin.token, { orgId: admin.orgId, role: "engineer" });
  expect(res.status).toBe(400);
  const row = await env.DB.prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(admin.orgId, admin.userId).first();
  expect(row.role.toLowerCase()).toBe("admin");
});

test("a role cannot be set in an org you are not in", async () => {
  const res = await put(member.token, { orgId: admin.orgId, role: "engineer" });
  expect(res.status).toBe(400);
  const row = await env.DB.prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(admin.orgId, member.userId).first();
  expect(row).toBeNull();
});
