import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { agentsCalled, requestFor, parseAgentMarkdown, agentMarkdown, cleanAgentHandle, PRESETS, presetsFor, readResponse, forChat } from "../src/customAgents.js";

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
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(400, { error: { message: "web_search not supported" } });
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

test("an agent looks things up on the web and answers with what it found, and where", async () => {
  const made = await (await send("POST", "/channels/agents", toru, { orgId: ORG, markdown: HAYAO })).json();
  let asked;
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, (opts) => {
    asked = JSON.parse(opts.body);
    return {
      model: "gpt-4o-mini",
      output: [
        { type: "web_search_call", status: "completed" },
        { type: "message", content: [{ type: "output_text", text: "## 結論\n**Blue Bottle** opened 3 Kyoto shops in 2025.", annotations: [
          { type: "url_citation", url: "https://example.com/bb", title: "Blue Bottle Kyoto" },
        ] }] },
      ],
      usage: { input_tokens: 40, output_tokens: 20 },
    };
  });
  await send("POST", "/channels/messages", mika, { orgId: ORG, channel: `ag:${made.agent.id}`, body: "Blue Bottleの京都出店を調べて" }, { OPENAI_API_KEY: "sk-test" });
  expect(asked.tools).toEqual([{ type: "web_search" }]);
  expect(asked.instructions).toContain("Deliver findings, never a plan");
  expect(asked.input).toContain("Blue Bottleの京都出店を調べて");
  const { messages } = await (await get(`/channels/messages?${q({ orgId: ORG, channel: `ag:${made.agent.id}` })}`, mika)).json();
  expect(messages[1].body).toBe("*結論*\n*Blue Bottle* opened 3 Kyoto shops in 2025.\n\n*Sources*\n- Blue Bottle Kyoto: https://example.com/bb");
  const calls = await env.DB.prepare("SELECT purpose FROM ai_calls WHERE org_id = ?1").bind(ORG).all();
  expect(calls.results.map((r) => r.purpose)).toEqual(["agent"]);
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
