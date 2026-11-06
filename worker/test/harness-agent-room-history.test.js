import {env} from 'cloudflare:test';
import {beforeEach,expect,test} from 'vitest';
import schemaSql from '../schema.sql?raw';
import {upsertUser,upsertMembership,upsertBusiness} from '../src/db.js';
import {setMode} from '../src/harness/mode.js';
import {agentRoomHistoryTools} from '../src/harness/agentRoomHistory.js';
import {agentTools} from '../src/agentTools.js';

const orgId='personal:agent-room-history';
const session={github_id:'history-human'};
const agentId='history-agent';
const stamp='2026-11-06T00:00:00.000Z';
const tool=()=>agentRoomHistoryTools(env,{orgId,session,agentId}).search_room_history;
const run=(query,limit=10,before=null)=>tool().run({query,limit,before});

beforeEach(async()=>{
 await env.DB.exec(schemaSql.replace(/\n/g,' '));
 for(const [id,login,role] of [['history-human','history-human','member'],['history-maker','history-maker','member']]){
  await upsertUser(env.DB,{githubId:id,login,name:login});
  await upsertMembership(env.DB,orgId,id,role);
 }
 for(const name of ['Cafe','Private Room','Other Room','Other Private Room']){
  await upsertBusiness(env.DB,orgId,{name,createdBy:'history-maker'});
 }
 await env.DB.prepare("UPDATE businesses SET private=1 WHERE org_id=?1 AND slug IN ('private-room','other-private-room')").bind(orgId).run();
 await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_by,added_at) VALUES(?1,'b:private-room','history-human','history-maker',?2)")
  .bind(orgId,stamp).run();
 await env.DB.prepare(`INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at)
  VALUES(?1,?2,'historian','Historian','Research earlier room work','team','history-maker',?3,?3)`)
  .bind(orgId,agentId,stamp).run();
 await env.DB.prepare("INSERT INTO channel_agents(org_id,channel,agent_id,added_by,added_at) VALUES(?1,'b:private-room',?2,'history-maker',?3)")
  .bind(orgId,agentId,stamp).run();
 for(const [id,channel,body,createdAt] of [
  ['hist-public','b:cafe','The violet launch plan is approved.',stamp],
  ['hist-before-install','b:cafe','Violet before Agent installation remains searchable.','2026-10-01T00:00:00.000Z'],
  ['hist-private','b:private-room','Private violet budget is confidential.',stamp],
  ['hist-other','b:other-room','Public unassigned violet message is searchable.',stamp],
  ['hist-other-private','b:other-private-room','Unassigned private violet message must stay hidden.',stamp],
  ['hist-thread-root','b:cafe','A previous thread discussed a launch.',stamp],
 ]){
  await env.DB.prepare("INSERT INTO channel_messages(id,org_id,channel,author_login,kind,body,created_at) VALUES(?1,?2,?3,'history-human','message',?4,?5)")
   .bind(id,orgId,channel,body,createdAt).run();
 }
 await env.DB.prepare("INSERT INTO channel_messages(id,org_id,channel,author_login,kind,body,created_at,parent_id) VALUES('hist-thread-reply',?1,'b:cafe','history-human','message','threadtoken: answer from history',?2,'hist-thread-root')")
  .bind(orgId,stamp).run();
 await env.DB.prepare("INSERT INTO channel_messages(id,org_id,channel,author_login,kind,body,created_at,deleted_at) VALUES('hist-deleted',?1,'b:cafe','history-human','message','violet removedtoken must stay hidden',?2,?2)")
  .bind(orgId,stamp).run();
 await setMode(env.DB,orgId,'harness','history-maker');
});

test('search finds every readable public Room but only assigned and readable private Rooms',async()=>{
 const first=JSON.parse(await run('violet'));
 expect([...new Set(first.messages.map(row=>row.room))].sort()).toEqual(['b:cafe','b:other-room','b:private-room']);
 expect(first.messages.some(row=>row.text.includes('Public unassigned'))).toBe(true);
 expect(first.messages.some(row=>row.text.includes('before Agent installation'))).toBe(true);
 expect(first.messages.some(row=>row.text.includes('removedtoken'))).toBe(false);
 expect(first.messages.some(row=>row.text.includes('Unassigned private'))).toBe(false);
 expect(first.messages.every(row=>row.date&&row.href.startsWith('#/m/'))).toBe(true);
 expect(first.messages.find(row=>row.text.includes('before Agent installation')).date).toBe('2026-10-01T00:00:00.000Z');
 expect(first.nextCursor).toBeNull();
});

