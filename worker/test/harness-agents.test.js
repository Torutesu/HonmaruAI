import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { rememberRequest, modelForTier, filterResponders } from "../src/harness/agents.js";

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
  // Most tests exercise an explicitly shared agent, not the creation default.
  await send("PUT", "/channels/agents", mika, { orgId: ORG, id: agentId, scope: "team" });
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

test("a profile: everyone reads it, only its owner or assigned agent admin changes it", async () => {
  const fresh = await (await get(`/hx/agents/${agentId}/profile?${q({ orgId: ORG })}`, kenji)).json();
  expect(fresh).toMatchObject({ profile: { tier: "standard", mentionOnly: false, access: "everyone" }, canEdit: false, tiers: ["lite", "standard", "max"] });
  expect((await send("PUT", `/hx/agents/${agentId}/profile`, kenji, { orgId: ORG, tier: "max" })).status).toBe(403);
  expect((await send("PUT", `/hx/agents/${agentId}/profile`, mika, { orgId: ORG, tier: "huge" })).status).toBe(400);
  const set = await (await send("PUT", `/hx/agents/${agentId}/profile`, mika, { orgId: ORG, specialty: "Accounts receivable", tier: "max" })).json();
  expect(set.profile).toMatchObject({ specialty: "Accounts receivable", tier: "max" });
  expect((await send("PUT", `/hx/agents/${agentId}/profile`, toru, { orgId: ORG, mentionOnly: true })).status).toBe(403);
  const roles=await(await get(`/hx/agents/${agentId}/members?${q({orgId:ORG})}`,mika)).json();
  const ref=roles.candidates.find(p=>p.name==='Toru').ref;
  expect((await send('PUT',`/hx/agents/${agentId}/members`,mika,{orgId:ORG,ref,role:'admin',expectedVersion:0})).status).toBe(200);
  expect((await send("PUT", `/hx/agents/${agentId}/profile`, toru, { orgId: ORG, mentionOnly: true })).status).toBe(200);
});

test('profile audience changes refresh only the affected members without sharing profile data',async()=>{
 const events=[];
 const relayStub={fetch:async(_url,init)=>{events.push(JSON.parse(init.body));return new Response('{}')}};
 const relay={idFromName:id=>id,get:()=>relayStub};
 const response=await send('PUT',`/hx/agents/${agentId}/profile`,mika,{orgId:ORG,access:'people',people:['toru']},{ORG_RELAY:relay});
 expect(response.status).toBe(200);
 expect(events).toHaveLength(1);
 const deliveries=events[0].deliveries;
 expect(deliveries.map(item=>item.to).sort()).toEqual(['kenji','mika','toru']);
 expect(deliveries.every(item=>item.event.name==='agent_access_changed'&&item.event.value.agentId===agentId&&Object.keys(item.event.value).sort().join(',')==='agentId,version')).toBe(true);
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
  const memory = await (await get(`/hx/agents/${agentId}/memory?${q({ orgId: ORG, channel: "b:ops" })}`, kenji)).json();
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
  expect((await call(`/hx/agents/${agentId}/memory?${q({ orgId: ORG, id: "*", channel: "b:ops" })}`, { method: "DELETE", headers: headers(kenji) })).status).toBe(403);
  expect((await (await call(`/hx/agents/${agentId}/memory?${q({ orgId: ORG, id: "*", channel: "b:ops" })}`, { method: "DELETE", headers: headers(mika) })).json()).deleted).toBe(1);
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
  await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:ops", body: "@billy remember that Acme pays on the 25th" }, MODEL);
  const body = await seen;
  expect(body.model).toBe("gpt-4o-mini");
  expect(body.messages.find((m) => m.role === "system").content).not.toContain("Your specialty");
  expect((await (await get(`/hx/agents/${agentId}/memory?${q({ orgId: ORG })}`, mika)).json()).memories).toEqual([]);
});

test("restricted agent data stays private through direct APIs, listings and Simple mode", async () => {
  await send("POST", `/hx/agents/${agentId}/memory`, mika, { orgId: ORG, text: "Private pricing" });
  await send("PUT", `/hx/agents/${agentId}/profile`, mika, { orgId: ORG, access: "private" });
  for (const mode of ["harness", "simple"]) {
    await send("PUT", "/orgs/mode", toru, { orgId: ORG, mode });
    for (const token of [kenji, toru]) {
      for (const sub of ["profile", "memory", "skills"]) {
        expect((await get(`/hx/agents/${agentId}/${sub}?${q({ orgId: ORG })}`, token)).status).toBe(404);
      }
      expect((await send("POST", `/hx/agents/${agentId}/memory`, token, { orgId: ORG, text: "Poison memory" })).status).toBe(404);
      expect((await send("PUT", "/channels/agents", token, { orgId: ORG, id: agentId, instructions: "Replace private agent" })).status).toBe(404);
      expect((await get(`/channels/messages?${q({ orgId: ORG, channel: `ag:${agentId}` })}`, token)).status).toBe(404);
      const listing = await (await get(`/channels/agents?${q({ orgId: ORG })}`, token)).json();
      expect(listing.agents.some((a) => a.id === agentId)).toBe(false);
    }
    const kept = await (await get(`/hx/agents/${agentId}/memory?${q({ orgId: ORG })}`, mika)).json();
    expect(kept.memories.map((m) => m.text)).toEqual(["Private pricing"]);
  }
});

test("the channel overview does not advertise a restricted agent placed in a readable room", async () => {
  await send("PUT", `/hx/agents/${agentId}/profile`, mika, { orgId: ORG, access: "private" });
  const placed = await send("POST", "/channels/channel-agents", mika, { orgId: ORG, channel: "b:ops", agentId });
  expect(placed.status).toBe(200);

  const overview = await (await get(`/channels?${q({ orgId: ORG })}`, kenji)).json();
  expect(overview.agents.some((agent) => agent.id === agentId || agent.handle === "billy")).toBe(false);
});

