import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { asksTheAI, withoutAI, recentBusinessTalk } from "../src/channels.js";

// Channels you can talk in: a business's, read by the workspace; a direct
// one, read by the two in it. "@AI" — or a click — turns a message into a
// decision written from the conversation around it.

const ORG = "personal:channels";
let toru; let mika; let kenji; let outsider;
const ENV = (over = {}) => ({ ...env, ...over });
// Work the Worker hands to waitUntil, awaited before a test looks at it.
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const settle = async () => { while (pending.length) await pending.shift(); };
const call = async (path, init, over) => {
  const res = await worker.fetch(new Request("https://example.com" + path, init), ENV(over), ctx);
  await settle();
  return res;
};
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const post = (path, token, body, over) => call(path, { method: "POST", headers: headers(token), body: JSON.stringify(body) }, over);
const get = (path, token) => call(path, { headers: headers(token) });
const q = (o) => new URLSearchParams(o).toString();
let refs;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9701", login: "toru", name: "Toru", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "email:mika@example.com", login: "u:mika@example.com", name: "Mika", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "9703", login: "kenji", name: "Kenji", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "9704", login: "nobody", name: "Nobody", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "9701", "admin");
  await upsertMembership(env.DB, ORG, "email:mika@example.com", "member");
  await upsertMembership(env.DB, ORG, "9703", "member");
  await upsertMembership(env.DB, "personal:else", "9704", "admin");
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "9701" });
  toru = await createSession(env.DB, "9701", "gho_t");
  mika = await createSession(env.DB, "email:mika@example.com", "gho_m");
  kenji = await createSession(env.DB, "9703", "gho_k");
  outsider = await createSession(env.DB, "9704", "gho_n");
  const list = await (await get(`/channels?${q({ orgId: ORG })}`, toru)).json();
  refs = Object.fromEntries(list.members.map((m) => [m.name, m.ref]));
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("@AI is read where a mention starts, and in Japanese", () => {
  expect(asksTheAI("@AI approve this")).toBe(true);
  expect(asksTheAI("@AIにまとめて")).toBe(true);
  expect(asksTheAI("＠ai これ決めて")).toBe(true);
  expect(asksTheAI("mail me at x@ai.com")).toBe(false);
  expect(asksTheAI("@aida can you")).toBe(false);
  expect(withoutAI("@AIに先週の売上をまとめて")).toBe("先週の売上をまとめて");
  expect(withoutAI("@AI, @Mika approve the price")).toBe("@Mika approve the price");
});

test("a business channel is the workspace's; messages come back by name, never by login", async () => {
  const sent = await post("/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "Roaster wants +8% from Friday" });
  expect(sent.status).toBe(201);
  const { message } = await sent.json();
  expect(message).toMatchObject({ channel: "b:cafe", kind: "message", authorName: "Mika", mine: true });
  const { messages } = await (await get(`/channels/messages?${q({ orgId: ORG, channel: "b:cafe" })}`, toru)).json();
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ body: "Roaster wants +8% from Friday", authorName: "Mika", mine: false, authorRef: refs.Mika });
  expect(JSON.stringify(messages)).not.toContain("mika@example.com");
  expect((await get(`/channels/messages?${q({ orgId: ORG, channel: "b:cafe" })}`, outsider)).status).toBe(403);
  expect((await post("/channels/messages", toru, { orgId: ORG, channel: "b:Not A Slug", body: "x" })).status).toBe(404);
  expect((await post("/channels/messages", toru, { orgId: ORG, channel: "b:cafe", body: "   " })).status).toBe(400);
});

test("a direct conversation is the two people's, named by the other's handle", async () => {
  await post("/channels/messages", toru, { orgId: ORG, channel: `dm:${refs.Mika}`, body: "Can you check the lease?" });
  const mine = await (await get(`/channels/messages?${q({ orgId: ORG, channel: `dm:${refs.Mika}` })}`, toru)).json();
  expect(mine.messages).toHaveLength(1);
  const mikaRefs = Object.fromEntries((await (await get(`/channels?${q({ orgId: ORG })}`, mika)).json()).members.map((m) => [m.name, m.ref]));
  const theirs = await (await get(`/channels/messages?${q({ orgId: ORG, channel: `dm:${mikaRefs.Toru}` })}`, mika)).json();
  expect(theirs.messages[0]).toMatchObject({ body: "Can you check the lease?", channel: `dm:${mikaRefs.Toru}`, mine: false });
  // Kenji reading "his" conversation with Mika sees nothing of Toru's.
  const kenjiRefs = Object.fromEntries((await (await get(`/channels?${q({ orgId: ORG })}`, kenji)).json()).members.map((m) => [m.name, m.ref]));
  expect((await (await get(`/channels/messages?${q({ orgId: ORG, channel: `dm:${kenjiRefs.Mika}` })}`, kenji)).json()).messages).toEqual([]);
  // And the sidebar's activity lists it for the two of them only.
  const act = (await (await get(`/channels?${q({ orgId: ORG })}`, toru)).json()).activity;
  expect(act).toEqual([expect.objectContaining({ channel: `dm:${refs.Mika}`, preview: "Can you check the lease?", lastBy: "me" })]);
  expect((await (await get(`/channels?${q({ orgId: ORG })}`, kenji)).json()).activity).toEqual([]);
});

