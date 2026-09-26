import { env, runDurableObjectAlarm } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { agentTalkFilter, agentsCalled, requestFor, parseAgentMarkdown, agentMarkdown, cleanAgentHandle, PRESETS, presetsFor, readResponse, forChat } from "../src/customAgents.js";

// Agents a team writes for itself: "@hayao" answers in the thread under the
// message that named it, as its Markdown instructions say. A team agent is
// everyone's to call and improve; a personal one answers only its owner.

const ORG = "personal:agents";
let toru; let mika; let kenji; let guest;
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

const HAYAO = `---
name: Hayao
handle: hayao
emoji: 🎨
description: Art direction for the cafe
scope: team
---

# Hayao

You are the cafe's art director. Answer with *one* clear visual direction.`;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  for (const [id, login, name, role] of [["8801", "toru", "Toru", "admin"], ["8802", "mika", "Mika", "member"], ["8803", "kenji", "Kenji", "member"], ["8804", "gus", "Gus", "guest"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, role);
  }
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "8801" });
  toru = await createSession(env.DB, "8801", "gho_t");
  mika = await createSession(env.DB, "8802", "gho_m");
  kenji = await createSession(env.DB, "8803", "gho_k");
  guest = await createSession(env.DB, "8804", "gho_g");
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("a handle is letters and numbers, and never a word @ already means", () => {
  expect(cleanAgentHandle("@Hayao")).toBe("hayao");
  expect(cleanAgentHandle("＠秘書")).toBe("秘書");
  expect(cleanAgentHandle("ai")).toBeNull();
  expect(cleanAgentHandle("x")).toBeNull();
  expect(cleanAgentHandle("has space")).toBeNull();
});

