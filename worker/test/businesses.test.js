import {SELF, env} from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { joined, message } from "./helpers.js";
import { businessSlug } from "../src/db.js";
import { routeInstruction, buildAgentTools, matchBusiness } from "../src/routing.js";

// Ten people running ten businesses: every card belongs to one, and the
// taxonomy is discovered by tagging rather than designed up front.

const ORG = "acme/holdings";
let ownerToken;
let memberToken;
let outsiderToken;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "6101", login: "owner", name: "Owner", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "6102", login: "member", name: "Member", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "6103", login: "outsider", name: "Outsider", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "6101", "admin");
  await upsertMembership(env.DB, ORG, "6102", "member");
  ownerToken = await createSession(env.DB, "6101", "gho_owner");
  memberToken = await createSession(env.DB, "6102", "gho_member");
  outsiderToken = await createSession(env.DB, "6103", "gho_outsider");
});

beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });

test("a slug is the name, folded, in any script", () => {
  expect(businessSlug("Hotel 本丸")).toBe("hotel-本丸");
  expect(businessSlug("  HOTEL   本丸 ")).toBe("hotel-本丸");
  expect(businessSlug("SaaS / Billing")).toBe("saas-billing");
  expect(businessSlug("   ")).toBeNull();
  expect(businessSlug(42)).toBeNull();
});

