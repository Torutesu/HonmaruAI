import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// Threads you are in, newest reply first; read and unread across devices.

const ORG = "personal:threads";
let toru; let mika; let kenji;
const ctx = { waitUntil: () => {} };
const call = async (path, token, { method = "GET", body } = {}) => worker.fetch(new Request(`https://example.com${path}`, {
  method, headers: { "content-type": "application/json", "x-session-token": token }, body: body ? JSON.stringify(body) : undefined,
}), env, ctx);
const say = async (token, text, parentId) => (await (await call("/channels/messages", token, { method: "POST", body: { orgId: ORG, channel: "b:cafe", body: text, parentId } })).json()).message;
const threads = async (token) => (await (await call(`/channels/threads?orgId=${encodeURIComponent(ORG)}`, token)).json()).threads;
const pause = () => new Promise((r) => setTimeout(r, 5));

test("thread search includes the root, scopes replies and treats wildcards literally", async () => {
  const root = await say(toru, "Budget 100%_done");
  const match = await say(mika, "Confirmed 100%_done", root.id);
  await say(toru, "Confirmed 100XXdone", root.id);
  await say(toru, "Other thread 100%_done");
  const removed = await say(toru, "Deleted 100%_done", root.id);
  await env.DB.prepare("UPDATE channel_messages SET deleted_at='2026-01-01' WHERE id=?1").bind(removed.id).run();
  const url = `/channels/thread/search?orgId=${encodeURIComponent(ORG)}&channel=b:cafe&messageId=${root.id}&q=${encodeURIComponent("100%_done")}`;
  const found = await (await call(url, toru)).json();
  expect(found.messages.map(m => m.id)).toEqual([match.id, root.id]);
  expect(found.nextCursor).toBeNull();
  expect((await call(url.replace(root.id, match.id), toru)).status).toBe(404);
  expect((await call(`${url}&before=bad`, toru)).status).toBe(400);
  expect((await call(url.replace("channel=b:cafe", "channel=general"), toru)).status).toBe(404);
});

test("thread search pages all matches without repeating them", async () => {
  const root = await say(toru, "Needle root");
  for (let i = 0; i < 32; i++) await say(toru, `Needle ${i}`, root.id);
  const url = `/channels/thread/search?orgId=${encodeURIComponent(ORG)}&channel=b:cafe&messageId=${root.id}&q=Needle`;
  const first = await (await call(url, toru)).json();
  const last = await (await call(`${url}&before=${first.nextCursor}`, toru)).json();
  expect(first.messages).toHaveLength(30);
  expect(last.messages).toHaveLength(3);
  expect(last.nextCursor).toBeNull();
  expect(new Set([...first.messages, ...last.messages].map(m => m.id)).size).toBe(33);
});

test("references scan the whole thread in pages and enforce app visibility", async () => {
  const { referencedAppIds } = await import("../src/threadReferences.js");
  const link = id => `[App](#/apps/${id}/${encodeURIComponent(ORG)})`;
  expect(referencedAppIds(`${link("a")} ${link("a")} [Bad](https://example.com/#/apps/b/${encodeURIComponent(ORG)}) [Other](#/apps/c/other) [Bad](#/apps/%ZZ/x)`, ORG)).toEqual(["a"]);
  for (const id of ["visible", "private"]) {
    await env.DB.prepare(`INSERT INTO hx_apps (id,org_id,name,table_id,definition,created_by,created_at,updated_at)
      VALUES (?1,?2,?1,'unused','{}','6602','2026-01-01','2026-01-01')`).bind(id, ORG).run();
  }
  await env.DB.prepare("INSERT INTO hx_app_access (org_id,app_id,visibility,version) VALUES (?1,'private','private',1)").bind(ORG).run();
  const root = await say(toru, "Root");
  for (let i = 0; i < 21; i++) await say(toru, i === 20 ? `${link("visible")} ${link("private")}` : `Reply ${i}`, root.id);
  const url = `/channels/thread/references?orgId=${encodeURIComponent(ORG)}&channel=b:cafe&messageId=${root.id}`;
  const first = await (await call(url, toru)).json();
  expect(first.apps).toEqual([]);
  expect(first.nextCursor).toBeTruthy();
  const last = await (await call(`${url}&after=${first.nextCursor}`, toru)).json();
  expect(last.apps).toEqual([{ id: "visible", name: "visible" }]);
  expect(last.nextCursor).toBeNull();
  expect((await (await call(`${url}&after=${first.nextCursor}`, mika)).json()).apps.map(a => a.id)).toEqual(["visible", "private"]);
  expect((await call(`${url}&after=oops`, toru)).status).toBe(400);
  expect((await call(url.replace("channel=b:cafe", "channel=general"), toru)).status).toBe(404);
});

