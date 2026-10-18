import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { forgetDeletions, purgeDueWorkspaces } from "../src/workspaceDeletion.js";

// A workspace could not be deleted at all: `workspace.delete` was a
// permission nothing used. An owner now asks, has thirty days to take it
// back, and then everything stored under it goes.

const ORG = "team:going";
const DAY = 86_400_000;
let owner; let member;
const post = (path, token, body) => worker.fetch(new Request(`https://example.com${path}`, {
  method: "POST", headers: { "content-type": "application/json", "x-session-token": token }, body: JSON.stringify(body),
}), env, { waitUntil() {} });
const get = (path, token) => worker.fetch(new Request(`https://example.com${path}`, { headers: { "x-session-token": token } }), env, { waitUntil() {} });

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  forgetDeletions();
  const { createSession, upsertUser, upsertMembership, saveCard } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9501", login: "own", name: "Own", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "9502", login: "mem", name: "Mem", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "9501", "owner");
  await upsertMembership(env.DB, ORG, "9502", "member");
  await upsertMembership(env.DB, "team:stays", "9502", "owner");
  await env.DB.prepare("INSERT INTO orgs (id, name, created_at) VALUES (?1, 'Going Co', ?2)").bind(ORG, new Date().toISOString()).run();
  const now = new Date().toISOString();
  await saveCard(env.DB, ORG, { id: "c1", recipientUserID: "own", senderUserID: "mem", type: "approval", title: "x", status: "pending", createdAt: now });
  await saveCard(env.DB, "team:stays", { id: "c2", recipientUserID: "mem", senderUserID: "mem", type: "approval", title: "y", status: "pending", createdAt: now });
  await env.MEDIA.put(`org/${encodeURIComponent(ORG)}/files/f_1`, "bytes");
  await env.MEDIA.put(`org/${encodeURIComponent("team:stays")}/files/f_2`, "bytes");
  owner = await createSession(env.DB, "9501", "x");
  member = await createSession(env.DB, "9502", "x");
});

test("only an owner, typing its name, asks; the workspace closes to everyone else, and the owner can take it back", async () => {
  expect((await post("/orgs/delete", member, { orgId: ORG, confirm: "Going Co" })).status).toBe(403);
  const wrong = await post("/orgs/delete", owner, { orgId: ORG, confirm: "going" });
  expect(wrong.status).toBe(400);
  expect((await wrong.json()).code).toBe("confirm-name");
  const asked = await post("/orgs/delete", owner, { orgId: ORG, confirm: "Going Co" });
  expect(asked.status).toBe(202);
  expect(Date.parse((await asked.json()).dueAt) - Date.now()).toBeGreaterThan(29 * DAY);

  const closed = await get(`/members?orgId=${encodeURIComponent(ORG)}`, member);
  expect(closed.status).toBe(410);
  expect((await closed.json()).code).toBe("workspace-deleting");
  expect((await get(`/members?orgId=${encodeURIComponent(ORG)}`, owner)).status).toBe(200);
  // Their other workspace is untouched.
  expect((await get(`/members?orgId=${encodeURIComponent("team:stays")}`, member)).status).toBe(200);

  expect((await post("/orgs/delete/cancel", owner, { orgId: ORG })).status).toBe(200);
  forgetDeletions();
  expect((await get(`/members?orgId=${encodeURIComponent(ORG)}`, member)).status).toBe(200);
  const actions = (await env.DB.prepare("SELECT action FROM audit_events WHERE org_id = ?1 ORDER BY seq").bind(ORG).all()).results.map((r) => r.action);
  expect(actions).toEqual(expect.arrayContaining(["workspace.deletion_scheduled", "workspace.deletion_cancelled"]));
});

test("after thirty days everything under the workspace goes, the audit log stays, and a tombstone says when", async () => {
  await post("/orgs/delete", owner, { orgId: ORG, confirm: "Going Co" });
  // Not yet.
  expect(await purgeDueWorkspaces(env, { now: Date.now() + 29 * DAY })).toEqual([]);
  expect(await purgeDueWorkspaces(env, { now: Date.now() + 31 * DAY })).toEqual([ORG]);

  const left = async (sql) => (await env.DB.prepare(sql).bind(ORG).first()).n;
  expect(await left("SELECT COUNT(*) AS n FROM cards WHERE org_id = ?1")).toBe(0);
  expect(await left("SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?1")).toBe(0);
  expect(await left("SELECT COUNT(*) AS n FROM orgs WHERE id = ?1")).toBe(0);
  expect(await left("SELECT COUNT(*) AS n FROM workspace_tombstones WHERE org_id = ?1")).toBe(1);
  expect(await left("SELECT COUNT(*) AS n FROM audit_events WHERE org_id = ?1")).toBeGreaterThan(0);
  expect(await env.MEDIA.get(`org/${encodeURIComponent(ORG)}/files/f_1`)).toBeNull();
  // Nobody else's.
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cards WHERE org_id = 'team:stays'").first()).n).toBe(1);
  expect(await env.MEDIA.get(`org/${encodeURIComponent("team:stays")}/files/f_2`)).not.toBeNull();
});

