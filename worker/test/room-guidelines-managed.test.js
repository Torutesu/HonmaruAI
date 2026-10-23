import {env} from 'cloudflare:test';
import {beforeEach,test,expect} from 'vitest';
import worker from '../src/index.js';
import {upsertUser,upsertMembership,createSession} from '../src/db.js';
import {createManagedRoom} from '../src/harness/roomCreation.js';
import {getGuidelines,saveGuidelines} from '../src/harness/guidelines.js';
const org='managed-guidelines';let channel;
beforeEach(async()=>{
 for(const id of ['creator','outside']){await upsertUser(env.DB,{githubId:id,login:id,name:id});await upsertMembership(env.DB,org,id,'admin')}
 channel=(await createManagedRoom(env.DB,org,'creator',{requestId:'guidelines-create',name:'Rules',private:false,guidelines:'',color:'teal',memberRefs:[],agentIds:[]})).room.channel;
});
const save=(db,body,version,actor='creator')=>saveGuidelines(db,org,channel,{body,version},actor);
test('requires explicit membership even for public room administrators',async()=>{
 const initial=await getGuidelines(env.DB,org,channel);
 expect((await save(env.DB,'Denied',initial.version,'outside')).status).toBe(403);
 const saved=await save(env.DB,'First',initial.version);expect(saved.guidelines.body).toBe('First');
 expect((await save(env.DB,'Stale',initial.version)).status).toBe(409);
 expect((await getGuidelines(env.DB,org,channel)).body).toBe('First');
});
test.each(['rejoin','guest','archive'])('rechecks %s immediately in the write statement',async change=>{
 const initial=await getGuidelines(env.DB,org,channel);let changed=false;
 const raced={prepare(sql){const statement=env.DB.prepare(sql);if(!sql.startsWith('INSERT INTO hx_room_guidelines'))return statement;return {bind(...values){return {async first(){
  if(!changed){changed=true;
   if(change==='rejoin')await env.DB.prepare("UPDATE conversation_members SET added_at='rejoined' WHERE org_id=?1 AND channel=?2 AND login='creator'").bind(org,channel).run();
   if(change==='guest')await env.DB.prepare("UPDATE memberships SET role='guest' WHERE org_id=?1 AND user_github_id='creator'").bind(org).run();
   if(change==='archive')await env.DB.prepare("UPDATE businesses SET archived_at='now' WHERE org_id=?1").bind(org).run();
  }
  return statement.bind(...values).first();
 }}}}}};
 expect((await save(raced,'Must not save',initial.version)).status).toBe(409);
 expect(await getGuidelines(env.DB,org,channel)).toEqual(initial);
});
test('concurrent writers return only their own winning revision',async()=>{
 const initial=await getGuidelines(env.DB,org,channel);
 const results=await Promise.all([save(env.DB,'One',initial.version),save(env.DB,'Two',initial.version)]);
 expect(results.filter(result=>result.guidelines)).toHaveLength(1);
 expect(results.filter(result=>result.status===409)).toHaveLength(1);
 const winner=results.find(result=>result.guidelines).guidelines;
 expect(await getGuidelines(env.DB,org,channel)).toEqual(winner);
});

test('HTTP exposes read-only capability and refuses archived managed writes',async()=>{
 const token=await createSession(env.DB,'outside','test');
 const query=new URLSearchParams({orgId:org,channel});
 const response=await worker.fetch(new Request(`https://test/hx/rooms/guidelines?${query}`,{headers:{'x-session-token':token}}),env);
 expect(response.status).toBe(200);expect((await response.json()).canEdit).toBe(false);
 const initial=await getGuidelines(env.DB,org,channel);
 await env.DB.prepare("UPDATE businesses SET archived_at='now' WHERE org_id=?1").bind(org).run();
 expect((await save(env.DB,'Archived edit',initial.version)).status).toBe(404);
 expect(await getGuidelines(env.DB,org,channel)).toEqual(initial);
});