test("@AI turns a message into a decision written from the conversation, and says so in the channel", async () => {
  await post("/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "The roaster quote came in: +8% from Friday, same beans" });
  await post("/channels/messages", kenji, { orgId: ORG, channel: "b:cafe", body: "Last year we declined +5% until the lease was settled" });
  let prompt;
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, (opts) => {
    prompt = JSON.parse(opts.body);
    return { choices: [{ message: { content: null, tool_calls: [] } }] };
  });
  const res = await post("/channels/messages", toru, { orgId: ORG, channel: "b:cafe", body: "@AI @Mika approve the new roaster price" }, { OPENAI_API_KEY: "sk-test" });
  expect((await res.json()).deciding).toBe(true);
  const user = prompt.messages.find((m) => m.role === "user").content;
  expect(user).toContain("The roaster quote came in: +8% from Friday");
  expect(user).toContain("Last year we declined +5%");
  const { results } = await env.DB.prepare("SELECT data FROM cards WHERE org_id = ?1").bind(ORG).all();
  expect(results).toHaveLength(1);
  const card = JSON.parse(results[0].data);
  expect(card).toMatchObject({ recipientUserID: "u:mika@example.com", senderUserID: "toru", business: "cafe", status: "pending" });
  expect(card.sourceInstruction).toBe("@Mika approve the new roaster price");
  const { messages } = await (await get(`/channels/messages?${q({ orgId: ORG, channel: "b:cafe" })}`, toru)).json();
  const asked = messages.find((m) => m.body.startsWith("@AI"));
  expect(asked.cardId).toBe(card.id);
  const ai = messages[messages.length - 1];
  expect(ai).toMatchObject({ kind: "ai", cardId: card.id, authorName: null });
  expect(ai.body).toContain("Mika");
});

test("any message can be made a decision afterwards, once; in a direct conversation it goes to the other person", async () => {
  const { message } = await (await post("/channels/messages", toru, { orgId: ORG, channel: `dm:${refs.Kenji}`, body: "Sign off the menu photos by Thursday" })).json();
  const made = await post("/channels/decide", toru, { orgId: ORG, channel: `dm:${refs.Kenji}`, messageId: message.id }, { OPENAI_API_KEY: undefined });
  expect(made.status).toBe(202);
  const card = JSON.parse((await env.DB.prepare("SELECT data FROM cards WHERE org_id = ?1").bind(ORG).first()).data);
  expect(card.recipientUserID).toBe("kenji");
  const again = await post("/channels/decide", toru, { orgId: ORG, channel: `dm:${refs.Kenji}`, messageId: message.id });
  expect(again.status).toBe(409);
  // Mika is not in that conversation and cannot reach its messages.
  const mikaRefs = Object.fromEntries((await (await get(`/channels?${q({ orgId: ORG })}`, mika)).json()).members.map((m) => [m.name, m.ref]));
  expect((await post("/channels/decide", mika, { orgId: ORG, channel: `dm:${mikaRefs.Kenji}`, messageId: message.id })).status).toBe(404);
});

test("what a channel says is context for Ask and for routines", async () => {
  await post("/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "Beans are 20% cheaper at the new place" });
  const talk = await recentBusinessTalk(env.DB, ORG, ["cafe"]);
  expect(talk).toEqual([expect.objectContaining({ channel: "#cafe", who: "Mika", text: "Beans are 20% cheaper at the new place" })]);
  const { saveCard } = await import("../src/db.js");
  await saveCard(env.DB, ORG, { id: "c1", recipientUserID: "toru", senderUserID: "kenji", title: "Switch roaster", business: "cafe", status: "pending", createdAt: new Date().toISOString() });
  let prompt;
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, (opts) => {
    prompt = JSON.parse(opts.body);
    return { choices: [{ message: { content: "Mika says the new place is 20% cheaper." } }] };
  });
  const res = await post("/ai/ask", toru, { orgId: ORG, cardId: "c1", question: "Why switch?" }, { OPENAI_API_KEY: "sk-test" });
  expect(res.status).toBe(200);
  expect(prompt.messages[1].content).toContain("Beans are 20% cheaper at the new place");
});