test("a .md file is the agent: front matter for its face, the rest its instructions, and back again", () => {
  const parsed = parseAgentMarkdown(HAYAO);
  expect(parsed).toMatchObject({ name: "Hayao", handle: "hayao", emoji: "🎨", description: "Art direction for the cafe", scope: "team" });
  expect(parsed.instructions).toMatch(/^# Hayao\n\nYou are the cafe's art director/);
  const again = parseAgentMarkdown(agentMarkdown({ ...parsed }));
  expect(again).toEqual(parsed);
  // No front matter: all instructions, named by the first heading.
  expect(parseAgentMarkdown("# 経理の鬼\n\n経費を厳しく見る。")).toMatchObject({ name: "経理の鬼", instructions: "# 経理の鬼\n\n経費を厳しく見る。" });
  // A description with a colon survives the trip.
  expect(parseAgentMarkdown(agentMarkdown({ name: "A", handle: "aa", description: "Note: be brief", instructions: "x" })).description).toBe("Note: be brief");
});

test("a message calls the agents it names, the particle going with the name", () => {
  const agents = [{ id: "1", handle: "hayao", scope: "team" }, { id: "2", handle: "秘書", scope: "team" }, { id: "3", handle: "hayao", scope: "personal" }];
  expect(agentsCalled("@hayaoに ポスター案を", agents).map((a) => a.id)).toEqual(["3"]);
  expect(agentsCalled("@秘書 まとめて。 @hayao も見て", agents).map((a) => a.id)).toEqual(["2", "3"]);
  expect(agentsCalled("mail hayao@cafe.jp", agents)).toEqual([]);
  expect(requestFor("@hayaoに ポスター案を考えて", { handle: "hayao" })).toBe("ポスター案を考えて");
  expect(requestFor("Hi @hayao, what colour?", { handle: "hayao" })).toBe("Hi what colour?");
});

test("presets come in the reader's language, and one becomes a team agent anyone can call and improve", async () => {
  expect(presetsFor("ja").find((p) => p.id === "secretary")).toMatchObject({ name: "秘書", handle: "secretary" });
  expect(presetsFor("es").find((p) => p.id === "secretary").name).toBe("Secretary");
  const listed = await (await get(`/channels/agents?${q({ orgId: ORG })}`, toru)).json();
  expect(listed.agents).toEqual([]);
  expect(listed.presets).toHaveLength(PRESETS.length);
  const preset = listed.presets.find((p) => p.id === "secretary");

  const made = await send("POST", "/channels/agents", toru, { orgId: ORG, preset: "secretary", ...preset, scope: "team" });
  expect(made.status).toBe(201);
  const { agent } = await made.json();
  expect(agent).toMatchObject({ handle: "secretary", scope: "team", mine: true, canEdit: true, canDelete: true, preset: "secretary" });
  expect(agent.markdown).toContain("handle: secretary");
  expect(JSON.stringify(agent)).not.toContain("toru");

  // Mika sees it, may improve it, may not delete it.
  const seen = await (await get(`/channels/agents?${q({ orgId: ORG })}`, mika)).json();
  expect(seen.agents[0]).toMatchObject({ handle: "secretary", mine: false, canEdit: true, canDelete: false, createdByName: "Toru" });
  const changed = await send("PUT", "/channels/agents", mika, { orgId: ORG, id: agent.id, instructions: "Summarise in three bullets." });
  expect(changed.status).toBe(200);
  expect((await changed.json()).agent).toMatchObject({ instructions: "Summarise in three bullets.", updatedByName: "Mika", scope: "team" });
  expect((await send("DELETE", "/channels/agents", mika, { orgId: ORG, id: agent.id })).status).toBe(403);
  // The overview carries it for @ suggestions.
  const overview = await (await get(`/channels?${q({ orgId: ORG })}`, kenji)).json();
  expect(overview.agents).toEqual([expect.objectContaining({ handle: "secretary", scope: "team" })]);
  // Written to the audit log, as the team's.
  const { results } = await env.DB.prepare("SELECT action FROM audit_events WHERE org_id = ?1 ORDER BY seq").bind(ORG).all();
  expect(results.map((r) => r.action)).toEqual(["agent.created", "agent.updated"]);
});

test("a handle that means someone else, an agent already, or nothing is refused; a guest makes none", async () => {
  expect((await send("POST", "/channels/agents", toru, { orgId: ORG, markdown: HAYAO })).status).toBe(201);
  expect((await send("POST", "/channels/agents", mika, { orgId: ORG, markdown: HAYAO })).status).toBe(409);
  expect((await send("POST", "/channels/agents", mika, { orgId: ORG, name: "Mika bot", handle: "mika", instructions: "x" })).status).toBe(409);
  expect((await send("POST", "/channels/agents", mika, { orgId: ORG, name: "AI", handle: "ai", instructions: "x" })).status).toBe(400);
  expect((await send("POST", "/channels/agents", mika, { orgId: ORG, name: "Empty", handle: "empty" })).status).toBe(400);
  expect((await send("POST", "/channels/agents", guest, { orgId: ORG, name: "Mine", handle: "mine", instructions: "x" })).status).toBe(403);
  // A group cannot take an agent's name either.
  expect((await send("POST", "/channels/usergroups", toru, { orgId: ORG, handle: "hayao", refs: [] })).status).toBe(409);
});

test("@hayao answers in the thread under the message, as itself, from its instructions and the conversation", async () => {
  await send("POST", "/channels/agents", toru, { orgId: ORG, markdown: HAYAO });
  await send("POST", "/channels/messages", kenji, { orgId: ORG, channel: "b:cafe", body: "Autumn menu launches on the 1st" });
  let prompt;
  // A model that cannot search: the ordinary answer.
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(400, { error: { message: "web_search not supported" } }).times(2);
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, (opts) => {
    prompt = JSON.parse(opts.body);
    return { choices: [{ message: { content: "Warm amber and chestnut brown, hand-drawn type." } }], usage: { prompt_tokens: 10, completion_tokens: 8 } };
  });
  const sent = await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@hayao ポスターの方向性をください" }, { OPENAI_API_KEY: "sk-test" });
  expect(sent.status).toBe(201);
  const asked = (await sent.json()).message;

  const system = prompt.messages.find((m) => m.role === "system").content;
  const user = prompt.messages.find((m) => m.role === "user").content;
  expect(system).toContain("You are the cafe's art director");
  expect(system).toContain("🎨 Hayao (@hayao)");
  expect(user).toContain("Autumn menu launches on the 1st");
  expect(user).toContain("Request to you (@hayao): ポスターの方向性をください");
  expect(user).toContain("Asked by: Mika");

  const thread = await (await get(`/channels/thread?${q({ orgId: ORG, channel: "b:cafe", messageId: asked.id })}`, kenji)).json();
  expect(thread.parent.replyCount).toBe(1);
  expect(thread.replies).toEqual([expect.objectContaining({
    kind: "agent", body: "Warm amber and chestnut brown, hand-drawn type.", authorName: "Hayao", authorRef: null, mine: false,
    agent: expect.objectContaining({ handle: "hayao", name: "Hayao", emoji: "🎨" }),
  })]);
  // Mika hears it the way a teammate's reply would reach her.
  const queued = await env.DB.prepare("SELECT login, reason FROM push_queue WHERE org_id = ?1 AND message_id = ?2").bind(ORG, thread.replies[0].id).all();
  expect(queued.results).toEqual([{ login: "mika", reason: "thread" }]);
  // It was a model call, on the books.
  const calls = await env.DB.prepare("SELECT purpose FROM ai_calls WHERE org_id = ?1").bind(ORG).all();
  expect(calls.results.map((r) => r.purpose)).toEqual(["agent"]);
  // Deleted, what it said keeps its name.
  const { agents } = await (await get(`/channels/agents?${q({ orgId: ORG })}`, toru)).json();
  expect((await send("DELETE", "/channels/agents", toru, { orgId: ORG, id: agents[0].id })).status).toBe(200);
  const later = await (await get(`/channels/thread?${q({ orgId: ORG, channel: "b:cafe", messageId: asked.id })}`, kenji)).json();
  expect(later.replies[0]).toMatchObject({ authorName: "Hayao", agent: expect.objectContaining({ emoji: "🎨" }) });
});

