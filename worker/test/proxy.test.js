import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { takeAction, mentionedPeople, settleProxyAction, MAX_PROXIES } from "../src/proxy.js";

// "@toru review PR 858": with his proxy on, Toru's agent reads it, does it
// and answers in the thread as his agent. Anything it would write outside
// the chat — a comment on the pull request — waits for Toru to approve.

const ORG = "personal:proxy";
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
const AI = { OPENAI_API_KEY: "sk-test" };
const thread = async (token, id) => (await get(`/channels/thread?${q({ orgId: ORG, channel: "b:cafe", messageId: id })}`, token)).json();

/// The model: the classifier gets `act`, the agent gets `answer`. The agent
/// first tries the research API, which this one does not have.
function model({ act, answer = "", seen = [] }) {
  if (act !== "none") fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(400, { error: { message: "no" } }).times(2);
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, (opts) => {
    const body = JSON.parse(opts.body);
    seen.push(body);
    const system = body.messages.find((m) => m.role === "system").content;
    const content = /Decide whether the message asks/.test(system) ? JSON.stringify({ act }) : answer;
    return { choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 5 } };
  }).times(act === "none" ? 1 : 2);
}

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  for (const [id, login, name, role] of [["7701", "toru", "Toru", "admin"], ["7702", "mika", "Mika", "member"], ["7703", "kenji", "Kenji", "member"], ["7704", "gus", "Gus", "guest"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, role);
  }
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "7701" });
  toru = await createSession(env.DB, "7701", "gho_toru");
  mika = await createSession(env.DB, "7702", "gho_m");
  kenji = await createSession(env.DB, "7703", "gho_k");
  guest = await createSession(env.DB, "7704", "gho_g");
  // The team's repository: the one a proxy may read and comment on.
  await env.DB.prepare("INSERT INTO org_github (org_id, repo, token, connected_by, updated_at) VALUES (?1, 'acme/app', NULL, 'toru', ?2)").bind(ORG, new Date().toISOString()).run();
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("a proposal is taken out of an answer, and only a GitHub comment is understood", () => {
  const block = (o) => `Looks good overall.\n\n\`\`\`proxy-action\n${JSON.stringify(o)}\n\`\`\``;
  expect(takeAction(block({ kind: "github_comment", repo: "acme/app", number: 858, body: "LGTM, one nit." }))).toEqual({
    text: "Looks good overall.", action: { kind: "github_comment", repo: "acme/app", number: 858, body: "LGTM, one nit." },
  });
  // Anything else is dropped, and never shown.
  expect(takeAction(block({ kind: "merge", repo: "acme/app", number: 858 }))).toEqual({ text: "Looks good overall.", action: null });
  expect(takeAction(block({ kind: "github_comment", repo: "not a repo", number: 1, body: "x" })).action).toBeNull();
  expect(takeAction("Just an answer.")).toEqual({ text: "Just an answer.", action: null });
});

test("only the people a message names one by one, never its author, a group or @channel", () => {
  const members = [
    { login: "toru", name: "Toru", ref: "r1", groups: ["design"] },
    { login: "mika", name: "Mika", ref: "r2", groups: ["design"] },
    { login: "kenji", name: "Kenji", ref: "r3" },
  ];
  expect(mentionedPeople("@toru review PR 858", members, "mika").map((m) => m.login)).toEqual(["toru"]);
  expect(mentionedPeople("@channel @design heads up", members, "kenji")).toEqual([]);
  expect(mentionedPeople("@mika note to self", members, "mika")).toEqual([]);
  expect(mentionedPeople("@toru @mika @kenji all of you", members, "x")).toHaveLength(MAX_PROXIES);
});

test("turned on, it makes you an agent of your own; nobody else's agent can be yours, and a guest has none", async () => {
  expect((await (await get(`/channels/proxy?${q({ orgId: ORG })}`, toru)).json()).proxy).toEqual({ enabled: false, agentId: null, useTeammate: true });
  const on = await send("PUT", "/channels/proxy", toru, { orgId: ORG, enabled: true });
  expect(on.status).toBe(200);
  const { proxy } = await on.json();
  expect(proxy.enabled).toBe(true);
  const { agents } = await (await get(`/channels/agents?${q({ orgId: ORG })}`, toru)).json();
  expect(agents.find((a) => a.id === proxy.agentId)).toMatchObject({ name: "Toru AI", handle: "toru-ai", scope: "personal" });
  // Mika cannot point hers at Toru's agent.
  expect((await send("PUT", "/channels/proxy", mika, { orgId: ORG, enabled: true, agentId: proxy.agentId })).status).toBe(400);
  expect((await send("PUT", "/channels/proxy", guest, { orgId: ORG, enabled: true })).status).toBe(403);
  // Off again, the agent stays chosen.
  expect((await (await send("PUT", "/channels/proxy", toru, { orgId: ORG, enabled: false })).json()).proxy).toEqual({ enabled: false, agentId: proxy.agentId, useTeammate: true });
});

