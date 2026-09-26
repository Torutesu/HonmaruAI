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
  expect((await (await call(`/channels/sidebar?${q({ orgId: ORG })}`, mika)).json()).sidebar).toEqual({ starred: [], sections: [] });
});
