import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { createSession, upsertUser, upsertMembership, setOrgProfile } from "../src/db.js";
import { buildOrgGraph } from "../src/org.js";

// The org graph was the repository's permission list with the words changed.
// Nobody's actual responsibility was in it, so "route this to whoever it
// belongs to" had nothing to route by — and the `manages` edge the router looks
// for on every escalation was never once emitted, by anything.

const SELF = { fetch: (url, init) => worker.fetch(new Request(url, init), env) };
const ORG = "acme/team";

let ada;
beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await upsertUser(env.DB, { githubId: "8001", login: "ada", name: "Ada", avatarUrl: "", locale: "en" });
  await upsertUser(env.DB, { githubId: "8002", login: "grace", name: "Grace", avatarUrl: "", locale: "en" });
  await upsertMembership(env.DB, ORG, "8001", "Engineer");
  await upsertMembership(env.DB, ORG, "8002", "Admin");
  ada = await createSession(env.DB, "8001", "gho_ada");
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

const COLLABS = [
  { id: 8001, login: "ada", avatar_url: "", permissions: { push: true, pull: true } },
  { id: 8002, login: "grace", avatar_url: "", permissions: { admin: true, push: true, pull: true } },
];

test("a profile turns a permission list into an organization", () => {
  const graph = buildOrgGraph(COLLABS, {
    owner: "acme", repo: "team",
    profiles: {
      8001: { title: "Design", responsibilities: "Brand, the marketing site", manager_login: "grace" },
    },
  });

  const ada = graph.nodes.find((n) => n.id === "ada");
  // What she says she does, not what GitHub lets her push.
  expect(ada.label).toBe("ada · Design");
  expect(ada.detail).toBe("Brand, the marketing site");
  // Grace has said nothing, so she keeps the permission-derived role.
  expect(graph.nodes.find((n) => n.id === "grace").label).toBe("grace · Admin");

  // fromID is the manager, toID the person reporting to them — the direction
  // the router and the app both already read, and never had an edge for.
  const manages = graph.edges.find((e) => e.kind === "manages");
  expect(manages).toMatchObject({ fromID: "grace", toID: "ada" });
});

test("a manager who is not here is not a manager", () => {
  // An edge pointing outside the organization would route escalations nowhere.
  const graph = buildOrgGraph(COLLABS, {
    owner: "acme", repo: "team",
    profiles: { 8001: { manager_login: "someone-else" }, 8002: { manager_login: "grace" } },
  });
  expect(graph.edges.some((e) => e.kind === "manages")).toBe(false);
});

test("an org that has filled nothing in gets what it always got", () => {
  const graph = buildOrgGraph(COLLABS, { owner: "acme", repo: "team" });
  expect(graph.nodes.find((n) => n.id === "ada").label).toBe("ada · Engineer");
  expect(graph.nodes.find((n) => n.id === "ada").detail).toBeUndefined();
  expect(graph.edges.some((e) => e.kind === "manages")).toBe(false);
});

test("you write your own place in the organization, and read it back", async () => {
  const put = await SELF.fetch(`https://example.com/orgs/acme/team/profile`, {
    method: "PUT",
    headers: { "x-session-token": ada, "content-type": "application/json" },
    body: JSON.stringify({ title: "Design", responsibilities: "Brand and the site", managerLogin: "grace" }),
  });
  expect(put.status).toBe(200);

  const get = await SELF.fetch(`https://example.com/orgs/acme/team/profile`, {
    headers: { "x-session-token": ada },
  });
  expect(await get.json()).toEqual({
    title: "Design", responsibilities: "Brand and the site", managerLogin: "grace",
  });
});

test("a profile is refused when it names a manager who is not in the org", async () => {
  const res = await SELF.fetch(`https://example.com/orgs/acme/team/profile`, {
    method: "PUT",
    headers: { "x-session-token": ada, "content-type": "application/json" },
    body: JSON.stringify({ managerLogin: "stranger" }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).message).toMatch(/organization/i);
});

test("a profile is refused from outside the organization, and from nobody at all", async () => {
  await upsertUser(env.DB, { githubId: "8003", login: "mallory", name: "M", avatarUrl: "", locale: "en" });
  const outsider = await createSession(env.DB, "8003", "gho_m");

  const stranger = await SELF.fetch(`https://example.com/orgs/acme/team/profile`, {
    headers: { "x-session-token": outsider },
  });
  expect(stranger.status).toBe(403);

  const anonymous = await SELF.fetch(`https://example.com/orgs/acme/team/profile`);
  expect(anonymous.status).toBe(401);
});

test("the graph is served with the profiles layered onto it", async () => {
  await setOrgProfile(env.DB, ORG, "8002", {
    title: "Finance", responsibilities: "Budgets and vendor contracts", managerLogin: null,
  });
  fetchMock.get("https://api.github.com")
    .intercept({ path: "/repos/acme/team/collaborators?per_page=100&page=1", method: "GET" })
    .reply(200, COLLABS);

  const res = await SELF.fetch("https://example.com/orgs/acme/team/graph", {
    headers: { "x-session-token": ada },
  });
  const graph = await res.json();
  const grace = graph.nodes.find((n) => n.id === "grace");
  expect(grace.label).toBe("grace · Finance");
  expect(grace.detail).toBe("Budgets and vendor contracts");
});
