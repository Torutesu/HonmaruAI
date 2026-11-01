import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { recipientsOf } from "../src/pushes.js";
import { listMembers } from "../src/team.js";

// A user group: "@営業" reaches everyone in it. A sidebar: one person's
// stars and sections, in one workspace.

const ORG = "personal:groups";
let toru; let mika; let kenji; let refs;
const ctx = { waitUntil: () => {} };
const call = async (path, token, { method = "GET", body } = {}) => worker.fetch(new Request(`https://example.com${path}`, {
  method, headers: { "content-type": "application/json", "x-session-token": token }, body: body ? JSON.stringify(body) : undefined,
}), env, ctx);
const q = (o) => new URLSearchParams(o).toString();

test('concurrent sidebar changes reject stale versions without erasing other devices', async () => {
  const read = () => call(`/channels/sidebar?${q({orgId: ORG})}`,toru).then(r=>r.json());
  const write = (sidebar,version) => call('/channels/sidebar',toru,{method:'PUT',body:{orgId:ORG,sidebar,version}});
  const first = await read();
  expect(first.version).toBeNull();
  const a = await write({...first.sidebar,starred:['b:cafe']},first.version);
  expect(a.status).toBe(200);
  const second = await a.json();
  const stale = await write({...first.sidebar,starred:['b:kitchen']},first.version);
  expect(stale.status).toBe(409);
  const conflict=await stale.json();
  expect(conflict.sidebar.starred).toEqual(['b:cafe']);
  const b=await write({...conflict.sidebar,starred:[...conflict.sidebar.starred,'b:kitchen']},conflict.version);
  expect(b.status).toBe(200);
  expect((await read()).sidebar.starred).toEqual(['b:cafe','b:kitchen']);
  expect((await write(second.sidebar,second.version)).status).toBe(409);
  expect((await read()).sidebar.starred).toEqual(['b:cafe','b:kitchen']);
  const current=await read();
  const simultaneous=await Promise.all([
    write({...current.sidebar,starred:[...current.sidebar.starred,'b:a']},current.version),
    write({...current.sidebar,starred:[...current.sidebar.starred,'b:b']},current.version),
  ]);
  expect(simultaneous.map(result=>result.status).sort()).toEqual([200,409]);
});

test('a damaged sidebar is not silently replaced by an empty layout', async () => {
  await env.DB.prepare('INSERT INTO sidebar_prefs(org_id,login,data,updated_at) VALUES(?1,?2,?3,?4)').bind(ORG,'toru','{broken','2026-01-01').run();
  const response=await call(`/channels/sidebar?${q({orgId:ORG})}`,toru);
  expect(response.status).toBe(500);
  expect((await env.DB.prepare('SELECT data FROM sidebar_prefs WHERE org_id=?1 AND login=?2').bind(ORG,'toru').first()).data).toBe('{broken');
});

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  for (const [id, login, name] of [["5501", "toru", "Toru"], ["5502", "mika", "Mika"], ["5503", "kenji", "Kenji"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "ja" });
    await upsertMembership(env.DB, ORG, id, id === "5501" ? "admin" : "member");
  }
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "5501" });
  toru = await createSession(env.DB, "5501", "gho_t");
  mika = await createSession(env.DB, "5502", "gho_m");
  kenji = await createSession(env.DB, "5503", "gho_k");
  const people = await (await call(`/channels?${q({ orgId: ORG })}`, toru)).json();
  refs = Object.fromEntries(people.members.map((m) => [m.name, m.ref]));
});