test("a personal agent answers only its owner; with no model, the agent says so rather than staying silent", async () => {
  await send("POST", "/channels/agents", mika, { orgId: ORG, name: "My notes", handle: "notes", instructions: "Keep my notes.", scope: "personal" });
  expect((await (await get(`/channels/agents?${q({ orgId: ORG })}`, kenji)).json()).agents).toEqual([]);
  // Kenji naming it calls nothing.
  const byKenji = await (await send("POST", "/channels/messages", kenji, { orgId: ORG, channel: "b:cafe", body: "@notes hello" })).json();
  const none = await (await get(`/channels/thread?${q({ orgId: ORG, channel: "b:cafe", messageId: byKenji.message.id })}`, kenji)).json();
  expect(none.replies).toEqual([]);
  // Kenji may have his own @notes.
  expect((await send("POST", "/channels/agents", kenji, { orgId: ORG, name: "Notes", handle: "notes", instructions: "x", scope: "personal" })).status).toBe(201);
  // Mika's, with no model on this deployment: an answer that says why.
  const byMika = await (await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@notes remember the lease date" })).json();
  const said = await (await get(`/channels/thread?${q({ orgId: ORG, channel: "b:cafe", messageId: byMika.message.id })}`, mika)).json();
  expect(said.replies).toHaveLength(1);
  expect(said.replies[0]).toMatchObject({ kind: "agent", authorName: "My notes" });
  expect(said.replies[0].body).toContain("no AI model");
});

test("a conversation with an agent is one person's, and the agent answers everything said in it, in the conversation", async () => {
  const made = await (await send("POST", "/channels/agents", toru, { orgId: ORG, markdown: HAYAO })).json();
  const view = `ag:${made.agent.id}`;
  let prompt;
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, (opts) => {
    prompt = JSON.parse(opts.body);
    return { choices: [{ message: { content: "Deep green, gold leaf." } }] };
  });
  // No @ needed: in the agent's own conversation, it is spoken to.
  const sent = await send("POST", "/channels/messages", mika, { orgId: ORG, channel: view, body: "What colour for the menu?" }, { OPENAI_API_KEY: "sk-test" });
  expect(sent.status).toBe(201);
  expect(prompt.messages[1].content).toContain("a direct conversation with you");
  const { messages } = await (await get(`/channels/messages?${q({ orgId: ORG, channel: view })}`, mika)).json();
  expect(messages.map((m) => [m.kind, m.body, m.parentId])).toEqual([
    ["message", "What colour for the menu?", null],
    ["agent", "Deep green, gold leaf.", null],
  ]);
  expect(messages[1]).toMatchObject({ channel: view, authorName: "Hayao" });
  // Kenji's conversation with the same agent is his own: empty.
  const his = await (await get(`/channels/messages?${q({ orgId: ORG, channel: view })}`, kenji)).json();
  expect(his.messages).toEqual([]);
  // It shows in Mika's list of conversations, and nobody else's.
  const mine = await (await get(`/channels?${q({ orgId: ORG })}`, mika)).json();
  expect(mine.activity.map((a) => a.channel)).toContain(view);
  const theirs = await (await get(`/channels?${q({ orgId: ORG })}`, kenji)).json();
  expect(theirs.activity.map((a) => a.channel)).not.toContain(view);
  // Mika hears the answer as a direct message.
  const queued = await env.DB.prepare("SELECT login, reason FROM push_queue WHERE org_id = ?1 AND message_id = ?2").bind(ORG, messages[1].id).all();
  expect(queued.results).toEqual([{ login: "mika", reason: "direct" }]);
});

