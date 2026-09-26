import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { domainMatches, normalizeDomain, recheckDomains, domainJoin } from "../src/domains.js";

// A company's domain proved by DNS, and the people who sign in with it
// (docs/sso-and-domain-join.md §4–5).

const ORG = "team:acme";
let owner; let admin;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const txt = new Map(); // domain -> [records]
const realFetch = globalThis.fetch;
const call = async (path, token, { method = "GET", body } = {}) => {
  const res = await worker.fetch(new Request(`https://example.com${path}`, {
    method, headers: { "content-type": "application/json", ...(token ? { "x-session-token": token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, ctx);
  while (pending.length) await pending.shift();
  return res;
};

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM rate_limits; DELETE FROM audit_events; DELETE FROM sessions; DELETE FROM memberships; DELETE FROM org_domains; DELETE FROM join_requests; DELETE FROM users;");
  txt.clear();
  globalThis.fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    if (u.hostname === "cloudflare-dns.com") {
      const name = u.searchParams.get("name");
      return new Response(JSON.stringify({ Status: 0, Answer: (txt.get(name) || []).map((d) => ({ name, type: 16, data: `"${d}"` })) }), { headers: { "content-type": "application/dns-json" } });
    }
    return realFetch(input, init);
  };
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  for (const [id, login, name, role, email] of [["7701", "u:toru@acme.co.jp", "Toru", "owner", "toru@acme.co.jp"], ["7702", "u:mika@acme.co.jp", "Mika", "admin", "mika@acme.co.jp"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await env.DB.prepare("UPDATE users SET email = ?2, email_verified_at = ?3 WHERE github_id = ?1").bind(id, email, new Date().toISOString()).run();
    await upsertMembership(env.DB, ORG, id, role);
  }
  owner = await createSession(env.DB, "7701", "x");
  admin = await createSession(env.DB, "7702", "x");
});
afterEach(() => { globalThis.fetch = realFetch; });

const newcomer = async (id, email, { proved = true } = {}) => {
  const { upsertUser, createSession } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: id, login: `u:${email}`, name: email.split("@")[0], avatarUrl: null, locale: "en" });
  await env.DB.prepare("UPDATE users SET email = ?2, email_verified_at = ?3 WHERE github_id = ?1").bind(id, email, proved ? new Date().toISOString() : null).run();
  return createSession(env.DB, id, "x");
};

test("domains are compared whole: a subdomain matches, a lookalike never does", () => {
  expect(normalizeDomain("ACME.co.jp.")).toBe("acme.co.jp");
  expect(domainMatches("sales.acme.co.jp", "acme.co.jp")).toBe(true);
  expect(domainMatches("acme.co.jp.evil.com", "acme.co.jp")).toBe(false);
  expect(domainMatches("notacme.co.jp", "acme.co.jp")).toBe(false);
  expect(normalizeDomain("bücher.example")).toBe("xn--bcher-kva.example");
});

test("an owner adds their own company's domain, proves it by DNS, and sets who joins", async () => {
  expect((await call("/orgs/domains", owner, { method: "POST", body: { orgId: ORG, domain: "gmail.com" } })).status).toBe(400);
  expect((await call("/orgs/domains", owner, { method: "POST", body: { orgId: ORG, domain: "other.co.jp" } })).status).toBe(400);
  expect((await call("/orgs/domains", admin, { method: "POST", body: { orgId: ORG, domain: "acme.co.jp" } })).status).toBe(403);
  const added = await (await call("/orgs/domains", owner, { method: "POST", body: { orgId: ORG, domain: "acme.co.jp" } })).json();
  expect(added.txtValue).toMatch(/^honmaru-verify=[a-z2-7]{32}$/);
  // Not there yet.
  const early = await call("/orgs/domains/verify", owner, { method: "POST", body: { orgId: ORG, domain: "acme.co.jp" } });
  expect(early.status).toBe(409);
  // Joining by an unproved domain is refused.
  expect((await call("/orgs/domains", owner, { method: "PUT", body: { orgId: ORG, domain: "acme.co.jp", joinPolicy: "auto" } })).status).toBe(400);
  txt.set("acme.co.jp", ["v=spf1 -all", added.txtValue]);
  expect((await call("/orgs/domains/verify", owner, { method: "POST", body: { orgId: ORG, domain: "acme.co.jp" } })).status).toBe(200);
  expect((await call("/orgs/domains", owner, { method: "PUT", body: { orgId: ORG, domain: "acme.co.jp", joinPolicy: "auto" } })).status).toBe(200);
  const listed = await (await call(`/orgs/domains?orgId=${ORG}`, admin)).json();
  expect(listed).toMatchObject({ canEdit: false, domains: [{ domain: "acme.co.jp", verified: true, joinPolicy: "auto" }] });
  // Another workspace cannot claim it now.
  const { upsertMembership } = await import("../src/db.js");
  await upsertMembership(env.DB, "team:rival", "7701", "owner");
  expect((await call("/orgs/domains", owner, { method: "POST", body: { orgId: "team:rival", domain: "acme.co.jp" } })).status).toBe(409);
});

const provedAndPolicy = async (policy) => {
  const added = await (await call("/orgs/domains", owner, { method: "POST", body: { orgId: ORG, domain: "acme.co.jp" } })).json();
  txt.set("acme.co.jp", [added.txtValue]);
  await call("/orgs/domains/verify", owner, { method: "POST", body: { orgId: ORG, domain: "acme.co.jp" } });
  await call("/orgs/domains", owner, { method: "PUT", body: { orgId: ORG, domain: "acme.co.jp", joinPolicy: policy } });
  return added;
};

test("auto: a proved address at the domain (or a subdomain) joins as a member; an unproved one does not", async () => {
  await provedAndPolicy("auto");
  await newcomer("7710", "aya@sales.acme.co.jp");
  expect(await domainJoin(env, "7710")).toEqual({ orgId: ORG });
  const row = await env.DB.prepare("SELECT role, joined_via FROM memberships WHERE org_id = ?1 AND user_github_id = '7710'").bind(ORG).first();
  expect(row).toEqual({ role: "member", joined_via: "domain" });
  await newcomer("7711", "ken@acme.co.jp", { proved: false });
  expect(await domainJoin(env, "7711")).toBe(null);
  await newcomer("7712", "eve@acme.co.jp.evil.com");
  expect(await domainJoin(env, "7712")).toBe(null);
});

test("request: they see the workspace, ask, and an admin lets them in", async () => {
  await provedAndPolicy("request");
  const ken = await newcomer("7720", "ken@acme.co.jp");
  expect(await domainJoin(env, "7720")).toBe(null);
  const offered = (await (await call("/orgs/joinable", ken)).json()).workspaces;
  expect(offered).toMatchObject([{ orgId: ORG, requested: false }]);
  expect((await call("/orgs/join-requests/ask", ken, { method: "POST", body: { orgId: ORG } })).status).toBe(200);
  const reqs = (await (await call(`/orgs/join-requests?orgId=${ORG}`, admin)).json()).requests;
  expect(reqs).toHaveLength(1);
  expect((await call("/orgs/join-requests", admin, { method: "POST", body: { orgId: ORG, ref: reqs[0].ref, approve: true } })).status).toBe(200);
  expect((await call(`/members?orgId=${ORG}`, ken)).status).toBe(200);
  const actions = (await env.DB.prepare("SELECT action FROM audit_events WHERE org_id = ?1").bind(ORG).all()).results.map((r) => r.action);
  expect(actions).toEqual(expect.arrayContaining(["member.join_requested", "member.join_approved", "member.joined"]));
});

test("a record gone three days running: no longer proved, nobody joins, and the log says so", async () => {
  await provedAndPolicy("auto");
  txt.set("acme.co.jp", []);
  const stale = () => env.DB.prepare("UPDATE org_domains SET last_checked_at = ?1").bind(new Date(Date.now() - 2 * 86_400_000).toISOString()).run();
  for (let day = 0; day < 2; day += 1) { await stale(); expect(await recheckDomains(env)).toEqual([]); }
  await stale();
  expect(await recheckDomains(env)).toEqual(["acme.co.jp"]);
  await newcomer("7730", "late@acme.co.jp");
  expect(await domainJoin(env, "7730")).toBe(null);
  const lost = await env.DB.prepare("SELECT severity FROM audit_events WHERE org_id = ?1 AND action = 'domain.verification_lost'").bind(ORG).first();
  expect(lost.severity).toBe("critical");
});
