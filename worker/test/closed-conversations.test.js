import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { channelActivity, recentBusinessTalk } from "../src/channels.js";
import { emitMessage } from "../src/webhooks.js";

// Conversations with a closed door: a group DM, and a private channel.
// Whoever is not in one cannot read it, find it, search it, be told about
// it, or reach it through a webhook — and cannot tell it is there.

const ORG = "personal:closed";
let toru; let mika; let kenji; let ann; let refs;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const settle = async () => { while (pending.length) await pending.shift(); };
const call = async (path, token, { method = "GET", body } = {}) => {
  const res = await worker.fetch(new Request(`https://example.com${path}`, {
    method, headers: { "content-type": "application/json", "x-session-token": token }, body: body ? JSON.stringify(body) : undefined,
  }), env, ctx);
  await settle();
  return res;
};
const q = (o) => new URLSearchParams(o).toString();
const say = async (token, channel, text) => call("/channels/messages", token, { method: "POST", body: { orgId: ORG, channel, body: text } });
const list = async (token, channel) => call(`/channels/messages?${q({ orgId: ORG, channel })}`, token);
const search = async (token, text) => (await (await call(`/channels/search?${q({ orgId: ORG, q: text })}`, token)).json()).messages || [];
const businesses = async (token) => (await (await call(`/businesses?${q({ orgId: ORG })}`, token)).json()).businesses.map((b) => b.slug);

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  for (const [id, login, name] of [["9901", "toru", "Toru"], ["9902", "mika", "Mika"], ["9903", "kenji", "Kenji"], ["9904", "ann", "Ann"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, id === "9901" ? "admin" : "member");
  }
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "9901" });
  toru = await createSession(env.DB, "9901", "gho_t");
  mika = await createSession(env.DB, "9902", "gho_m");
  kenji = await createSession(env.DB, "9903", "gho_k");
  ann = await createSession(env.DB, "9904", "gho_a");
  const people = await (await call(`/channels?${q({ orgId: ORG })}`, toru)).json();
  refs = Object.fromEntries(people.members.map((m) => [m.name, m.ref]));
});
afterEach(() => fetchMock.deactivate?.());

test("a group DM: the same people find the same one, and only they can read it", async () => {
  const made = await call("/channels/groups", toru, { method: "POST", body: { orgId: ORG, refs: [refs.Mika, refs.Kenji] } });
  expect(made.status).toBe(201);
  const { view } = await made.json();
  expect(view).toMatch(/^g:[0-9a-f]{16}$/);
  // Mika starting it with the same two people lands in the same one.
  const again = await (await call("/channels/groups", mika, { method: "POST", body: { orgId: ORG, refs: [refs.Kenji, refs.Toru] } })).json();
  expect(again.view).toBe(view);
  // One other person is simply a DM.
  expect((await (await call("/channels/groups", toru, { method: "POST", body: { orgId: ORG, refs: [refs.Mika] } })).json()).view).toBe(`dm:${refs.Mika}`);

  expect((await say(mika, view, "Dinner Friday? @Kenji")).status).toBe(201);
  const seen = await (await list(kenji, view)).json();
  expect(seen.messages.map((m) => m.body)).toEqual(["Dinner Friday? @Kenji"]);
  expect(seen.messages[0].channel).toBe(view);

  // Ann is in the workspace, not in the group: nothing, anywhere.
  expect((await list(ann, view)).status).toBe(404);
  expect((await say(ann, view, "hi")).status).toBe(404);
  expect(await search(ann, "Dinner")).toEqual([]);
  expect((await search(toru, "Dinner")).map((m) => m.channel)).toEqual([view]);
  expect((await channelActivity(env.DB, ORG, "ann", [])).map((a) => a.channel)).not.toContain(view);
  const annList = await (await call(`/channels?${q({ orgId: ORG })}`, ann)).json();
  expect(annList.groups).toEqual([]);
  const kenjiList = await (await call(`/channels?${q({ orgId: ORG })}`, kenji)).json();
  expect(kenjiList.groups).toEqual([{ view, refs: expect.arrayContaining([refs.Toru, refs.Mika]) }]);
  const where = await call(`/channels/locate?${q({ orgId: ORG, messageId: seen.messages[0].id })}`, ann);
  expect(where.status).toBe(404);

  // The mention reaches Kenji's Activity; the details list the three.
  const act = await (await call(`/channels/activity?${q({ orgId: ORG })}`, kenji)).json();
  expect(act.items.map((i) => i.message.channel)).toContain(view);
  const details = await (await call(`/channels/details?${q({ orgId: ORG, channel: view })}`, toru)).json();
  expect(details.channel).toMatchObject({ kind: "group", name: expect.stringContaining("Mika") });
  expect(details.members.people.map((p) => p.name).sort()).toEqual(["Kenji", "Mika", "Toru"]);
});