test("someone else's personal agent has no conversation to open", async () => {
  const made = await (await send("POST", "/channels/agents", mika, { orgId: ORG, name: "Diary", handle: "diary", instructions: "x", scope: "personal" })).json();
  expect((await get(`/channels/messages?${q({ orgId: ORG, channel: `ag:${made.agent.id}` })}`, kenji)).status).toBe(404);
  expect((await get(`/channels/messages?${q({ orgId: ORG, channel: `ag:${made.agent.id}` })}`, mika)).status).toBe(200);
});

test("in its own conversation an agent reads the team's past decisions; in a channel it does not", async () => {
  const made = await (await send("POST", "/channels/agents", toru, { orgId: ORG, markdown: HAYAO })).json();
  const { saveCard } = await import("../src/db.js");
  await saveCard(env.DB, ORG, { id: "c-roast", recipientUserID: "mika", senderUserID: "kenji", title: "Switch roaster supplier", status: "approved", createdAt: new Date().toISOString(), decision: { action: "approve", actorUserID: "mika", decidedAt: new Date().toISOString() } });
  const prompts = [];
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, (opts) => {
    prompts.push(JSON.parse(opts.body).messages[1].content);
    return { choices: [{ message: { content: "ok" } }] };
  }).times(2);
  await send("POST", "/channels/messages", mika, { orgId: ORG, channel: `ag:${made.agent.id}`, body: "What did we decide about the roaster supplier?" }, { OPENAI_API_KEY: "sk-test" });
  await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@hayao what about the roaster supplier?" }, { OPENAI_API_KEY: "sk-test" });
  expect(prompts[0]).toContain("Switch roaster supplier");
  expect(prompts[1]).not.toContain("Switch roaster supplier");
});