test("a group is made, named, changed, and one mention reaches everyone in it", async () => {
  const made = await call("/channels/usergroups", mika, { method: "POST", body: { orgId: ORG, handle: "@営業", name: "Sales", refs: [refs.Mika, refs.Kenji, "member:nobody"] } });
  expect(made.status).toBe(201);
  expect((await made.json()).group).toMatchObject({ handle: "営業", name: "Sales", refs: expect.arrayContaining([refs.Mika, refs.Kenji]) });
  // Taken, or somebody's own name: refused.
  expect((await call("/channels/usergroups", toru, { method: "POST", body: { orgId: ORG, handle: "営業", refs: [] } })).status).toBe(409);
  expect((await call("/channels/usergroups", toru, { method: "POST", body: { orgId: ORG, handle: "mika", refs: [] } })).status).toBe(409);

  const members = await listMembers(env.DB, ORG, null);
  const to = await recipientsOf(env.DB, ORG, { id: "x", kind: "message", channel: "b:cafe", author_login: "toru", body: "@営業 来週の数字を" }, members);
  expect(to.map((r) => r.login).sort()).toEqual(["kenji", "mika"]);

  // Anyone may change who is in it.
  const changed = await (await call("/channels/usergroups", toru, { method: "PUT", body: { orgId: ORG, handle: "営業", name: "Sales team", refs: [refs.Kenji] } })).json();
  expect(changed.group).toMatchObject({ name: "Sales team", refs: [refs.Kenji] });
  // Only its maker, or an admin, deletes it.
  expect((await call("/channels/usergroups", kenji, { method: "DELETE", body: { orgId: ORG, handle: "営業" } })).status).toBe(403);
  const gone = await (await call("/channels/usergroups", toru, { method: "DELETE", body: { orgId: ORG, handle: "営業" } })).json();
  expect(gone.groups).toEqual([]);
});

test("a sidebar is one person's own, and keeps only what makes sense", async () => {
  const saved = await (await call("/channels/sidebar", toru, { method: "PUT", body: { orgId: ORG, sidebar: {
    starred: ["b:cafe", "b:cafe", "javascript:alert(1)"],
    sections: [
      { id: "s1", name: "Clients", views: ["b:cafe", `dm:${refs.Mika}`] },
      { id: "s2", name: "  ", views: ["b:x"] },
      { name: "Later", views: ["b:cafe"] },
    ],
  } } })).json();
  expect(saved.sidebar.starred).toEqual(["b:cafe"]);
  expect(saved.sidebar.sections.map((s) => [s.name, s.views])).toEqual([["Clients", ["b:cafe", `dm:${refs.Mika}`]], ["Later", []]]);
  expect((await (await call(`/channels/sidebar?${q({ orgId: ORG })}`, toru)).json()).sidebar.sections[0].id).toBe("s1");
  // Mika's is her own.
  expect((await (await call(`/channels/sidebar?${q({ orgId: ORG })}`, mika)).json()).sidebar).toEqual({ starred: [], sections: [], order: [] });
});

test("a conversation with an agent can be starred and put in a section, and only as ag:<id>", async () => {
  const agent = "ag:6f1c2d3e-0a4b-4c5d-8e9f-a0b1c2d3e4f5";
  const put = async (sidebar) => (await (await call("/channels/sidebar", toru, { method: "PUT", body: { orgId: ORG, sidebar } })).json()).sidebar;
  const saved = await put({
    starred: [agent, "ag:x|toru", "ag:", "ag:../b:cafe"],
    sections: [{ id: "s1", name: "Helpers", views: ["ag:hayao", "ag:hayao|mika"], collapsed: true }],
  });
  expect(saved.starred).toEqual([agent]);
  expect(saved.sections).toEqual([{ id: "s1", name: "Helpers", views: ["ag:hayao"], collapsed: true }]);
  // Kept, and read back the same.
  const read = (await (await call(`/channels/sidebar?${q({ orgId: ORG })}`, toru)).json()).sidebar;
  expect(read.starred).toEqual([agent]);
  expect(read.sections[0]).toMatchObject({ views: ["ag:hayao"], collapsed: true });
});

test("the order you dragged your channels into is kept, and an app that does not know about it cannot lose it", async () => {
  const put = async (sidebar) => (await (await call("/channels/sidebar", toru, { method: "PUT", body: { orgId: ORG, sidebar } })).json()).sidebar;
  expect((await put({ starred: [], sections: [], order: ["b:roastery", "b:cafe", "b:cafe", "nope"] })).order).toEqual(["b:roastery", "b:cafe"]);
  // An older phone saves only what it knows.
  expect((await put({ starred: ["b:cafe"], sections: [] })).order).toEqual(["b:roastery", "b:cafe"]);
  // Saying the order outright replaces it.
  expect((await put({ starred: [], sections: [], order: [] })).order).toEqual([]);
});