test("a member names a business; the list is the org's; an outsider sees nothing", async () => {
  let res = await SELF.fetch("https://example.com/businesses", {
    method: "POST", headers: headers(ownerToken), body: JSON.stringify({ orgId: ORG, name: "Hotel 本丸" }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).business).toEqual({ slug: "hotel-本丸", name: "Hotel 本丸" });

  // The same name again is the same business, and the first spelling sticks.
  res = await SELF.fetch("https://example.com/businesses", {
    method: "POST", headers: headers(memberToken), body: JSON.stringify({ orgId: ORG, name: "hotel 本丸" }),
  });
  expect((await res.json()).businesses).toEqual([{ slug: "hotel-本丸", name: "Hotel 本丸", createdBy: "6101", createdAt: expect.any(String) }]);

  res = await SELF.fetch(`https://example.com/businesses?orgId=${encodeURIComponent(ORG)}`, { headers: headers(outsiderToken) });
  expect(res.status).toBe(403);
  res = await SELF.fetch("https://example.com/businesses", {
    method: "POST", headers: headers(outsiderToken), body: JSON.stringify({ orgId: ORG, name: "Mine now" }),
  });
  expect(res.status).toBe(403);

  res = await SELF.fetch("https://example.com/businesses", {
    method: "POST", headers: headers(ownerToken), body: JSON.stringify({ orgId: ORG, name: "   " }),
  });
  expect(res.status).toBe(400);
});

test("tagging a card with a new name creates the business, and either party may re-file it", async () => {
  const owner = await joined(ORG, ownerToken);
  const member = await joined(ORG, memberToken);

  owner.ws.send(JSON.stringify({
    type: "card_created",
    payload: { card: {
      id: "card-biz-1", type: "approval", status: "pending", recipientUserID: "member",
      title: "Approve the new menu", summary: "Spring menu for the cafe.", priority: "medium",
      createdAt: new Date().toISOString(), business: "Cafe Sakura",
    } },
  }));
  const seen = await message(member.messages, (m) => JSON.stringify(m).includes("card-biz-1"));
  expect(JSON.stringify(seen)).toContain('"business":"cafe-sakura"');

  const { listBusinesses, getCard } = await import("../src/db.js");
  expect((await listBusinesses(env.DB, ORG)).map((b) => b.slug)).toContain("cafe-sakura");

  // The recipient re-files it under the hotel.
  const before = owner.messages.length;
  member.ws.send(JSON.stringify({ type: "set_business", payload: { cardId: "card-biz-1", business: "Hotel 本丸" } }));
  const refiled = await message(owner.messages, (m, i) => i >= before && JSON.stringify(m).includes("hotel-本丸"));
  expect(refiled).toBeTruthy();
  expect((await getCard(env.DB, ORG, "card-biz-1")).business).toBe("hotel-本丸");

  // And can clear it.
  member.ws.send(JSON.stringify({ type: "set_business", payload: { cardId: "card-biz-1", business: null } }));
  const { until } = await import("./helpers.js");
  expect(await until(async () => (await getCard(env.DB, ORG, "card-biz-1")).business === undefined)).toBeTruthy();

  // Someone who is neither sender nor recipient may not.
  const { upsertMembership, createSession } = await import("../src/db.js");
  await upsertMembership(env.DB, ORG, "6103", "member");
  const third = await joined(ORG, await createSession(env.DB, "6103", "gho_outsider2"));
  third.ws.send(JSON.stringify({ type: "set_business", payload: { cardId: "card-biz-1", business: "Cafe Sakura" } }));
  const refused = await message(third.messages, (m) => m.type === "RUN_ERROR");
  expect(refused.message).toContain("Only the sender or the recipient");
});

test("the router files a card under one of the org's businesses, never one it invented", async () => {
  const org = {
    nodes: [
      { id: "owner", kind: "person", label: "owner · Admin" },
      { id: "member", kind: "person", label: "member · Engineer" },
    ],
    edges: [],
    businesses: [{ slug: "hotel-本丸", name: "Hotel 本丸" }, { slug: "cafe-sakura", name: "Cafe Sakura" }],
  };
  const tool = buildAgentTools(org).find((t) => t.function.name === "create_decision_card");
  expect(tool.function.parameters.properties.business.enum).toEqual(["hotel-本丸", "cafe-sakura"]);
  // No businesses, no field: the model is not invited to guess.
  expect(buildAgentTools({ nodes: org.nodes }).find((t) => t.function.name === "create_decision_card")
    .function.parameters.properties.business).toBeUndefined();

  expect(matchBusiness("ask member to fix the Cafe Sakura menu", org)).toBe("cafe-sakura");
  expect(matchBusiness("本丸の予約システムを直して", org)).toBe("hotel-本丸");
  expect(matchBusiness("nothing in particular", org)).toBeNull();

  const reply = (business) => ({
    choices: [{ message: { tool_calls: [{
      id: "t1", type: "function",
      function: { name: "create_decision_card", arguments: JSON.stringify({
        recipientUserID: "member", cardType: "task", title: "Fix the menu", summary: "The cafe menu is wrong.",
        context: "scope: menu", priority: "medium", routingReason: "Engineer.", business,
      }) },
    }] } }],
  });
  const provider = { providerName: "OpenAI", endpoint: "https://api.openai.com/v1/chat/completions", apiKey: "sk-test", model: "m" };
  const sender = { id: "owner", name: "owner", role: "admin" };

  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, reply("cafe-sakura"));
  let routed = await routeInstruction({ text: "ask member to fix the menu", sender, organization: org, openRouter: provider });
  expect(routed.business).toBe("cafe-sakura");

  // An invented slug is dropped, and the instruction's own words decide.
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, reply("bakery"));
  routed = await routeInstruction({ text: "ask member to fix the Hotel 本丸 menu", sender, organization: org, openRouter: provider });
  expect(routed.business).toBe("hotel-本丸");

  // The keyword router files by name too.
  routed = await routeInstruction({ text: "ask member to fix the cafe sakura menu", sender, organization: org });
  expect(routed.business).toBe("cafe-sakura");
});