test("an agent researches with a reasoning model, web search and its own tools, and answers with what it found, and where", async () => {
  const made = await (await send("POST", "/channels/agents", toru, { orgId: ORG, markdown: HAYAO })).json();
  const asked = [];
  // Round 1: it searched the web, and asks to read a page in full.
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, (opts) => {
    asked.push(JSON.parse(opts.body));
    return {
      id: "resp_1", model: "gpt-5-mini",
      output: [
        { type: "reasoning", summary: [] },
        { type: "web_search_call", status: "completed", action: { type: "search", query: "Blue Bottle Kyoto", sources: [{ type: "url", url: "https://example.com/news" }] } },
        { type: "function_call", call_id: "call_1", name: "read_url", arguments: JSON.stringify({ url: "https://bluebottle.example/kyoto" }) },
      ],
      usage: { input_tokens: 400, output_tokens: 90 },
    };
  });
  fetchMock.get("https://r.jina.ai").intercept({ path: "/https://bluebottle.example/kyoto", method: "GET" })
    .reply(200, "Title: Kyoto cafes\n\nMarkdown Content:\nThree Kyoto cafes: Nanzenji (2018), Rokkaku (2020), Kyoto Station (2025).");
  // Round 2: it has read the page, and answers.
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, (opts) => {
    asked.push(JSON.parse(opts.body));
    return {
      id: "resp_2", model: "gpt-5-mini",
      output: [{ type: "message", content: [{ type: "output_text", text: "## 結論\n**Blue Bottle** has 3 Kyoto cafes; the newest opened in 2025.", annotations: [
        { type: "url_citation", url: "https://bluebottle.example/kyoto", title: "Kyoto cafes" },
      ] }] }],
      usage: { input_tokens: 900, output_tokens: 120 },
    };
  });
  await send("POST", "/channels/messages", mika, { orgId: ORG, channel: `ag:${made.agent.id}`, body: "Blue Bottleの京都出店を調べて" }, { OPENAI_API_KEY: "sk-test" });

  const [first, second] = asked;
  expect(first.model).toBe("gpt-5-mini");
  expect(first.reasoning).toEqual({ effort: "medium" });
  expect(first.tools[0]).toMatchObject({ type: "web_search", search_context_size: "high" });
  expect(first.tools.slice(1).map((t) => t.name)).toEqual(["read_url", "search_team_decisions"]);
  expect(first.tools[1]).toMatchObject({ type: "function", strict: true, parameters: { additionalProperties: false, required: ["url"] } });
  expect(first.instructions).toContain("Deliver findings, never a plan");
  expect(first.instructions).toContain("read them in full");
  expect(first.input).toContain("Blue Bottleの京都出店を調べて");
  // The page's text went back on the same thread of reasoning.
  expect(second.previous_response_id).toBe("resp_1");
  expect(second.input).toEqual([{ type: "function_call_output", call_id: "call_1", output: expect.stringContaining("Three Kyoto cafes") }]);

  const { messages } = await (await get(`/channels/messages?${q({ orgId: ORG, channel: `ag:${made.agent.id}` })}`, mika)).json();
  expect(messages[1].body).toBe("*結論*\n*Blue Bottle* has 3 Kyoto cafes; the newest opened in 2025.\n\n*Sources*\n- Kyoto cafes: https://bluebottle.example/kyoto");
  const calls = await env.DB.prepare("SELECT purpose FROM ai_calls WHERE org_id = ?1").bind(ORG).all();
  expect(calls.results.map((r) => r.purpose)).toEqual(["agent", "agent"]);
});

test("in a channel an agent reads the web but not the team's decisions; a model that refuses the full call is tried bare", async () => {
  await send("POST", "/channels/agents", toru, { orgId: ORG, markdown: HAYAO });
  const asked = [];
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(400, (opts) => {
    asked.push(JSON.parse(opts.body));
    return { error: { message: "Unsupported model" } };
  });
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, (opts) => {
    asked.push(JSON.parse(opts.body));
    return { id: "r", output_text: "Chestnut and amber.", output: [] };
  });
  const sent = await (await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@hayao autumn colours?" }, { OPENAI_API_KEY: "sk-test" })).json();
  expect(asked[0].tools.map((t) => t.name || t.type)).toEqual(["web_search", "read_url"]);
  expect(asked[1]).toMatchObject({ model: "gpt-4o-mini", tools: [{ type: "web_search" }] });
  expect(asked[1].reasoning).toBeUndefined();
  const thread = await (await get(`/channels/thread?${q({ orgId: ORG, channel: "b:cafe", messageId: sent.message.id })}`, mika)).json();
  expect(thread.replies[0].body).toBe("Chestnut and amber.");
});