test("references exclude deleted messages, unsent files and files from another room", async () => {
  const root = await say(toru, "Root with attachments");
  const reply = await say(toru, "Deleted attachment", root.id);
  for (const [id, channel, messageId] of [
    ["ref_root", "b:cafe", root.id],
    ["ref_deleted", "b:cafe", reply.id],
    ["ref_other_room", "b:other", root.id],
    ["ref_unsent", "b:cafe", null],
  ]) {
    await env.DB.prepare(`INSERT INTO message_files (id,org_id,channel,message_id,uploader,name,type,size,created_at)
      VALUES (?1,?2,?3,?4,'toru','notes.txt','text/plain',1,'2026-01-01')`)
      .bind(id, ORG, channel, messageId).run();
  }
  await env.DB.prepare("UPDATE channel_messages SET deleted_at='2026-01-01' WHERE id=?1").bind(reply.id).run();
  const url = `/channels/thread/references?orgId=${encodeURIComponent(ORG)}&channel=b:cafe&messageId=${root.id}`;
  const result = await (await call(url, toru)).json();
  expect(result.files.map(file => file.id)).toEqual(["ref_root"]);
  expect(result.files[0]).toMatchObject({ name: "notes.txt", messageId: root.id });
  expect(result.files[0].url).toBeTruthy();
  expect((await call(url.replace(root.id, reply.id), toru)).status).toBe(404);
  await env.DB.prepare("UPDATE channel_messages SET deleted_at='2026-01-01' WHERE id=?1").bind(root.id).run();
  expect((await call(url, toru)).status).toBe(404);
});

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  for (const [id, login, name] of [["6601", "toru", "Toru"], ["6602", "mika", "Mika"], ["6603", "kenji", "Kenji"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, "member");
  }
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "6601" });
  toru = await createSession(env.DB, "6601", "gho_t");
  mika = await createSession(env.DB, "6602", "gho_m");
  kenji = await createSession(env.DB, "6603", "gho_k");
});

test("the threads you are in, newest reply first, and whether one is new", async () => {
  const beans = await say(toru, "New beans?");
  await pause();
  const hours = await say(mika, "Opening hours");
  await pause();
  await say(mika, "Ethiopian", beans.id);
  await pause();
  await say(kenji, "Nobody asked me", hours.id);
  await pause();
  // Toru started one; Mika is in both.
  expect((await threads(toru)).map((x) => x.parent.body)).toEqual(["New beans?"]);
  const forMika = await threads(mika);
  expect(forMika.map((x) => x.parent.body)).toEqual(["Opening hours", "New beans?"]);
  expect(forMika[0]).toMatchObject({ replyCount: 1, unread: true });
  expect(forMika[1].unread).toBe(false); // her own reply is the last word
  // Kenji is named in a reply: now he is in it.
  expect((await threads(kenji)).map((x) => x.parent.body)).toEqual(["Opening hours"]);
  await say(mika, "@Kenji roast date?", beans.id);
  expect((await threads(kenji)).map((x) => x.parent.body)).toEqual(["New beans?", "Opening hours"]);

  // Read on one device, read everywhere.
  const t0 = (await threads(toru))[0];
  expect(t0.unread).toBe(true);
  expect(t0.replies.map((r) => r.body)).toEqual(["Ethiopian", "@Kenji roast date?"]);
  await call("/channels/read", toru, { method: "POST", body: { orgId: ORG, channel: "b:cafe", thread: beans.id } });
  expect((await threads(toru))[0].unread).toBe(false);
  // And back to unread from a reply.
  const reply = t0.replies[0];
  const back = await call("/channels/unread", toru, { method: "POST", body: { orgId: ORG, channel: "b:cafe", messageId: reply.id } });
  expect((await back.json()).thread).toBe(beans.id);
  expect((await threads(toru))[0].unread).toBe(true);
});