test("a folded section stays folded when an app that does not know about folding saves", async () => {
  const put = async (sidebar) => (await (await call("/channels/sidebar", toru, { method: "PUT", body: { orgId: ORG, sidebar } })).json()).sidebar;
  const folded = (sidebar) => sidebar.sections.map((s) => [s.id, s.collapsed]);
  expect(folded(await put({ starred: [], sections: [{ id: "s1", name: "Clients", views: [], collapsed: true }, { id: "s2", name: "Later", views: [] }], order: [] })))
    .toEqual([["s1", true], ["s2", false]]);
  // The iOS app saves its sections without the flag: the fold is kept, and
  // a section it adds starts open.
  expect(folded(await put({ starred: ["b:cafe"], sections: [{ id: "s1", name: "Clients", views: ["b:cafe"] }, { id: "s2", name: "Later", views: [] }, { id: "s3", name: "New", views: [] }], order: [] })))
    .toEqual([["s1", true], ["s2", false], ["s3", false]]);
  // Saying it outright opens it.
  expect(folded(await put({ starred: [], sections: [{ id: "s1", name: "Clients", views: [], collapsed: false }], order: [] }))).toEqual([["s1", false]]);
  // The order is still kept for a client that does not send one.
  await put({ starred: [], sections: [{ id: "s1", name: "Clients", views: [], collapsed: true }], order: ["b:cafe"] });
  const older = await put({ starred: [], sections: [{ id: "s1", name: "Clients", views: [] }] });
  expect(older.order).toEqual(["b:cafe"]);
  expect(folded(older)).toEqual([["s1", true]]);
});

test("folding a section writes that flag and nothing else, so a window open since the morning keeps your stars", async () => {
  const put = async (sidebar) => (await (await call("/channels/sidebar", toru, { method: "PUT", body: { orgId: ORG, sidebar } })).json()).sidebar;
  const fold = (token, body) => call("/channels/sidebar/fold", token, { method: "POST", body: { orgId: ORG, ...body } });
  // What the stale window loaded: one section, nothing starred.
  await put({ starred: [], sections: [{ id: "s1", name: "Later", views: [], collapsed: false }], order: [] });
  // Since then, on another device: a star, a new section, an order.
  const since = await put({ starred: ["b:cafe"], sections: [{ id: "s1", name: "Later", views: ["b:roastery"], collapsed: false }, { id: "s2", name: "Clients", views: [`dm:${refs.Mika}`], collapsed: false }], order: ["b:roastery", "b:cafe"] });

  const folded = await fold(toru, { id: "s1", collapsed: true });
  expect(folded.status).toBe(200);
  const after = (await folded.json()).sidebar;
  expect(after).toEqual({ ...since, sections: [{ ...since.sections[0], collapsed: true }, since.sections[1]] });
  expect((await (await call(`/channels/sidebar?${q({ orgId: ORG })}`, toru)).json()).sidebar).toEqual(after);
  // The second one, and open again: each its own flag.
  expect((await (await fold(toru, { id: "s2", collapsed: true })).json()).sidebar.sections.map((s) => s.collapsed)).toEqual([true, true]);
  expect((await (await fold(toru, { id: "s1", collapsed: false })).json()).sidebar.sections.map((s) => s.collapsed)).toEqual([false, true]);
  // Anything but true opens it.
  expect((await (await fold(toru, { id: "s2", collapsed: "yes" })).json()).sidebar.sections.map((s) => s.collapsed)).toEqual([false, false]);

  // A section you do not have, or no section at all: nothing is written.
  expect((await fold(toru, { id: "gone", collapsed: true })).status).toBe(404);
  expect((await fold(toru, { id: "s1'] || '", collapsed: true })).status).toBe(404);
  expect((await fold(toru, { id: { $ne: null }, collapsed: true })).status).toBe(404);
  expect((await fold(toru, { collapsed: true })).status).toBe(404);
  // Mika has no sidebar yet, and Toru's "s1" is not hers to fold.
  expect((await fold(mika, { id: "s1", collapsed: true })).status).toBe(404);
  expect((await (await call(`/channels/sidebar?${q({ orgId: ORG })}`, mika)).json()).sidebar).toEqual({ starred: [], sections: [], order: [] });
  expect((await (await call(`/channels/sidebar?${q({ orgId: ORG })}`, toru)).json()).sidebar.sections.map((s) => s.collapsed)).toEqual([false, false]);

  // Signed in, and in the workspace, like the rest of the sidebar.
  expect((await fold("nope", { id: "s1", collapsed: true })).status).toBe(401);
  expect((await call("/channels/sidebar/fold", toru, { method: "POST", body: { orgId: "personal:elsewhere", id: "s1", collapsed: true } })).status).toBe(403);
  expect((await call("/channels/sidebar/fold", toru, { method: "POST", body: { id: "s1", collapsed: true } })).status).toBe(400);
});
