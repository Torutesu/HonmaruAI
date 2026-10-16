import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import worker from "../src/index.js";
import { withRoomGuidelines } from "../src/harness/guidelines.js";
import { createSession, upsertUser, upsertMembership, upsertBusiness } from "../src/db.js";

const ORG = "personal:guidelines";
let owner, outsider;
const call = (method, channel, token, data) => worker.fetch(new Request(
  `https://example.com/hx/rooms/guidelines?${new URLSearchParams({ orgId: ORG, channel })}`,
  { method, headers: { "x-session-token": token, "content-type": "application/json" },
    ...(data ? { body: JSON.stringify({ orgId: ORG, channel, ...data }) } : {}) }), env);
beforeEach(async () => {
  for (const [id, login] of [["guideline-owner", "owner"], ["guideline-admin", "other"]]) {
    await upsertUser(env.DB, { githubId: id, login, name: login });
    await upsertMembership(env.DB, ORG, id, "admin");
  }
  owner = await createSession(env.DB, "guideline-owner", "test");
  outsider = await createSession(env.DB, "guideline-admin", "test");
  await upsertBusiness(env.DB, ORG, { name: "Private", createdBy: "guideline-owner" });
  await env.DB.prepare("UPDATE businesses SET private = 1 WHERE org_id = ?1 AND slug = 'private'").bind(ORG).run();
  await env.DB.prepare("INSERT INTO conversation_members (org_id, channel, login, added_by, added_at) VALUES (?1, 'b:private', 'owner', 'owner', ?2)").bind(ORG, new Date().toISOString()).run();
});

test("only room members read and write rules; admin has no private-room bypass", async () => {
  expect((await call("GET", "b:private", outsider)).status).toBe(404);
  expect((await call("PUT", "b:private", outsider, { body: "Override", version: 0 })).status).toBe(404);
  expect((await call("GET", "b:missing", owner)).status).toBe(404);
  expect((await call("GET", "dm:other", owner)).status).toBe(404);
  expect(await (await call("GET", "b:private", owner)).json()).toMatchObject({ guidelines: { body: "", version: 0 } });
  expect((await call("PUT", "b:private", owner, { body: "Cite every number", version: 0 })).status).toBe(200);
});

test("concurrent saves cannot overwrite a newer version, and inputs are bounded", async () => {
  expect((await call("PUT", "b:private", owner, { body: "x".repeat(4097), version: 0 })).status).toBe(400);
  expect((await call("PUT", "b:private", owner, { body: "Rules" })).status).toBe(400);
  expect((await call("PUT", "b:private", owner, { body: "First", version: 0 })).status).toBe(200);
  expect((await call("PUT", "b:private", owner, { body: "Stale", version: 0 })).status).toBe(409);
  expect((await call("PUT", "b:private", owner, { body: "Second", version: 1 })).status).toBe(200);
  expect((await call("PUT", "b:private", owner, { body: "Stale again", version: 1 })).status).toBe(409);
  expect(await (await call("GET", "b:private", owner)).json()).toMatchObject({ guidelines: { body: "Second", version: 2 } });
});

test("rules are refreshed each turn and do not bleed into a different room or DM", async () => {
  const agent = { instructions: "Be helpful" };
  await call("PUT", "b:private", owner, { body: "Cite sources", version: 0 });
  expect((await withRoomGuidelines(env.DB, ORG, "b:private", agent)).instructions).toContain("Cite sources");
  await call("PUT", "b:private", owner, { body: "New rules", version: 1 });
  const next = await withRoomGuidelines(env.DB, ORG, "b:private", agent);
  expect(next.instructions).toContain("New rules");
  expect(next.instructions).not.toContain("Cite sources");
  expect(await withRoomGuidelines(env.DB, ORG, "b:another", agent)).toEqual(agent);
  expect(await withRoomGuidelines(env.DB, ORG, "dm:owner|other", agent)).toEqual(agent);
  expect(await withRoomGuidelines(env.DB, "another-org", "b:private", agent)).toEqual(agent);
});
