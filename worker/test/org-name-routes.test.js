import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// Reading the name is how a member avoids ever seeing the id. Changing it is
// how everyone else in the org sees it change, so it sits behind admin.

const ORG = "personal:deadbeef";
let adminToken, memberToken, outsiderToken;

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, upsertOrg } = await import("../src/db.js");

  await upsertUser(env.DB, { githubId: "1", login: "boss", name: "Boss", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "2", login: "hand", name: "Hand", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "3", login: "nobody", name: "Nobody", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "1", "admin");
  await upsertMembership(env.DB, ORG, "2", "member");
  await upsertOrg(env.DB, ORG, "Boss's team");

  adminToken = await createSession(env.DB, "1", "gho_a");
  memberToken = await createSession(env.DB, "2", "gho_m");
  outsiderToken = await createSession(env.DB, "3", "gho_o");
});

const read = (token, orgId = ORG) =>
  new Request(`https://x.com/orgs/name?orgId=${encodeURIComponent(orgId)}`, {
    headers: { "x-session-token": token },
  });

const rename = (token, name, orgId = ORG) =>
  new Request(`https://x.com/orgs/name?orgId=${encodeURIComponent(orgId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-session-token": token },
    body: JSON.stringify({ name }),
  });

test("a member reads the name instead of the id", async () => {
  const res = await worker.fetch(read(memberToken), env);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.name).toBe("Boss's team");
  expect(body.named).toBe(true);
});

test("an org with no row falls back to its id rather than failing", async () => {
  const { upsertMembership } = await import("../src/db.js");
  await upsertMembership(env.DB, "legacy/org", "2", "member");
  const res = await worker.fetch(read(memberToken, "legacy/org"), env);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.name).toBe("legacy/org");
  expect(body.named).toBe(false);
});

test("a non-member cannot read the name", async () => {
  const res = await worker.fetch(read(outsiderToken), env);
  expect(res.status).toBe(403);
});

test("a member cannot rename the org", async () => {
  const res = await worker.fetch(rename(memberToken, "Hand's Team Now"), env);
  expect(res.status).toBe(403);
  const { getOrg } = await import("../src/db.js");
  expect((await getOrg(env.DB, ORG)).name).toBe("Boss's team");
});

test("an admin renames it, and the id is untouched", async () => {
  const res = await worker.fetch(rename(adminToken, "Acme Design"), env);
  expect(res.status).toBe(200);

  const { getOrg } = await import("../src/db.js");
  const org = await getOrg(env.DB, ORG);
  expect(org.name).toBe("Acme Design");
  // The id routes sockets and is stored inside card data; a rename must not
  // move it.
  expect(org.id).toBe(ORG);

  const { results } = await env.DB
    .prepare("SELECT 1 AS ok FROM memberships WHERE org_id = ?1").bind(ORG).all();
  expect(results.length).toBe(2);
});

test("an empty or oversized name is refused", async () => {
  expect((await worker.fetch(rename(adminToken, "   "), env)).status).toBe(400);
  expect((await worker.fetch(rename(adminToken, "x".repeat(61)), env)).status).toBe(400);
});