test("/ai/route hands the router the org's businesses from the table", async () => {
  // Storage is isolated per test, so the business is named here.
  await (await SELF.fetch("https://example.com/businesses", {
    method: "POST", headers: headers(ownerToken), body: JSON.stringify({ orgId: ORG, name: "Hotel 本丸" }),
  })).json();
  // No model behind SELF, so this is the keyword router — which files by
  // name only when the route loaded the businesses from the table. (The
  // model's enum is covered above.)
  const res = await SELF.fetch("https://example.com/ai/route", {
    method: "POST", headers: headers(ownerToken),
    body: JSON.stringify({ text: "ask member to fix the hotel booking form", orgId: ORG, sender: { id: "owner", name: "owner", role: "admin" } }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.recipientUserID).toBe("member");
  expect(body.business).toBe("hotel-本丸");
});

test("a channel can be renamed, and deleting one empties it for everyone", async () => {
  const { saveCard, getCard } = await import("../src/db.js");
  let res = await SELF.fetch("https://example.com/businesses", {
    method: "POST", headers: headers(memberToken), body: JSON.stringify({ orgId: ORG, name: "Cafe" }),
  });
  expect(res.status).toBe(200);
  await saveCard(env.DB, ORG, {
    id: "c-cafe", recipientUserID: "member", senderUserID: "owner", status: "pending",
    title: "Approve the cafe menu", priority: "medium", createdAt: "2026-09-24T00:00:00Z", business: "cafe",
  });

  // Renamed: the slug stays, the name changes, the room hears.
  const { ws, messages } = await joined(ORG, ownerToken);
  res = await SELF.fetch("https://example.com/businesses", {
    method: "PUT", headers: headers(memberToken), body: JSON.stringify({ orgId: ORG, slug: "cafe", name: "Cafe & Bakery" }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).business).toEqual({ slug: "cafe", name: "Cafe & Bakery" });
  const heard = await message(messages, (m) => m.type === "CUSTOM" && m.name === "businesses" && JSON.stringify(m).includes("Cafe & Bakery"));
  expect(heard).toBeTruthy();

  // Deleted: the channel is gone from the list, its card is unfiled, the
  // room hears both.
  res = await SELF.fetch("https://example.com/businesses", {
    method: "DELETE", headers: headers(memberToken), body: JSON.stringify({ orgId: ORG, slug: "cafe" }),
  });
  expect(res.status).toBe(200);
  const gone = await res.json();
  expect(gone.businesses.some((b) => b.slug === "cafe")).toBe(false);
  expect(gone.unfiled).toBe(1);
  expect((await getCard(env.DB, ORG, "c-cafe")).business).toBeUndefined();
  const unfiled = await message(messages, (m) => m.type === "STATE_DELTA" && JSON.stringify(m).includes("c-cafe") && !JSON.stringify(m).includes('"business":"cafe"'));
  expect(unfiled).toBeTruthy();
  // A deleted public Simple channel can still be made again by name.
  const recreated=await SELF.fetch("https://example.com/businesses",{
    method:"POST",headers:headers(memberToken),body:JSON.stringify({orgId:ORG,name:"Cafe"}),
  });
  expect(recreated.status).toBe(200);
  expect((await recreated.json()).business.slug).toBe('cafe');
  // An outsider can do none of it.
  res = await SELF.fetch("https://example.com/businesses", {
    method: "PUT", headers: headers(outsiderToken), body: JSON.stringify({ orgId: ORG, slug: "cafe", name: "Mine" }),
  });
  expect(res.status).toBe(403);
  void ws;
});

test('legacy deletion refuses a changed privacy or membership snapshot without changing data', async () => {
  const {upsertBusiness,removeBusiness}=await import('../src/db.js');
  await upsertBusiness(env.DB,ORG,{name:'Race room',createdBy:'6101'});
  const room=await env.DB.prepare("SELECT created_at FROM businesses WHERE org_id=? AND slug='race-room'").bind(ORG).first();
  await env.DB.prepare("UPDATE businesses SET private=1 WHERE org_id=? AND slug='race-room'").bind(ORG).run();
  expect(await removeBusiness(env.DB,ORG,'race-room',{actorId:'6101',createdAt:room.created_at,wasPrivate:false})).toBe(false);
  const privateSnapshot={actorId:'6101',createdAt:room.created_at,wasPrivate:true};
  expect(await removeBusiness(env.DB,ORG,'race-room',privateSnapshot)).toBe(false);
  const at=new Date().toISOString();
  await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES (?,'b:race-room','owner',?)").bind(ORG,at).run();
  await env.DB.prepare("UPDATE memberships SET role='Guest' WHERE org_id=? AND user_github_id='6101'").bind(ORG).run();
  expect(await removeBusiness(env.DB,ORG,'race-room',privateSnapshot)).toBe(false);
  await env.DB.prepare("UPDATE memberships SET role='admin' WHERE org_id=? AND user_github_id='6101'").bind(ORG).run();
  await env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at,purge_started_at) VALUES (?,?,?,?,?)").bind(ORG,at,'6101',at,at).run();
  expect(await removeBusiness(env.DB,ORG,'race-room',privateSnapshot)).toBe(false);
  await env.DB.prepare('DELETE FROM workspace_deletions WHERE org_id=?').bind(ORG).run();
  await env.DB.prepare('INSERT INTO workspace_tombstones(org_id,deleted_at) VALUES (?,?)').bind(ORG,at).run();
  expect(await removeBusiness(env.DB,ORG,'race-room',privateSnapshot)).toBe(false);
  expect(await env.DB.prepare("SELECT private,archived_at FROM businesses WHERE org_id=? AND slug='race-room'").bind(ORG).first()).toEqual({private:1,archived_at:null});
  expect(await env.DB.prepare("SELECT channel FROM hx_room_access WHERE org_id=? AND channel='b:race-room'").bind(ORG).first()).toBeNull();
  expect(await env.DB.prepare("SELECT login FROM conversation_members WHERE org_id=? AND channel='b:race-room'").bind(ORG).first()).toEqual({login:'owner'});
});

test('public deletion unfiles only cards from its transaction, not a recreated room', async () => {
  const {upsertBusiness,removeBusiness,saveCard,getCard}=await import('../src/db.js');
  await upsertBusiness(env.DB,ORG,{name:'Public Race',createdBy:'6101'});
  const room=await env.DB.prepare("SELECT created_at FROM businesses WHERE org_id=? AND slug='public-race'").bind(ORG).first();
  const card=id=>({id,recipientUserID:'owner',senderUserID:'owner',status:'pending',title:id,priority:'medium',createdAt:new Date().toISOString(),business:'public-race'});
  await saveCard(env.DB,ORG,card('before-recreation'));
  const racing=new Proxy(env.DB,{get(db,key){
    if(key==='batch')return async statements=>{
      const result=await db.batch(statements);
      await upsertBusiness(db,ORG,{name:'Public Race',createdBy:'6101'});
      await saveCard(db,ORG,card('after-recreation'));
      return result;
    };
    return typeof db[key]==='function'?db[key].bind(db):db[key];
  }});
  const removed=await removeBusiness(racing,ORG,'public-race',{actorId:'6101',createdAt:room.created_at,wasPrivate:false});
  expect(removed.unfiled.map(item=>item.id)).toEqual(['before-recreation']);
  expect((await getCard(env.DB,ORG,'before-recreation')).business).toBeUndefined();
  expect((await getCard(env.DB,ORG,'after-recreation')).business).toBe('public-race');
});

test('private deletion returns members added just before the transaction for Jam eviction', async () => {
  const {upsertBusiness,removeBusiness}=await import('../src/db.js');
  const {addMembers}=await import('../src/access.js');
  await upsertBusiness(env.DB,ORG,{name:'Late Join',createdBy:'6101'});
  await env.DB.prepare("UPDATE businesses SET private=1 WHERE org_id=? AND slug='late-join'").bind(ORG).run();
  await addMembers(env.DB,{orgId:ORG,key:'b:late-join',logins:['owner'],addedBy:'owner'});
  const room=await env.DB.prepare("SELECT created_at FROM businesses WHERE org_id=? AND slug='late-join'").bind(ORG).first();
  const racing=new Proxy(env.DB,{get(db,key){
    if(key==='batch')return async statements=>{
      await addMembers(db,{orgId:ORG,key:'b:late-join',logins:['member'],addedBy:'owner'});
      return db.batch(statements);
    };
    return typeof db[key]==='function'?db[key].bind(db):db[key];
  }});
  const removed=await removeBusiness(racing,ORG,'late-join',{actorId:'6101',createdAt:room.created_at,wasPrivate:true});
  expect(removed.formerMembers.sort()).toEqual(['member','owner']);
  expect((await env.DB.prepare("SELECT login FROM conversation_members WHERE org_id=? AND channel='b:late-join'").bind(ORG).all()).results).toEqual([]);
});

test.each([false,true])('failed legacy deletion rolls back room, membership, cards and claim (private=%s)', async wasPrivate => {
  const {upsertBusiness,removeBusiness,saveCard,getCard}=await import('../src/db.js');
  await upsertBusiness(env.DB,ORG,{name:'Rollback Room',createdBy:'6101'});
  await env.DB.prepare("UPDATE businesses SET private=? WHERE org_id=? AND slug='rollback-room'").bind(Number(wasPrivate),ORG).run();
  const room=await env.DB.prepare("SELECT created_at FROM businesses WHERE org_id=? AND slug='rollback-room'").bind(ORG).first();
  await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES (?,'b:rollback-room','owner',?)").bind(ORG,new Date().toISOString()).run();
  await saveCard(env.DB,ORG,{id:'rollback-card',recipientUserID:'owner',senderUserID:'owner',status:'pending',title:'Keep me',priority:'medium',createdAt:new Date().toISOString(),business:'rollback-room'});
  const failing=new Proxy(env.DB,{get(db,key){
    if(key==='batch')return statements=>db.batch([...statements,db.prepare("INSERT INTO hx_room_access(org_id,channel,version) VALUES (NULL,'forced-error',1)")]);
    return typeof db[key]==='function'?db[key].bind(db):db[key];
  }});
  await expect(removeBusiness(failing,ORG,'rollback-room',{actorId:'6101',createdAt:room.created_at,wasPrivate})).rejects.toThrow();
  expect(await env.DB.prepare("SELECT private,archived_at FROM businesses WHERE org_id=? AND slug='rollback-room'").bind(ORG).first()).toEqual({private:Number(wasPrivate),archived_at:null});
  expect(await env.DB.prepare("SELECT login FROM conversation_members WHERE org_id=? AND channel='b:rollback-room'").bind(ORG).first()).toEqual({login:'owner'});
  expect(await env.DB.prepare("SELECT channel FROM hx_room_access WHERE org_id=? AND channel='b:rollback-room'").bind(ORG).first()).toBeNull();
  expect((await getCard(env.DB,ORG,'rollback-card')).business).toBe('rollback-room');
});

test("deleting an unmanaged private channel keeps its history and cards closed", async () => {
  const now = new Date().toISOString();
  const { saveCard, getCard, upsertBusiness } = await import('../src/db.js');
  const { postMessage } = await import('../src/channels.js');
  await upsertBusiness(env.DB, ORG, {name:'Private Board',createdBy:'6101'});
  await env.DB.prepare("UPDATE businesses SET private=1 WHERE org_id=? AND slug='private-board'").bind(ORG).run();
  await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES (?,'b:private-board','owner',?)").bind(ORG,now).run();
  await postMessage(env.DB,{orgId:ORG,key:'b:private-board',authorLogin:'owner',body:'Confidential planning note'});
  await saveCard(env.DB,ORG,{id:'private-board-card',recipientUserID:'owner',senderUserID:'owner',status:'pending',title:'Confidential board decision',priority:'medium',createdAt:now,business:'private-board'});
  const channelPath=`/channels/messages?${new URLSearchParams({orgId:ORG,channel:'b:private-board'})}`;
  expect((await SELF.fetch(`https://example.com${channelPath}`,{headers:headers(memberToken)})).status).toBe(404);
  const deleted=await SELF.fetch('https://example.com/businesses',{method:'DELETE',headers:headers(ownerToken),body:JSON.stringify({orgId:ORG,slug:'private-board'})});
  expect(deleted.status).toBe(200);
  expect((await SELF.fetch(`https://example.com${channelPath}`,{headers:headers(memberToken)})).status).toBe(404);
  expect((await deleted.json()).unfiled).toBe(0);
  expect((await getCard(env.DB,ORG,'private-board-card')).business).toBe('private-board');
  const search=await (await SELF.fetch(`https://example.com/channels/search?${new URLSearchParams({orgId:ORG,q:'Confidential planning'})}`,{headers:headers(memberToken)})).json();
  expect(search.messages).toEqual([]);
  const {messages: outsiderMessages}=await joined(ORG,memberToken);
  const snapshot=outsiderMessages.find(m=>m.type==='STATE_SNAPSHOT');
  expect(JSON.stringify(snapshot)).not.toContain('Confidential board decision');
  const {addMembers}=await import('../src/access.js');
  expect(await addMembers(env.DB,{orgId:ORG,key:'b:private-board',logins:['member'],addedBy:'owner'})).toBe(0);
  const archived=await (await SELF.fetch(`https://example.com/businesses/archived?${new URLSearchParams({orgId:ORG})}`,{headers:headers(ownerToken)})).json();
  expect(archived.channels.some(channel=>channel.slug==='private-board')).toBe(false);
  const restore=await SELF.fetch('https://example.com/businesses/unarchive',{method:'POST',headers:headers(ownerToken),body:JSON.stringify({orgId:ORG,slug:'private-board'})});
  expect(restore.status).toBe(404);
  const recreate=await SELF.fetch('https://example.com/businesses',{method:'POST',headers:headers(memberToken),body:JSON.stringify({orgId:ORG,name:'Private Board'})});
  expect(recreate.status).toBe(409);
});

test("channels nobody talks in are offered for tidying, and archiving hides them with their cards kept", async () => {
  const { upsertBusiness, saveCard, listBusinesses } = await import("../src/db.js");
  const { postMessage } = await import("../src/channels.js");
  await upsertBusiness(env.DB, ORG, { name: "Research", createdBy: "6101" });
  await upsertBusiness(env.DB, ORG, { name: "Food Truck", createdBy: "6101" });
  await postMessage(env.DB, { orgId: ORG, key: "b:research", authorLogin: "owner", body: "Starting the YCS26 study" });
  await saveCard(env.DB, ORG, { id: "ft1", recipientUserID: "member", senderUserID: "owner", status: "pending", title: "Permit", createdAt: new Date().toISOString(), business: "food-truck" });
  const unused = await (await SELF.fetch(`https://example.com/businesses/unused?orgId=${encodeURIComponent(ORG)}`, { headers: headers(memberToken) })).json();
  expect(unused.channels).toEqual([expect.objectContaining({ slug: "food-truck", name: "Food Truck", cards: 1 })]);
  const archive = (token, slugs) => SELF.fetch("https://example.com/businesses/archive", { method: "POST", headers: headers(token), body: JSON.stringify({ orgId: ORG, slugs }) });
  expect((await archive(outsiderToken, ["food-truck"])).status).toBe(403);
  const done = await (await archive(memberToken, ["food-truck", "nope"])).json();
  expect(done.archived).toBe(1);
  expect((await listBusinesses(env.DB, ORG)).map((b) => b.slug)).toEqual(["research"]);
  const card = await env.DB.prepare("SELECT json_extract(data, '$.business') AS b FROM cards WHERE card_id = 'ft1'").first();
  expect(card.b).toBe("food-truck");
  // Archived channels are listed, and one can be brought back as it was.
  const archivedList = async (token) => (await SELF.fetch(`https://example.com/businesses/archived?orgId=${encodeURIComponent(ORG)}`, { headers: headers(token) })).json();
  expect((await archivedList(memberToken)).channels).toEqual([expect.objectContaining({ slug: "food-truck", name: "Food Truck", private: false })]);
  const restore = (token, slug) => SELF.fetch("https://example.com/businesses/unarchive", { method: "POST", headers: headers(token), body: JSON.stringify({ orgId: ORG, slug }) });
  expect((await restore(outsiderToken, "food-truck")).status).toBe(403);
  expect((await restore(memberToken, "research")).status).toBe(404);
  const back = await restore(memberToken, "food-truck");
  expect(back.status).toBe(200);
  expect((await back.json()).businesses.map((b) => b.slug)).toContain("food-truck");
  expect((await archivedList(memberToken)).channels).toEqual([]);
});

test('private Simple creation commits a private room and its selected members together', async () => {
  const {listMembers}=await import('../src/team.js');
  const members=await listMembers(env.DB,ORG,'6101');
  const invited=members.find(member=>member.userId==='6102');
  const res=await SELF.fetch('https://example.com/businesses',{method:'POST',headers:headers(ownerToken),body:JSON.stringify({orgId:ORG,name:'Private atomic',private:true,members:[invited.ref]})});
  expect(res.status).toBe(200);
  expect((await res.json()).business).toEqual({slug:'private-atomic',name:'Private atomic',private:true});
  expect(await env.DB.prepare("SELECT private,created_by FROM businesses WHERE org_id=? AND slug='private-atomic'").bind(ORG).first()).toEqual({private:1,created_by:'6101'});
  expect((await env.DB.prepare("SELECT login FROM conversation_members WHERE org_id=? AND channel='b:private-atomic' ORDER BY login").bind(ORG).all()).results).toEqual([{login:'member'},{login:'owner'}]);
  const other=await SELF.fetch('https://example.com/businesses',{method:'POST',headers:headers(memberToken),body:JSON.stringify({orgId:ORG,name:'Private atomic',private:true})});
  expect(other.status).toBe(409);
});

test('private room creation rolls back the room if its member insertion fails',async()=>{
  const {createPrivateBusiness}=await import('../src/db.js');
  const {listMembers}=await import('../src/team.js');
  const members=await listMembers(env.DB,ORG,'6101');
  await env.DB.exec("CREATE TRIGGER reject_private_create_member BEFORE INSERT ON conversation_members WHEN NEW.channel='b:failure-atomic' BEGIN SELECT RAISE(ABORT,'injected membership failure'); END;");
  await expect(createPrivateBusiness(env.DB,ORG,{name:'Failure atomic',actorId:'6101',actorLogin:'owner',members})).rejects.toThrow();
  expect(await env.DB.prepare("SELECT 1 FROM businesses WHERE org_id=? AND slug='failure-atomic'").bind(ORG).first()).toBeNull();
  expect((await env.DB.prepare("SELECT login FROM conversation_members WHERE org_id=? AND channel='b:failure-atomic'").bind(ORG).all()).results).toEqual([]);
  await env.DB.exec('DROP TRIGGER reject_private_create_member');
});

test('a competing creation cannot attach private members to the existing public room',async()=>{
  const {createPrivateBusiness,upsertBusiness}=await import('../src/db.js');
  const {listMembers}=await import('../src/team.js');
  const members=await listMembers(env.DB,ORG,'6101');
  const racing=new Proxy(env.DB,{get(db,key){
    if(key==='batch')return async statements=>{
      await upsertBusiness(db,ORG,{name:'Race creation',createdBy:'6102'});
      return db.batch(statements);
    };
    return typeof db[key]==='function'?db[key].bind(db):db[key];
  }});
  expect(await createPrivateBusiness(racing,ORG,{name:'Race creation',actorId:'6101',actorLogin:'owner',members})).toBeNull();
  expect(await env.DB.prepare("SELECT private,created_by FROM businesses WHERE org_id=? AND slug='race-creation'").bind(ORG).first()).toEqual({private:0,created_by:'6102'});
  expect((await env.DB.prepare("SELECT login FROM conversation_members WHERE org_id=? AND channel='b:race-creation'").bind(ORG).all()).results).toEqual([]);
});

test('private creation fences revoked creator membership and rejects stale invitations',async()=>{
  const {createPrivateBusiness}=await import('../src/db.js');
  const {listMembers}=await import('../src/team.js');
  const members=await listMembers(env.DB,ORG,'6101');
  const staleLogin=members.map(member=>member.userId==='6101'?{...member,login:'former-owner'}:member);
  expect(await createPrivateBusiness(env.DB,ORG,{name:'Stale creator login',actorId:'6101',actorLogin:'owner',members:staleLogin})).toBeNull();
  await env.DB.prepare('DELETE FROM memberships WHERE org_id=? AND user_github_id=?').bind(ORG,'6102').run();
  const created=await createPrivateBusiness(env.DB,ORG,{name:'Stale invitations',actorId:'6101',actorLogin:'owner',members});
  expect(created).toBeNull();
  expect(await env.DB.prepare("SELECT 1 FROM businesses WHERE org_id=? AND slug='stale-invitations'").bind(ORG).first()).toBeNull();
  await env.DB.prepare("UPDATE memberships SET role='guest' WHERE org_id=? AND user_github_id=?").bind(ORG,'6101').run();
  expect(await createPrivateBusiness(env.DB,ORG,{name:'Revoked creator',actorId:'6101',actorLogin:'owner',members})).toBeNull();
  expect(await env.DB.prepare("SELECT 1 FROM businesses WHERE org_id=? AND slug='revoked-creator'").bind(ORG).first()).toBeNull();
});

test.each(['removed','rejoined','login','role'])('private creation rejects a member whose %s changes immediately before commit',async mutation=>{
  const {createPrivateBusiness}=await import('../src/db.js');
  const {listMembers}=await import('../src/team.js');
  const members=await listMembers(env.DB,ORG,'6101');
  const racing=new Proxy(env.DB,{get(db,key){
    if(key==='batch')return async statements=>{
      if(mutation==='removed')await db.prepare('DELETE FROM memberships WHERE org_id=? AND user_github_id=?').bind(ORG,'6102').run();
      if(mutation==='rejoined')await db.prepare("UPDATE memberships SET created_at='2099-01-01' WHERE org_id=? AND user_github_id=?").bind(ORG,'6102').run();
      if(mutation==='login')await db.prepare("UPDATE users SET login='new-member' WHERE github_id='6102'").run();
      if(mutation==='role')await db.prepare("UPDATE memberships SET role='guest' WHERE org_id=? AND user_github_id=?").bind(ORG,'6102').run();
      return db.batch(statements);
    };
    return typeof db[key]==='function'?db[key].bind(db):db[key];
  }});
  expect(await createPrivateBusiness(racing,ORG,{name:'Snapshot race',actorId:'6101',actorLogin:'owner',members})).toBeNull();
  expect(await env.DB.prepare("SELECT 1 FROM businesses WHERE org_id=? AND slug='snapshot-race'").bind(ORG).first()).toBeNull();
  expect((await env.DB.prepare("SELECT login FROM conversation_members WHERE org_id=? AND channel='b:snapshot-race'").bind(ORG).all()).results).toEqual([]);
});

test('private creation rejects a selected reference that disappeared before roster loading',async()=>{
  const {listMembers}=await import('../src/team.js');
  const members=await listMembers(env.DB,ORG,'6101');
  const ref=members.find(member=>member.userId==='6102').ref;
  await env.DB.prepare('DELETE FROM memberships WHERE org_id=? AND user_github_id=?').bind(ORG,'6102').run();
  const response=await SELF.fetch('https://example.com/businesses',{method:'POST',headers:headers(ownerToken),body:JSON.stringify({orgId:ORG,name:'Missing selected member',private:true,members:[ref]})});
  expect(response.status).toBe(409);
  expect((await response.json()).message).toContain('Selected members changed');
  expect(await env.DB.prepare("SELECT 1 FROM businesses WHERE org_id=? AND slug='missing-selected-member'").bind(ORG).first()).toBeNull();
});

test('private creation refuses a name with orphaned members without deleting or granting them access',async()=>{
  await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES (?,'b:old-members','member','2026-01-01')").bind(ORG).run();
  const res=await SELF.fetch('https://example.com/businesses',{method:'POST',headers:headers(ownerToken),body:JSON.stringify({orgId:ORG,name:'Old members',private:true})});
  expect(res.status).toBe(409);
  expect((await res.json()).message).toContain('Choose another name');
  expect(await env.DB.prepare("SELECT 1 FROM businesses WHERE org_id=? AND slug='old-members'").bind(ORG).first()).toBeNull();
  expect((await env.DB.prepare("SELECT login FROM conversation_members WHERE org_id=? AND channel='b:old-members'").bind(ORG).all()).results).toEqual([{login:'member'}]);
});