test("a Responses reply reads as text and sources; Markdown becomes the chat's own marks", () => {
  expect(readResponse({ output_text: "Hi", output: [{ type: "message", content: [{ type: "output_text", text: "Hi", annotations: [
    { type: "url_citation", url: "https://a.example", title: "A" }, { type: "url_citation", url: "https://a.example", title: "A" },
  ] }] }] })).toEqual({ text: "Hi", sources: [{ url: "https://a.example", title: "A" }] });
  expect(readResponse(null)).toEqual({ text: "", sources: [] });
  expect(forChat("### Plan\n**Key** point, __also__ [Docs](https://d.example/x)")).toBe("*Plan*\n*Key* point, *also* Docs https://d.example/x");
});

test("a link shared with an agent is opened and read: the post on X is in what the agent sees", async () => {
  const made = await (await send("POST", "/channels/agents", toru, { orgId: ORG, markdown: HAYAO })).json();
  fetchMock.get("https://api.fxtwitter.com").intercept({ path: "/cafe/status/123", method: "GET" }).reply(200, {
    code: 200, tweet: { text: "Our pumpkin latte is back Oct 1", author: { name: "Cafe", screen_name: "cafe" }, likes: 42 },
  });
  let asked;
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, (opts) => {
    asked = JSON.parse(opts.body);
    return { output_text: "They bring the pumpkin latte back on Oct 1.", output: [] };
  });
  await send("POST", "/channels/messages", mika, { orgId: ORG, channel: `ag:${made.agent.id}`, body: "これ要約して https://x.com/cafe/status/123?s=20" }, { OPENAI_API_KEY: "sk-test" });
  expect(asked.input).toContain("<shared_links>");
  expect(asked.input).toContain("Post on X: https://x.com/cafe/status/123?s=20");
  expect(asked.input).toContain("Our pumpkin latte is back Oct 1");
  expect(asked.instructions).toContain("Never say you cannot open links");
  const { messages } = await (await get(`/channels/messages?${q({ orgId: ORG, channel: `ag:${made.agent.id}` })}`, mika)).json();
  expect(messages[1].body).toBe("They bring the pumpkin latte back on Oct 1.");
});