test("profile lookup failures do not silently grant access", async () => {
  const { getProfile, profilesFor } = await import("../src/harness/agents.js");
  const db = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("DB unavailable"); }, all: async () => { throw new Error("DB unavailable"); } }) }) };
  await expect(getProfile(db, ORG, agentId)).rejects.toThrow("DB unavailable");
  await expect(profilesFor(db, ORG, [agentId])).rejects.toThrow("DB unavailable");
});

test("queued work rechecks an agent grant after it is revoked", async () => {
  const wf = await (await send("POST", "/workflows", toru, {
    orgId: ORG, name: "Use Billy", trigger: { type: "manual" },
    steps: [{ type: "agent", agentId, prompt: "Read your memory", channel: "b:ops" }],
  })).json();
  const scheduled = await (await send("POST", "/followups", toru, {
    orgId: ORG, channel: "b:ops", agentId, instruction: "Read your memory", minutes: 1,
  })).json();
  await send("PUT", `/hx/agents/${agentId}/profile`, mika, { orgId: ORG, access: "private" });
  expect((await send("POST", `/workflows/${wf.workflow.id}/run`, toru, { orgId: ORG })).status).toBe(404);
  const { startRun } = await import('../src/harness/workflows.js');
  const ran = { run: await startRun(env, { orgId: ORG, workflow: wf.workflow, trigger: 'manual' }) };
  expect(ran.run).toMatchObject({ status: "failed", log: [expect.objectContaining({ error: "Agent access required." })] });
  const { runDueFollowups } = await import("../src/harness/followups.js");
  expect(await runDueFollowups(env, { now: new Date(Date.now() + 120000) })).toBe(0);
  const row = await env.DB.prepare("SELECT status, result FROM hx_followups WHERE id = ?1").bind(scheduled.followup.id).first();
  expect(row).toMatchObject({ status: "failed", result: "Agent access required." });
});

test("chat reads the latest room rules even when Simple is selected", async () => {
  const { saveGuidelines } = await import("../src/harness/guidelines.js");
  await saveGuidelines(env.DB, ORG, "b:ops", { body: "Always cite invoice IDs.", version: 0 }, "9202");
  await send("PUT", "/orgs/mode", toru, { orgId: ORG, mode: "simple" });
  const seen = nextCompletion("Invoice INV-12 is overdue.");
  await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:ops", body: "@billy what is overdue?" }, MODEL);
  expect((await seen).messages.find(m => m.role === "system").content).toContain("Always cite invoice IDs.");
});

test('memory API hides private-room scopes and forbids cross-scope deletion', async () => {
  await env.DB.prepare("UPDATE businesses SET private = 1 WHERE org_id = ?1 AND slug = 'ops'").bind(ORG).run();
  await env.DB.prepare("INSERT INTO conversation_members (org_id, channel, login, added_by, added_at) VALUES (?1, 'b:ops', 'mika', 'mika', ?2)").bind(ORG, new Date().toISOString()).run();
  const base = `/hx/agents/${agentId}/memory`;
  const kept = await (await send('POST', base, mika, { orgId: ORG, channel: 'b:ops', text: 'Private room knowledge', kind: 'reference' })).json();
  expect(kept.memory.id).toBeTruthy();
  expect((await get(`${base}?${q({ orgId: ORG, channel: 'b:ops' })}`, toru)).status).toBe(404);
  expect((await (await get(`${base}/scopes?${q({ orgId: ORG })}`, toru)).json()).scopes).toEqual([]);
  expect((await (await get(`${base}/scopes?${q({ orgId: ORG })}`, mika)).json()).scopes).toEqual([{ channel: 'b:ops', label: 'Ops' }]);
  expect((await (await get(`${base}?${q({ orgId: ORG })}`, mika)).json()).memories).toEqual([]);
  const deleted = await call(`${base}?${q({ orgId: ORG, id: kept.memory.id })}`, { method: 'DELETE', headers: headers(mika) });
  expect((await deleted.json()).deleted).toBe(0);
});


