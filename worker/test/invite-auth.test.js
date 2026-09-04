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

test("an unknown role falls back to member rather than being honoured", async () => {
  const res = await worker.fetch(createInviteReq(ownerToken, { orgId: VICTIM_ORG, role: "superuser" }), env);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.role).toBe("member");
});
