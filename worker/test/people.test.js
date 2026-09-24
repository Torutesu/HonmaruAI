import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { redirectIfAway } from "../src/people.js";
import { listMembers } from "../src/team.js";

// People: a status, away with a delegate, how loud each conversation is,
// and a teammate's profile.

const ORG = "personal:people";
let toru; let mika; let kenji;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const settle = async () => { while (pending.length) await pending.shift(); };
const call = async (path, init) => { const res = await worker.fetch(new Request("https://example.com" + path, init), env, ctx); await settle(); return res; };
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const post = (path, token, body) => call(path, { method: "POST", headers: headers(token), body: JSON.stringify(body) });
const get = (path, token) => call(path, { headers: headers(token) });
const q = (o) => new URLSearchParams(o).toString();
const put = (path, token, body) => call(path, { method: "PUT", headers: headers(token), body: JSON.stringify(body) });
const say = async (token, body, extra = {}) => (await (await post("/channels/messages", token, { orgId: ORG, channel: "b:cafe", body, ...extra })).json()).message;
let refs;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, upsertBusiness, setUserHandle } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9801", login: "toru", name: "Toru", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "9802", login: "mika", name: "Mika", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "9803", login: "kenji", name: "Kenji", avatarUrl: null, locale: "en" });
  for (const id of ["9801", "9802", "9803"]) await upsertMembership(env.DB, ORG, id, id === "9801" ? "admin" : "member");
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "9801" });
  await setUserHandle(env.DB, "9802", "mika.k");
  toru = await createSession(env.DB, "9801", "a"); mika = await createSession(env.DB, "9802", "b"); kenji = await createSession(env.DB, "9803", "c");
  refs = Object.fromEntries((await (await get(`/channels?${q({ orgId: ORG })}`, toru)).json()).members.map((m) => [m.name, m.ref]));
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());


test("a status shows on the member list, and clears itself when it runs out", async () => {
  const until = new Date(Date.now() + 3600000).toISOString();
  expect((await put("/channels/status", mika, { orgId: ORG, emoji: "🏖️", text: "On holiday", until })).status).toBe(200);
  const list = (await (await get(`/channels?${q({ orgId: ORG })}`, toru)).json()).members;
  expect(list.find((m) => m.name === "Mika").status).toMatchObject({ emoji: "🏖️", text: "On holiday" });
  await env.DB.prepare("UPDATE memberships SET status_until = ?1 WHERE user_github_id = '9802'").bind(new Date(Date.now() - 1000).toISOString()).run();
  const later = (await (await get(`/channels?${q({ orgId: ORG })}`, toru)).json()).members;
  expect(later.find((m) => m.name === "Mika").status).toBeNull();
  expect((await put("/channels/status", mika, { orgId: ORG, text: "x", until: "2001-01-01" })).status).toBe(400);
});

test("away with a delegate: a new card goes to the delegate, once, and says whose it was", async () => {
  const awayUntil = new Date(Date.now() + 3 * 86400000).toISOString();
  expect((await put("/channels/status", mika, { orgId: ORG, awayUntil, delegateRef: refs.Kenji })).status).toBe(200);
  expect((await put("/channels/status", mika, { orgId: ORG, awayUntil, delegateRef: refs.Mika })).status).toBe(400);
  const members = await listMembers(env.DB, ORG, null);
  const card = { id: "a1", recipientUserID: "mika", senderUserID: "toru", type: "approval" };
  const moved = await redirectIfAway(members, card);
  expect(moved.to.login).toBe("kenji");
  expect(card).toMatchObject({ recipientUserID: "kenji", coveringFor: { name: "Mika" } });
  expect(card.routingReason).toContain("Mika is away");
  // The delegate asking the away person does not bounce back to themselves.
  const own = { id: "a2", recipientUserID: "mika", senderUserID: "kenji", type: "approval" };
  expect(await redirectIfAway(members, own)).toBeNull();
  // Nobody else learns who the delegate is by login.
  const shown = JSON.stringify((await (await get(`/channels?${q({ orgId: ORG })}`, toru)).json()).members);
  expect(shown).not.toContain("delegate");
  const mine = (await (await get(`/channels?${q({ orgId: ORG })}`, mika)).json()).mine;
  expect(mine).toMatchObject({ awayUntil, delegateRef: refs.Kenji });
});

test("a conversation can be muted or set to mentions, per person", async () => {
  expect((await put("/channels/prefs", mika, { orgId: ORG, channel: "b:cafe", level: "mute" })).status).toBe(200);
  expect((await put("/channels/prefs", mika, { orgId: ORG, channel: "b:cafe", level: "loud" })).status).toBe(400);
  expect((await (await get(`/channels?${q({ orgId: ORG })}`, mika)).json()).prefs).toEqual({ "b:cafe": "mute" });
  expect((await (await get(`/channels?${q({ orgId: ORG })}`, toru)).json()).prefs).toEqual({});
  await put("/channels/prefs", mika, { orgId: ORG, channel: "b:cafe", level: "all" });
  expect((await (await get(`/channels?${q({ orgId: ORG })}`, mika)).json()).prefs).toEqual({});
});

test("a profile says who, where their clock is, and how they are with decisions", async () => {
  await get(`/channels?${q({ orgId: ORG, tz: "Asia/Tokyo" })}`, mika);
  await get(`/channels?${q({ orgId: ORG, tz: "Not/AZone!" })}`, kenji);
  const { saveCard } = await import("../src/db.js");
  const t0 = new Date(Date.now() - 3 * 3600000).toISOString();
  await saveCard(env.DB, ORG, { id: "p1", recipientUserID: "mika", senderUserID: "toru", type: "approval", status: "pending", title: "a", createdAt: t0 });
  await saveCard(env.DB, ORG, { id: "p2", recipientUserID: "mika", senderUserID: "toru", type: "approval", status: "approved", title: "b", createdAt: t0,
    decision: { action: "approve", actorUserID: "mika", decidedAt: new Date(Date.parse(t0) + 30 * 60000).toISOString() } });
  const res = await get(`/channels/member?${q({ orgId: ORG, ref: refs.Mika })}`, toru);
  expect(res.status).toBe(200);
  const { member } = await res.json();
  expect(member).toMatchObject({ name: "Mika", handle: "mika.k", timezone: "Asia/Tokyo", stats: { waiting: 1 } });
  expect(JSON.stringify(member)).not.toContain('"mika"');
  const kenjiP = (await (await get(`/channels/member?${q({ orgId: ORG, ref: refs.Kenji })}`, toru)).json()).member;
  expect(kenjiP.timezone).toBeNull();
  expect((await get(`/channels/member?${q({ orgId: ORG, ref: "nobody" })}`, toru)).status).toBe(404);
});