test("a group is three to nine people from this workspace", async () => {
  expect((await call("/channels/groups", toru, { method: "POST", body: { orgId: ORG, refs: [] } })).status).toBe(404);
  expect((await call("/channels/groups", toru, { method: "POST", body: { orgId: ORG, refs: [refs.Mika, "member:nobody"] } })).status).toBe(404);
});

test("a private channel: only its members see it at all, and they bring others in", async () => {
  const made = await call("/businesses", toru, { method: "POST", body: { orgId: ORG, name: "Payroll", private: true, members: [refs.Mika] } });
  expect(made.status).toBe(200);
  expect((await made.json()).business).toMatchObject({ slug: "payroll", private: true });
  // A private channel is made, never found: the name is taken.
  expect((await call("/businesses", mika, { method: "POST", body: { orgId: ORG, name: "payroll", private: true } })).status).toBe(409);
  expect((await call("/businesses", mika, { method: "POST", body: { orgId: ORG, name: "Cafe", private: true } })).status).toBe(409);

  expect(await businesses(mika)).toEqual(["cafe", "payroll"]);
  expect(await businesses(kenji)).toEqual(["cafe"]);

  await say(mika, "b:payroll", "Salaries go out on the 25th");
  expect((await list(kenji, "b:payroll")).status).toBe(404);
  expect((await say(kenji, "b:payroll", "hello?")).status).toBe(404);
  expect(await search(kenji, "Salaries")).toEqual([]);
  expect((await search(mika, "Salaries")).length).toBe(1);
  expect((await channelActivity(env.DB, ORG, "kenji", [])).map((a) => a.channel)).not.toContain("b:payroll");
  // Its words never feed the AI's answers anyone may read.
  expect(await recentBusinessTalk(env.DB, ORG, ["payroll"])).toEqual([]);
  // Nobody outside renames or deletes it.
  expect((await call("/businesses", kenji, { method: "PUT", body: { orgId: ORG, slug: "payroll", name: "Hacked" } })).status).toBe(400);
  await call("/businesses", kenji, { method: "DELETE", body: { orgId: ORG, slug: "payroll" } });
  expect(await businesses(mika)).toEqual(["cafe", "payroll"]);

  // Mika brings Kenji in; the channel says so, and now he reads it.
  const added = await call("/channels/members", mika, { method: "POST", body: { orgId: ORG, channel: "b:payroll", refs: [refs.Kenji] } });
  expect(await added.json()).toEqual({ added: 1 });
  const now = await (await list(kenji, "b:payroll")).json();
  expect(now.messages.map((m) => m.body)).toEqual(["Salaries go out on the 25th", "Mika added Kenji to the channel."]);
  expect(await businesses(kenji)).toEqual(["cafe", "payroll"]);
  // Kenji leaves; the door closes behind him.
  expect((await call("/channels/members", kenji, { method: "DELETE", body: { orgId: ORG, channel: "b:payroll" } })).status).toBe(200);
  expect((await list(kenji, "b:payroll")).status).toBe(404);
  expect(await businesses(kenji)).toEqual(["cafe"]);
  // A public channel has no member list to change.
  expect((await call("/channels/members", toru, { method: "POST", body: { orgId: ORG, channel: "b:cafe", refs: [refs.Ann] } })).status).toBe(400);
});

test("an invitation into a private channel takes the newcomer in, only if the inviter is there", async () => {
  await call("/businesses", toru, { method: "POST", body: { orgId: ORG, name: "Board", private: true } });
  const { channelsOf } = await import("../src/auth.js");
  expect(await channelsOf(env.DB, ORG, ["board", "cafe"], "9901")).toEqual(["board", "cafe"]);
  expect(await channelsOf(env.DB, ORG, ["board", "cafe"], "9902")).toEqual(["cafe"]);
  const { introduce } = await import("../src/welcome.js");
  await introduce(env, { orgId: ORG, channels: ["board"], githubId: "9904", invitedBy: "9901" });
  expect((await list(ann, "b:board")).status).toBe(200);
});

test("a webhook hears a closed conversation only if the person who made it is in it", async () => {
  await call("/businesses", toru, { method: "POST", body: { orgId: ORG, name: "Legal", private: true, members: [refs.Mika] } });
  const url = "https://closed-hooks.example.com/in";
  await call("/webhooks", kenji, { method: "POST", body: { orgId: ORG, url, events: ["message.created"] } });
  await call("/webhooks", mika, { method: "POST", body: { orgId: ORG, url, events: ["message.created"] } });
  let deliveries = 0;
  fetchMock.activate();
  fetchMock.get("https://closed-hooks.example.com").intercept({ path: "/in", method: "POST" }).reply(200, () => { deliveries += 1; return "ok"; }).persist();
  const row = { id: "m9", channel: "b:legal", author_login: "toru", body: "NDA draft", created_at: "2026-09-25T10:00:00Z" };
  expect(await emitMessage(env, ORG, row)).toBe(1);
  expect(deliveries).toBe(1);
  // A public channel reaches both.
  expect(await emitMessage(env, ORG, { ...row, id: "m10", channel: "b:cafe" })).toBe(2);
});
