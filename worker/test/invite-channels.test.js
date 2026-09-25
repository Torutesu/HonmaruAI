import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// An invitation names the channels a new person is introduced in, and an
// agent comes in by a link that works once, for fifteen minutes.

const ORG = "personal:invites";
let toru; let newcomer; let outsider;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const call = async (path, token, { method = "GET", body } = {}) => {
  const res = await worker.fetch(new Request("https://example.com" + path, {
    method, headers: { "x-session-token": token || "", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, ctx);
  while (pending.length) await pending.shift();
  return res;
};
const said = async (slug) => (await env.DB.prepare(
  "SELECT body FROM channel_messages WHERE org_id = ?1 AND channel = ?2 ORDER BY created_at ASC"
).bind(ORG, `b:${slug}`).all()).results.map((r) => r.body);

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM channel_messages; DELETE FROM invites; DELETE FROM agent_invites; DELETE FROM api_tokens; DELETE FROM rate_limits;");
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9701", login: "u:toru@x.jp", name: "Toru", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "9702", login: "u:gota@x.jp", name: "Gota", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "9703", login: "u:eve@x.jp", name: "Eve", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "9701", "admin");
  await upsertMembership(env.DB, "personal:gota", "9702", "admin");
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "9701" });
  await upsertBusiness(env.DB, ORG, { name: "Roastery", createdBy: "9701" });
  toru = await createSession(env.DB, "9701", "gho_t");
  newcomer = await createSession(env.DB, "9702", "gho_g");
  outsider = await createSession(env.DB, "9703", "gho_e");
});

test("a person who takes an invitation is introduced in the channels it named, and only those", async () => {
  const made = await (await call("/invites/create", toru, { method: "POST", body: { orgId: ORG, role: "member", channels: ["cafe", "nowhere"] } })).json();
  expect(made.channels).toEqual(["cafe"]);
  const joined = await call("/invites/accept", newcomer, { method: "POST", body: { code: made.code } });
  expect(joined.status).toBe(200);
  // In the inviter's language, since the channel is theirs.
  expect(await said("cafe")).toEqual(["Gotaさんがワークスペースに参加しました。ようこそ！"]);
  expect(await said("roastery")).toEqual([]);
  // Taking it again adds nobody, and says nothing twice.
  await call("/invites/accept", newcomer, { method: "POST", body: { code: made.code } });
  expect(await said("cafe")).toHaveLength(1);
});

test("an agent link mints a token once, for the member who made it, and introduces the agent", async () => {
  expect((await call("/agents/invite", outsider, { method: "POST", body: { orgId: ORG } })).status).toBe(403);
  const link = await (await call("/agents/invite", toru, { method: "POST", body: { orgId: ORG, channels: ["roastery"] } })).json();
  expect(link.url).toMatch(/^https:\/\/example\.com\/agents\/join\/[0-9a-f]{48}$/);
  expect(Date.parse(link.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);

  const path = new URL(link.url).pathname;
  const opened = await call(`${path}?name=${encodeURIComponent("Claude Code")}`, null);
  expect(opened.status).toBe(201);
  const got = await opened.json();
  expect(got).toMatchObject({ agent: "Claude Code", endpoint: "https://example.com/mcp" });
  expect(got.token).toMatch(/^hm_/);
  expect(got.claudeCode).toContain(got.token);
  // The token is Toru's, listed with his.
  const tokens = await (await call(`/tokens?orgId=${encodeURIComponent(ORG)}`, toru)).json();
  expect(tokens.tokens.map((t) => t.name)).toEqual(["Claude Code"]);
  expect(await said("roastery")).toEqual(["エージェント「Claude Code」が参加しました（Toruさんの代わりに動きます）。"]);

  // Once.
  expect((await call(path, null)).status).toBe(410);
});

test("an expired agent link lets nobody in", async () => {
  const link = await (await call("/agents/invite", toru, { method: "POST", body: { orgId: ORG } })).json();
  await env.DB.prepare("UPDATE agent_invites SET expires_at = ?1").bind(new Date(Date.now() - 1000).toISOString()).run();
  expect((await call(new URL(link.url).pathname, null)).status).toBe(410);
});