test("off, a mention is only a mention: no model is asked", async () => {
  const sent = await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@toru can you look at the roaster quote?" }, AI);
  expect(sent.status).toBe(201);
  const { message } = await sent.json();
  expect((await thread(kenji, message.id)).replies).toEqual([]);
});

test("on, a request to you is answered in the thread by your agent, as yours, never as you", async () => {
  await send("PUT", "/channels/proxy", toru, { orgId: ORG, enabled: true });
  const seen = [];
  model({ act: "answer", answer: "The roaster's quote is 8% up on last year; the market is up about 5%.", seen });
  const sent = await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@toru is the roaster's new quote reasonable?" }, AI);
  const { message } = await sent.json();
  const { replies } = await thread(kenji, message.id);
  expect(replies).toEqual([expect.objectContaining({
    kind: "agent", authorName: "Toru AI", onBehalfOf: { name: "Toru", ref: expect.any(String) },
    body: "The roaster's quote is 8% up on last year; the market is up about 5%.",
  })]);
  // It was asked as Toru's agent, by Mika, with what she wrote.
  const user = seen.at(-1).messages.find((m) => m.role === "user").content;
  expect(user).toContain("Mika mentioned Toru, and you are Toru's agent");
  expect(user).toContain("is the roaster's new quote reasonable?");
  // Its words are its own: no one is told it was Toru.
  const row = await env.DB.prepare("SELECT author_login, on_behalf_of FROM channel_messages WHERE id = ?1").bind(replies[0].id).first();
  expect(row.author_login).toMatch(/^agent:/);
  expect(row.on_behalf_of).toBe("toru");
});

test("thanks and news are left alone: the agent answers only when something is asked", async () => {
  await send("PUT", "/channels/proxy", toru, { orgId: ORG, enabled: true });
  model({ act: "none" });
  const { message } = await (await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "thanks @toru, great job today!" }, AI)).json();
  expect((await thread(kenji, message.id)).replies).toEqual([]);
});

