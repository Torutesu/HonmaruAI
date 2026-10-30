import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { listThread, threadPageRequest } from "../src/channels.js";
import { createSession, upsertUser, upsertMembership, upsertBusiness } from "../src/db.js";
import worker from "../src/index.js";

const ORG = "personal:thread-pages";
const CHANNEL = "b:cafe";
let token;
beforeEach(async () => {
  await upsertUser(env.DB, { githubId: "thread-reader", login: "reader", name: "Reader", locale: "en" });
  await upsertMembership(env.DB, ORG, "thread-reader", "admin");
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "thread-reader" });
  token = await createSession(env.DB, "thread-reader", "test");
});

async function seed(count, { orgId = ORG, parent = "root", channel = CHANNEL } = {}) {
  const statement = (id, parentId, time, deleted = null) => env.DB.prepare("INSERT INTO channel_messages (id,org_id,channel,author_login,body,parent_id,created_at,deleted_at) VALUES (?1,?2,?3,'reader',?4,?5,?6,?7)")
    .bind(id, orgId, channel, `Synthetic ${id}`, parentId, time, deleted);
  await statement(parent, null, "2026-10-01T00:00:00.000Z").run();
  for (let start = 0; start < count; start += 80) {
    await env.DB.batch(Array.from({ length: Math.min(80, count - start) }, (_, offset) => {
      const i = start + offset;
      // Five rows share each timestamp; IDs intentionally sort differently.
      const stamp = new Date(Date.UTC(2026, 9, 2, 0, 0, Math.floor(i / 5))).toISOString();
      return statement(`${parent}-${String(count - i).padStart(5, "0")}`, parent, stamp);
    }));
  }
}
const read = (page) => listThread(env.DB, ORG, CHANNEL, "root", "reader", CHANNEL, [], page);
const request = (params) => threadPageRequest(new URLSearchParams(params));
const get = async (params) => worker.fetch(new Request(`https://example.com/channels/thread?${new URLSearchParams({ orgId: ORG, channel: CHANNEL, messageId: "root", ...params })}`, { headers: { "x-session-token": token } }), env, { waitUntil() {} });

test("thread paging is explicit and validates limits and opaque cursors", () => {
  expect(request({})).toBeNull();
  expect(request({ limit: "50" })).toEqual({ limit: 50, before: null });
  for (const params of [{ limit: "0" }, { limit: "51" }, { limit: "1.5" }, { limit: "NaN" }, { before: "x" }, { limit: "50", before: "garbage" }]) {
    expect(() => request(params)).toThrow();
  }
});

test.each([0, 1, 50, 1000, 10000])("initial page bounds %i replies and preserves parent counts", async (count) => {
  await seed(count);
  const result = await read(request({ limit: "50" }));
  expect(result.replies).toHaveLength(Math.min(50, count));
  expect(result.parent.replyCount).toBe(count);
  expect(result.more).toBe(count > 50);
  expect(Boolean(result.nextCursor)).toBe(count > 50);
  expect(result.replies.every((m) => !Object.hasOwn(m, "thread_rowid"))).toBe(true);
  const plan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT id FROM channel_messages WHERE org_id=?1 AND parent_id=?2 AND deleted_at IS NULL ORDER BY created_at DESC,rowid DESC LIMIT 51").bind(ORG, "root").all();
  const detail = plan.results.map((r) => r.detail).join(" ");
  expect(detail).toContain("idx_channel_thread_page");
  expect(detail).not.toContain("TEMP B-TREE");
}, 30000);

test("walking pages preserves ties, survives deletion of the cursor row, and does not repeat live arrivals", async () => {
  await seed(123);
  const complete = await read(null);
  let page = await read(request({ limit: "50" }));
  const seen = page.replies.map((m) => m.id);
  const boundary = page.replies[0];
  // The cursor keeps its ordering boundary even after physical retention cleanup.
  await env.DB.prepare("DELETE FROM channel_messages WHERE id=?1").bind(boundary.id).run();
  await env.DB.prepare("INSERT INTO channel_messages(id,org_id,channel,author_login,body,parent_id,created_at) VALUES('live',?1,?2,'reader','New','root','2026-10-29T00:00:00.000Z')").bind(ORG, CHANNEL).run();
  while (page.more) {
    page = await read(request({ limit: "50", before: page.nextCursor }));
    seen.unshift(...page.replies.map((m) => m.id));
  }
  expect(seen).toEqual(complete.replies.map((m) => m.id));
  expect(new Set(seen).size).toBe(123);
  expect(seen).not.toContain("live");
});

