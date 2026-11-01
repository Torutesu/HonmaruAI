import {env} from 'cloudflare:test';
import {expect,test} from 'vitest';
import schema from '../schema.sql?raw';
import {upsertUser,upsertMembership,createSession,sessionKey} from '../src/db.js';
import {handleChannels} from '../src/channelRoutes.js';

test.each(['GET','POST'])('untrusted IP cannot trigger legacy owner promotion for Activity %s',async method=>{
 await env.DB.exec(schema.replace(/\n/g,' '));
 const org=`personal:caller-audit-${method}`,user='8258';
 await upsertUser(env.DB,{githubId:user,login:`audit${method}`,name:'Audit'});
 await upsertMembership(env.DB,org,user,'admin');
 const token=await createSession(env.DB,user,'fixture');
 await env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at) VALUES (?,'2090-01-01',?,'2026-01-01')").bind(org,user).run();
 await env.DB.prepare("INSERT INTO org_governance(org_id,ip_enforce,ip_allowlist,updated_by,updated_at) VALUES (?,1,'[\"192.0.2.0/24\"]',?,'2090-01-01')").bind(org,user).run();
 const req=method==='GET'?new Request(`https://test/channels/activity?orgId=${encodeURIComponent(org)}`,{headers:{'x-session-token':token}}):new Request('https://test/channels/read',{method:'POST',headers:{'x-session-token':token,'content-type':'application/json'},body:JSON.stringify({orgId:org,channel:'activity',items:[]})});
 const response=await handleChannels(req,env,new URL(req.url),{after:()=>{}});
 expect(response.status).toBe(403);
 expect((await env.DB.prepare('SELECT role FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,user).first()).role).toBe('admin');
});

test('expired session policy cannot trigger legacy owner promotion',async()=>{
 await env.DB.exec(schema.replace(/\n/g,' '));
 const org='personal:caller-expiry-audit',user='8259';
 await upsertUser(env.DB,{githubId:user,login:'auditexpiry',name:'Audit'});
 await upsertMembership(env.DB,org,user,'admin');
 const token=await createSession(env.DB,user,'fixture');
 await env.DB.prepare("UPDATE sessions SET created_at='2020-01-01T00:00:00.000Z' WHERE token=?").bind(await sessionKey(token)).run();
 await env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at) VALUES (?,'2090-01-01',?,'2026-01-01')").bind(org,user).run();
 await env.DB.prepare("INSERT INTO org_session_policy(org_id,web_max_hours,updated_by,updated_at) VALUES (?,1,?,'2090-01-01')").bind(org,user).run();
 const req=new Request(`https://test/channels/activity?orgId=${encodeURIComponent(org)}`,{headers:{'x-session-token':token}});
 const response=await handleChannels(req,env,new URL(req.url),{after:()=>{}});
 expect(response.status).toBe(401);
 expect((await env.DB.prepare('SELECT role FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,user).first()).role).toBe('admin');
});



test('a valid legacy admin is promoted so deletion can be cancelled',async()=>{
 await env.DB.exec(schema.replace(/\n/g,' '));
 const org='personal:caller-valid',user='8262';await upsertUser(env.DB,{githubId:user,login:'validlegacy',name:'Valid'});await upsertMembership(env.DB,org,user,'admin');
 const token=await createSession(env.DB,user,'fixture');
 await env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at) VALUES (?,'2090-01-01',?,'2026-01-01')").bind(org,user).run();
 const req=new Request(`https://test/channels/activity?orgId=${encodeURIComponent(org)}`,{headers:{'x-session-token':token}});
 expect((await handleChannels(req,env,new URL(req.url),{after:()=>{}})).status).toBe(200);
 expect((await env.DB.prepare('SELECT role FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,user).first()).role).toBe('owner');
});

test.each(['session','policy','membership','purge','tombstone','cancel'])('revocation of %s immediately before the D1 batch prevents owner promotion',async change=>{
 await env.DB.exec(schema.replace(/\n/g,' '));
 const org=`personal:owner-race-${change}`,user='8270';
 await upsertUser(env.DB,{githubId:user,login:`race${change}`,name:'Race'});await upsertMembership(env.DB,org,user,'admin');
 const token=await createSession(env.DB,user,'fixture');const key=await sessionKey(token);
 await env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at) VALUES (?,'2090-01-01',?,'2026-01-01')").bind(org,user).run();
 let injected=false;
 const db={prepare:env.DB.prepare.bind(env.DB),batch:async statements=>{
  if(!injected){injected=true;
   if(change==='session')await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(key).run();
   if(change==='membership')await env.DB.prepare('DELETE FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,user).run();
   if(change==='cancel')await env.DB.prepare('DELETE FROM workspace_deletions WHERE org_id=?').bind(org).run();
   if(change==='purge')await env.DB.prepare("UPDATE workspace_deletions SET purge_started_at='2026-01-01' WHERE org_id=?").bind(org).run();
   if(change==='tombstone')await env.DB.prepare("INSERT INTO workspace_tombstones(org_id,deleted_at,requested_by) VALUES (?,'2026-01-01',?)").bind(org,user).run();
   if(change==='policy')await env.DB.prepare("INSERT INTO org_governance(org_id,ip_enforce,ip_allowlist,updated_by,updated_at) VALUES (?,1,'[\"192.0.2.0/24\"]',?,'2090-01-01')").bind(org,user).run();
  }
  return env.DB.batch(statements);
 }};
 const req=new Request(`https://test/channels/activity?orgId=${encodeURIComponent(org)}`,{headers:{'x-session-token':token}});
 const response=await handleChannels(req,{...env,DB:db},new URL(req.url),{after:()=>{}});
 expect(injected).toBe(true);expect(response.status).not.toBe(200);
 const row=await env.DB.prepare('SELECT role FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,user).first();
 expect(row?.role).not.toBe('owner');
 if(change==='cancel'){const retry=new Request(`https://test/channels/activity?orgId=${encodeURIComponent(org)}`,{headers:{'x-session-token':token}});expect((await handleChannels(retry,env,new URL(retry.url),{after:()=>{}})).status).toBe(200)}
});

test('the earliest admin alone is promoted when a later admin requests recovery',async()=>{
 await env.DB.exec(schema.replace(/\n/g,' '));
 const org='personal:owner-first',first='8271',later='8272';
 for(const [id,login] of [[first,'earlier'],[later,'later']]){await upsertUser(env.DB,{githubId:id,login,name:login});await upsertMembership(env.DB,org,id,'admin')}
 await env.DB.prepare("UPDATE memberships SET created_at='2000-01-01' WHERE org_id=? AND user_github_id=?").bind(org,first).run();
 const token=await createSession(env.DB,later,'fixture');
 await env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at) VALUES (?,'2090-01-01',?,'2026-01-01')").bind(org,first).run();
 const req=new Request(`https://test/channels/activity?orgId=${encodeURIComponent(org)}`,{headers:{'x-session-token':token}});
 expect((await handleChannels(req,env,new URL(req.url),{after:()=>{}})).status).toBe(410);
 expect((await env.DB.prepare("SELECT user_github_id FROM memberships WHERE org_id=? AND role='owner'").bind(org).all()).results).toEqual([{user_github_id:first}]);
});

test('an existing owner retains no-IP internal compatibility while no promotion occurs',async()=>{
 await env.DB.exec(schema.replace(/\n/g,' '));const org='personal:owner-internal',user='8273';
 await upsertUser(env.DB,{githubId:user,login:'existingowner',name:'Owner'});await upsertMembership(env.DB,org,user,'owner');
 const token=await createSession(env.DB,user,'fixture');
 await env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at) VALUES (?,'2090-01-01',?,'2026-01-01')").bind(org,user).run();
 await env.DB.prepare("INSERT INTO org_governance(org_id,ip_enforce,ip_allowlist,updated_by,updated_at) VALUES (?,1,'[\"192.0.2.0/24\"]',?,'2090-01-01')").bind(org,user).run();
 const req=new Request(`https://test/channels/activity?orgId=${encodeURIComponent(org)}`,{headers:{'x-session-token':token}});
 expect((await handleChannels(req,env,new URL(req.url),{after:()=>{}})).status).toBe(200);
 expect((await env.DB.prepare('SELECT role FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,user).first()).role).toBe('owner');
});

test.each(['scim','workspace-session','wrong-ip'])('%s denial does not promote a legacy admin',async reason=>{
 await env.DB.exec(schema.replace(/\n/g,' '));const org=`personal:owner-deny-${reason}`,user='8274';
 await upsertUser(env.DB,{githubId:user,login:`deny${reason}`,name:'Deny'});await upsertMembership(env.DB,org,user,'admin');
 const token=await createSession(env.DB,user,'fixture'),key=await sessionKey(token);
 await env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at) VALUES (?,'2090-01-01',?,'2026-01-01')").bind(org,user).run();
 if(reason==='scim')await env.DB.prepare("INSERT INTO scim_users(org_id,id,user_github_id,user_name,active,created_at,updated_at) VALUES (?,'scim',?,'deny',0,'2026-01-01','2026-01-01')").bind(org,user).run();
 if(reason==='workspace-session')await env.DB.prepare("INSERT INTO session_workspaces(token,org_id,last_seen_at,ended_at) VALUES (?,?,'2026-01-01','2026-01-01')").bind(key,org).run();
 if(reason==='wrong-ip')await env.DB.prepare("INSERT INTO org_governance(org_id,ip_enforce,ip_allowlist,updated_by,updated_at) VALUES (?,1,'[\"192.0.2.0/24\"]',?,'2090-01-01')").bind(org,user).run();
 const req=new Request(`https://test/channels/activity?orgId=${encodeURIComponent(org)}`,{headers:{'x-session-token':token}});
 const {requestContext}=await import('../src/requestContext.js');
 const response=await requestContext.run({ip:'198.51.100.1'},()=>handleChannels(req,env,new URL(req.url),{after:()=>{}}));
 expect(response.status).not.toBe(200);
 expect((await env.DB.prepare('SELECT role FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,user).first()).role).toBe('admin');
});

test('trusted allowed IP permits canonical recovery',async()=>{
 await env.DB.exec(schema.replace(/\n/g,' '));const org='personal:owner-allowed-ip',user='8275';
 await upsertUser(env.DB,{githubId:user,login:'allowedip',name:'Allowed'});await upsertMembership(env.DB,org,user,'admin');
 const token=await createSession(env.DB,user,'fixture');
 await env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at) VALUES (?,'2090-01-01',?,'2026-01-01')").bind(org,user).run();
 await env.DB.prepare("INSERT INTO org_governance(org_id,ip_enforce,ip_allowlist,updated_by,updated_at) VALUES (?,1,'[\"192.0.2.0/24\"]',?,'2090-01-01')").bind(org,user).run();
 const req=new Request(`https://test/channels/activity?orgId=${encodeURIComponent(org)}`,{headers:{'x-session-token':token}});
 const {requestContext}=await import('../src/requestContext.js');
 const response=await requestContext.run({ip:'192.0.2.5'},()=>handleChannels(req,env,new URL(req.url),{after:()=>{}}));
 expect(response.status).toBe(200);
 expect((await env.DB.prepare('SELECT role FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,user).first()).role).toBe('owner');
});

test('required SSO denial happens before legacy owner promotion',async()=>{
 await env.DB.exec(schema.replace(/\n/g,' '));const org='personal:owner-deny-sso',user='8276',at='2026-01-01T00:00:00.000Z';
 await upsertUser(env.DB,{githubId:user,login:'denysso',name:'Denied'});await upsertMembership(env.DB,org,user,'admin');
 await env.DB.prepare("UPDATE users SET email='user@example.test' WHERE github_id=?").bind(user).run();
 const token=await createSession(env.DB,user,'fixture');
 await env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at) VALUES (?,'2090-01-01',?,'2026-01-01')").bind(org,user).run();
 await env.DB.prepare("INSERT INTO org_domains(domain,org_id,verify_token,verified_at,created_by,created_at) VALUES ('example.test',?,'token',?,?,?)").bind(org,at,user,at).run();
 await env.DB.prepare("INSERT INTO sso_connections(id,org_id,provider,issuer,allowed_domains,status,created_by,created_at,updated_at) VALUES ('owner-sso',?,'oidc','https://example.test','[\"example.test\"]','active',?,?,?)").bind(org,user,at,at).run();
 await env.DB.prepare('INSERT INTO org_sso_policy(org_id,enforce,updated_at) VALUES (?,1,?)').bind(org,at).run();
 const req=new Request(`https://test/channels/activity?orgId=${encodeURIComponent(org)}`,{headers:{'x-session-token':token}});
 const response=await handleChannels(req,env,new URL(req.url),{after:()=>{}});
 expect(response.status).toBe(403);expect((await response.json()).code).toBe('sso-required');
 expect((await env.DB.prepare('SELECT role FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,user).first()).role).toBe('admin');
});

test('purge starting as the previous owner disappears cannot promote a new owner',async()=>{
 await env.DB.exec(schema.replace(/\n/g,' '));const org='personal:owner-purge-race',owner='8277',admin='8278';
 for(const [id,login,role] of [[owner,'existing','owner'],[admin,'replacement','admin']]){await upsertUser(env.DB,{githubId:id,login,name:login});await upsertMembership(env.DB,org,id,role)}
 const token=await createSession(env.DB,admin,'fixture');
 await env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at) VALUES (?,'2090-01-01',?,'2026-01-01')").bind(org,owner).run();
 let injected=false;const db={prepare:env.DB.prepare.bind(env.DB),batch:async statements=>{
  if(!injected){injected=true;await env.DB.prepare('DELETE FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,owner).run();await env.DB.prepare("UPDATE workspace_deletions SET purge_started_at='2026-01-01' WHERE org_id=?").bind(org).run()}
  return env.DB.batch(statements);
 }};
 const req=new Request(`https://test/channels/activity?orgId=${encodeURIComponent(org)}`,{headers:{'x-session-token':token}});
 const response=await handleChannels(req,{...env,DB:db},new URL(req.url),{after:()=>{}});
 expect(injected).toBe(true);expect(response.status).toBe(410);
 expect((await env.DB.prepare('SELECT role FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,admin).first()).role).toBe('admin');
});

test('cancelled deletion is reread rather than rejected by a stale cached due date',async()=>{
 await env.DB.exec(schema.replace(/\n/g,' '));const org='personal:owner-cancel-cache',user='8279';
 await upsertUser(env.DB,{githubId:user,login:'cancelcache',name:'Cache'});await upsertMembership(env.DB,org,user,'member');const token=await createSession(env.DB,user,'fixture');
 await env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at) VALUES (?,'2090-01-01',?,'2026-01-01')").bind(org,user).run();
 const {deletionDue}=await import('../src/workspaceDeletion.js');expect(await deletionDue(env.DB,org)).toBeTruthy();
 await env.DB.prepare('DELETE FROM workspace_deletions WHERE org_id=?').bind(org).run();
 const req=new Request(`https://test/channels/activity?orgId=${encodeURIComponent(org)}`,{headers:{'x-session-token':token}});
 expect((await handleChannels(req,env,new URL(req.url),{after:()=>{}})).status).toBe(200);
});

test('legacy raw session is upgraded before authorized deletion recovery',async()=>{
 await env.DB.exec(schema.replace(/\n/g,' '));const org='personal:owner-legacy-token',user='8280',token='legacy-owner-raw-token';
 await upsertUser(env.DB,{githubId:user,login:'legacytoken',name:'Legacy'});await upsertMembership(env.DB,org,user,'admin');
 await env.DB.prepare("INSERT INTO sessions(token,github_id,github_access_token,created_at,expires_at) VALUES (?,?,'email-auth','2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z')").bind(token,user).run();
 await env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at) VALUES (?,'2090-01-01',?,'2026-01-01')").bind(org,user).run();
 const req=new Request(`https://test/channels/activity?orgId=${encodeURIComponent(org)}`,{headers:{'x-session-token':token}});
 expect((await handleChannels(req,env,new URL(req.url),{after:()=>{}})).status).toBe(200);
 expect(await env.DB.prepare('SELECT 1 FROM sessions WHERE token=?').bind(token).first()).toBeNull();
 expect(await env.DB.prepare('SELECT 1 FROM sessions WHERE token=?').bind(await sessionKey(token)).first()).toBeTruthy();
 expect((await env.DB.prepare('SELECT role FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,user).first()).role).toBe('owner');
});

test('background caller using a stored key can recover an authorized owner',async()=>{
 await env.DB.exec(schema.replace(/\n/g,' '));const org='personal:owner-background',user='8281';
 await upsertUser(env.DB,{githubId:user,login:'background',name:'Background'});await upsertMembership(env.DB,org,user,'admin');
 const token=await createSession(env.DB,user,'fixture');await env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at) VALUES (?,'2090-01-01',?,'2026-01-01')").bind(org,user).run();
 const {sessionByKey}=await import('../src/db.js'),{policyDenial}=await import('../src/policy.js');
 const session=await sessionByKey(env.DB,await sessionKey(token));expect(await policyDenial(env,session,org)).toBeNull();
 expect((await env.DB.prepare('SELECT role FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,user).first()).role).toBe('owner');
});