test("mark unread moves a conversation's read position back", async () => {
  const a = await say(mika, "one");
  await pause();
  await say(mika, "two");
  await call("/channels/read", toru, { method: "POST", body: { orgId: ORG, channel: "b:cafe" } });
  const res = await call("/channels/unread", toru, { method: "POST", body: { orgId: ORG, channel: "b:cafe", messageId: a.id } });
  const { lastReadAt } = await res.json();
  expect(lastReadAt < a.createdAt).toBe(true);
  const list = await (await call(`/channels?orgId=${encodeURIComponent(ORG)}`, toru)).json();
  expect(list.reads["b:cafe"]).toBe(lastReadAt);
  expect((await call("/channels/unread", toru, { method: "POST", body: { orgId: ORG, channel: "b:cafe", messageId: "nope" } })).status).toBe(404);
});

// Activity and Threads are two views of the same replies: read in either,
// no longer new in the other.
test("a reply read in Activity is read in Threads, and a thread read clears its replies in Activity", async () => {
  const activity = async (token) => (await (await call(`/channels/activity?orgId=${encodeURIComponent(ORG)}`, token)).json()).items;
  const beans = await say(toru, "New beans?");
  await pause();
  const first = await say(mika, "Ethiopian", beans.id);
  await pause();
  expect((await threads(toru))[0].unread).toBe(true);
  const item = (await activity(toru)).find((i) => i.message.id === first.id);
  expect(item).toMatchObject({ type: "reply", unread: true });

  // Looked at in Activity: gone from Threads too, and said so for other devices.
  const seen = await (await call("/channels/read", toru, { method: "POST", body: { orgId: ORG, channel: "activity", items: [item.key] } })).json();
  expect(seen.threads).toEqual([{ thread: beans.id, lastReadAt: first.createdAt }]);
  expect((await threads(toru))[0].unread).toBe(false);

  // A later reply is new in both, until read in either.
  await pause();
  const second = await say(kenji, "or Kenyan", beans.id);
  expect((await threads(toru))[0].unread).toBe(true);
  expect((await activity(toru)).find((i) => i.message.id === second.id).unread).toBe(true);
  await call("/channels/read", toru, { method: "POST", body: { orgId: ORG, channel: "b:cafe", thread: beans.id } });
  expect((await activity(toru)).find((i) => i.message.id === second.id).unread).toBe(false);
  expect((await threads(toru))[0].unread).toBe(false);

  // A reply in a conversation this person cannot read moves nothing.
  const { upsertBusiness } = await import("../src/db.js");
  await upsertBusiness(env.DB, ORG, { name: "Board", createdBy: "6602" });
  await env.DB.prepare("UPDATE businesses SET private = 1 WHERE org_id = ?1 AND slug = 'board'").bind(ORG).run();
  await env.DB.prepare("INSERT INTO conversation_members (org_id, channel, login, added_at) VALUES (?1, 'b:board', 'mika', ?2)").bind(ORG, new Date().toISOString()).run().catch(() => {});
  const secret = await (await call("/channels/messages", mika, { method: "POST", body: { orgId: ORG, channel: "b:board", body: "secret" } })).json();
  const secretReply = await (await call("/channels/messages", mika, { method: "POST", body: { orgId: ORG, channel: "b:board", body: "reply", parentId: secret.message?.id } })).json();
  expect(secretReply.message?.parentId).toBe(secret.message.id);
  const other = await (await call("/channels/read", toru, { method: "POST", body: { orgId: ORG, channel: "activity", items: [`m:${secretReply.message.id}`] } })).json();
  expect(other.threads).toEqual([]);
});