test("Harness creation is private even when a client requests team scope, and stays private in Simple", async () => {
  const made = await send("POST", "/channels/agents", mika, { orgId: ORG, name: "Private", handle: "private-new", instructions: "Secret instructions", scope: "team" });
  expect(made.status).toBe(201);
  const a = (await made.json()).agent;
  expect(a.scope).toBe("personal");
  expect(await env.DB.prepare("SELECT agent_id FROM hx_agent_profiles WHERE org_id = ?1 AND agent_id = ?2").bind(ORG, a.id).first()).toBeTruthy();
  await env.DB.prepare("INSERT INTO channel_agents (org_id, channel, agent_id, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(ORG, "b:ops", a.id, "mika", new Date().toISOString()).run();
  expect(await filterResponders(env.DB, ORG, "kenji", [{ id: a.id, scope: "personal", ownerLogin: "mika" }], { channel: "b:ops" })).toEqual([]);
  for (const mode of ["harness", "simple"]) {
    await send("PUT", "/orgs/mode", toru, { orgId: ORG, mode });
    for (const token of [toru, kenji]) {
      const list = await (await get(`/channels/agents?${q({ orgId: ORG })}`, token)).json();
      expect(list.agents.some(x => x.id === a.id)).toBe(false);
      expect((await get(`/hx/agents/${a.id}/profile?${q({ orgId: ORG })}`, token)).status).toBe(404);
      expect((await send("PUT", "/channels/agents", token, { orgId: ORG, id: a.id, scope: "team" })).status).toBe(404);
    }
  }
  const shared = await send("PUT", "/channels/agents", mika, { orgId: ORG, id: a.id, scope: "team" });
  expect(shared.status).toBe(200);
  const list = await (await get(`/channels/agents?${q({ orgId: ORG })}`, kenji)).json();
  expect(list.agents.some(x => x.id === a.id)).toBe(true);
});
test("Harness creation saves specialty and tier with the private agent, and rejects invalid profiles without partial writes", async () => {
  const input = { orgId: ORG, name: "Analyst", handle: "analyst-profile", instructions: "Help with research", profile: { specialty: "Research", tier: "max" } };
  const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM custom_agents WHERE org_id = ?1").bind(ORG).first()).n;
  const before = await count();
  for (const profile of [null, [], { specialty: "Research", tier: "unknown" }, { specialty: "x".repeat(121), tier: "max" }]) {
    expect((await send("POST", "/channels/agents", mika, { ...input, profile })).status).toBe(400);
    expect(await count()).toBe(before);
  }
  const created = await send("POST", "/channels/agents", mika, input);
  expect(created.status).toBe(201);
  const agent = (await created.json()).agent;
  expect(agent.scope).toBe("personal");
  const stored = await env.DB.prepare("SELECT created_at FROM custom_agents WHERE org_id = ?1 AND id = ?2").bind(ORG, agent.id).first();
  expect(agent.createdAt).toBe(stored.created_at);
  await env.DB.prepare("UPDATE custom_agents SET updated_at = '2030-01-01T00:00:00Z' WHERE org_id = ?1 AND id = ?2").bind(ORG, agent.id).run();
  const listed = await (await get(`/channels/agents?${q({ orgId: ORG })}`, mika)).json();
  expect(listed.agents.find(item => item.id === agent.id).createdAt).toBe(stored.created_at);
  const result = await (await get(`/hx/agents/${agent.id}/profile?${q({ orgId: ORG })}`, mika)).json();
  expect(result.profile).toMatchObject({ specialty: "Research", tier: "max" });
  expect((await get(`/hx/agents/${agent.id}/profile?${q({ orgId: ORG })}`, toru)).status).toBe(404);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM channel_agents WHERE agent_id = ?1").bind(agent.id).first()).n).toBe(0);
});
test("inline persona edits reject concurrent writers and do not overwrite profile fields", async () => {
  const base = { orgId: ORG, id: agentId, expectedInstructions: "You chase invoices." };
  const responses = await Promise.all([
    send("PUT", "/channels/agents", mika, { ...base, instructions: "First edit" }),
    send("PUT", "/channels/agents", mika, { ...base, instructions: "Second edit" }),
  ]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  const stored = await env.DB.prepare("SELECT instructions FROM custom_agents WHERE org_id = ?1 AND id = ?2").bind(ORG, agentId).first();
  await send("PUT", "/channels/agents", mika, { orgId: ORG, id: agentId, name: "Renamed teammate" });
  const saved = await send("PUT", "/channels/agents", mika, { ...base, expectedInstructions: stored.instructions, instructions: "Reconciled edit" });
  expect(saved.status).toBe(200);
  expect((await saved.json()).agent).toMatchObject({ name: "Renamed teammate", instructions: "Reconciled edit", scope: "team" });
  expect((await send("PUT", "/channels/agents", mika, { ...base, expectedInstructions: "Reconciled edit", instructions: "Mixed edit", name: "Overwrite" })).status).toBe(400);
  await send("PUT", `/hx/agents/${agentId}/profile`, mika, { orgId: ORG, access: "private" });
  expect((await send("PUT", "/channels/agents", kenji, { ...base, expectedInstructions: "Reconciled edit", instructions: "Unauthorized" })).status).toBe(404);
});
test('profile dialog updates identity and profile together while preserving instructions and access', async () => {
  const path = `/hx/agents/${agentId}/profile`;
  const before = await env.DB.prepare('SELECT instructions, handle FROM custom_agents WHERE id = ?1').bind(agentId).first();
  const saved = await send('PUT', path, mika, { orgId: ORG, name: 'Invoice specialist', emoji: '📚', specialty: 'Accounting', tier: 'max' });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ identity: { name: 'Invoice specialist', emoji: '📚' }, profile: { specialty: 'Accounting', tier: 'max' } });
  const after = await env.DB.prepare('SELECT instructions, handle FROM custom_agents WHERE id = ?1').bind(agentId).first();
  expect(after).toEqual(before);
  for (const patch of [{ name: '', specialty: 'Not saved' }, { name: 'Changed', tier: 'invalid' }, { emoji: 'x'.repeat(17), specialty: 'Not saved' }]) {
    expect((await send('PUT', path, mika, { orgId: ORG, ...patch })).status).toBe(400);
  }
  expect((await (await get(`${path}?${q({ orgId: ORG })}`, mika)).json()).profile).toMatchObject({ specialty: 'Accounting', tier: 'max' });
  expect((await send('PUT', path, kenji, { orgId: ORG, name: 'Unauthorized' })).status).toBe(403);
});
test('a thread reply that does not name the agent gets no answer, with or without the room policy; explicit mentions and agent DMs still answer', async () => {
  const { respondingAgents } = await import('../src/customAgents.js');
  const { saveRoomResponses } = await import('../src/harness/roomResponses.js');
  await env.DB.prepare("INSERT INTO channel_agents (org_id, channel, agent_id, added_by, added_at) VALUES (?1, 'b:ops', ?2, 'mika', ?3)").bind(ORG, agentId, new Date().toISOString()).run();
  for (const [id, author, body, parent, at] of [
    ['root-response', 'mika', '@billy help', null, '2026-01-01T00:00:00Z'],
    ['answer-response', `agent:${agentId}`, 'Ready', 'root-response', '2026-01-01T00:00:01Z'],
    ['follow-response', 'mika', 'Continue', 'root-response', '2026-01-01T00:00:02Z'],
  ]) await env.DB.prepare("INSERT INTO channel_messages (id, org_id, channel, author_login, body, parent_id, created_at) VALUES (?1, ?2, 'b:ops', ?3, ?4, ?5, ?6)").bind(id, ORG, author, body, parent, at).run();
  const row = await env.DB.prepare("SELECT * FROM channel_messages WHERE id = 'follow-response'").first();
  const args = { orgId: ORG, login: 'mika', resolved: { kind: 'business', key: 'b:ops' }, row };
  expect(await respondingAgents(env.DB, args)).toEqual([]);
  await saveRoomResponses(env.DB, ORG, 'b:ops', { mentionedOnly: true, version: 0 }, 'mika');
  expect(await respondingAgents(env.DB, args)).toEqual([]);
  const { runQueuedAgents } = await import('../src/agentRunner.js');
  expect(await runQueuedAgents(env, { orgId: ORG, token: mika, rowId: row.id, locale: 'en' })).toBe(0);
  expect((await respondingAgents(env.DB, { ...args, row: { ...row, body: '@billy Continue' } })).map(x => x.id)).toEqual([agentId]);
  expect((await respondingAgents(env.DB, { ...args, resolved: { kind: 'agent', key: `agent:${agentId}`, agent: { id: agentId } } })).map(x => x.id)).toEqual([agentId]);
  await send('PUT', '/orgs/mode', toru, { orgId: ORG, mode: 'simple' });
  expect(await respondingAgents(env.DB, args)).toEqual([]);
});
test('Harness routes clear new requests only to accessible room members, leaving Simple and human threads unchanged', async () => {
  const { respondingAgents } = await import('../src/customAgents.js');
  const { saveRoomResponses } = await import('../src/harness/roomResponses.js');
  const args = { orgId: ORG, login: 'mika', resolved: { kind: 'business', key: 'b:ops' }, row: { id: 'routing-request', kind: 'message', author_login: 'mika', body: 'Please review these invoices', parent_id: null } };
  expect(await respondingAgents(env.DB, args)).toEqual([]);
  await env.DB.prepare("INSERT INTO channel_agents (org_id, channel, agent_id, added_by, added_at) VALUES (?1, 'b:ops', ?2, 'mika', ?3)").bind(ORG, agentId, new Date().toISOString()).run();
  expect((await respondingAgents(env.DB, args)).map(x => x.id)).toEqual([agentId]);
  for (const patch of [{ author_login: `agent:${agentId}` }, { body: '@kenji please review these invoices' }, { body: 'I will review it tomorrow' }, { body: '> Please review these invoices' }, { parent_id: 'human-thread', created_at: new Date().toISOString() }]) {
    expect(await respondingAgents(env.DB, { ...args, row: { ...args.row, ...patch } })).toEqual([]);
  }
  await send('PUT', `/hx/agents/${agentId}/profile`, mika, { orgId: ORG, mentionOnly: true });
  expect(await respondingAgents(env.DB, args)).toEqual([]);
  await send('PUT', `/hx/agents/${agentId}/profile`, mika, { orgId: ORG, mentionOnly: false });
  await saveRoomResponses(env.DB, ORG, 'b:ops', { mentionedOnly: true, version: 0 }, 'mika');
  expect(await respondingAgents(env.DB, args)).toEqual([]);
  await saveRoomResponses(env.DB, ORG, 'b:ops', { mentionedOnly: false, version: 1 }, 'mika');
  await send('PUT', '/orgs/mode', toru, { orgId: ORG, mode: 'simple' });
  expect(await respondingAgents(env.DB, args)).toEqual([]);
});