test("unupgraded clients retain complete arrays and pages retain tenant/channel authorization", async () => {
  await seed(51);
  const legacy = await (await get({})).json();
  expect(legacy.replies).toHaveLength(51);
  expect(legacy).not.toHaveProperty("more");
  const paged = await (await get({ limit: "50" })).json();
  expect(paged.replies).toHaveLength(50);
  expect(paged.more).toBe(true);
  expect((await get({ limit: "999" })).status).toBe(400);
  const other = new Request(`https://example.com/channels/thread?${new URLSearchParams({ orgId: "personal:else", channel: CHANNEL, messageId: "root", limit: "50", before: paged.nextCursor })}`, { headers: { "x-session-token": token } });
  expect((await worker.fetch(other, env, { waitUntil() {} })).status).toBe(403);
  expect(await listThread(env.DB, ORG, "b:else", "root", "reader", "b:else", [], request({ limit: "50" }))).toBeNull();
}, 60000);

test("reference context hydrates one authorized reply and never leaks other or deleted threads", async () => {
  await seed(51);
  const reference = "root-00051";
  const response = await get({ reference });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.reference.id).toBe(reference);
  expect(body).not.toHaveProperty("replies");
  expect((await get({ reference: "absent" })).status).toBe(404);
  await seed(1, { parent: "other-root" });
  expect((await get({ reference: "other-root-00001" })).status).toBe(404);
  await env.DB.prepare("UPDATE channel_messages SET deleted_at='2026-10-29T00:00:00.000Z' WHERE id=?1").bind(reference).run();
  expect((await get({ reference })).status).toBe(404);
  const page = await (await get({ limit: "50" })).json();
  expect(page.replies.some(row => row.id === reference)).toBe(false);
  await env.DB.prepare("UPDATE channel_messages SET deleted_at='2026-10-29T00:00:00.000Z' WHERE id='root'").run();
  expect((await get({ reference: "root-00001" })).status).toBe(404);
  expect((await get({ limit: "50", before: page.nextCursor || "" })).status).toBe(404);
}, 60000);

test("file lookup and signed attachments cover only the parent and displayed reply page", async () => {
  await seed(100);
  await env.DB.prepare(`INSERT INTO message_files(id,org_id,channel,message_id,uploader,name,type,size,created_at)
    SELECT 'file-' || id,org_id,channel,id,'reader','Synthetic.txt','text/plain',16,created_at
    FROM channel_messages WHERE org_id=?1 AND parent_id='root'`).bind(ORG).run();
  const fileLookups = [];
  const observed = {
    prepare(sql) {
      const statement = env.DB.prepare(sql);
      return { bind(...values) { if (sql.startsWith("SELECT * FROM message_files WHERE")) fileLookups.push(values.slice(1)); return statement.bind(...values); } };
    },
  };
  const result = await listThread(observed, ORG, CHANNEL, "root", "reader", CHANNEL, [], request({ limit: "50" }));
  expect(result.replies).toHaveLength(50);
  expect(fileLookups.flat()).toEqual(["root", ...result.replies.map(row => row.id)]);
  expect(result.replies.flatMap(row => row.files)).toHaveLength(50);
  expect(result.replies.every(row => row.files[0].url.startsWith("/files/file-"))).toBe(true);
  expect(result.replies.every(row => row.files[0].expiresAt > Date.now())).toBe(true);
}, 60000);

test("a dense soft-deleted tail still seeks the partial page index", async () => {
  await seed(1000);
  await env.DB.prepare("UPDATE channel_messages SET deleted_at='2026-10-29T00:00:00.000Z' WHERE parent_id='root' AND rowid > (SELECT rowid FROM channel_messages WHERE id='root-00941')").run();
  const result = await read(request({ limit: "50" }));
  expect(result.replies).toHaveLength(50);
  expect(result.parent.replyCount).toBe(60);
  const plan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT id FROM channel_messages WHERE org_id=?1 AND parent_id=?2 AND deleted_at IS NULL AND created_at=?3 AND rowid<?4 ORDER BY created_at DESC,rowid DESC LIMIT 51").bind(ORG, 'root', '2026-10-29T00:00:00.000Z', 1000000).all();
  expect(plan.results.map(row => row.detail).join(' ')).toContain('idx_channel_thread_page');
  expect(plan.results.map(row => row.detail).join(' ')).toContain('rowid<?');
  expect(plan.results.map(row => row.detail).join(' ')).not.toContain('TEMP B-TREE');
  const index = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name='idx_channel_thread_page'").first();
  expect(index.sql).toContain('WHERE deleted_at IS NULL');
}, 60000);