test("Mark all as read, in Activity or in Threads, clears both; a thread read clears the mention that started it", async () => {
  const activity = async (token) => (await (await call(`/channels/activity?orgId=${encodeURIComponent(ORG)}`, token)).json()).items;
  const read = (token, body) => call("/channels/read", token, { method: "POST", body: { orgId: ORG, ...body } });

  // Activity's Mark all as read: the replies go from Threads too.
  const beans = await say(toru, "New beans?");
  await pause();
  await say(mika, "Ethiopian", beans.id);
  await pause();
  const named = await say(mika, "@Toru the grinder is back");
  expect((await activity(toru)).filter((i) => i.unread).length).toBe(2);
  expect((await threads(toru))[0].unread).toBe(true);
  const all = await (await read(toru, { channel: "activity" })).json();
  expect(all.items.length).toBe(2);
  expect(all.threads.map((t) => t.thread)).toEqual([beans.id]);
  expect((await activity(toru)).filter((i) => i.unread)).toEqual([]);
  expect((await threads(toru))[0].unread).toBe(false);
  expect(named.id).toBeTruthy();

  // Threads' Mark all as read: each thread read to its newest reply, and
  // Activity drops those replies.
  await pause();
  const later = await say(kenji, "or Kenyan", beans.id);
  expect((await threads(toru))[0].unread).toBe(true);
  const fromThreads = await (await read(toru, { channel: "threads" })).json();
  expect(fromThreads.threads).toEqual([{ thread: beans.id, lastReadAt: later.createdAt }]);
  expect((await threads(toru))[0].unread).toBe(false);
  expect((await activity(toru)).find((i) => i.message.id === later.id).unread).toBe(false);

  // A thread whose first message named you: reading the thread reads it.
  await pause();
  const ask = await say(mika, "@Toru which roaster?");
  await pause();
  await say(mika, "the one on 5th", ask.id);
  expect((await activity(toru)).find((i) => i.message.id === ask.id).unread).toBe(true);
  await read(toru, { channel: "b:cafe", thread: ask.id });
  expect((await activity(toru)).find((i) => i.message.id === ask.id).unread).toBe(false);
});

// Named in somebody else's thread is being in it, in Activity as in Threads:
// the replies after the name come to Activity too, so seeing them there
// reads the thread — nobody has to open both.
test("named in a thread, its later replies are in Activity, and seeing them there reads it in Threads", async () => {
  const activity = async (token) => (await (await call(`/channels/activity?orgId=${encodeURIComponent(ORG)}`, token)).json()).items;
  const seenAll = async (token) => {
    const keys = (await activity(token)).filter((i) => i.unread).map((i) => i.key);
    return (await call("/channels/read", token, { method: "POST", body: { orgId: ORG, channel: "activity", items: keys } })).json();
  };

  // Named in a reply.
  const topic = await say(mika, "Mika's topic");
  await pause();
  await say(kenji, "before anyone named Toru", topic.id);
  await pause();
  await say(kenji, "@Toru what do you think", topic.id);
  await pause();
  await say(kenji, "and one more", topic.id);
  const items = (await activity(toru)).filter((i) => i.unread).map((i) => `${i.type}:${i.message.body}`);
  expect(items).toEqual(["reply:and one more", "mention:@Toru what do you think"]);
  expect((await threads(toru)).find((t) => t.parent.id === topic.id).unread).toBe(true);
  await seenAll(toru);
  expect((await threads(toru)).find((t) => t.parent.id === topic.id).unread).toBe(false);

  // Named in the first message.
  await pause();
  const ask = await say(mika, "@Toru look at this");
  await pause();
  await say(kenji, "reply under it", ask.id);
  expect((await activity(toru)).filter((i) => i.unread).map((i) => `${i.type}:${i.message.body}`)).toEqual(["reply:reply under it", "mention:@Toru look at this"]);
  await seenAll(toru);
  expect((await threads(toru)).find((t) => t.parent.id === ask.id).unread).toBe(false);

  // A thread nobody named you in stays out of your Activity.
  await pause();
  const other = await say(mika, "not for Toru");
  await say(kenji, "nor this", other.id);
  expect((await activity(toru)).some((i) => i.message.body === "nor this")).toBe(false);
});