test("structured memory preserves multiline bodies, scopes edits and refuses stale or unauthorized updates", async () => {
  const path = `/hx/agents/${agentId}/memory`;
  const body = '# Billing\n\n' + 'Detailed procedure. '.repeat(100);
  const made = await send('POST', path, mika, { orgId: ORG, title: 'Billing procedure', description: 'Monthly invoices', body, kind: 'reference', channel: 'b:ops' });
  expect(made.status).toBe(201);
  const { memory } = await made.json();
  expect(memory).toMatchObject({ title: 'Billing procedure', description: 'Monthly invoices', body: body.trim(), version: 1 });
  expect(memory.text.length).toBeLessThanOrEqual(500);
  const payload = { orgId: ORG, id: memory.id, title: 'Updated billing', description: 'New procedure', body: 'New\n\nbody', kind: 'feedback', expectedVersion: 1, channel: 'b:ops' };
  expect((await send('PUT', path, kenji, payload)).status).toBe(403);
  expect((await send('PUT', path, mika, { ...payload, channel: '' })).status).toBe(404);
  const changed = await send('PUT', path, mika, payload);
  expect(changed.status).toBe(200);
  expect((await changed.json()).memory).toMatchObject({ body: 'New\n\nbody', version: 2, kind: 'feedback' });
  expect((await send('PUT', path, mika, { ...payload, body: 'Stale overwrite' })).status).toBe(409);
  const listed = await (await get(`${path}?${q({ orgId: ORG, channel: 'b:ops' })}`, mika)).json();
  expect(listed.memories.find(m => m.id === memory.id)).toMatchObject({ body: 'New\n\nbody', text: 'New body', title: 'Updated billing', version: 2, kind: 'feedback' });
  expect((await send('POST', path, mika, { orgId: ORG, title: 'Too long', body: 'x'.repeat(16001) })).status).toBe(400);
  const legacy = (await (await send('POST', path, mika, { orgId: ORG, text: 'Old note' })).json()).memory;
  expect(legacy).toMatchObject({ body: 'Old note', title: 'Old note', version: 0 });
  expect((await send('PUT', path, mika, { ...payload, id: legacy.id, channel: '', expectedVersion: 0 })).status).toBe(200);
  expect((await call(`${path}?${q({ orgId: ORG, id: memory.id, channel: 'b:ops' })}`, { method: 'DELETE', headers: headers(mika) })).status).toBe(200);
  expect(await env.DB.prepare('SELECT * FROM hx_memory_entries WHERE memory_id=?1').bind(memory.id).first()).toBeNull();
});

