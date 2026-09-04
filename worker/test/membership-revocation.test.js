import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { createSession, upsertUser, upsertMembership, isMember, retainMemberships } from "../src/db.js";
import { authorizeOrgAccess } from "../src/membership.js";

const SELF = { fetch: (url, init) => worker.fetch(new Request(url, init), env) };

let token;
beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await upsertUser(env.DB, { githubId: "1", login: "stayer", name: "S", avatarUrl: "", locale: "en" });
  await upsertUser(env.DB, { githubId: "2", login: "leaver", name: "L", avatarUrl: "", locale: "en" });
  token = await createSession(env.DB, "1", "gho_stayer");
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("loading the org graph removes anyone GitHub no longer lists", async () => {
  await upsertMembership(env.DB, "acme/web", "1", "Admin");
  await upsertMembership(env.DB, "acme/web", "2", "Engineer");
  expect(await isMember(env.DB, "acme/web", "2")).toBe(true);

  // GitHub's answer: leaver is gone from the repository.
  fetchMock.get("https://api.github.com")
    .intercept({ path: "/repos/acme/web/collaborators?per_page=100&page=1", method: "GET" })
    .reply(200, [{ id: 1, login: "stayer", avatar_url: "", permissions: { admin: true } }]);

  const res = await SELF.fetch("https://example.com/orgs/acme/web/graph", {
    headers: { "x-session-token": token },
  });
  expect(res.status).toBe(200);

  expect(await isMember(env.DB, "acme/web", "1")).toBe(true);
  expect(await isMember(env.DB, "acme/web", "2")).toBe(false);
});

// The relay's fast path trusts this table and never re-asks GitHub, so a stale
// row is the whole of someone's continued access.
test("a revoked member is refused by the relay's authorization", async () => {
  const leaverToken = await createSession(env.DB, "2", "gho_leaver");
  const session = { github_id: "2", github_access_token: "gho_leaver" };

  // No membership row, so it falls through to GitHub — which refuses.
  fetchMock.get("https://api.github.com")
    .intercept({ path: "/repos/acme/web", method: "GET" })
    .reply(404, {});

  const access = await authorizeOrgAccess(env, session, "acme/web");
  expect(access.ok).toBe(false);
  expect(leaverToken).toBeTruthy();
});

// GitHub answering with nothing — an outage, a permissions blip — must not be
// read as "this organization has no members".
test("an empty collaborator list never empties an organization", async () => {
  await upsertMembership(env.DB, "acme/api", "1", "Admin");
  await retainMemberships(env.DB, "acme/api", []);
  expect(await isMember(env.DB, "acme/api", "1")).toBe(true);
});