test('private Room access requires Agent assignment and current human membership, and profile revocation blocks all search',async()=>{
 await env.DB.prepare("DELETE FROM channel_agents WHERE org_id=?1 AND channel='b:private-room' AND agent_id=?2").bind(orgId,agentId).run();
 expect(await run('confidential')).toContain('No matching messages');
 await env.DB.prepare("INSERT INTO channel_agents(org_id,channel,agent_id,added_by,added_at) VALUES(?1,'b:private-room',?2,'history-maker',?3)").bind(orgId,agentId,stamp).run();
 await env.DB.prepare("DELETE FROM conversation_members WHERE org_id=?1 AND channel='b:private-room' AND login='history-human'").bind(orgId).run();
 expect(await run('confidential')).toContain('No matching messages');
 await env.DB.prepare("INSERT INTO hx_agent_profiles(org_id,agent_id,access,people,updated_at) VALUES(?1,?2,'private','[]',?3)").bind(orgId,agentId,stamp).run();
 expect(await run('violet')).toContain('No currently accessible');
});

test('thread replies are searchable and deleted messages are not',async()=>{
 const found=JSON.parse(await run('threadtoken'));
 expect(found.messages).toHaveLength(1);
 expect(found.messages[0].text).toContain('answer from history');
 expect(await run('removedtoken')).toContain('No matching messages');
});

test('pagination is bounded and continues without repeating same-timestamp messages',async()=>{
 const page1=JSON.parse(await run('violet',2));
 expect(page1.messages).toHaveLength(2);
 expect(page1.nextCursor).toContain('|');
 const page2=JSON.parse(await run('violet',2,page1.nextCursor));
 expect(page2.messages).toHaveLength(2);
 expect(page2.messages.every(row=>!page1.messages.some(first=>first.href===row.href))).toBe(true);
 expect(page2.nextCursor).toBeNull();
 expect(await run('x'.repeat(121))).toContain('1 to 120');
});

test('the tool is omitted in Simple mode and execution rechecks the workspace mode',async()=>{
 const raw=tool();
 await setMode(env.DB,orgId,'simple','history-maker');
 expect(await raw.run({query:'violet',limit:5,before:null})).toContain('No currently accessible');
 const tools=await agentTools(env,{orgId,session,personal:true,agentId});
 expect(tools.search_room_history).toBeUndefined();
});

test('search covers more than 200 Rooms and paginates one globally ordered result set',async()=>{
 for(let index=0;index<205;index++){
  const suffix=String(index).padStart(3,'0');
  const slug='z-room-'+suffix;
  await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,created_by,created_at) VALUES(?1,?2,?3,'history-maker',?4)")
   .bind(orgId,slug,'Z room '+suffix,stamp).run();
  await env.DB.prepare("INSERT INTO channel_messages(id,org_id,channel,author_login,kind,body,created_at) VALUES(?1,?2,?3,'history-human','message','widebatch marker',?4)")
   .bind('wide-'+suffix,orgId,'b:'+slug,stamp).run();
 }
 const first=JSON.parse(await run('widebatch',10));
 expect(first.messages.map(row=>row.href.split('/').at(-2))).toEqual(Array.from({length:10},(_,index)=>'wide-'+String(204-index).padStart(3,'0')));
 expect(first.messages[0].room).toBe('b:z-room-204');
 expect(first.nextCursor).toBeTruthy();
 const second=JSON.parse(await run('widebatch',10,first.nextCursor));
 expect(second.messages.map(row=>row.href.split('/').at(-2))).toEqual(Array.from({length:10},(_,index)=>'wide-'+String(194-index).padStart(3,'0')));
 expect(second.messages.every(row=>!first.messages.some(previous=>previous.href===row.href))).toBe(true);
});

test('a Room membership revoked during search discards the whole result page',async()=>{
 let intercepted=false;
 const database={
  prepare(sql){
   const statement=env.DB.prepare(sql);
   if(!sql.includes('SELECT m.id,m.channel,substr(m.body,1,'))return statement;
   return {bind(...values){
    const bound=statement.bind(...values);
    return {all:async()=>{
     const result=await bound.all();
     if(!intercepted){
      intercepted=true;
      await env.DB.prepare("DELETE FROM conversation_members WHERE org_id=?1 AND channel='b:private-room' AND login='history-human'").bind(orgId).run();
     }
     return result;
    }};
   }};
  },
 };
 const guardedTool=agentRoomHistoryTools({...env,DB:database},{orgId,session,agentId}).search_room_history;
 const result=await guardedTool.run({query:'confidential',limit:5,before:null});
 expect(intercepted).toBe(true);
 expect(result).toContain('Room access changed');
 expect(result).not.toContain('Private violet budget');
});