test("structured memory reader rechecks identity and conversation and keeps full bodies out of the research index", async () => {
  const { addAgentMemory, prepareAgent } = await import('../src/harness/agents.js');
  const { agentMemoryTools } = await import('../src/harness/memoryReader.js');
  const body = '# Full instructions\n\n' + 'private detail '.repeat(100);
  const { memory } = await addAgentMemory(env.DB, ORG, agentId, { title: 'Procedure', description: 'Useful index', body }, { channel: 'b:ops', by: '9202' });
  const context = { userId: '9202', channel: 'b:ops' };
  const tools = agentMemoryTools(env.DB, ORG, agentId, context);
  expect(JSON.parse(await tools.read_agent_memory.run({ memory_id: memory.id })).body).toBe(body.trim());
  expect(await agentMemoryTools(env.DB, ORG, agentId, { ...context, channel: '' }).read_agent_memory.run({ memory_id: memory.id })).toBe('Memory unavailable.');
  const ready = await prepareAgent(env, ORG, { id: agentId, instructions: 'You help.' }, null, context);
  expect(ready.agent.researchInstructions).toContain('read_agent_memory');
  expect(ready.agent.researchInstructions).toContain('Useful index');
  expect(ready.agent.researchInstructions).not.toContain('private detail');
  expect(ready.skillTools.read_agent_memory).toBeDefined();
  await env.DB.prepare('DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(ORG, '9202').run();
  expect(await tools.read_agent_memory.run({ memory_id: memory.id })).toBe('Memory unavailable.');
});

test('memory bodies with the same short preview stay distinct and concurrent edits have one winner', async () => {
  const path = `/hx/agents/${agentId}/memory`;
  const prefix = 'x'.repeat(600);
  const first = (await (await send('POST', path, mika, { orgId: ORG, title: 'One', body: prefix + 'one' })).json()).memory;
  const second = (await (await send('POST', path, mika, { orgId: ORG, title: 'Two', body: prefix + 'two' })).json()).memory;
  expect(first.id).not.toBe(second.id);
  const requests = ['A', 'B'].map(letter => send('PUT', path, mika, { orgId: ORG, id: first.id, expectedVersion: 1, title: letter, description: letter, body: letter, kind: 'context' }));
  const replies = await Promise.all(requests);
  expect(replies.map(r => r.status).sort()).toEqual([200, 409]);
  const winner = (await replies.find(r => r.status === 200).json()).memory;
  const listed = (await (await get(`${path}?${q({ orgId: ORG })}`, mika)).json()).memories.find(m => m.id === first.id);
  expect(listed).toMatchObject({ title: winner.title, description: winner.title, body: winner.title, text: winner.title, version: 2 });
});

test('memory search finds older full-body matches without crossing scopes or exposing bodies', async () => {
  const { addAgentMemory, prepareAgent } = await import('../src/harness/agents.js');
  const { agentMemoryTools } = await import('../src/harness/memoryReader.js');
  const { memory } = await addAgentMemory(env.DB, ORG, agentId, { title: 'Archive', description: 'Old procedure', body: 'Confidential invoice-needle details' }, { by: '9202' });
  await env.DB.prepare('UPDATE hx_agent_memories SET created_at=?1 WHERE id=?2').bind('2000-01-01',memory.id).run();
  await env.DB.batch(Array.from({length:41},(_,i)=>env.DB.prepare('INSERT INTO hx_agent_memories (id,org_id,agent_id,text,source,created_by,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)').bind(`recent-${i}`,ORG,agentId,`Recent note ${i}`,'test','9202','2026-10-21')));
  const hidden = await addAgentMemory(env.DB, ORG, agentId, { title:'Other room', body:'invoice-needle hidden' }, { channel:'b:other', by:'9202' });
  const scoped = await addAgentMemory(env.DB, ORG, agentId, { title:'Ops', body:'invoice-needle scoped' }, { channel:'b:ops', by:'9202' });
  const ready = await prepareAgent(env, ORG, { id:agentId,instructions:'Help.' }, null, { userId:'9202',channel:'b:ops' });
  expect(ready.agent.researchInstructions).not.toContain('Old procedure');
  expect(ready.agent.researchInstructions).toContain('search_agent_memory');
  const search = ready.skillTools.search_agent_memory;
  const raw = await search.run({query:'INVOICE-NEEDLE'});
  const found = JSON.parse(raw);
  expect(found.memories.map(m=>m.id).sort()).toEqual([memory.id,scoped.memory.id].sort());
  expect(found.truncated).toBe(false);
  expect(raw).not.toContain('Confidential');
  expect(raw).not.toContain(hidden.memory.id);
  expect(found.memories.every(m=>!('body' in m)&&!('text' in m))).toBe(true);
  const shared = agentMemoryTools(env.DB,ORG,agentId,{userId:'9202'}).search_agent_memory;
  expect(JSON.parse(await shared.run({query:'invoice-needle'})).memories.map(m=>m.id)).toEqual([memory.id]);
  expect(JSON.parse(await search.run({query:'%'})).memories).toEqual([]);
  const many = JSON.parse(await search.run({query:'Recent note'}));
  expect(many.memories).toHaveLength(20); expect(many.truncated).toBe(true);
  expect(await search.run({query:' '.repeat(3)})).toContain('search phrase');
  expect(await search.run({query:'x'.repeat(201)})).toContain('search phrase');
  expect(await agentMemoryTools(env.DB,'other-workspace',agentId,{userId:'9202'}).search_agent_memory.run({query:'invoice-needle'})).toBe('Memory unavailable.');
  expect(await agentMemoryTools(env.DB,ORG,agentId,{userId:'9202',channel:'b:missing'}).search_agent_memory.run({query:'invoice-needle'})).toBe('Memory unavailable.');
  const guest = agentMemoryTools(env.DB,ORG,agentId,{userId:'9203'}).search_agent_memory;
  expect(JSON.parse(await guest.run({query:'invoice-needle'})).memories).toHaveLength(1);
  await send('PUT', `/hx/agents/${agentId}/profile`, mika, {orgId:ORG,access:'private'});
  expect(await guest.run({query:'invoice-needle'})).toBe('Memory unavailable.');
  await env.DB.prepare('DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(ORG,'9202').run();
  expect(await search.run({query:'invoice-needle'})).toBe('Memory unavailable.');
});

test('manual memory mutations audit metadata only, without recording duplicate, denied or stale saves as changes', async () => {
  const path = `/hx/agents/${agentId}/memory`;
  const input = {orgId:ORG,title:'Secret title',description:'Secret description',body:'Secret memory body',kind:'reference',channel:'b:ops'};
  const {memory} = await (await send('POST',path,mika,input)).json();
  await send('POST',path,mika,input);
  const changed = {...input,id:memory.id,expectedVersion:1,body:'Secret replacement'};
  expect((await send('PUT',path,kenji,changed)).status).toBe(403);
  expect((await send('PUT',path,mika,changed)).status).toBe(200);
  expect((await send('PUT',path,mika,changed)).status).toBe(409);
  const remove = `${path}?${q({orgId:ORG,id:memory.id,channel:'b:ops'})}`;
  await call(remove,{method:'DELETE',headers:headers(mika)});
  await call(remove,{method:'DELETE',headers:headers(mika)});
  const actions = 'agent.memory_created,agent.memory_updated,agent.memory_deleted';
  const res = await get(`/audit/logs?${q({orgId:ORG,action:actions})}`,toru);
  expect(res.status).toBe(200);
  const {entries} = await res.json();
  expect(entries.map(e=>e.action).sort()).toEqual(actions.split(',').sort());
  for (const entry of entries) { expect(entry.actor).toMatchObject({type:'user',name:'Mika'}); expect(entry.entity).toMatchObject({type:'custom_agent',id:agentId}); }
  expect(entries.find(e=>e.action==='agent.memory_updated').details).toEqual({memoryId:memory.id,kind:'reference',version:2,scope:'conversation'});
  expect(entries.find(e=>e.action==='agent.memory_deleted').details).toEqual({memoryId:memory.id,count:1,scope:'conversation'});
  const serialized = JSON.stringify(entries);
  for(const secret of [input.title,input.description,input.body,changed.body,'b:ops']) expect(serialized).not.toContain(secret);
  expect((await get(`/audit/logs?${q({orgId:ORG})}`,mika)).status).toBe(403);
});

test('independent agent roles govern API editing, listing and execution in both presentation modes',async()=>{
 const {agentMemoryTools}=await import('../src/harness/memoryReader.js');
 const profilePath=`/hx/agents/${agentId}/profile`,rolesPath=`/hx/agents/${agentId}/members`;
 await send('PUT',profilePath,mika,{orgId:ORG,access:'private'});
 expect((await get(`${profilePath}?${q({orgId:ORG})}`,kenji)).status).toBe(404);
 const initial=await (await get(`${rolesPath}?${q({orgId:ORG})}`,mika)).json();
 expect(initial).toMatchObject({version:0,canManage:true,scope:'team'});
 expect(JSON.stringify(initial)).not.toContain('9202');
 const target=initial.candidates.find(p=>p.name==='Kenji');
 expect(target.ref).toBeTruthy();
 expect((await send('PUT',rolesPath,mika,{orgId:ORG,ref:'9203',role:'admin',expectedVersion:0})).status).toBe(404);
 expect((await send('PUT',rolesPath,mika,{orgId:ORG,ref:target.ref,role:'member',expectedVersion:0})).status).toBe(200);
 expect((await (await get(`${profilePath}?${q({orgId:ORG})}`,kenji)).json()).canEdit).toBe(false);
 expect((await send('PUT',rolesPath,kenji,{orgId:ORG,ref:target.ref,role:'admin',expectedVersion:1})).status).toBe(403);
 expect((await send('PUT',profilePath,kenji,{orgId:ORG,specialty:'Not permitted'})).status).toBe(403);
 expect((await send('PUT',rolesPath,mika,{orgId:ORG,ref:target.ref,role:'admin',expectedVersion:1})).status).toBe(200);
 for(const mode of ['simple','harness']) {
  await send('PUT','/orgs/mode',toru,{orgId:ORG,mode});
  expect((await send('PUT',profilePath,kenji,{orgId:ORG,specialty:'Delegated editor'})).status).toBe(200);
  const updated=await send('PUT','/channels/agents',kenji,{orgId:ORG,id:agentId,instructions:'Delegated persona'});
  expect(updated.status).toBe(200);
  expect((await updated.json()).agent).toMatchObject({canEdit:true,canDelete:true});
  const listed=(await (await get(`/channels/agents?${q({orgId:ORG})}`,kenji)).json()).agents.find(a=>a.id===agentId);
  expect(listed).toMatchObject({canEdit:true,canDelete:true});
  expect((await call(`/channels/agents/avatar?${q({orgId:ORG,id:agentId})}`,{method:'DELETE',headers:headers(kenji)})).status).toBe(200);
 }
 const {memory}=await (await send('POST',`/hx/agents/${agentId}/memory`,mika,{orgId:ORG,text:'Shared procedure'})).json();
 const tool=agentMemoryTools(env.DB,ORG,agentId,{userId:'9203'}).read_agent_memory;
 expect(await tool.run({memory_id:memory.id})).toContain('Shared procedure');
 expect((await send('PUT',rolesPath,mika,{orgId:ORG,ref:target.ref,role:'none',expectedVersion:2})).status).toBe(200);
 expect(await tool.run({memory_id:memory.id})).toBe('Memory unavailable.');
 expect((await get(`${profilePath}?${q({orgId:ORG})}`,kenji)).status).toBe(404);
 expect((await (await get(`/channels/agents?${q({orgId:ORG})}`,kenji)).json()).agents.some(a=>a.id===agentId)).toBe(false);
});

test('ordinary agent members manage ordinary grants through opaque refs and can remove themselves',async()=>{
 const path=`/hx/agents/${agentId}/members`;
 await send('PUT',`/hx/agents/${agentId}/profile`,mika,{orgId:ORG,access:'private'});
 const state=await(await get(`${path}?${q({orgId:ORG})}`,mika)).json();
 const kenjiRef=state.candidates.find(p=>p.name==='Kenji').ref;
 const toruRef=state.candidates.find(p=>p.name==='Toru').ref;
 expect((await send('PUT',path,mika,{orgId:ORG,ref:kenjiRef,role:'member',expectedVersion:0})).status).toBe(200);
 const ordinary=await(await get(`${path}?${q({orgId:ORG})}`,kenji)).json();
 expect(ordinary).toMatchObject({canManage:false,canAddMembers:true});
 expect(ordinary.members.find(m=>m.ref===kenjiRef).mine).toBe(true);
 expect((await send('PUT',path,kenji,{orgId:ORG,ref:toruRef,role:'member',expectedVersion:1})).status).toBe(200);
 expect((await send('PUT',path,kenji,{orgId:ORG,ref:toruRef,role:'admin',expectedVersion:2})).status).toBe(403);
 expect((await send('PUT',path,kenji,{orgId:ORG,ref:toruRef,role:'none',expectedVersion:2})).status).toBe(200);
 expect((await send('PUT',path,kenji,{orgId:ORG,ref:kenjiRef,role:'none',expectedVersion:3})).status).toBe(200);
 expect((await get(`${path}?${q({orgId:ORG})}`,kenji)).status).toBe(404);
});

test('ownership transfer is owner-only, versioned, and preserves the original creator in client listings',async()=>{
 const path=`/hx/agents/${agentId}`,query=q({orgId:ORG});
 await send('PUT',`${path}/profile`,mika,{orgId:ORG,access:'private'});
 const state=await(await get(`${path}/members?${query}`,mika)).json();
 const target=state.candidates.find(p=>p.name==='Kenji').ref;
 const owner=state.members.find(p=>p.owner).ref;
 await send('PUT',`${path}/members`,mika,{orgId:ORG,ref:target,role:'admin',expectedVersion:0});
 expect((await send('PUT',`${path}/ownership`,kenji,{orgId:ORG,ref:owner,expectedVersion:1})).status).toBe(403);
 expect((await send('PUT',`${path}/ownership`,mika,{orgId:ORG,ref:target,expectedVersion:0})).status).toBe(409);
 expect((await send('PUT',`${path}/ownership`,mika,{orgId:ORG,ref:target,expectedVersion:1})).status).toBe(200);
 const next=await(await get(`${path}/members?${query}`,kenji)).json();
 expect(next.members.find(p=>p.ref===target)).toMatchObject({owner:true,mine:true,role:'admin'});
 const list=await(await get(`/channels/agents?${query}`,kenji)).json();
 expect(list.agents.find(a=>a.id===agentId)).toMatchObject({mine:true,createdByName:'Mika',createdByMe:false});
 expect((await send('PUT',`${path}/members`,mika,{orgId:ORG,ref:owner,role:'none',expectedVersion:2})).status).toBe(200);
 expect((await get(`${path}/members?${query}`,mika)).status).toBe(404);
});

test('workspace admin status does not confer edit or delete rights over a managed agent in either mode',async()=>{
 const path=`/hx/agents/${agentId}`,query=q({orgId:ORG});
 await send('PUT',`${path}/profile`,mika,{orgId:ORG,access:'people',people:['toru']});
 const roles=await(await get(`${path}/members?${query}`,mika)).json();
 const ref=roles.candidates.find(p=>p.name==='Toru').ref;
 await send('PUT',`${path}/members`,mika,{orgId:ORG,ref,role:'member',expectedVersion:0});
 for(const mode of ['simple','harness']){
  await send('PUT','/orgs/mode',toru,{orgId:ORG,mode});
  expect((await(await get(`${path}/profile?${query}`,toru)).json()).canEdit).toBe(false);
  const listed=(await(await get(`/channels/agents?${query}`,toru)).json()).agents.find(a=>a.id===agentId);
  expect(listed).toMatchObject({canEdit:false,canDelete:false});
  expect((await send('PUT',`${path}/profile`,toru,{orgId:ORG,access:'everyone'})).status).toBe(403);
  expect((await send('PUT','/channels/agents',toru,{orgId:ORG,id:agentId,instructions:'Unauthorized'})).status).toBe(403);
  expect((await call(`/channels/agents/avatar?${q({orgId:ORG,id:agentId})}`,{method:'DELETE',headers:headers(toru)})).status).toBe(403);
  expect((await send('DELETE','/channels/agents',toru,{orgId:ORG,id:agentId})).status).toBe(403);
 }
 expect((await send('PUT',`${path}/members`,mika,{orgId:ORG,ref,role:'admin',expectedVersion:1})).status).toBe(200);
 expect((await send('PUT',`${path}/profile`,toru,{orgId:ORG,specialty:'Authorized'})).status).toBe(200);
 const updated=await(await send('PUT','/channels/agents',toru,{orgId:ORG,id:agentId,instructions:'Authorized persona'})).json();
 expect(updated.agent).toMatchObject({canEdit:true,canDelete:true});
 expect((await send('PUT',`${path}/members`,mika,{orgId:ORG,ref,role:'member',expectedVersion:2})).status).toBe(200);
 expect((await send('DELETE','/channels/agents',toru,{orgId:ORG,id:agentId})).status).toBe(403);
});

test('memory review HTTP requires agent edit rights and preserves validation across later edits',async()=>{
 const base=`/hx/agents/${agentId}/memory`;
 const made=await(await send('POST',base,mika,{orgId:ORG,title:'Policy',description:'',body:'Original policy',kind:'reference'})).json();
 const route=`${base}/${made.memory.id}/review`;
 const input={orgId:ORG,expectedVersion:1,evidence:'Confirmed with finance'};
 expect((await send('PUT',route,kenji,input)).status).toBe(403);
 expect((await send('PUT',route,toru,input)).status).toBe(403);
 expect((await send('PUT',route,mika,{...input,evidence:''})).status).toBe(400);
 const reviewed=await send('PUT',route,mika,input);
 expect(reviewed.status).toBe(200);
 const result=await reviewed.json();
 expect(result.review.by).toBe('9202');
 const read=async()=> (await(await get(`${base}?${q({orgId:ORG,paged:'1'})}`,kenji)).json()).memories[0];
 expect((await read()).review.current).toBe(true);
 const changed=await send('PUT',`${base}/${made.memory.id}`,mika,{orgId:ORG,expectedVersion:1,title:'Policy',description:'',body:'Updated policy',kind:'reference'});
 expect(changed.status).toBe(200);
 expect((await read()).review).toMatchObject({current:false,at:result.review.at});
 expect((await send('PUT',route,mika,input)).status).toBe(409);
 expect((await send('PUT',route,mika,{...input,expectedVersion:2})).status).toBe(200);
 expect((await read()).review.current).toBe(true);
});

test('review history HTTP permits readers and denies them after agent access is removed',async()=>{
 const base=`/hx/agents/${agentId}/memory`;
 const made=await(await send('POST',base,mika,{orgId:ORG,title:'History',description:'',body:'Policy',kind:'reference'})).json();
 expect((await send('PUT',`${base}/${made.memory.id}/review`,mika,{orgId:ORG,expectedVersion:1,evidence:'Checked source'})).status).toBe(200);
 const history=`${base}/${made.memory.id}/reviews?${q({orgId:ORG})}`;
 const read=await get(history,kenji);
 expect(read.status).toBe(200);
 expect((await read.json()).reviews).toEqual([expect.objectContaining({version:1,evidence:'Checked source',by:'9202',reviewerName:'Mika'})]);
 expect((await get(`${base}/${made.memory.id}/reviews?${q({orgId:ORG,channel:'dm:toru'})}`,kenji)).status).toBe(404);
 expect((await send('PUT',`/hx/agents/${agentId}/profile`,mika,{orgId:ORG,access:'private'})).status).toBe(200);
 expect((await get(history,kenji)).status).toBe(404);
});

test('update review HTTP enforces edit rights and returns the newly validated version',async()=>{
 const base=`/hx/agents/${agentId}/memory`;
 const made=await(await send('POST',base,mika,{orgId:ORG,title:'Policy',description:'Summary',body:'Original',kind:'reference'})).json();
 const input={orgId:ORG,verdict:'update',expectedVersion:1,body:'Revised',evidence:'Checked new procedure'};
 const path=`${base}/${made.memory.id}/review`;
 expect((await send('PUT',path,kenji,input)).status).toBe(403);
 const response=await send('PUT',path,mika,input);
 expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({memory:{body:'Revised',description:'Summary',version:2},review:{version:2,current:true}});
 const history=await(await get(`${base}/${made.memory.id}/reviews?${q({orgId:ORG})}`,kenji)).json();
 expect(history.reviews).toEqual([expect.objectContaining({verdict:'update',version:2,evidence:input.evidence})]);
 expect((await send('PUT',path,mika,input)).status).toBe(409);
});

test('deleted memory review log retains discoverable scopes but checks current room access',async()=>{
 await env.DB.prepare("UPDATE businesses SET private=1 WHERE org_id=? AND slug='ops'").bind(ORG).run();
 await env.DB.prepare("INSERT INTO conversation_members (org_id,channel,login,added_by,added_at) VALUES (?,'b:ops','mika','mika',?)").bind(ORG,new Date().toISOString()).run();
 const base=`/hx/agents/${agentId}/memory`;
 const made=await(await send('POST',base,mika,{orgId:ORG,channel:'b:ops',text:'Retired private memory'})).json();
 const input={orgId:ORG,channel:'b:ops',expectedVersion:0,verdict:'delete',evidence:'Replaced by approved procedure'};
 expect((await send('PUT',`${base}/${made.memory.id}/review`,kenji,input)).status).toBe(403);
 expect((await send('PUT',`${base}/${made.memory.id}/review`,mika,input)).status).toBe(200);
 const logPath=`${base}/reviews?${q({orgId:ORG,channel:'b:ops'})}`;
 const log=await get(logPath,mika);
 expect(log.status).toBe(200);
 expect((await log.json()).reviews).toEqual([expect.objectContaining({memoryId:made.memory.id,verdict:'delete',evidence:input.evidence})]);
 expect((await(await get(`${base}/scopes?${q({orgId:ORG})}`,mika)).json()).scopes).toEqual([{channel:'b:ops',label:'Ops'}]);
 expect((await get(logPath,toru)).status).toBe(404);
 expect((await(await get(`${base}/reviews?${q({orgId:ORG})}`,mika)).json()).reviews).toEqual([]);
 await env.DB.prepare("DELETE FROM conversation_members WHERE org_id=? AND channel='b:ops' AND login='mika'").bind(ORG).run();
 expect((await get(logPath,mika)).status).toBe(404);
 expect((await(await get(`${base}/scopes?${q({orgId:ORG})}`,mika)).json()).scopes).toEqual([]);
});

test('an active normal request loses authorization when agent access becomes private', async()=>{
 const {postMessage}=await import('../src/channels.js');
 const {agentExecutionGrant,agentExecutionAuthorizer}=await import('../src/agentExecutionGrant.js');
 const {row}=await postMessage(env.DB,{orgId:ORG,key:'b:ops',authorLogin:'kenji',body:'@billy check this'});
 const request={orgId:ORG,token:kenji,rowId:row.id};
 const grant=await agentExecutionGrant(env,request);
 expect(grant.agents.some(a=>a.id===agentId)).toBe(true);
 const authorize=agentExecutionAuthorizer(env,request,row);
 expect(await authorize(agentId)).toBe(true);
 await send('PUT',`/hx/agents/${agentId}/profile`,mika,{orgId:ORG,access:'private'});
 expect(await authorize(agentId)).toBe(false);
});
