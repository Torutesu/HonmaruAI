import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { findMember } from "../src/mcp.js";

// Any agent can ask a person for a decision over MCP. A token per agent,
// scoped to one workspace; the decision lands in the person's feed and the
// agent reads the answer back.

const ORG = "personal:mcp";
let toru;
let mika;
const call = (path, init) => worker.fetch(new Request("https://example.com" + path, init), env);
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
let seq = 0;
const rpc = (bearer, method, params) => call("/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
  body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, ...(params ? { params } : {}) }),
});
const tool = async (bearer, name, args = {}) => (await (await rpc(bearer, "tools/call", { name, arguments: args })).json()).result;

async function mintToken(session, name = "Claude Code") {
  const res = await call("/tokens", { method: "POST", headers: headers(session), body: JSON.stringify({ orgId: ORG, name }) });
  return res.json();
}

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, saveCard } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "8701", login: "toru", name: "Toru Tesu", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "8702", login: "u:mika@example.com", name: "Mika", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "8703", login: "nobody", name: "Nobody", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "8701", "admin");
  await upsertMembership(env.DB, ORG, "8702", "member");
  await upsertMembership(env.DB, "personal:other", "8703", "admin");
  toru = await createSession(env.DB, "8701", "gho_toru");
  mika = await createSession(env.DB, "8702", "gho_mika");
  await saveCard(env.DB, ORG, {
    id: "old", recipientUserID: "toru", senderUserID: "u:mika@example.com", type: "approval", title: "Ship the Friday release",
    status: "approved", createdAt: "2026-09-01T00:00:00Z",
    decision: { action: "approve", actorUserID: "toru", decidedAt: "2026-09-01T02:00:00Z", note: "Only with the rollback plan" },
  });
});

test("a token is shown once, listed by prefix, and revoked", async () => {
  const made = await mintToken(toru);
  expect(made.token).toMatch(/^hm_[0-9a-f]{64}$/);
  expect(made.endpoint).toBe("https://example.com/mcp");
  const list = await (await call(`/tokens?orgId=${encodeURIComponent(ORG)}`, { headers: headers(toru) })).json();
  expect(list.tokens).toEqual([expect.objectContaining({ id: made.id, name: "Claude Code", prefix: made.token.slice(0, 10), lastUsedAt: null })]);
  expect(JSON.stringify(list)).not.toContain(made.token);
  // Stored only as a hash.
  const row = await env.DB.prepare("SELECT token_hash FROM api_tokens").first();
  expect(row.token_hash).not.toContain(made.token);
  // Mika cannot see or revoke Toru's.
  expect((await (await call(`/tokens?orgId=${encodeURIComponent(ORG)}`, { headers: headers(mika) })).json()).tokens).toEqual([]);
  expect((await call(`/tokens/${made.id}?orgId=${encodeURIComponent(ORG)}`, { method: "DELETE", headers: headers(mika) })).status).toBe(404);
  expect((await call(`/tokens/${made.id}?orgId=${encodeURIComponent(ORG)}`, { method: "DELETE", headers: headers(toru) })).status).toBe(200);
  expect((await rpc(made.token, "tools/list")).status).toBe(401);
});

test("an agent initializes, lists the tools, and without a token is refused", async () => {
  const { token } = await mintToken(toru);
  const init = await (await rpc(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })).json();
  expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "honmaru" }, capabilities: { tools: {} } });
  const note = await call("/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  expect(note.status).toBe(202);
  const list = await (await rpc(token, "tools/list")).json();
  expect(list.result.tools.map((t) => t.name)).toEqual(["request_decision", "get_decision", "list_pending", "search_decisions", "list_members", "get_playbook"]);
  const refused = await rpc(null, "tools/list");
  expect(refused.status).toBe(401);
  expect(refused.headers.get("www-authenticate")).toContain("Bearer");
  expect((await rpc("hm_" + "0".repeat(64), "tools/list")).status).toBe(401);
  const unknown = await (await rpc(token, "resources/list")).json();
  expect(unknown.error.code).toBe(-32601);
});

