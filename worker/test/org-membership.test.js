import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { createSession, upsertUser, upsertMembership, isMember, retainMemberships } from "../src/db.js";
import { canWrite, membersOf } from "../src/org.js";

// "Membership means write access" was true on the socket and false everywhere
// else. `/orgs/:owner/:repo/graph` wrote a membership row for every
// collaborator GitHub returned — read-only ones included — and the relay's fast
// path trusts that table without re-asking. One admin opening the org screen
// quietly handed every reader of the repository the whole decision history.

const SELF = { fetch: (url, init) => worker.fetch(new Request(url, init), env) };

let token;
beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await upsertUser(env.DB, { githubId: "5001", login: "writer", name: "W", avatarUrl: "", locale: "en" });
  token = await createSession(env.DB, "5001", "gho_writer");
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("write access is what makes someone a member", () => {
  expect(canWrite({ admin: true })).toBe(true);
  expect(canWrite({ maintain: true })).toBe(true);
  expect(canWrite({ push: true })).toBe(true);
  // GitHub grants triage for managing issues without any push permission.
  expect(canWrite({ triage: true, pull: true })).toBe(false);
  expect(canWrite({ pull: true })).toBe(false);
  expect(canWrite()).toBe(false);

  expect(membersOf([
    { login: "a", permissions: { push: true } },
    { login: "b", permissions: { pull: true } },
  ]).map((c) => c.login)).toEqual(["a"]);
});

test("a read-only collaborator is not persisted as a member and is not in the graph", async () => {
  fetchMock.get("https://api.github.com")
    .intercept({ path: "/repos/acme/readers/collaborators?per_page=100&page=1", method: "GET" })
    .reply(200, [
      { id: 5001, login: "writer", avatar_url: "", permissions: { push: true, pull: true } },
      { id: 5002, login: "reader", avatar_url: "", permissions: { triage: true, pull: true } },
    ]);

  const res = await SELF.fetch("https://example.com/orgs/acme/readers/graph", {
    headers: { "x-session-token": token },
  });
  expect(res.status).toBe(200);
  const graph = await res.json();

  // Not offered as a routing target: a card addressed to them could never be
  // decided, because they cannot join.
  expect(graph.nodes.some((n) => n.id === "writer")).toBe(true);
  expect(graph.nodes.some((n) => n.id === "reader")).toBe(false);
  expect(await isMember(env.DB, "acme/readers", "5001")).toBe(true);
  expect(await isMember(env.DB, "acme/readers", "5002")).toBe(false);
});

test("losing write access removes you, even when nobody is left", async () => {
  await upsertMembership(env.DB, "acme/demoted", "5001", "Engineer");
  fetchMock.get("https://api.github.com")
    .intercept({ path: "/repos/acme/demoted/collaborators?per_page=100&page=1", method: "GET" })
    .reply(200, [{ id: 5001, login: "writer", avatar_url: "", permissions: { pull: true } }]);

  const res = await SELF.fetch("https://example.com/orgs/acme/demoted/graph", {
    headers: { "x-session-token": token },
  });
  expect(res.status).toBe(200);
  // GitHub answered, and the answer was "nobody here can write" — which is a
  // real answer, not a failure to get one.
  expect(await isMember(env.DB, "acme/demoted", "5001")).toBe(false);
});

test("an empty collaborator list is still read as an outage, not an empty org", async () => {
  await upsertMembership(env.DB, "acme/quiet", "5001", "Admin");
  await retainMemberships(env.DB, "acme/quiet", []);
  expect(await isMember(env.DB, "acme/quiet", "5001")).toBe(true);
});

test("membership survives a repository with more collaborators than D1 can bind", async () => {
  // The prune was a `NOT IN (?2 … ?101)`, and D1 binds at most 100 parameters:
  // at exactly a hundred collaborators the statement threw, after the upserts
  // had already run. The set difference is computed in JS now.
  const keep = [];
  for (let i = 0; i < 120; i += 1) {
    const id = String(6000 + i);
    await upsertMembership(env.DB, "acme/big", id, "Engineer");
    keep.push(id);
  }
  await upsertMembership(env.DB, "acme/big", "9999", "Engineer");

  const { removed } = await retainMemberships(env.DB, "acme/big", keep, { authoritative: true });
  expect(removed).toBe(1);
  expect(await isMember(env.DB, "acme/big", "9999")).toBe(false);
  expect(await isMember(env.DB, "acme/big", "6000")).toBe(true);
  expect(await isMember(env.DB, "acme/big", "6119")).toBe(true);
});
