import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// Minting an invite is granting access: redeeming the code writes a membership
// row, and authorizeOrgAccess treats that row as proof. So the mint itself has
// to be gated on the caller already belonging to the org.

const VICTIM_ORG = "victim/private-repo";
let outsiderToken;
let ownerToken;

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");

  await upsertUser(env.DB, { githubId: "7001", login: "owner", name: "Owner", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, VICTIM_ORG, "7001", "admin");
  ownerToken = await createSession(env.DB, "7001", "gho_owner");

  // A real account, correctly signed in, that belongs to no org at all.
  await upsertUser(env.DB, { githubId: "7002", login: "outsider", name: "Outsider", avatarUrl: null, locale: "en" });
  outsiderToken = await createSession(env.DB, "7002", "gho_outsider");
});

function createInviteReq(token, body) {
  return new Request("https://example.com/invites/create", {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-token": token },
    body: JSON.stringify(body),
  });
}

test("a non-member cannot mint an invite to an org", async () => {
  const res = await worker.fetch(createInviteReq(outsiderToken, { orgId: VICTIM_ORG, role: "admin" }), env);
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.code).toBeUndefined();
});

test("a member can mint an invite to their own org", async () => {
  const res = await worker.fetch(createInviteReq(ownerToken, { orgId: VICTIM_ORG }), env);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.code).toBeTruthy();
  expect(body.orgId).toBe(VICTIM_ORG);
});

test("an unknown role is refused rather than quietly downgraded", async () => {
  // Substituting a different role than the one asked for is worse than saying
  // no: the inviter hands out a code believing it grants something it doesn't.
  const res = await worker.fetch(createInviteReq(ownerToken, { orgId: VICTIM_ORG, role: "superuser" }), env);
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.code).toBeUndefined();
});

test("a member cannot mint an invite above their own role", async () => {
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "7003", login: "plainmember", name: "Plain", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, VICTIM_ORG, "7003", "member");
  const memberToken = await createSession(env.DB, "7003", "gho_member");

  // Membership was enough to mint an admin code and redeem it, which promoted
  // the caller in two calls.
  const res = await worker.fetch(createInviteReq(memberToken, { orgId: VICTIM_ORG, role: "admin" }), env);
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.code).toBeUndefined();
});

test("redeeming a lesser invite does not demote an existing member", async () => {
  const { upsertMembership, isMember } = await import("../src/db.js");
  const { acceptInvite } = await import("../src/auth.js");

  await upsertMembership(env.DB, VICTIM_ORG, "7001", "admin");
  const res = await worker.fetch(createInviteReq(ownerToken, { orgId: VICTIM_ORG, role: "member" }), env);
  const { code } = await res.json();

  await acceptInvite(env, { code, userId: "7001" });
  const row = await env.DB
    .prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(VICTIM_ORG, "7001").first();
  expect(row.role).toBe("admin");
  expect(await isMember(env.DB, VICTIM_ORG, "7001")).toBe(true);
});

test("an invite code carries no hint of the org it opens", async () => {
  const res = await worker.fetch(createInviteReq(ownerToken, { orgId: VICTIM_ORG }), env);
  const { code } = await res.json();
  // The org used to be the code's prefix, which turned a 3-byte random suffix
  // into the whole of the secret.
  expect(code).not.toContain("victim");
  expect(code).not.toContain("private");
  // 16 bytes of hex. Enough that guessing is not a strategy.
  expect(code).toMatch(/^[0-9a-f]{32}$/);
});

test("an expired invite is refused", async () => {
  const res = await worker.fetch(createInviteReq(ownerToken, { orgId: VICTIM_ORG }), env);
  const { code } = await res.json();

  // Backdate it past its own expiry.
  await env.DB.prepare("UPDATE invites SET expires_at = ?1 WHERE code = ?2")
    .bind(new Date(Date.now() - 1000).toISOString(), code)
    .run();

  const { acceptInvite } = await import("../src/auth.js");
  const { isMember } = await import("../src/db.js");
  const result = await acceptInvite(env, { code, userId: "7002" });

  expect(result.error).toBeTruthy();
  expect(await isMember(env.DB, VICTIM_ORG, "7002")).toBe(false);
});

test("signup will not redeem an expired invite either", async () => {
  const res = await worker.fetch(createInviteReq(ownerToken, { orgId: VICTIM_ORG }), env);
  const { code } = await res.json();
  await env.DB.prepare("UPDATE invites SET expires_at = ?1 WHERE code = ?2")
    .bind(new Date(Date.now() - 1000).toISOString(), code)
    .run();

  const { signup } = await import("../src/auth.js");
  const result = await signup(env, {
    email: "late@example.com", password: "password123", name: "Late", inviteCode: code,
  });
  expect(result.error).toBeTruthy();
});
