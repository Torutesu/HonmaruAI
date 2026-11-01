import {env} from 'cloudflare:test';
import {expect,test} from 'vitest';
import schema from '../schema.sql?raw';
import {upsertUser,upsertMembership,createSession,sessionKey,sessionByKey} from '../src/db.js';
import {policyDenial} from '../src/policy.js';
import {endedHere} from '../src/sessions.js';

test('normal workspace policy combines the deletion and session lookup in one query',async()=>{
 await env.DB.exec(schema.replace(/\n/g,' '));const org='personal:combined-read',user='8291';
 await upsertUser(env.DB,{githubId:user,login:'combined',name:'Combined'});await upsertMembership(env.DB,org,user,'member');
 const key=await sessionKey(await createSession(env.DB,user,'fixture'));const session=await sessionByKey(env.DB,key);const sqls=[];
 const db={prepare(sql){sqls.push(sql);return env.DB.prepare(sql)},batch:env.DB.batch.bind(env.DB)};
 expect(await policyDenial({...env,DB:db},session,org)).toBeNull();
 expect(sqls.filter(sql=>sql.includes('AS deletion_due'))).toHaveLength(1);
 expect(sqls.filter(sql=>sql.startsWith('SELECT due_at FROM workspace_deletions'))).toHaveLength(0);
 expect(sqls.filter(sql=>sql.includes('JOIN session_workspaces'))).toHaveLength(1);
});

test('the combined read preserves session touch, ended state, and deleted status without caching',async()=>{
 await env.DB.exec(schema.replace(/\n/g,' '));const org='personal:combined-state',user='8292';
 await upsertUser(env.DB,{githubId:user,login:'combinedstate',name:'Combined'});await upsertMembership(env.DB,org,user,'member');
 const key=await sessionKey(await createSession(env.DB,user,'fixture'));
 expect(await endedHere(env.DB,key,org,{includeDeletion:true})).toEqual({ended:false,due:null});
 expect(await env.DB.prepare('SELECT 1 FROM session_workspaces WHERE token=? AND org_id=?').bind(key,org).first()).toBeTruthy();
 await env.DB.prepare("UPDATE session_workspaces SET ended_at='2026-01-01' WHERE token=? AND org_id=?").bind(key,org).run();
 await env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at) VALUES (?,'2090-01-01',?,'2026-01-01')").bind(org,user).run();
 expect(await endedHere(env.DB,key,org,{includeDeletion:true})).toEqual({ended:true,due:'2090-01-01'});
 await env.DB.prepare('DELETE FROM workspace_deletions WHERE org_id=?').bind(org).run();
 expect(await endedHere(env.DB,key,org,{includeDeletion:true})).toEqual({ended:true,due:null});
});

test('a missing combined authorization row fails closed',async()=>{
 await env.DB.exec(schema.replace(/\n/g,' '));const org='personal:combined-missing',user='8293';
 await upsertUser(env.DB,{githubId:user,login:'combinedmissing',name:'Combined'});await upsertMembership(env.DB,org,user,'member');
 const key=await sessionKey(await createSession(env.DB,user,'fixture'));const session=await sessionByKey(env.DB,key);
 const db={prepare(sql){if(sql.includes('AS deletion_due'))return {bind(){return {first:async()=>null}}};return env.DB.prepare(sql)},batch:env.DB.batch.bind(env.DB)};
 expect(await policyDenial({...env,DB:db},session,org)).toMatchObject({status:503,body:{code:'workspace-status-unavailable'}});
});

test('a deletion reserved just after the combined read prevents later route authorization from promoting an owner',async()=>{
 await env.DB.exec(schema.replace(/\n/g,' '));const org='personal:combined-reservation-race',user='8294';
 await upsertUser(env.DB,{githubId:user,login:'combinedrace',name:'Race'});await upsertMembership(env.DB,org,user,'admin');
 const token=await createSession(env.DB,user,'fixture');let injected=false;
 const db={prepare(sql){const stmt=env.DB.prepare(sql);if(!sql.includes('AS deletion_due'))return stmt;
  return {bind(...args){const bound=stmt.bind(...args);return {async first(){const result=await bound.first();
   await env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at) VALUES (?,'2090-01-01',?,'2026-01-01')").bind(org,user).run();injected=true;return result;
  }}}};
 },batch:env.DB.batch.bind(env.DB)};
 const {handlePolicy}=await import('../src/policy.js');
 const req=new Request(`https://test/orgs/session-policy?orgId=${encodeURIComponent(org)}`,{headers:{'x-session-token':token}});
 await handlePolicy(req,{...env,DB:db},new URL(req.url));
 expect(injected).toBe(true);
 expect((await env.DB.prepare('SELECT role FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,user).first()).role).toBe('admin');
});

test.each(['deletion','tombstone'])('ensureOwner cannot promote a legacy admin when %s exists',async reason=>{
 await env.DB.exec(schema.replace(/\n/g,' '));const org=`personal:combined-${reason}`,user='8295';
 await upsertUser(env.DB,{githubId:user,login:`guard${reason}`,name:'Guard'});await upsertMembership(env.DB,org,user,'admin');
 if(reason==='deletion')await env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at) VALUES (?,'2090-01-01',?,'2026-01-01')").bind(org,user).run();
 else await env.DB.prepare("INSERT INTO workspace_tombstones(org_id,deleted_at,requested_by) VALUES (?,'2026-01-01',?)").bind(org,user).run();
 const {ensureOwner}=await import('../src/permissions.js');expect(await ensureOwner(env.DB,org)).toBeNull();
 expect((await env.DB.prepare('SELECT role FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,user).first()).role).toBe('admin');
});
