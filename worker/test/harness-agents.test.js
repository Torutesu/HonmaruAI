import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { rememberRequest, modelForTier } from "../src/harness/agents.js";

// Agents as members (docs/kylon-gap-plan.md): a specialty, a tier, a memory
// of its own, skills, who may call it, and whether it waits to be named.

const ORG = "personal:hxagents";
let toru, mika, kenji;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const settle = async () => { while (pending.length) await pending.shift(); };
const call = async (path, init, over = {}) => {
  const res = await worker.fetch(new Request("https://example.com" + path, init), { ...env, OPENAI_API_KEY: undefined, ...over }, ctx);
  await settle();
  return res;
};
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const send = (method, path, token, body, over) => call(path, { method, headers: headers(token), body: JSON.stringify(body) }, over);
const get = (path, token) => call(path, { headers: headers(token) });
const q = (o) => new URLSearchParams(o).toString();
const MODEL = { OPENAI_API_KEY: "sk-test" };

let agentId;
beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  for (const [id, login, name, role] of [["9201", "toru", "Toru", "admin"], ["9202", "mika", "Mika", "member"], ["9203", "kenji", "Kenji", "member"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, role);
  }
  await upsertBusiness(env.DB, ORG, { name: "Ops", createdBy: "9201" });
  toru = await createSession(env.DB, "9201", "gho_t");
  mika = await createSession(env.DB, "9202", "gho_m");
  kenji = await createSession(env.DB, "9203", "gho_k");
  fetchMock.activate();
  // Everything here is the harness's; a simple workspace's agents are
  // untouched (the last test).
  await send("PUT", "/orgs/mode", toru, { orgId: ORG, mode: "harness" });
  const made = await send("POST", "/channels/agents", mika, { orgId: ORG, name: "Billy", handle: "billy", instructions: "You chase invoices.", scope: "team" });
  agentId = (await made.json()).agent.id;
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

/// The next chat completion, answered with `answer`; resolves to its body.
function nextCompletion(answer = "On it.") {
  let resolve;
  const seen = new Promise((r) => { resolve = r; });
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(400, { error: { message: "web_search not supported" } }).times(2);
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, (opts) => {
    resolve(JSON.parse(opts.body));
    return { choices: [{ message: { content: answer } }], usage: { prompt_tokens: 5, completion_tokens: 3 } };
  });
  return seen;
}

test("a profile: everyone reads it, its maker or an admin changes it", async () => {
  const fresh = await (await get(`/hx/agents/${agentId}/profile?${q({ orgId: ORG })}`, kenji)).json();
  expect(fresh).toMatchObject({ profile: { tier: "standard", mentionOnly: false, access: "everyone" }, canEdit: false, tiers: ["lite", "standard", "max"] });
  expect((await send("PUT", `/hx/agents/${agentId}/profile`, kenji, { orgId: ORG, tier: "max" })).status).toBe(403);
  expect((await send("PUT", `/hx/agents/${agentId}/profile`, mika, { orgId: ORG, tier: "huge" })).status).toBe(400);
  const set = await (await send("PUT", `/hx/agents/${agentId}/profile`, mika, { orgId: ORG, specialty: "Accounts receivable", tier: "max" })).json();
  expect(set.profile).toMatchObject({ specialty: "Accounts receivable", tier: "max" });
  expect((await send("PUT", `/hx/agents/${agentId}/profile`, toru, { orgId: ORG, mentionOnly: true })).status).toBe(200);
});