const roomDirectory = async (token, params = {}) => call(`/channels/room-threads?${new URLSearchParams({ orgId: ORG, channel: 'b:cafe', ...params })}`, token);

test('room directory includes unanswered and non-participating roots, with exact tie pagination', async () => {
  const roots = [await say(mika, 'Unanswered'), await say(kenji, 'Another root'), await say(mika, 'Third root')];
  const at = '2026-01-01T00:00:00.000Z';
  for (const root of roots) await env.DB.prepare('UPDATE channel_messages SET created_at = ?1 WHERE id = ?2').bind(at, root.id).run();
  expect(await threads(toru)).toEqual([]);
  const first = await (await roomDirectory(toru, { limit: '2' })).json();
  expect(first.threads).toHaveLength(2);
  expect(first.threads.every(t => t.replyCount === 0 && t.unread && t.replies.length === 0)).toBe(true);
  const second = await (await roomDirectory(toru, { limit: '2', ...first.nextCursor })).json();
  expect(second.threads).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect([...first.threads, ...second.threads].map(t => t.parent.id).sort()).toEqual(roots.map(r => r.id).sort());
  expect((await roomDirectory(toru, { before: at })).status).toBe(400);
});

test('room directory orders by latest reply, reflects reads, and excludes deleted roots', async () => {
  const old = await say(mika, 'Older root'); await pause();
  const fresh = await say(kenji, 'Newer root'); await pause();
  const reply = await say(kenji, 'Latest reply', old.id);
  let page = await (await roomDirectory(toru)).json();
  expect(page.threads.map(t => t.parent.id)).toEqual([old.id, fresh.id]);
  expect(page.threads[0]).toMatchObject({ replyCount: 1, unread: true, replies: [{ id: reply.id }] });
  await call('/channels/read', toru, { method: 'POST', body: { orgId: ORG, channel: 'b:cafe', thread: old.id } });
  page = await (await roomDirectory(toru)).json();
  expect(page.threads[0].unread).toBe(false);
  await env.DB.prepare('UPDATE channel_messages SET deleted_at = ?1 WHERE id = ?2').bind(new Date().toISOString(), old.id).run();
  page = await (await roomDirectory(toru)).json();
  expect(page.threads.map(t => t.parent.id)).toEqual([fresh.id]);
});

test('room directory requires room membership and never accepts another workspace', async () => {
  const { upsertBusiness } = await import('../src/db.js');
  await upsertBusiness(env.DB, ORG, { name: 'Board', createdBy: '6602' });
  await env.DB.prepare("UPDATE businesses SET private = 1 WHERE org_id = ?1 AND slug = 'board'").bind(ORG).run();
  await env.DB.prepare("INSERT INTO conversation_members (org_id, channel, login, added_at) VALUES (?1, 'b:board', 'mika', ?2)").bind(ORG, new Date().toISOString()).run().catch(() => {});
  expect((await roomDirectory(toru, { channel: 'b:board' })).status).toBe(404);
  expect((await roomDirectory(mika, { channel: 'b:board' })).status).toBe(200);
  expect((await roomDirectory(toru, { orgId: 'personal:another' })).status).not.toBe(200);
});

const renameThread = (token, messageId, title, version, extra = {}) => call('/channels/thread/title', token, { method: 'PUT', body: { orgId: ORG, channel: 'b:cafe', messageId, title, version, ...extra } });
test('thread titles persist separately, appear in the directory, and reject stale versions', async () => {
  const root = await say(toru, 'Original request stays intact');
  const response = await renameThread(toru, root.id, '採用面談', 0);
  expect(response.status).toBe(200);
  expect((await response.json()).parent).toMatchObject({ id: root.id, body: root.body, threadTitle: '採用面談', threadTitleVersion: 1, canRenameThread: true });
  const directory = await (await roomDirectory(mika)).json();
  expect(directory.threads[0].parent.threadTitle).toBe('採用面談');
  const read = await (await call(`/channels/thread?${new URLSearchParams({ orgId: ORG, channel: 'b:cafe', messageId: root.id })}`, mika)).json();
  expect(read.parent).toMatchObject({ threadTitle: '採用面談', threadTitleVersion: 1, canRenameThread: true });
  expect((await renameThread(mika, root.id, 'Newer title', 1)).status).toBe(200);
  expect((await renameThread(toru, root.id, 'Stale overwrite', 1)).status).toBe(409);
  expect((await env.DB.prepare('SELECT body FROM channel_messages WHERE id = ?1').bind(root.id).first()).body).toBe(root.body);
  expect((await env.DB.prepare('SELECT title,version FROM channel_thread_details WHERE message_id = ?1').bind(root.id).first())).toMatchObject({ title: 'Newer title', version: 2 });
});

