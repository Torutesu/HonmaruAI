import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { audit, verifyChain, toCsv } from "../src/audit.js";
import { describeDevice } from "../src/sessions.js";
import { accessFor, mayRead, audienceOf } from "../src/access.js";
import { listMembers } from "../src/team.js";
import { cleanKeywords, keywordHit } from "../src/quiet.js";
import { recipientsOf } from "../src/pushes.js";
import { parseQuery } from "../src/channels.js";

// Running a workspace a company can trust: where you are signed in, the
// audit log, guests who see only their channels, API keys that do only
// what they say, and webhooks you can read back and send again. Plus
// three things people use every day: keywords, search filters, bookmarks.

const ORG = "personal:admin";
let toru; let mika; let gus; let toruPhone;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const call = async (path, token, { method = "GET", body, headers = {} } = {}) => {
  const res = await worker.fetch(new Request(`https://example.com${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-session-token": token } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, ctx);
  while (pending.length) await pending.shift();
  return res;
};
const q = (o) => new URLSearchParams(o).toString();

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM rate_limits; DELETE FROM audit_events; DELETE FROM sessions; DELETE FROM conversation_members; DELETE FROM channel_messages; DELETE FROM channel_bookmarks; DELETE FROM org_webhooks; DELETE FROM webhook_deliveries; DELETE FROM api_tokens;");
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  for (const [id, login, name, role] of [["7101", "toru", "Toru", "admin"], ["7102", "mika", "Mika", "member"], ["7103", "gus", "Gus", "guest"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, role);
  }
  await env.DB.prepare("UPDATE memberships SET role = 'guest' WHERE user_github_id = '7103'").run();
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "7101" });
  await upsertBusiness(env.DB, ORG, { name: "Hotel", createdBy: "7101" });
  await env.DB.prepare("INSERT INTO conversation_members (org_id, channel, login, added_by, added_at) VALUES (?1, 'b:cafe', 'gus', 'toru', ?2)").bind(ORG, new Date().toISOString()).run();
  toru = await createSession(env.DB, "7101", "x", { client: "web", userAgent: MAC_CHROME, place: "Tokyo, JP" });
  toruPhone = await createSession(env.DB, "7101", "x", { client: "web", userAgent: IPHONE_SAFARI, place: "Osaka, JP" });
  mika = await createSession(env.DB, "7102", "x");
  gus = await createSession(env.DB, "7103", "x");
});
afterEach(() => fetchMock.deactivate?.());

test("where you are signed in: each device by name, one signed out, then all the others", async () => {
  expect(describeDevice(MAC_CHROME, "web")).toBe("Chrome on macOS");
  expect(describeDevice(IPHONE_SAFARI, "web")).toBe("Safari on iPhone");
  expect(describeDevice("HonmaruAI/1 CFNetwork/1568 Darwin/24.0.0", "ios")).toBe("iPhone app");

  const listed = await (await call("/sessions", toru)).json();
  expect(listed.sessions).toHaveLength(2);
  expect(listed.sessions[0]).toMatchObject({ current: true, device: "Chrome on macOS", place: "Tokyo, JP" });
  expect(JSON.stringify(listed)).not.toContain(toru);
  const phone = listed.sessions.find((s) => !s.current);

  const after = await (await call("/sessions", toru, { method: "DELETE", body: { ref: phone.ref } })).json();
  expect(after.ended).toBe(1);
  expect(after.sessions).toHaveLength(1);
  expect((await call("/sessions", toruPhone)).status).toBe(401);

  // Signing out here ends this one on the server too.
  expect((await call("/auth/logout", toru, { method: "POST" })).status).toBe(200);
  expect((await call("/sessions", toru)).status).toBe(401);
  const log = await env.DB.prepare("SELECT action FROM audit_events WHERE org_id = ?1 ORDER BY seq").bind(ORG).all();
  expect(log.results.map((r) => r.action)).toEqual(["auth.session_revoked", "auth.logout"]);
});

test("an admin signs a member out everywhere; a member cannot do it to anyone", async () => {
  const members = await (await call(`/members?${q({ orgId: ORG })}`, toru)).json();
  const mikaRef = members.members.find((m) => m.name === "Mika").ref;
  const toruRef = members.members.find((m) => m.name === "Toru").ref;
  expect((await call("/members/sessions", mika, { method: "DELETE", body: { orgId: ORG, ref: toruRef } })).status).toBe(403);
  const seen = await (await call(`/members/sessions?${q({ orgId: ORG, ref: mikaRef })}`, toru)).json();
  expect(seen.sessions).toHaveLength(1);
  expect(seen.sessions[0].ref).toBeUndefined();
  expect((await (await call("/members/sessions", toru, { method: "DELETE", body: { orgId: ORG, ref: mikaRef } })).json()).ended).toBe(1);
  expect((await call("/sessions", mika)).status).toBe(401);
});

test("the audit log: admins only, filtered, exported, and its chain holds", async () => {
  // Things happen: an invite, a rename, a refusal.
  expect((await call("/invites/create", toru, { method: "POST", body: { orgId: ORG, role: "member" } })).status).toBe(200);
  expect((await call("/orgs/name", toru, { method: "PUT", body: { orgId: ORG, name: "Admin Co" } })).status).toBe(200);
  expect((await call(`/audit/logs?${q({ orgId: ORG })}`, mika)).status).toBe(403);

  const page = await (await call(`/audit/logs?${q({ orgId: ORG })}`, toru, { headers: { "cf-connecting-ip": "203.0.113.9" } })).json();
  const actions = page.entries.map((e) => e.action);
  expect(actions).toEqual(expect.arrayContaining(["invite.created", "workspace.renamed", "security.permission_denied"]));
  const renamed = page.entries.find((e) => e.action === "workspace.renamed");
  expect(renamed).toMatchObject({ severity: "warning", outcome: "success", actor: { type: "user", name: "Toru" }, entity: { name: "Admin Co" } });
  expect(renamed.actor.ref).toMatch(/^[0-9a-f]{16}$/);
  // No logins in what a screen reads.
  expect(JSON.stringify(page)).not.toMatch(/"id":"(toru|mika)"/);

  const warnings = await (await call(`/audit/logs?${q({ orgId: ORG, severity: "warning" })}`, toru)).json();
  expect(warnings.entries.every((e) => ["warning", "critical"].includes(e.severity))).toBe(true);
  const byMika = await (await call(`/audit/logs?${q({ orgId: ORG, actor: page.entries.find((e) => e.actor?.name === "Mika").actor.ref })}`, toru)).json();
  expect(byMika.entries.map((e) => e.action)).toEqual(["security.permission_denied"]);

  const csv = await (await call(`/audit/logs?${q({ orgId: ORG, format: "csv" })}`, toru)).text();
  expect(csv.split("\n")[0]).toBe("date,action,severity,outcome,actor,actor_type,entity,entity_type,country,client,ip_address,details");
  expect(csv).toContain("workspace.renamed");
  // Reading and exporting it are on it too.
  const all = await env.DB.prepare("SELECT action FROM audit_events WHERE org_id = ?1").bind(ORG).all();
  expect(all.results.map((r) => r.action)).toEqual(expect.arrayContaining(["audit.viewed", "audit.exported"]));

  expect(await verifyChain(env.DB, ORG)).toMatchObject({ ok: true });
  // An edited row breaks it.
  await env.DB.prepare("UPDATE audit_events SET body = replace(body, 'Admin Co', 'Other Co') WHERE org_id = ?1 AND action = 'workspace.renamed'").bind(ORG).run();
  expect(await verifyChain(env.DB, ORG)).toMatchObject({ ok: false, reason: "hash" });
});

test("a spreadsheet never runs what the log says", () => {
  const csv = toCsv([{ date_create: 0, action: "x", severity: "info", outcome: "success", actor: { name: "=HYPERLINK(1)", type: "user" }, entity: null, context: {}, details: null }]);
  expect(csv).toContain("'=HYPERLINK(1)");
});

test("audit() never throws, and numbers every event in order", async () => {
  await audit(env, null, { orgId: ORG, action: "auth.login", actor: { type: "user", id: "toru", name: "Toru" } });
  await audit(env, null, { orgId: ORG, action: "auth.logout", actor: { type: "user", id: "toru", name: "Toru" } });
  expect(await audit({ DB: null }, null, { orgId: ORG, action: "auth.login" })).toBe(null);
  const { results } = await env.DB.prepare("SELECT seq FROM audit_events WHERE org_id = ?1 ORDER BY seq").bind(ORG).all();
  expect(results.map((r) => r.seq)).toEqual([1, 2]);
});

test("a guest sees only the channels they were let into", async () => {
  const members = await listMembers(env.DB, ORG, null);
  const access = await accessFor(env.DB, ORG, "gus");
  expect(access.guest).toBe(true);
  expect(mayRead("b:cafe", access)).toBe(true);
  expect(mayRead("b:hotel", access)).toBe(false);
  expect(mayRead("b:hotel", await accessFor(env.DB, ORG, "mika"))).toBe(true);
  // A public channel in a workspace with guests is named person by person.
  expect(await audienceOf(env.DB, ORG, "b:hotel")).toEqual(["toru", "mika"]);
  expect(await audienceOf(env.DB, ORG, "b:cafe")).toEqual(["toru", "mika", "gus"]);

  const list = await (await call(`/businesses?${q({ orgId: ORG })}`, gus)).json();
  expect(list.businesses.map((b) => b.slug)).toEqual(["cafe"]);
  expect((await call(`/channels/messages?${q({ orgId: ORG, channel: "b:hotel" })}`, gus)).status).toBe(404);
  expect((await call(`/channels/messages?${q({ orgId: ORG, channel: "b:cafe" })}`, gus)).status).toBe(200);
  // Search does not reach past the door either.
  await env.DB.prepare("INSERT INTO channel_messages (id, org_id, channel, author_login, body, kind, created_at) VALUES ('h1', ?1, 'b:hotel', 'mika', 'room rates secret', 'message', ?2)").bind(ORG, new Date().toISOString()).run();
  const found = await (await call(`/channels/search?${q({ orgId: ORG, q: "rates" })}`, gus)).json();
  expect(found.messages).toHaveLength(0);
  expect(members.length).toBe(3);

  // A guest cannot make channels, invitations, keys or webhooks.
  expect((await call("/businesses", gus, { method: "POST", body: { orgId: ORG, name: "Mine" } })).status).toBe(403);
  expect((await call("/invites/create", gus, { method: "POST", body: { orgId: ORG, role: "guest", channels: ["cafe"] } })).status).toBe(400);
  expect((await call("/tokens", gus, { method: "POST", body: { orgId: ORG, name: "x" } })).status).toBe(403);
});

test("a guest is invited to chosen channels, and an admin changes their role and channels", async () => {
  expect((await call("/invites/create", toru, { method: "POST", body: { orgId: ORG, role: "guest" } })).status).toBe(400);
  const invite = await (await call("/invites/create", toru, { method: "POST", body: { orgId: ORG, role: "guest", channels: ["hotel"] } })).json();
  const { createSession, upsertUser } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "7104", login: "vic", name: "Vic", avatarUrl: null, locale: "en" });
  const vic = await createSession(env.DB, "7104", "x");
  const joined = await (await call("/invites/accept", vic, { method: "POST", body: { code: invite.code } })).json();
  expect(joined.orgId).toBe(ORG);
  expect((await accessFor(env.DB, ORG, "vic")).in.has("b:hotel")).toBe(true);
  expect(mayRead("b:cafe", await accessFor(env.DB, ORG, "vic"))).toBe(false);

  const members = (await (await call(`/members?${q({ orgId: ORG })}`, toru)).json()).members;
  const gusRef = members.find((m) => m.name === "Gus").ref;
  const toruRef = members.find((m) => m.name === "Toru").ref;
  // Mika is not an admin.
  expect((await call("/members/role", mika, { method: "PUT", body: { orgId: ORG, ref: gusRef, role: "member" } })).status).toBe(403);
  // Gus's channels: Hotel instead of Cafe.
  const moved = await (await call("/members/role", toru, { method: "PUT", body: { orgId: ORG, ref: gusRef, channels: ["hotel"] } })).json();
  expect(moved).toMatchObject({ role: "guest", channels: ["hotel"] });
  const gusAccess = await accessFor(env.DB, ORG, "gus");
  expect([mayRead("b:cafe", gusAccess), mayRead("b:hotel", gusAccess)]).toEqual([false, true]);
  // Made a member: every public channel.
  expect((await (await call("/members/role", toru, { method: "PUT", body: { orgId: ORG, ref: gusRef, role: "member" } })).json()).role).toBe("member");
  expect(mayRead("b:cafe", await accessFor(env.DB, ORG, "gus"))).toBe(true);
  expect((await call("/members/role", toru, { method: "PUT", body: { orgId: ORG, ref: toruRef, role: "member" } })).status).toBe(400);
  const log = await env.DB.prepare("SELECT action FROM audit_events WHERE org_id = ?1").bind(ORG).all();
  expect(log.results.map((r) => r.action)).toEqual(expect.arrayContaining(["member.joined", "member.channels_changed", "member.role_changed"]));
});

test("API keys carry scopes: a read key cannot ask, an audit key reads the log", async () => {
  const made = await (await call("/tokens", toru, { method: "POST", body: { orgId: ORG, name: "Reader", scopes: ["read"] } })).json();
  expect(made.scopes).toEqual(["read"]);
  const mcp = (token, body) => worker.fetch(new Request("https://example.com/mcp", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }), env, ctx);
  const tools = await (await mcp(made.token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  expect(tools.result.tools.map((t) => t.name)).not.toContain("request_decision");
  const asked = await (await mcp(made.token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "request_decision", arguments: { title: "Ship?" } } })).json();
  expect(asked.result.isError).toBe(true);
  // Without audit:read the log is closed to it.
  expect((await call(`/audit/logs?${q({ orgId: ORG })}`, null, { headers: { authorization: `Bearer ${made.token}` } })).status).toBe(403);

  const auditor = await (await call("/tokens", toru, { method: "POST", body: { orgId: ORG, name: "SIEM", scopes: ["audit:read"] } })).json();
  const read = await call(`/audit/logs?${q({ orgId: ORG })}`, null, { headers: { authorization: `Bearer ${auditor.token}` } });
  expect(read.status).toBe(200);
  expect((await read.json()).entries.map((e) => e.action)).toEqual(expect.arrayContaining(["api_token.created"]));

  // A key made before scopes keeps read and write.
  await env.DB.prepare("UPDATE api_tokens SET scopes = NULL WHERE name = 'Reader'").run();
  const listed = await (await call(`/tokens?${q({ orgId: ORG })}`, toru)).json();
  expect(listed.tokens.find((t) => t.name === "Reader").scopes).toEqual(["read", "write"]);
  expect(listed.scopes).toEqual(["read", "write", "audit:read"]);
});

test("a webhook's deliveries are kept, can be sent again, and its secret replaced", async () => {
  const made = await (await call("/webhooks", mika, { method: "POST", body: { orgId: ORG, url: "https://log-hooks.example.com/in", events: ["message.created"] } })).json();
  const id = made.webhook.id;
  let calls = 0;
  fetchMock.activate();
  fetchMock.get("https://log-hooks.example.com").intercept({ path: "/in", method: "POST" }).reply(() => { calls += 1; return { statusCode: calls === 1 ? 500 : 200, data: "" }; }).persist();
  const tested = await (await call(`/webhooks/${id}/test`, mika, { method: "POST", body: { orgId: ORG } })).json();
  expect(tested.status).toBe(500);

  const log = await (await call(`/webhooks/${id}/deliveries?${q({ orgId: ORG })}`, mika)).json();
  expect(log.deliveries).toHaveLength(1);
  expect(log.deliveries[0]).toMatchObject({ event: "webhook.test", status: 500, ok: false, redelivery: false });
  expect(log.deliveries[0].body.type).toBe("webhook.test");
  // Somebody else's, unless an admin.
  expect((await call(`/webhooks/${id}/deliveries?${q({ orgId: ORG })}`, gus)).status).toBe(403);
  expect((await call(`/webhooks/${id}/deliveries?${q({ orgId: ORG })}`, toru)).status).toBe(200);

  const again = await (await call(`/webhooks/${id}/deliveries/${log.deliveries[0].id}/redeliver`, mika, { method: "POST", body: { orgId: ORG } })).json();
  expect(again).toMatchObject({ ok: true, status: 200, delivery: { redelivery: true, eventId: log.deliveries[0].eventId } });

  const rotated = await (await call(`/webhooks/${id}/rotate`, mika, { method: "POST", body: { orgId: ORG } })).json();
  expect(rotated.secret).toMatch(/^whsec_/);
  expect(rotated.secret).not.toBe(made.secret);
  const actions = (await env.DB.prepare("SELECT action FROM audit_events WHERE org_id = ?1").bind(ORG).all()).results.map((r) => r.action);
  expect(actions).toEqual(expect.arrayContaining(["webhook.created", "webhook.redelivered", "webhook.secret_rotated"]));
});

test("keywords reach a person wherever they are said, and appear in Activity", async () => {
  expect(cleanKeywords(["Invoice", "invoice", " 見積 ", "a", ""])).toEqual(["Invoice", "見積"]);
  expect(keywordHit("Where is the invoice?", ["invoice"])).toBe("invoice");
  expect(keywordHit("invoices", ["invoice"])).toBe(null);
  expect(keywordHit("来週の見積を送ります", ["見積"])).toBe("見積");

  const set = await (await call("/me", mika, { method: "PUT", body: { notifyKeywords: ["invoice", "見積"] } })).json();
  expect(set.notifyKeywords).toEqual(["invoice", "見積"]);
  const members = await listMembers(env.DB, ORG, null);
  const row = { id: "k1", org_id: ORG, channel: "b:hotel", author_login: "toru", body: "The invoice is late", kind: "message", created_at: new Date().toISOString() };
  await env.DB.prepare("INSERT INTO channel_messages (id, org_id, channel, author_login, body, kind, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'message', ?6)").bind(row.id, ORG, row.channel, row.author_login, row.body, row.created_at).run();
  expect(await recipientsOf(env.DB, ORG, row, members)).toEqual([{ login: "mika", reason: "keyword" }]);
  // A guest's keyword does not open a channel they are not in.
  await env.DB.prepare("UPDATE users SET notify_keywords = '[\"invoice\"]' WHERE login = 'gus'").run();
  expect((await recipientsOf(env.DB, ORG, row, members)).map((r) => r.login)).toEqual(["mika"]);

  const activity = await (await call(`/channels/activity?${q({ orgId: ORG })}`, mika)).json();
  expect(activity.items[0]).toMatchObject({ type: "keyword", keyword: "invoice" });
});

test("search filters: has, is, on, during, to, phrases and exclusions", async () => {
  const q1 = parseQuery('"cost sheet" -draft has:file has:link is:thread on:2026-09-01 in:@mika');
  expect(q1).toMatchObject({ phrases: ["cost sheet"], not: ["draft"], hasList: ["file", "link"], isList: ["thread"], on: "2026-09-01", in: "mika", inPerson: true });
  expect(parseQuery("price from:@mika in:#cafe is:pinned")).toMatchObject({ text: "price", from: "mika", in: "cafe", is: "pinned" });

  const put = (id, channel, body, at, extra = "") => env.DB.prepare(`INSERT INTO channel_messages (id, org_id, channel, author_login, body, kind, created_at${extra ? ", parent_id" : ""}) VALUES (?1, ?2, ?3, 'toru', ?4, 'message', ?5${extra ? ", ?6" : ""})`)
    .bind(...[id, ORG, channel, body, at, ...(extra ? [extra] : [])]).run();
  await put("s1", "b:cafe", "menu link https://example.com/menu", "2026-09-01T03:00:00Z");
  await put("s2", "b:cafe", "menu draft", "2026-09-02T03:00:00Z");
  await put("s3", "b:cafe", "menu reply", "2026-09-02T04:00:00Z", "s1");
  await put("s4", "dm:mika|toru", "menu in private", "2026-09-03T03:00:00Z");
  await env.DB.prepare("INSERT INTO message_reactions (org_id, message_id, emoji, login, created_at) VALUES (?1, 's2', '👍', 'mika', ?2)").bind(ORG, "2026-09-02T05:00:00Z").run();
  const find = async (query) => (await (await call(`/channels/search?${q({ orgId: ORG, q: query })}`, mika)).json()).messages.map((m) => m.id);
  expect(await find("menu has:link")).toEqual(["s1"]);
  expect(await find("menu -draft -reply -private")).toEqual(["s1"]);
  expect(await find("menu is:thread")).toEqual(["s3"]);
  expect(await find("menu has:reaction")).toEqual(["s2"]);
  expect(await find("menu on:2026-09-02")).toEqual(["s3", "s2"]);
  expect(await find("during:2026-09")).toEqual(["s4", "s3", "s2", "s1"]);
  expect(await find("menu is:dm")).toEqual(["s4"]);
  expect(await find("in:@toru")).toEqual(["s4"]);
  expect(await find('"menu in"')).toEqual(["s4"]);
});

test("bookmarks at the top of a conversation", async () => {
  const add = await call("/channels/bookmarks", mika, { method: "POST", body: { orgId: ORG, channel: "b:cafe", url: "https://docs.example.com/menu", title: "" } });
  expect(add.status).toBe(201);
  const { bookmarks } = await add.json();
  expect(bookmarks).toEqual([expect.objectContaining({ title: "docs.example.com", url: "https://docs.example.com/menu", addedBy: "Mika", mine: true })]);
  expect((await call("/channels/bookmarks", mika, { method: "POST", body: { orgId: ORG, channel: "b:cafe", url: "javascript:alert(1)" } })).status).toBe(400);
  // The guest in Cafe sees it; not Hotel's.
  expect((await (await call(`/channels/bookmarks?${q({ orgId: ORG, channel: "b:cafe" })}`, gus)).json()).bookmarks).toHaveLength(1);
  expect((await call(`/channels/bookmarks?${q({ orgId: ORG, channel: "b:hotel" })}`, gus)).status).toBe(404);
  // Renamed by anyone in it; removed by its maker or an admin.
  await call("/channels/bookmarks", gus, { method: "PUT", body: { orgId: ORG, channel: "b:cafe", id: bookmarks[0].id, title: "Menu" } });
  expect((await (await call(`/channels/bookmarks?${q({ orgId: ORG, channel: "b:cafe" })}`, toru)).json()).bookmarks[0].title).toBe("Menu");
  expect((await call("/channels/bookmarks", gus, { method: "DELETE", body: { orgId: ORG, channel: "b:cafe", id: bookmarks[0].id } })).status).toBe(403);
  expect((await call("/channels/bookmarks", toru, { method: "DELETE", body: { orgId: ORG, channel: "b:cafe", id: bookmarks[0].id } })).status).toBe(200);
});
