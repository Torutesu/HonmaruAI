import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// A conversation's canvas: one shared document, versioned so two people
// editing at once are told, with its earlier versions kept.

const ORG = "personal:canvas";
let toru; let mika; let gus;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const call = async (path, token, { method = "GET", body } = {}) => {
  const res = await worker.fetch(new Request(`https://example.com${path}`, {
    method, headers: { "content-type": "application/json", "x-session-token": token }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, ctx);
  while (pending.length) await pending.shift();
  return res;
};
const q = (o) => new URLSearchParams(o).toString();

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM rate_limits; DELETE FROM channel_canvases; DELETE FROM channel_canvas_revisions; DELETE FROM conversation_members;");
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  for (const [id, login, name, role] of [["7201", "toru", "Toru", "admin"], ["7202", "mika", "Mika", "member"], ["7203", "gus", "Gus", "guest"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, role);
  }
  await env.DB.prepare("UPDATE memberships SET role = 'guest' WHERE user_github_id = '7203'").run();
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "7201" });
  await upsertBusiness(env.DB, ORG, { name: "Hotel", createdBy: "7201" });
  await env.DB.prepare("INSERT INTO conversation_members (org_id, channel, login, added_by, added_at) VALUES (?1, 'b:cafe', 'gus', 'toru', ?2)").bind(ORG, new Date().toISOString()).run();
  toru = await createSession(env.DB, "7201", "x");
  mika = await createSession(env.DB, "7202", "x");
  gus = await createSession(env.DB, "7203", "x");
});

const read = async (token, channel = "b:cafe") => (await call(`/channels/canvas?${q({ orgId: ORG, channel })}`, token)).json();
const save = (token, body, baseVersion, channel = "b:cafe") => call("/channels/canvas", token, { method: "PUT", body: { orgId: ORG, channel, body, baseVersion } });

test("empty at first, then saved and read by everyone in the conversation", async () => {
  expect((await read(toru)).canvas).toEqual({ body: "", version: 0, updatedBy: null, updatedAt: null });
  const res = await save(mika, "## Opening\n- [ ] Unlock at 7", 0);
  expect(res.status).toBe(200);
  const saved = await res.json();
  expect(saved.canvas).toMatchObject({ version: 1, updatedBy: "Mika", body: "## Opening\n- [ ] Unlock at 7" });
  expect(JSON.stringify(saved)).not.toContain("mika\"");
  // A guest let into Cafe reads and edits it; Hotel's is not theirs.
  expect((await read(gus)).canvas.version).toBe(1);
  expect((await save(gus, "## Opening\n- [x] Unlock at 7", 1)).status).toBe(200);
  expect((await call(`/channels/canvas?${q({ orgId: ORG, channel: "b:hotel" })}`, gus)).status).toBe(404);
});

test("two people editing at once: the second is told, with the first one's version", async () => {
  await save(toru, "v1", 0);
  expect((await save(mika, "Mika's edit", 1)).status).toBe(200);
  const late = await save(toru, "Toru's edit", 1);
  expect(late.status).toBe(409);
  expect((await late.json()).canvas).toMatchObject({ version: 2, body: "Mika's edit", updatedBy: "Mika" });
  // Saving the same text again changes nothing.
  const same = await (await save(mika, "Mika's edit", 2)).json();
  expect(same.canvas.version).toBe(2);
});

test("earlier versions are kept and can be read back", async () => {
  await save(toru, "first", 0);
  await save(toru, "second", 1);
  const { revisions } = await read(mika);
  expect(revisions.map((r) => r.version)).toEqual([2, 1]);
  const old = await (await call(`/channels/canvas/revision?${q({ orgId: ORG, channel: "b:cafe", version: 1 })}`, mika)).json();
  expect(old.revision).toMatchObject({ body: "first", version: 1, updatedBy: "Toru" });
  // Put back as a new version.
  expect((await (await save(mika, old.revision.body, 2)).json()).canvas).toMatchObject({ version: 3, body: "first" });
});

test("too long is refused; without a model the AI draft leaves it as it was", async () => {
  expect((await save(toru, "x".repeat(50_001), 0)).status).toBe(400);
  await save(toru, "## Rules", 0);
  const draft = await (await call("/channels/canvas/draft", toru, { method: "POST", body: { orgId: ORG, channel: "b:cafe" } })).json();
  expect(draft).toMatchObject({ body: "## Rules", byModel: false });
  expect(draft.note).toBeTruthy();
});
