import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { issueLinks, looksLikeReport, buildRequest } from "../src/autoBuild.js";

// An issue link or a bug report posted in a channel: Claude starts on it on
// its own, in the message's thread, once — no copying it into Claude.

const ORG = "personal:autobuild";
let toru; let mika;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const settle = async () => { while (pending.length) await pending.shift(); };
const call = async (path, init, extra = {}) => { const res = await worker.fetch(new Request("https://example.com" + path, init), { ...env, OPENAI_API_KEY: undefined, ...extra }, ctx); await settle(); return res; };
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const send = (method, path, token, body, extra) => call(path, { method, headers: headers(token), body: JSON.stringify(body) }, extra);
const get = (path, token) => call(path, { headers: headers(token) });
const q = (o) => new URLSearchParams(o).toString();
const anthropic = () => fetchMock.get("https://api.anthropic.com");
const thread = async (token, messageId) => (await (await get(`/channels/thread?${q({ orgId: ORG, channel: "b:cafe", messageId })}`, token)).json()).replies;
const AI = { OPENAI_API_KEY: "sk-test" };
const runs = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_teammate_runs WHERE org_id = ?1").bind(ORG).first()).n;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  for (const [id, login, name, role] of [["9801", "toru", "Toru", "admin"], ["9802", "mika", "Mika", "member"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, role);
  }
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "9801" });
  toru = await createSession(env.DB, "9801", "gho_t");
  mika = await createSession(env.DB, "9802", "gho_m");
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function launch() {
  anthropic().intercept({ path: "/v1/environments?beta=true", method: "POST" }).reply(200, { id: "env_1", type: "environment" });
  anthropic().intercept({ path: "/v1/vaults?beta=true", method: "POST" }).reply(200, { id: "vlt_1", type: "vault" });
  anthropic().intercept({ path: "/v1/agents?beta=true", method: "POST" }).reply(200, { id: "agent_1", version: 1, type: "agent" });
  const res = await send("PUT", "/teammates", toru, { orgId: ORG, provider: "claude", enabled: true, apiKey: "sk-ant-test", githubToken: "ghp_claude", repos: ["acme/app"] });
  expect(res.status).toBe(200);
}

/// A session that starts, and finishes with a pull request.
function session(seen) {
  anthropic().intercept({ path: "/v1/sessions?beta=true", method: "POST" }).reply(200, (opts) => { seen.push(JSON.parse(opts.body)); return { id: "sesn_1", type: "session", status: "running" }; });
  anthropic().intercept({ path: (p) => p.startsWith("/v1/sessions/sesn_1/events?"), method: "GET" }).reply(200, {
    data: [
      { id: "e1", type: "agent.message", processed_at: "2026-10-05T10:00:05Z", content: [{ type: "text", text: "Done: https://github.com/acme/app/pull/9" }] },
      { id: "e2", type: "session.status_idle", processed_at: "2026-10-05T10:00:06Z", stop_reason: { type: "end_turn" } },
    ],
    next_page: null,
  });
  anthropic().intercept({ path: "/v1/sessions/sesn_1?beta=true", method: "GET" }).reply(200, { id: "sesn_1", status: "idle", usage: { list_cost: { amount: "100", currency: "USD" } } });
}

/// The classifier's answer for a report.
function classifier(build, seen = []) {
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, (opts) => {
    seen.push(JSON.parse(opts.body));
    return { choices: [{ message: { content: JSON.stringify({ build }) } }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
  });
}

test("the workspace's own issue links are found, once each; another repository's are not", () => {
  const repos = new Set(["acme/app"]);
  expect(issueLinks("see https://github.com/Acme/app/issues/205 and https://github.com/acme/app/issues/205#x", repos).map((i) => i.key)).toEqual(["acme/app#205"]);
  expect(issueLinks("https://github.com/someone/else/issues/1", repos)).toEqual([]);
  expect(issueLinks("https://github.com/acme/app/pull/3", repos)).toEqual([]);
  expect(looksLikeReport("thanks!")).toBe(false);
  expect(looksLikeReport("Mobile message can send twice on a slow network, a bug")).toBe(true);
  expect(looksLikeReport("プロフィールを開くたびに読み込みが遅い、直してほしい")).toBe(true);
  expect(buildRequest({ issues: [{ repo: "acme/app", number: 5, url: "https://github.com/acme/app/issues/5" }], body: "x", author: "Mika" })).toContain('"Fixes #<number>"');
});

test("an issue link posted in a channel starts Claude in its thread, and the same issue is not started twice", async () => {
  await launch();
  const seen = [];
  session(seen);
  const posted = (await (await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "https://github.com/acme/app/issues/205 これ修正して" })).json()).message;
  expect(seen).toHaveLength(1);
  const task = seen[0].initial_events[0].content[0].text;
  expect(task).toContain("https://github.com/acme/app/issues/205");
  expect(task).toContain("Fixes #<number>");
  const replies = await thread(mika, posted.id);
  expect(replies.map((m) => m.body)).toEqual([
    "Starting on acme/app#205 on my own. I'll post the pull request here when it's ready.",
    "Done: https://github.com/acme/app/pull/9",
  ]);
  expect(replies.every((m) => m.authorName === "Claude")).toBe(true);
  // Linked again, anywhere: already under way.
  await send("POST", "/channels/messages", toru, { orgId: ORG, channel: "b:cafe", body: "reminder: https://github.com/acme/app/issues/205" });
  expect(await runs()).toBe(1);
  // Another repository's issue is not this team's to start.
  await send("POST", "/channels/messages", toru, { orgId: ORG, channel: "b:cafe", body: "https://github.com/someone/else/issues/3" });
  expect(await runs()).toBe(1);
});

test("a bug report the model says is buildable starts Claude; chat and non-reports cost nothing or start nothing", async () => {
  await launch();
  // Chat: no model is asked at all.
  await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "thanks, see you tomorrow" }, AI);
  // Looks like a report, but the model says no.
  classifier(false);
  await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "is the outage at the bank causing errors for anyone else?" }, AI);
  expect(await runs()).toBe(0);
  // A real one.
  const asked = [];
  classifier(true, asked);
  const seen = [];
  session(seen);
  const posted = (await (await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "On a slow network the message stays in the composer and a second tap sends it twice. Bug." }, AI)).json()).message;
  expect(asked[0].messages[0].content).toContain("reports a bug");
  expect(seen[0].initial_events[0].content[0].text).toContain("a second tap sends it twice");
  expect((await thread(mika, posted.id))[0].body).toContain("starting on it");
});

test("off, or already someone's to answer, nothing starts on its own", async () => {
  await launch();
  // A person named: theirs to answer.
  await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@toru https://github.com/acme/app/issues/7" });
  // A reply in a thread: part of a conversation.
  const parent = (await (await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "hello" })).json()).message;
  await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "https://github.com/acme/app/issues/8", parentId: parent.id });
  // Turned off by an admin.
  await env.DB.prepare("UPDATE ai_teammates SET auto_build = 0 WHERE org_id = ?1").bind(ORG).run();
  await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "https://github.com/acme/app/issues/9" });
  expect(await runs()).toBe(0);
  const seen = (await (await get(`/teammates?${q({ orgId: ORG, provider: "claude" })}`, toru)).json()).teammate;
  expect(seen.autoBuild).toBe(false);
});