test('thread rename rejects replies, deleted roots, guests, wrong rooms and malformed input', async () => {
  const root = await say(toru, 'Root'), reply = await say(mika, 'Reply', root.id);
  expect((await renameThread(toru, reply.id, 'Reply title', 0)).status).toBe(404);
  expect((await renameThread(toru, root.id, '', 0)).status).toBe(400);
  expect((await renameThread(toru, root.id, 'x'.repeat(161), 0)).status).toBe(400);
  expect((await renameThread(toru, root.id, 'Line\nbreak', 0)).status).toBe(400);
  expect((await renameThread(toru, root.id, 'Title', -1)).status).toBe(400);
  expect((await renameThread(toru, root.id, 'Title', 0, { orgId:'personal:elsewhere' })).status).not.toBe(200);
  const { upsertBusiness, upsertMembership } = await import('../src/db.js');
  await upsertBusiness(env.DB, ORG, { name:'Other', createdBy:'6601' });
  expect((await renameThread(toru, root.id, 'Title', 0, { channel:'b:other' })).status).toBe(404);
  await upsertMembership(env.DB, ORG, '6603', 'guest');
  await env.DB.prepare("INSERT OR IGNORE INTO conversation_members (org_id, channel, login, added_at) VALUES (?1, 'b:cafe', 'kenji', ?2)").bind(ORG,new Date().toISOString()).run();
  expect((await renameThread(kenji, root.id, 'Guest title', 0)).status).toBe(403);
  await env.DB.prepare('UPDATE channel_messages SET deleted_at = ?1 WHERE id = ?2').bind(new Date().toISOString(),root.id).run();
  expect((await renameThread(toru, root.id, 'Deleted title', 0)).status).toBe(404);
});

test('unsending a root removes its saved name with the original message', async () => {
  const root = await say(toru, 'Disposable local test root');
  expect((await renameThread(toru, root.id, 'Private thread name', 0)).status).toBe(200);
  const response = await call('/channels/messages', toru, { method:'DELETE', body:{orgId:ORG,channel:'b:cafe',messageId:root.id} });
  expect(response.status).toBe(200);
  expect(await env.DB.prepare('SELECT title FROM channel_thread_details WHERE message_id = ?1').bind(root.id).first()).toBeNull();
  expect((await renameThread(toru, root.id, 'Restore name', 0)).status).toBe(404);
});


test("home thread pins persist per user, are idempotent, and hide deleted roots", async () => {
  const root = await say(toru, "Pinned work");
  const reply = await say(mika, "Reply", root.id);
  const pin = (token, messageId, pinned) => call("/channels/thread-pins", token, {method:"PUT",body:{orgId:ORG,messageId,pinned}});
  expect((await pin(toru, reply.id, true)).status).toBe(404);
  expect((await pin(toru, root.id, "yes")).status).toBe(400);
  expect((await pin(toru, root.id, true)).status).toBe(200);
  expect((await (await pin(toru, root.id, true)).json()).pins).toHaveLength(1);
  const read = async token => (await (await call(`/channels/thread-pins?orgId=${encodeURIComponent(ORG)}`,token)).json()).pins;
  expect(await read(toru)).toMatchObject([{id:root.id,view:"b:cafe",title:"Pinned work"}]);
  expect(await read(mika)).toEqual([]);
  await env.DB.prepare("UPDATE channel_messages SET deleted_at=? WHERE id=?").bind(new Date().toISOString(),root.id).run();
  expect(await read(toru)).toEqual([]);
  expect((await pin(toru, root.id, true)).status).toBe(404);
  expect((await pin(toru, root.id, false)).status).toBe(200);
  expect(await env.DB.prepare("SELECT 1 FROM channel_thread_pins WHERE message_id=?").bind(root.id).first()).toBeNull();
});

