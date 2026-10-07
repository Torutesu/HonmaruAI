import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { reconcile, useMirrorEnv } from "../src/store/mirror.js";

// M1: while D1 is still the record, every message written there is also
// written to the workspace's own Durable Object — for the workspaces
// WORKSPACE_DUAL names — and a daily pass repairs whatever a failed copy or
// a change outside the routes (an account deleted) left different.

const ORG = "team:dual";
let aya;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const call = async (path, { method = "GET", token, body, over = {} } = {}) => {
  const res = await worker.fetch(new Request(`https://api.example.com${path}`, {
    method, headers: { "content-type": "application/json", ...(token ? { "x-session-token": token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), { ...env, WORKSPACE_DUAL: ORG, ...over }, ctx);
  while (pending.length) await pending.shift();
  return res;
};
const post = async (text, extra = {}) => (await (await call("/channels/messages", { method: "POST", token: aya, body: { orgId: ORG, channel: "b:cafe", body: text, ...extra } })).json()).message;
const objectRows = async (orgId = ORG) => {
  const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(orgId));
  return runInDurableObject(stub, (_, state) => state.storage.sql.exec("SELECT id, channel_id, seq, body, deleted_at, edited_at FROM messages ORDER BY seq").toArray());
};

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM sessions; DELETE FROM memberships; DELETE FROM users; DELETE FROM businesses; DELETE FROM channel_messages; DELETE FROM org_governance;");
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "8901", login: "aya", name: "Aya", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "8901", "owner");
  await upsertMembership(env.DB, "team:single", "8901", "owner");
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "8901" });
  await upsertBusiness(env.DB, "team:single", { name: "Cafe", createdBy: "8901" });
  aya = await createSession(env.DB, "8901", "gho_a");
});

test("posting, editing and unsending in D1 reach the workspace's object", async () => {
  const first = await post("hello");
  const second = await post("second");
  expect((await objectRows()).map((r) => [r.id, r.seq, r.body])).toEqual([[first.id, 1, "hello"], [second.id, 2, "second"]]);

  await call("/channels/messages", { method: "PUT", token: aya, body: { orgId: ORG, channel: "b:cafe", messageId: first.id, body: "hello again" } });
  await call("/channels/messages", { method: "DELETE", token: aya, body: { orgId: ORG, channel: "b:cafe", messageId: second.id } });
  const rows = await objectRows();
  expect(rows[0]).toMatchObject({ body: "hello again" });
  expect(rows[0].edited_at).not.toBeNull();
  expect(rows[1]).toMatchObject({ body: "" });
  expect(rows[1].deleted_at).not.toBeNull();
});

test("a thread reply sent to the conversation too reaches the object as one", async () => {
  const parent = await post("menu?");
  const reply = await post("soup", { parentId: parent.id, alsoChannel: true });
  const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(ORG));
  const row = await runInDurableObject(stub, (_, state) => state.storage.sql.exec("SELECT parent_id, also_channel FROM messages WHERE id = ?", reply.id).toArray()[0]);
  expect(row).toEqual({ parent_id: parent.id, also_channel: 1 });
});

test("a workspace not named is left alone", async () => {
  const res = await call("/channels/messages", { method: "POST", token: aya, body: { orgId: "team:single", channel: "b:cafe", body: "only D1" } });
  expect(res.status).toBe(201);
  expect(await objectRows("team:single")).toEqual([]);
});

test("a copy that went missing, a change made behind the routes and a removed row are repaired", async () => {
  const a = await post("one");
  const b = await post("two");
  await post("three");
  // Behind the routes: a message the object never heard of, an edit, and a row D1 lost.
  await env.DB.prepare("INSERT INTO channel_messages (id, org_id, channel, author_login, body, created_at) VALUES ('zz-late', ?1, 'b:cafe', 'aya', 'late', ?2)").bind(ORG, new Date().toISOString()).run();
  await env.DB.prepare("UPDATE channel_messages SET body = 'two, changed' WHERE id = ?1").bind(b.id).run();
  await env.DB.prepare("DELETE FROM channel_messages WHERE id = ?1").bind(a.id).run();

  useMirrorEnv({ ...env, WORKSPACE_DUAL: ORG });
  const until = new Date(Date.now() + 60_000).toISOString();
  expect(await reconcile({ ...env, WORKSPACE_DUAL: ORG }, ORG, { until })).toMatchObject({ checked: 3, upserts: 2, deletes: 1, done: true });
  const bodies = (await objectRows()).map((r) => r.body).sort();
  expect(bodies).toEqual(["late", "three", "two, changed"]);
  // And a second pass finds nothing to do.
  expect(await reconcile({ ...env, WORKSPACE_DUAL: ORG }, ORG, { until })).toMatchObject({ upserts: 0, deletes: 0 });

  const check = await (await call(`/v2/w/${encodeURIComponent(ORG)}/checksum?until=${until}`, { token: aya, over: { WORKSPACE_V2: ORG } })).json();
  expect(check).toMatchObject({ match: true, checked: 3 });
});

test("messages past the workspace's retention leave the object as they leave D1", async () => {
  const old = await post("old");
  await post("new");
  await env.DB.prepare("UPDATE channel_messages SET created_at = ?2 WHERE id = ?1").bind(old.id, new Date(Date.now() - 40 * 86_400_000).toISOString()).run();
  await env.DB.prepare("INSERT INTO org_governance (org_id, retention_public_days, updated_by, updated_at) VALUES (?1, 30, '8901', ?2)").bind(ORG, new Date().toISOString()).run();
  const { pruneMessages } = await import("../src/governance.js");
  await pruneMessages({ ...env, WORKSPACE_DUAL: ORG });
  expect((await objectRows()).map((r) => r.body)).toEqual(["new"]);
});