test("told to remember, an agent keeps it without a model, and reads it, its specialty and skills next time, at its tier", async () => {
  await send("PUT", `/hx/agents/${agentId}/profile`, mika, { orgId: ORG, specialty: "Accounts receivable", tier: "max" });
  const skill = (await (await send("POST", "/skills", mika, { orgId: ORG, name: "Dunning", body: "Day 7: polite nudge. Day 14: call." })).json()).skill;
  expect((await send("POST", `/hx/agents/${agentId}/skills`, mika, { orgId: ORG, skillId: skill.id })).status).toBe(200);

  const kept = await send("POST", "/channels/messages", kenji, { orgId: ORG, channel: "b:ops", body: "@billy remember that Acme pays on the 25th" }, MODEL);
  expect(kept.status).toBe(201);
  const asked = (await kept.json()).message;
  const thread = await (await get(`/channels/thread?${q({ orgId: ORG, channel: "b:ops", messageId: asked.id })}`, kenji)).json();
  expect(thread.replies[0]).toMatchObject({ kind: "agent", body: "Got it — I'll remember: Acme pays on the 25th" });
  const memory = await (await get(`/hx/agents/${agentId}/memory?${q({ orgId: ORG })}`, kenji)).json();
  expect(memory.memories.map((m) => m.text)).toEqual(["Acme pays on the 25th"]);

  const seen = nextCompletion("Nudge Acme after the 25th.");
  await send("POST", "/channels/messages", kenji, { orgId: ORG, channel: "b:ops", body: "@billy when should we chase Acme?" }, MODEL);
  const body = await seen;
  expect(body.model).toBe("gpt-4.1");
  const system = body.messages.find((m) => m.role === "system").content;
  expect(system).toContain("Your specialty: Accounts receivable");
  expect(system).toContain("## Dunning");
  expect(system).toContain("- Acme pays on the 25th");

  // Forgotten, one at a time or all at once — by its maker.
  expect((await call(`/hx/agents/${agentId}/memory?${q({ orgId: ORG, id: "*" })}`, { method: "DELETE", headers: headers(kenji) })).status).toBe(403);
  expect((await (await call(`/hx/agents/${agentId}/memory?${q({ orgId: ORG, id: "*" })}`, { method: "DELETE", headers: headers(mika) })).json()).deleted).toBe(1);
});

test("an agent kept to some people does not answer anyone else", async () => {
  await send("PUT", `/hx/agents/${agentId}/profile`, mika, { orgId: ORG, access: "people", people: ["toru"] });
  const sent = await send("POST", "/channels/messages", kenji, { orgId: ORG, channel: "b:ops", body: "@billy what is overdue?" }, MODEL);
  const asked = (await sent.json()).message;
  const thread = await (await get(`/channels/thread?${q({ orgId: ORG, channel: "b:ops", messageId: asked.id })}`, kenji)).json();
  expect(thread.replies).toEqual([]);
});

test("an agent that speaks only when named stays out of a thread it would only be continuing", async () => {
  const first = nextCompletion("Three are overdue.");
  const sent = await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:ops", body: "@billy what is overdue?" }, MODEL);
  await first;
  const asked = (await sent.json()).message;
  await send("PUT", `/hx/agents/${agentId}/profile`, mika, { orgId: ORG, mentionOnly: true });
  await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:ops", body: "and which is the oldest?", parentId: asked.id }, MODEL);
  const thread = await (await get(`/channels/thread?${q({ orgId: ORG, channel: "b:ops", messageId: asked.id })}`, mika)).json();
  expect(thread.replies.filter((r) => r.kind === "agent")).toHaveLength(1);
});

test("a remember request is read in English and Japanese, and a tier names a model only on OpenAI", () => {
  expect(rememberRequest("remember that invoices go out on the 25th")).toBe("invoices go out on the 25th");
  expect(rememberRequest("Please remember: Ken approves travel")).toBe("Ken approves travel");
  expect(rememberRequest("請求書は25日に送ると覚えておいて")).toBe("請求書は25日に送る");
  expect(rememberRequest("覚えて: 経費は月末締め")).toBe("経費は月末締め");
  expect(rememberRequest("what do you remember?")).toBeNull();
  expect(modelForTier({}, { providerName: "OpenAI", model: "gpt-4o-mini" }, "lite")).toBe("gpt-4.1-nano");
  expect(modelForTier({}, { providerName: "OpenRouter", model: "x" }, "max")).toBe("x");
});

test("in a simple workspace an agent is exactly what it was: no remembering, no profile in its prompt", async () => {
  await send("PUT", `/hx/agents/${agentId}/profile`, mika, { orgId: ORG, specialty: "Accounts receivable", access: "people", people: ["toru"] });
  await send("PUT", "/orgs/mode", toru, { orgId: ORG, mode: "simple" });
  const seen = nextCompletion("Noted.");
  await send("POST", "/channels/messages", kenji, { orgId: ORG, channel: "b:ops", body: "@billy remember that Acme pays on the 25th" }, MODEL);
  const body = await seen;
  expect(body.model).toBe("gpt-4o-mini");
  expect(body.messages.find((m) => m.role === "system").content).not.toContain("Your specialty");
  expect((await (await get(`/hx/agents/${agentId}/memory?${q({ orgId: ORG })}`, kenji)).json()).memories).toEqual([]);
});