test("thread pins recheck private-room access and workspace membership on every read", async () => {
  const root = await say(toru, "Confidential work");
  const pin = (token, orgId, pinned) => call("/channels/thread-pins", token, {method:"PUT",body:{orgId,messageId:root.id,pinned}});
  expect((await pin(mika, ORG, true)).status).toBe(200);
  await env.DB.prepare("UPDATE businesses SET private=1 WHERE org_id=? AND slug='cafe'").bind(ORG).run();
  await env.DB.prepare("INSERT OR IGNORE INTO conversation_members (org_id,channel,login,added_at) VALUES (?,'b:cafe','toru',?)").bind(ORG,new Date().toISOString()).run();
  const result = await (await call(`/channels/thread-pins?orgId=${encodeURIComponent(ORG)}`,mika)).json();
  expect(result.pins).toEqual([]);
  expect((await pin(mika, ORG, true)).status).toBe(404);
  expect((await pin(mika, "personal:elsewhere", true)).status).not.toBe(200);
  expect((await pin(mika, ORG, false)).status).toBe(200);
  expect((await pin(toru, ORG, true)).status).toBe(200);
  await renameThread(toru,root.id,"Updated thread name",0);
  expect((await (await call(`/channels/thread-pins?orgId=${encodeURIComponent(ORG)}`,toru)).json()).pins[0].title).toBe("Updated thread name");
});


test("unsending a root removes every user's home pin atomically", async () => {
  const root = await say(toru, "Disposable pinned root");
  for (const token of [toru,mika]) expect((await call("/channels/thread-pins",token,{method:"PUT",body:{orgId:ORG,messageId:root.id,pinned:true}})).status).toBe(200);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM channel_thread_pins WHERE message_id=?").bind(root.id).first()).n).toBe(2);
  expect((await call("/channels/messages",toru,{method:"DELETE",body:{orgId:ORG,channel:"b:cafe",messageId:root.id}})).status).toBe(200);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM channel_thread_pins WHERE message_id=?").bind(root.id).first()).n).toBe(0);
});

const muteThread = (token, messageId, muted, extra = {}) => call('/channels/thread/notifications', token, { method: 'PUT', body: { orgId: ORG, channel: 'b:cafe', messageId, muted, ...extra } });
test('thread mute is personal, persists for another session, and does not mute the room', async () => {
  const root = await say(toru, 'Root'), reply = await say(mika, 'Reply', root.id);
  expect((await muteThread(toru, root.id, true)).status).toBe(200);
  const url = `/channels/thread/notifications?${new URLSearchParams({orgId:ORG,channel:'b:cafe',messageId:root.id})}`;
  const { createSession } = await import('../src/db.js');
  const otherSession = await createSession(env.DB, '6601', 'other-session');
  expect(await (await call(url, otherSession)).json()).toEqual({muted:true});
  expect(await (await call(url, mika)).json()).toEqual({muted:false});
  expect(await env.DB.prepare('SELECT 1 FROM channel_prefs WHERE org_id=?1').bind(ORG).first()).toBeNull();
  expect((await muteThread(toru, reply.id, true)).status).toBe(404);
  expect((await muteThread(toru, root.id, 'true')).status).toBe(400);
  expect((await muteThread(toru, root.id, true, {orgId:'personal:elsewhere'})).status).not.toBe(200);
  expect(await (await muteThread(toru, root.id, false)).json()).toEqual({muted:false});
  await env.DB.prepare("UPDATE businesses SET private=1 WHERE org_id=?1 AND slug='cafe'").bind(ORG).run();
  expect((await call(url, mika)).status).not.toBe(200);
  expect((await muteThread(mika, root.id, true)).status).not.toBe(200);
});