// The daily job read the due deletions, then went on to delete each one
// without asking again, so an owner who took the request back in between
// was told it was kept while it was deleted. The job now claims each
// request before deleting anything: whichever comes first wins.

/// The env with env.DB stopping once, right after the first statement
/// matching `match` has run, to let `during` happen there.
function pausedAfter(match, during) {
  let fired = false;
  const wrap = (stmt) => new Proxy(stmt, {
    get(t, p) {
      if (p === "bind") return (...args) => wrap(t.bind(...args));
      if (p === "all" || p === "first" || p === "run") {
        return async (...args) => {
          const out = await t[p](...args);
          if (!fired) { fired = true; await during(); }
          return out;
        };
      }
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const DB = new Proxy(env.DB, {
    get(t, p) {
      if (p === "prepare") return (sql) => (match.test(sql) ? wrap(t.prepare(sql)) : t.prepare(sql));
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { ...env, DB };
}
const count = async (sql) => (await env.DB.prepare(sql).bind(ORG).first()).n;

test("taken back after the job selected it but before it claimed it, the workspace is kept whole", async () => {
  await post("/orgs/delete", owner, { orgId: ORG, confirm: "Going Co" });
  let cancel;
  const racing = pausedAfter(/FROM workspace_deletions WHERE due_at <= /, async () => { cancel = await post("/orgs/delete/cancel", owner, { orgId: ORG }); });
  expect(await purgeDueWorkspaces(racing, { now: Date.now() + 31 * DAY })).toEqual([]);
  expect(cancel.status).toBe(200);
  expect(await count("SELECT COUNT(*) AS n FROM cards WHERE org_id = ?1")).toBe(1);
  expect(await count("SELECT COUNT(*) AS n FROM orgs WHERE id = ?1")).toBe(1);
  expect(await count("SELECT COUNT(*) AS n FROM workspace_tombstones WHERE org_id = ?1")).toBe(0);
  expect(await env.MEDIA.get(`org/${encodeURIComponent(ORG)}/files/f_1`)).not.toBeNull();
});

test("asked again after the job selected the old request, the new thirty days hold", async () => {
  await post("/orgs/delete", owner, { orgId: ORG, confirm: "Going Co" });
  const racing = pausedAfter(/FROM workspace_deletions WHERE due_at <= /, async () => {
    await post("/orgs/delete/cancel", owner, { orgId: ORG });
    await post("/orgs/delete", owner, { orgId: ORG, confirm: "Going Co" });
  });
  expect(await purgeDueWorkspaces(racing, { now: Date.now() + 31 * DAY })).toEqual([]);
  expect(await count("SELECT COUNT(*) AS n FROM cards WHERE org_id = ?1")).toBe(1);
  expect((await env.DB.prepare("SELECT purge_started_at FROM workspace_deletions WHERE org_id = ?1").bind(ORG).first()).purge_started_at).toBeNull();
});

test("once the job has claimed it, taking it back is refused rather than promised", async () => {
  await post("/orgs/delete", owner, { orgId: ORG, confirm: "Going Co" });
  let cancel; let again;
  const racing = pausedAfter(/sqlite_master/, async () => {
    cancel = await post("/orgs/delete/cancel", owner, { orgId: ORG });
    again = await post("/orgs/delete", owner, { orgId: ORG, confirm: "Going Co" });
  });
  expect(await purgeDueWorkspaces(racing, { now: Date.now() + 31 * DAY })).toEqual([ORG]);
  expect(cancel.status).toBe(409);
  expect((await cancel.json()).code).toBe("deletion-started");
  expect(again.status).toBe(202);
  expect(await count("SELECT COUNT(*) AS n FROM cards WHERE org_id = ?1")).toBe(0);
  expect(await count("SELECT COUNT(*) AS n FROM workspace_tombstones WHERE org_id = ?1")).toBe(1);
  expect(await count("SELECT COUNT(*) AS n FROM workspace_deletions WHERE org_id = ?1")).toBe(0);
  const actions = (await env.DB.prepare("SELECT action FROM audit_events WHERE org_id = ?1").bind(ORG).all()).results.map((r) => r.action);
  expect(actions).not.toContain("workspace.deletion_cancelled");
});

test("a deletion a run claimed and did not finish cannot be taken back, and the next run finishes it", async () => {
  await post("/orgs/delete", owner, { orgId: ORG, confirm: "Going Co" });
  const later = Date.now() + 31 * DAY;
  await env.DB.prepare("UPDATE workspace_deletions SET purge_started_at = ?2 WHERE org_id = ?1").bind(ORG, new Date(later).toISOString()).run();
  const cancel = await post("/orgs/delete/cancel", owner, { orgId: ORG });
  expect(cancel.status).toBe(409);
  expect((await cancel.json()).code).toBe("deletion-started");
  expect(await purgeDueWorkspaces(env, { now: later + DAY })).toEqual([ORG]);
  expect(await count("SELECT COUNT(*) AS n FROM cards WHERE org_id = ?1")).toBe(0);
});

// The purge deleted what was stored under org/<id>/ and called that all of
// it, while the workspace's icon, emoji, agents' pictures and Jam
// recordings were kept under names of their own, and the rows naming the
// icon and emoji went first. Those go too now, and nobody else's.

async function keptByName(orgId, tag) {
  const now = new Date().toISOString();
  const icon = `org-icon-${tag}`; const emoji = `emoji-${tag}`; const picture = `agent-avatar-00000000-0000-4000-8000-0000000000${tag}`;
  await env.MEDIA.put(icon, "png");
  await env.MEDIA.put(emoji, "png");
  await env.MEDIA.put(picture, "png");
  await env.MEDIA.put(`jam/rec-${tag}`, "audio", { customMetadata: { orgId, channel: "b:general" } });
  await env.DB.prepare("INSERT INTO org_icons (org_id, media_id, content_type, updated_at) VALUES (?1, ?2, 'image/png', ?3)").bind(orgId, icon, now).run();
  await env.DB.prepare("INSERT INTO org_emoji (org_id, name, media_id, content_type, created_by, created_at) VALUES (?1, 'party', ?2, 'image/png', 'own', ?3)").bind(orgId, emoji, now).run();
  await env.DB.prepare("INSERT INTO custom_agents (org_id, id, handle, name, avatar_url, instructions, owner_login, created_at, updated_at) VALUES (?1, 'a1', 'helper', 'Helper', ?2, 'x', 'own', ?3, ?3)")
    .bind(orgId, `https://example.com/agents/avatar/${picture}`, now).run();
  return [icon, emoji, picture, `jam/rec-${tag}`];
}

test("the purge deletes the icon, emoji, agents' pictures and Jam recordings kept by name, and nobody else's", async () => {
  const going = await keptByName(ORG, "01");
  const staying = await keptByName("team:stays", "02");
  await env.MEDIA.put("jam/rec-old", "audio");
  await post("/orgs/delete", owner, { orgId: ORG, confirm: "Going Co" });
  expect(await purgeDueWorkspaces(env, { now: Date.now() + 31 * DAY })).toEqual([ORG]);
  for (const key of going) expect(await env.MEDIA.get(key)).toBeNull();
  for (const key of staying) expect(await env.MEDIA.get(key)).not.toBeNull();
  expect(await env.MEDIA.get("jam/rec-old")).not.toBeNull();
});

test("a purge that runs out partway through those picks up where it stopped, and finishes only once they are gone", async () => {
  const going = await keptByName(ORG, "01");
  await post("/orgs/delete", owner, { orgId: ORG, confirm: "Going Co" });
  await env.DB.prepare("UPDATE workspace_deletions SET purge_started_at = due_at WHERE org_id = ?1").bind(ORG).run();
  const { purgeWorkspace } = await import("../src/workspaceDeletion.js");
  expect(await purgeWorkspace(env, ORG, { budget: 2 })).toBe(false);
  expect(await env.MEDIA.get(going[0])).toBeNull();
  expect(await env.MEDIA.get(going[3])).not.toBeNull();
  expect(await purgeWorkspace(env, ORG, { budget: 6 })).toBe(false);
  expect(await env.MEDIA.get(going[3])).toBeNull();
  expect((await env.DB.prepare("SELECT purge_cursor FROM workspace_deletions WHERE org_id = ?1").bind(ORG).first()).purge_cursor).toBe("scanned");
  expect(await purgeWorkspace(env, ORG)).toBe(true);
  for (const key of going) expect(await env.MEDIA.get(key)).toBeNull();
});
