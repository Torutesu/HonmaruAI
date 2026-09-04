import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";

// Signup is an unauthenticated endpoint that writes a membership row, and
// authorizeOrgAccess treats a membership row as proof of access. So anything
// signup will put in that row is, in effect, an access grant. These tests pin
// the rule: only an invite may name the org.

const VICTIM_ORG = "victim/private-repo";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { upsertUser, upsertMembership } = await import("../src/db.js");
  // A private org with exactly one member: its owner.
  await upsertUser(env.DB, { githubId: "9001", login: "victimowner", name: "Victim Owner", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, VICTIM_ORG, "9001", "Admin");
});

test("signup cannot place the caller in an org they named", async () => {
  const { signup } = await import("../src/auth.js");
  const { isMember } = await import("../src/db.js");

  const result = await signup(env, {
    email: "attacker@evil.com",
    password: "password123",
    name: "attacker",
    orgId: VICTIM_ORG,
  });

  // The signup itself may succeed — what must not happen is landing in the org.
  expect(result.error).toBeUndefined();
  expect(result.orgId).not.toBe(VICTIM_ORG);
  expect(await isMember(env.DB, VICTIM_ORG, result.userId)).toBe(false);
});

test("signup with no invite puts the user in an org of their own", async () => {
  const { signup } = await import("../src/auth.js");
  const { isMember } = await import("../src/db.js");

  const result = await signup(env, {
    email: "solo@example.com",
    password: "password123",
    name: "Solo",
  });

  expect(result.error).toBeUndefined();
  expect(await isMember(env.DB, result.orgId, result.userId)).toBe(true);
  // The org id travels in the socket's query string, so it must not carry the
  // address it was derived from.
  expect(result.orgId).not.toContain("solo@example.com");
  expect(result.orgId).not.toContain("@");
  // Same user, same org, every time — otherwise a re-signup would strand them.
  expect(result.orgId).toMatch(/^personal:[0-9a-f]{24}$/);
});

test("signup cannot claim another user's relay identity via name", async () => {
  const { signup } = await import("../src/auth.js");

  // `login` is what the relay matches on when delivering cards. Choosing it
  // freely would let a signup answer to an existing user's socket id.
  const result = await signup(env, {
    email: "impostor@evil.com",
    password: "password123",
    name: "victimowner",
  });

  expect(result.error).toBeUndefined();
  expect(result.login).not.toBe("victimowner");
});

test("two emails with the same local part get different identities", async () => {
  const { signup } = await import("../src/auth.js");

  const a = await signup(env, { email: "kinjal@a.com", password: "password123", name: "K" });
  const b = await signup(env, { email: "kinjal@b.com", password: "password123", name: "K" });

  expect(a.login).not.toBe(b.login);
});

test("two users cannot share a relay identity", async () => {
  const { upsertUser } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "8001", login: "taken", name: "First", avatarUrl: null, locale: "en" });

  // A second, different user claiming the same login must be rejected by the
  // database, not merely avoided by how signup happens to derive the value.
  await expect(
    upsertUser(env.DB, { githubId: "8002", login: "taken", name: "Second", avatarUrl: null, locale: "en" })
  ).rejects.toThrow();
});