test("an agent you have can be added to a channel: listed among its members, called there by anyone, and taken out again", async () => {
  // Mika's personal agent: only Mika can call it, until she brings it into #cafe.
  const made = await (await send("POST", "/channels/agents", mika, { orgId: ORG, name: "Menu", handle: "menu", emoji: "📋", instructions: "Knows the menu.", scope: "personal" })).json();
  const id = made.agent.id;
  const details = async (who) => (await get(`/channels/details?${q({ orgId: ORG, channel: "b:cafe" })}`, who)).json();
  expect((await details(mika)).addableAgents.map((a) => a.handle)).toEqual(["menu"]);
  expect((await details(kenji)).addableAgents).toEqual([]);
  // Kenji cannot add what is not his; a guest cannot add at all.
  expect((await send("POST", "/channels/channel-agents", kenji, { orgId: ORG, channel: "b:cafe", agentId: id })).status).toBe(404);
  expect([403, 404]).toContain((await send("POST", "/channels/channel-agents", guest, { orgId: ORG, channel: "b:cafe", agentId: id })).status);

  expect(await (await send("POST", "/channels/channel-agents", mika, { orgId: ORG, channel: "b:cafe", agentId: id })).json()).toEqual({ added: true });
  const seen = await details(kenji);
  expect(seen.members.agents.map((a) => a.kind)).toEqual(["ai", "custom"]);
  expect(seen.members.agents[1]).toMatchObject({ id, handle: "menu", name: "Menu", emoji: "📋", owner: "Mika", canRemove: true });
  expect((await details(mika)).addableAgents).toEqual([]);
  // It is in Kenji's list of agents now, placed in #cafe.
  const overview = await (await get(`/channels?${q({ orgId: ORG })}`, kenji)).json();
  expect(overview.agents.find((a) => a.handle === "menu")).toMatchObject({ id, channels: ["b:cafe"] });
  // The channel was told.
  const { messages } = await (await get(`/channels/messages?${q({ orgId: ORG, channel: "b:cafe" })}`, kenji)).json();
  expect(messages.at(-1)).toMatchObject({ kind: "ai" });
  expect(messages.at(-1).body).toContain("📋 Menu (@menu)");

  // Kenji calls it in #cafe, and it answers him.
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, { output_text: "Pumpkin latte, 5.50." });
  const asked = await (await send("POST", "/channels/messages", kenji, { orgId: ORG, channel: "b:cafe", body: "@menu what is new?" }, { OPENAI_API_KEY: "sk-test" })).json();
  const thread = await (await get(`/channels/thread?${q({ orgId: ORG, channel: "b:cafe", messageId: asked.message.id })}`, kenji)).json();
  expect(thread.replies).toEqual([expect.objectContaining({ kind: "agent", body: "Pumpkin latte, 5.50.", authorName: "Menu" })]);

  // Anyone in it but a guest takes it out; then Kenji calls nothing.
  expect([403, 404]).toContain((await send("DELETE", "/channels/channel-agents", guest, { orgId: ORG, channel: "b:cafe", agentId: id })).status);
  expect(await (await send("DELETE", "/channels/channel-agents", kenji, { orgId: ORG, channel: "b:cafe", agentId: id })).json()).toEqual({ removed: true });
  expect((await send("DELETE", "/channels/channel-agents", kenji, { orgId: ORG, channel: "b:cafe", agentId: id })).status).toBe(404);
  const again = await (await send("POST", "/channels/messages", kenji, { orgId: ORG, channel: "b:cafe", body: "@menu hello?" })).json();
  const none = await (await get(`/channels/thread?${q({ orgId: ORG, channel: "b:cafe", messageId: again.message.id })}`, kenji)).json();
  expect(none.replies).toEqual([]);
  const audit = await env.DB.prepare("SELECT action FROM audit_events WHERE org_id = ?1 AND action LIKE 'channel.agent_%' ORDER BY seq").bind(ORG).all();
  expect(audit.results.map((r) => r.action)).toEqual(["channel.agent_added", "channel.agent_removed"]);
});