test("a comment on GitHub waits for you: a card to approve, then it is posted with your GitHub", async () => {
  await send("PUT", "/channels/proxy", toru, { orgId: ORG, enabled: true });
  const action = { kind: "github_comment", repo: "acme/app", number: 858, body: "Reviewed: the option-key handler needs a test." };
  model({ act: "code", answer: `Reviewed #858: one missing test.\n\n\`\`\`proxy-action\n${JSON.stringify(action)}\n\`\`\`` });
  // No AI teammate here: the code goes to Toru's own agent.
  await send("PUT", "/channels/proxy", toru, { orgId: ORG, useTeammate: true });
  const { message } = await (await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@toru please review PR 858 acme/app" }, AI)).json();
  const { replies } = await thread(kenji, message.id);
  expect(replies).toHaveLength(1);
  expect(replies[0].body).toContain("Reviewed #858: one missing test.");
  expect(replies[0].body).toContain("waiting for Toru to approve it");
  expect(replies[0].body).not.toContain("proxy-action");
  const waiting = await env.DB.prepare("SELECT * FROM proxy_actions WHERE org_id = ?1").bind(ORG).first();
  expect(waiting).toMatchObject({ login: "toru", status: "pending", kind: "github_comment" });
  const { getCard } = await import("../src/db.js");
  const card = await getCard(env.DB, ORG, waiting.card_id);
  expect(card).toMatchObject({ recipientUserID: "toru", type: "approval", proxyAction: { repo: "acme/app", number: 858 } });

  // Somebody else deciding it does nothing.
  expect(await settleProxyAction(env, ORG, { ...card, decision: { action: "approve", actorUserID: "mika" } })).toBeNull();
  // Toru approves: posted as him.
  let posted;
  fetchMock.get("https://api.github.com").intercept({ path: "/repos/acme/app/issues/858/comments", method: "POST" }).reply(201, (opts) => {
    posted = { auth: opts.headers.authorization, body: JSON.parse(opts.body).body };
    return { html_url: "https://github.com/acme/app/pull/858#issuecomment-1" };
  });
  expect(await settleProxyAction(env, ORG, { ...card, decision: { action: "approve", actorUserID: "toru" } })).toBe("https://github.com/acme/app/pull/858#issuecomment-1");
  expect(posted).toEqual({ auth: "Bearer gho_toru", body: action.body });
  // Once.
  expect(await settleProxyAction(env, ORG, { ...card, decision: { action: "approve", actorUserID: "toru" } })).toBeNull();
  const after = await thread(kenji, message.id);
  expect(after.replies.at(-1)).toMatchObject({ kind: "agent", onBehalfOf: expect.objectContaining({ name: "Toru" }) });
  expect(after.replies.at(-1).body).toContain("https://github.com/acme/app/pull/858#issuecomment-1");
});

test("declined, nothing is posted", async () => {
  await send("PUT", "/channels/proxy", toru, { orgId: ORG, enabled: true });
  const action = { kind: "github_comment", repo: "acme/app", number: 9, body: "x" };
  model({ act: "code", answer: `Done.\n\n\`\`\`proxy-action\n${JSON.stringify(action)}\n\`\`\`` });
  await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@toru review acme/app#9" }, AI);
  const waiting = await env.DB.prepare("SELECT card_id FROM proxy_actions WHERE org_id = ?1").bind(ORG).first();
  const { getCard } = await import("../src/db.js");
  const card = await getCard(env.DB, ORG, waiting.card_id);
  expect(await settleProxyAction(env, ORG, { ...card, decision: { action: "decline", actorUserID: "toru" } })).toBeNull();
  expect((await env.DB.prepare("SELECT status FROM proxy_actions WHERE card_id = ?1").bind(card.id).first()).status).toBe("declined");
});

test("your agent does not answer where you could not read it yourself", async () => {
  await send("PUT", "/channels/proxy", toru, { orgId: ORG, enabled: true });
  // A direct conversation between Mika and Kenji: Toru is not in it, so no
  // model is asked (none is mocked) and nothing answers.
  const { members } = await (await get(`/channels?${q({ orgId: ORG })}`, mika)).json();
  const view = `dm:${members.find((m) => m.name === "Kenji").ref}`;
  const sent = await send("POST", "/channels/messages", mika, { orgId: ORG, channel: view, body: "@toru what do you think?" }, AI);
  expect(sent.status).toBe(201);
  const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM channel_messages WHERE org_id = ?1 AND kind = 'agent'").bind(ORG).first();
  expect(rows.n).toBe(0);
});

test("work done by the AI teammate for you is labelled yours, and its GitHub comment waits for you too", async () => {
  const { proxyTeammateAnswer } = await import("../src/proxy.js");
  const { message } = await (await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@toru review PR 858" })).json();
  const run = { id: "run-1", org_id: ORG, channel: "b:cafe", thread_id: message.id, started_by: "toru", on_behalf_of: "toru" };
  const action = { kind: "github_comment", repo: "acme/app", number: 858, body: "Please add a test." };
  const body = await proxyTeammateAnswer(env, { orgId: ORG, run, body: `Reviewed.\n\n\`\`\`proxy-action\n${JSON.stringify(action)}\n\`\`\``, agentLogin: "agent:claude-1" });
  expect(body).toContain("Reviewed.");
  expect(body).toContain("waiting for Toru to approve it");
  expect(body).not.toContain("proxy-action");
  const waiting = await env.DB.prepare("SELECT login, agent_login, thread_id FROM proxy_actions WHERE org_id = ?1").bind(ORG).first();
  expect(waiting).toEqual({ login: "toru", agent_login: "agent:claude-1", thread_id: message.id });
  // Nothing proposed: the words as they are.
  expect(await proxyTeammateAnswer(env, { orgId: ORG, run, body: "All good.", agentLogin: "agent:claude-1" })).toBe("All good.");
});

test("a comment for a repository that is not the team's is never proposed", async () => {
  await send("PUT", "/channels/proxy", toru, { orgId: ORG, enabled: true });
  const action = { kind: "github_comment", repo: "someone/private", number: 1, body: "x" };
  model({ act: "code", answer: `Here you go.\n\n\`\`\`proxy-action\n${JSON.stringify(action)}\n\`\`\`` });
  const { message } = await (await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@toru comment on someone/private#1" }, AI)).json();
  const { replies } = await thread(kenji, message.id);
  expect(replies[0].body).toBe("Here you go.");
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM proxy_actions").first()).n).toBe(0);
});
