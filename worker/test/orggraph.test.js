import { SELF, env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { createSession } from "../src/db.js";

let sessionToken;
beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  sessionToken = await createSession(env.DB, "42", "gho_abc");
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("GET /orgs/:owner/:repo/graph builds and persists the org", async () => {
  fetchMock.get("https://api.github.com")
    .intercept({ path: "/repos/acme/web/collaborators?per_page=100" })
    .reply(200, [
      { login: "octocat", id: 1, avatar_url: "http://a", permissions: { admin: true, push: true, pull: true } },
      { login: "hubot", id: 2, avatar_url: "http://b", permissions: { push: true, pull: true } },
    ]);

  const res = await SELF.fetch("https://example.com/orgs/acme/web/graph", {
    headers: { "x-session-token": sessionToken },
  });
  expect(res.status).toBe(200);
  const g = await res.json();
  expect(g.nodes.find((n) => n.id === "octocat").kind).toBe("person");
  expect(g.nodes.find((n) => n.kind === "team").label).toBe("acme/web");
  expect(g.edges.some((e) => e.kind === "canApprove" && e.fromID === "octocat")).toBe(true);

  const { results } = await env.DB.prepare(
    "SELECT user_github_id, role FROM memberships WHERE org_id=?1 ORDER BY user_github_id"
  ).bind("acme/web").all();
  expect(results).toHaveLength(2);
});

test("GET /orgs/:owner/:repo/graph is 401 without a valid session", async () => {
  const res = await SELF.fetch("https://example.com/orgs/acme/web/graph", {
    headers: { "x-session-token": "bogus" },
  });
  expect(res.status).toBe(401);
});