test("in production an agent answers from AgentRunner's alarm, not the request that called it", async () => {
  const made = await (await send("POST", "/channels/agents", toru, { orgId: ORG, markdown: HAYAO })).json();
  const view = `ag:${made.agent.id}`;
  // The request hands the job over and returns; the alarm answers — here,
  // with no model, the agent says so — once.
  expect((await send("POST", "/channels/messages", mika, { orgId: ORG, channel: view, body: "hello" }, { AGENT_INLINE: "" })).status).toBe(201);
  const stub = env.AGENT_RUNNER.get(env.AGENT_RUNNER.idFromName(ORG));
  let after;
  for (let i = 0; i < 40; i += 1) {
    await runDurableObjectAlarm(stub);
    after = await (await get(`/channels/messages?${q({ orgId: ORG, channel: view })}`, mika)).json();
    if (after.messages.length > 1) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await runDurableObjectAlarm(stub);
  after = await (await get(`/channels/messages?${q({ orgId: ORG, channel: view })}`, mika)).json();
  expect(after.messages.map((m) => [m.kind, m.authorName])).toEqual([["message", "Mika"], ["agent", "Hayao"]]);
  expect(after.messages[1].body).toContain("no AI model");
});

test("talk with the agents is left out of what a decision reads: calling one, and its answer", async () => {
  await send("POST", "/channels/agents", toru, { orgId: ORG, markdown: HAYAO });
  await send("POST", "/channels/messages", kenji, { orgId: ORG, channel: "b:cafe", body: "Autumn menu launches on the 1st" });
  await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@hayao poster ideas?" });
  const { transcriptUpTo } = await import("../src/channels.js");
  const skip = await agentTalkFilter(env.DB, ORG);
  const now = new Date(Date.now() + 1000).toISOString();
  const all = await transcriptUpTo(env.DB, ORG, "b:cafe", now);
  const kept = await transcriptUpTo(env.DB, ORG, "b:cafe", now, { skip });
  expect(all.some((l) => l.includes("@hayao poster ideas?"))).toBe(true);
  expect(all.some((l) => l.includes("Hayao: "))).toBe(true);
  expect(kept.some((l) => l.includes("Autumn menu launches on the 1st"))).toBe(true);
  expect(kept.some((l) => l.includes("hayao") || l.includes("Hayao"))).toBe(false);
  expect(skip({ kind: "message", channel: "b:cafe", body: "@hayaoに 調べて" })).toBe(true);
  expect(skip({ kind: "message", channel: "ag:x|mika", body: "hi" })).toBe(true);
  expect(skip({ kind: "message", channel: "b:cafe", body: "@AI ask Toru" })).toBe(false);
});

test("a message to an agent never becomes a card for a person, even with @AI or sent as a decision", async () => {
  await send("POST", "/channels/agents", toru, { orgId: ORG, markdown: HAYAO });
  const routed = [];
  fetchMock.get("https://api.openai.com").intercept({ path: /.*/, method: "POST" }).reply(200, (opts) => { routed.push(opts.path); return { choices: [{ message: { content: "ok" } }], output_text: "ok", output: [] }; }).persist();
  await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@hayao YCS26を徹底調査して @AI" }, { OPENAI_API_KEY: "sk-test" });
  await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@hayao 調べて", decide: true }, { OPENAI_API_KEY: "sk-test" });
  const cards = await env.DB.prepare("SELECT COUNT(*) AS n FROM cards WHERE org_id = ?1").bind(ORG).first();
  expect(cards.n).toBe(0);
  expect(routed.every((p) => p === "/v1/responses")).toBe(true);
  fetchMock.get("https://api.openai.com").interceptors = [];
});

test("an agent added from a preset and never changed follows the preset's current version; an edited one keeps its words", async () => {
  const { textHash, upgradedInstructions } = await import("../src/agentPresets.js");
  const EARLIER = "# 壁打ち相手\n\n反論することで、チームのアイデアを強くする役です。\n\n## 進め方\n- まずアイデアを一番良い形で一文にまとめる。\n- 次に: 懐疑的な人がする厳しい質問を3つ、最大のリスク、うまくいくために成り立っていなければならない前提。\n- 間違っていたら分かる、一番安い検証方法を提案する。\n- 率直に、でも親切に。反対するのはアイデアで、人ではない。";
  const current = PRESETS.find((p) => p.id === "sparring").instructions.ja;
  expect(upgradedInstructions(EARLIER)).toBe(current);
  expect(upgradedInstructions(`${EARLIER}\n- うちの業界に合わせて`)).toBe(null);
  expect(textHash("a  b\n c")).toBe(textHash("a b c"));
  // Stored with the earlier words, it reads — and is written back — as the current ones.
  const made = await (await send("POST", "/channels/agents", toru, { orgId: ORG, name: "壁打ち相手", handle: "sparring", instructions: "x", preset: "sparring" })).json();
  await env.DB.prepare("UPDATE custom_agents SET instructions = ?1 WHERE id = ?2").bind(EARLIER, made.agent.id).run();
  const { agents } = await (await get(`/channels/agents?${q({ orgId: ORG })}`, toru)).json();
  expect(agents.find((a) => a.handle === "sparring").instructions).toBe(current);
  const row = await env.DB.prepare("SELECT instructions FROM custom_agents WHERE id = ?1").bind(made.agent.id).first();
  expect(row.instructions).toBe(current);
});