test("request_decision puts a card in a teammate's feed, and get_decision reads the answer", async () => {
  const { token } = await mintToken(toru, "Release bot");
  const asked = await tool(token, "request_decision", {
    to: "mika", title: "Approve the 2.4 release?", summary: "All checks green; I recommend shipping.", priority: "high",
  });
  expect(asked.isError).toBeUndefined();
  const { cardId, recipient, status } = asked.structuredContent;
  expect({ recipient, status }).toEqual({ recipient: "Mika", status: "pending" });
  const { getCard, saveCard } = await import("../src/db.js");
  const card = await getCard(env.DB, ORG, cardId);
  expect(card).toMatchObject({
    recipientUserID: "u:mika@example.com", senderUserID: "toru", type: "approval", priority: "high",
    sourceApp: "Agent", sourceDetail: "Release bot", title: "Approve the 2.4 release?",
  });
  const event = await env.DB.prepare("SELECT type, actor_user_id FROM card_events WHERE card_id = ?1").bind(cardId).first();
  expect(event).toMatchObject({ type: "created", actor_user_id: "toru" });

  expect((await tool(token, "get_decision", { cardId })).structuredContent).toMatchObject({ status: "pending" });
  await saveCard(env.DB, ORG, { ...card, status: "approved", decision: { action: "approve", actorUserID: "u:mika@example.com", note: "Go", decidedAt: "2026-09-24T01:00:00Z" } });
  expect((await tool(token, "get_decision", { cardId })).structuredContent).toMatchObject({ status: "approved", decision: { action: "approve", note: "Go" } });

  // What Toru is waiting on from others.
  const sent = (await tool(token, "list_pending", { direction: "sent" })).structuredContent;
  expect(sent.decisions).toEqual([]);
});

test("a name that is nobody on the team is an error that lists who is", async () => {
  const { token } = await mintToken(toru);
  const out = await tool(token, "request_decision", { to: "Nobody", title: "Anything" });
  expect(out.isError).toBe(true);
  expect(out.content[0].text).toContain("Mika");
  const missing = await tool(token, "request_decision", { to: "mika" });
  expect(missing.isError).toBe(true);
});

test("an agent reads only its owner's cards, searches decisions, and reads the playbook", async () => {
  const { token } = await mintToken(mika);
  const { saveCard } = await import("../src/db.js");
  await saveCard(env.DB, ORG, { id: "private", recipientUserID: "toru", senderUserID: "toru", title: "Toru's own", status: "pending", createdAt: "2026-09-02T00:00:00Z" });
  expect((await tool(token, "get_decision", { cardId: "private" })).isError).toBe(true);
  const found = (await tool(token, "search_decisions", { query: "release" })).structuredContent;
  expect(found.decisions[0]).toMatchObject({ title: "Ship the Friday release", note: "Only with the rollback plan" });
  const members = (await tool(token, "list_members")).structuredContent.members;
  expect(members).toEqual([{ name: "Toru Tesu", title: "admin", you: false }, { name: "Mika", title: "member", you: true }]);
  // No logins — an email address is somebody's inbox.
  expect(JSON.stringify(members)).not.toContain("@");
  await call("/memories", { method: "POST", headers: headers(toru), body: JSON.stringify({ orgId: ORG, text: "Releases ship only with a rollback plan." }) });
  expect((await tool(token, "get_playbook")).structuredContent.rules).toEqual(["Releases ship only with a rollback plan."]);
});

test("a token stops working the moment its owner leaves the workspace", async () => {
  const { token } = await mintToken(mika);
  expect((await rpc(token, "tools/list")).status).toBe(200);
  await env.DB.prepare("DELETE FROM memberships WHERE org_id = ?1 AND user_github_id = '8702'").bind(ORG).run();
  expect((await rpc(token, "tools/list")).status).toBe(401);
});

test("names match whole, and a name two people share matches nobody", () => {
  const members = [{ name: "Mika Sato", login: "a", ref: "r1" }, { name: "Mika Ito", login: "b", ref: "r2" }, { name: "Kenji", login: "c", ref: "r3", aliases: ["ケンジ"] }];
  expect(findMember(members, "mika")).toBeNull();
  expect(findMember(members, "Mika Ito").login).toBe("b");
  expect(findMember(members, "ケンジ").login).toBe("c");
  expect(findMember(members, "member:r3").login).toBe("c");
  expect(findMember(members, "sato").login).toBe("a");
});

test("the request limit is a person's, not a token's", async () => {
  const one = (await mintToken(toru, "one")).token;
  const two = (await mintToken(toru, "two")).token;
  for (let i = 0; i < 30; i++) {
    const out = await tool(i % 2 ? one : two, "request_decision", { title: `Ask ${i}` });
    expect(out.isError).toBeUndefined();
  }
  const refused = await tool(two, "request_decision", { title: "One more" });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain("Too many");
});
