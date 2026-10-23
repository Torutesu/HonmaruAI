import {env} from 'cloudflare:test';
import {expect,test} from 'vitest';
import {upsertUser,upsertMembership} from '../src/db.js';
import {createManagedRoom} from '../src/harness/roomCreation.js';
import {createRoomHook,authenticateRoomHook,receiveRoomHookEvent} from '../src/harness/roomHooks.js';
import {roomHookAgentAllowed} from '../src/harness/roomHookAgentAccess.js';
test('agent access is recomputed after profile restriction and deletion',async()=>{
 const org='hook-agent-access';
 for(const id of ['maker','agent-owner']){await upsertUser(env.DB,{githubId:id,login:id,name:id});await upsertMembership(env.DB,org,id,'admin')}
 const channel=(await createManagedRoom(env.DB,org,'maker',{requestId:'agent-access-room',name:'Agents',private:true,guidelines:'',color:'teal',memberRefs:[],agentIds:[]})).room.channel;
 await env.DB.prepare("INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES (?1,'helper','helper','Helper','Help','team','agent-owner','now','now')").bind(org).run();
 await env.DB.prepare("INSERT INTO hx_agent_profiles(org_id,agent_id,access,updated_at) VALUES (?1,'helper','everyone','now')").bind(org).run();
 const made=await createRoomHook(env.DB,org,channel,'maker','Access');
 const hook=await authenticateRoomHook(env.DB,made.hook.id,made.secret);
 const event=await receiveRoomHookEvent(env.DB,hook,{eventId:'access',body:'@helper review deployment'});
 expect(await roomHookAgentAllowed(env.DB,org,event.messageId,'helper')).toBe(true);
 await env.DB.prepare("UPDATE hx_agent_profiles SET access='private' WHERE org_id=?1").bind(org).run();
 expect(await roomHookAgentAllowed(env.DB,org,event.messageId,'helper')).toBe(false);
 await env.DB.prepare("UPDATE hx_agent_profiles SET access='everyone' WHERE org_id=?1").bind(org).run();
 await env.DB.prepare("UPDATE custom_agents SET deleted_at='now' WHERE org_id=?1").bind(org).run();
 expect(await roomHookAgentAllowed(env.DB,org,event.messageId,'helper')).toBe(false);
});
