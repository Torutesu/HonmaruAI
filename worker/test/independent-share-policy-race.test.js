import {env} from 'cloudflare:test';
import {expect,test} from 'vitest';
import worker from '../src/index.js';
import {upsertUser,upsertMembership,createSession,sessionKey} from '../src/db.js';
import {createSkill} from '../src/harness/skills.js';
import {createSkillShare} from '../src/harness/skillShares.js';
import {forgetPolicies,policyDenial} from '../src/policy.js';
import {forgetGovernance,ipDenial} from '../src/governance.js';
import {getSession} from '../src/db.js';
import {ssoDenial} from '../src/sso.js';

test.each([['issue','workspace policy'],['import','workspace policy'],['issue','workspace idle'],['import','workspace idle'],['issue','mobile policy'],['import','mobile policy'],['issue','sso lifetime'],['import','sso lifetime']])('%s session %s expiry during audit blocks delivery',async(operation,mode)=>{
 const source='independent-policy-source',destination='independent-policy-destination',actor='9942';
 await upsertUser(env.DB,{githubId:actor,login:'policy-user',name:'User',locale:'en'});
 await upsertMembership(env.DB,source,actor,'member');await upsertMembership(env.DB,destination,actor,'member');
 const {skill}=await createSkill(env.DB,source,{name:'Procedure',description:'Private procedure',body:'Sensitive instructions',visibility:'private'},actor);
 const issued=await createSkillShare(env.DB,source,skill,actor,{confirmAnyoneWithLink:true});
 const target=operation==='issue'?source:destination;
 if(mode==='workspace policy')await env.DB.prepare('INSERT INTO org_session_policy(org_id,web_max_hours,updated_by,updated_at) VALUES(?,1,?,?)').bind(target,actor,new Date().toISOString()).run();
 if(mode==='workspace idle')await env.DB.prepare('INSERT INTO org_session_policy(org_id,idle_hours,updated_by,updated_at) VALUES(?,1,?,?)').bind(target,actor,new Date().toISOString()).run();
 if(mode==='mobile policy')await env.DB.prepare('INSERT INTO org_session_policy(org_id,mobile_max_hours,updated_by,updated_at) VALUES(?,1,?,?)').bind(target,actor,new Date().toISOString()).run();
 forgetPolicies();
 const token=await createSession(env.DB,actor,'test'),key=await sessionKey(token);
 if(mode==='sso lifetime')await env.DB.prepare("UPDATE sessions SET auth_method='sso',sso_org_id=? WHERE token=?").bind(target,key).run();
 if(mode==='mobile policy')await env.DB.prepare("UPDATE sessions SET client='ios' WHERE token=?").bind(key).run();
 let injected=false;
 const db={
  prepare(sql){const stmt=env.DB.prepare(sql);if(!sql.startsWith('INSERT INTO audit_events'))return stmt;
   return {bind(...args){const bound=stmt.bind(...args);return {async run(){
    if(!injected){injected=true;
     if(mode==='workspace idle')await env.DB.prepare('UPDATE sessions SET longest_idle_ms=7200000 WHERE token=?').bind(key).run();
     else await env.DB.prepare("UPDATE sessions SET created_at='2000-01-01T00:00:00.000Z' WHERE token=?").bind(key).run();
    }
    return bound.run();
   }}}};
  },batch:stmts=>env.DB.batch(stmts),
 };
 try {
  const path=operation==='issue'?`/skills/${skill.id}/shares`:`/skill-shares/${issued.token}/import`;
  const res=await worker.fetch(new Request(`https://example.com${path}`,{method:'POST',headers:{'x-session-token':token,'content-type':'application/json'},body:JSON.stringify({orgId:target,confirmAnyoneWithLink:true})}),{...env,DB:db},{waitUntil(){}});
  expect(injected).toBe(true);
  expect((await policyDenial(env,await getSession(env.DB,token),target))?.body.code).toBe(mode==='sso lifetime'?'sso-reauth':'session-policy');
  expect([401,403,409]).toContain(res.status);
  const body=await res.text();expect(body).not.toContain('Sensitive instructions');expect(body).not.toMatch(/skl_[a-f0-9]{64}/);
 } finally {forgetPolicies()}
});

test.each([['issue','sso'],['import','sso'],['issue','network'],['import','network']])('%s rechecks %s policy enforced during audit',async(operation,mode)=>{
 const source='independent-policy-source',destination='independent-policy-destination',actor='9942',email='policy-user@example.test';
 await upsertUser(env.DB,{githubId:actor,login:'policy-user',name:'User',locale:'en'});
 await env.DB.prepare('UPDATE users SET email=? WHERE github_id=?').bind(email,actor).run();
 await upsertMembership(env.DB,source,actor,'member');await upsertMembership(env.DB,destination,actor,'member');
 const {skill}=await createSkill(env.DB,source,{name:'Procedure',description:'Private procedure',body:'Sensitive instructions',visibility:'private'},actor);
 const issued=await createSkillShare(env.DB,source,skill,actor,{confirmAnyoneWithLink:true});
 const target=operation==='issue'?source:destination;
 const now=new Date().toISOString();
 if(mode==='sso'){
  await env.DB.prepare("INSERT INTO org_domains(domain,org_id,verify_token,verified_at,created_by,created_at) VALUES('example.test',?,'test',?,?,?)").bind(target,now,actor,now).run();
  await env.DB.prepare("INSERT INTO sso_connections(id,org_id,provider,issuer,allowed_domains,status,created_by,created_at,updated_at) VALUES('test-connection',?,'oidc','https://example.test','[\"example.test\"]','active',?,?,?)").bind(target,actor,now,now).run();
  await env.DB.prepare('INSERT INTO org_sso_policy(org_id,enforce,updated_at) VALUES(?,0,?)').bind(target,now).run();
 }
 forgetPolicies();forgetGovernance();
 const token=await createSession(env.DB,actor,'test');
 let injected=false;
 const db={prepare(sql){const stmt=env.DB.prepare(sql);if(!sql.startsWith('INSERT INTO audit_events'))return stmt;
   return {bind(...args){const bound=stmt.bind(...args);return {async run(){
    if(!injected){injected=true;
     if(mode==='sso')await env.DB.prepare('UPDATE org_sso_policy SET enforce=1 WHERE org_id=?').bind(target).run();
     else {await env.DB.prepare("INSERT INTO org_governance(org_id,ip_enforce,ip_allowlist,updated_by,updated_at) VALUES(?,1,'[\"192.0.2.0/24\"]',?,?)").bind(target,actor,now).run();forgetGovernance()}
    }
    return bound.run();
   }}}};
  },batch:stmts=>env.DB.batch(stmts)};
 try {
  const path=operation==='issue'?`/skills/${skill.id}/shares`:`/skill-shares/${issued.token}/import`;
  const res=await worker.fetch(new Request(`https://example.com${path}`,{method:'POST',headers:{'x-session-token':token,'content-type':'application/json','cf-connecting-ip':'203.0.113.7'},body:JSON.stringify({orgId:target,confirmAnyoneWithLink:true})}),{...env,DB:db},{waitUntil(){}});
  expect(injected).toBe(true);
  if(mode==='sso')expect((await ssoDenial(env,await getSession(env.DB,token),target))?.body.code).toBe('sso-required');
  else expect((await ipDenial(env,target,'203.0.113.7'))?.body.code).toBe('ip-not-allowed');
  expect([401,403,409]).toContain(res.status);
  const body=await res.text();expect(body).not.toContain('Sensitive instructions');expect(body).not.toMatch(/skl_[a-f0-9]{64}/);
 } finally {forgetPolicies();forgetGovernance()}
});

test.each([['issue','workspace policy'],['import','workspace policy'],['issue','sso'],['import','sso'],['issue','network'],['import','network']])('%s refuses to commit after %s changes',async(operation,mode)=>{
 const source='independent-policy-source',destination='independent-policy-destination',actor='9942';
 await upsertUser(env.DB,{githubId:actor,login:'policy-user',name:'User',locale:'en'});
 await env.DB.prepare("UPDATE users SET email='policy-user@example.test' WHERE github_id=?").bind(actor).run();
 await upsertMembership(env.DB,source,actor,'member');await upsertMembership(env.DB,destination,actor,'member');
 const {skill}=await createSkill(env.DB,source,{name:'Procedure',description:'Private procedure',body:'Sensitive instructions',visibility:'private'},actor);
 const issued=await createSkillShare(env.DB,source,skill,actor,{confirmAnyoneWithLink:true});
 const target=operation==='issue'?source:destination,now=new Date().toISOString();
 if(mode==='workspace policy')await env.DB.prepare('INSERT INTO org_session_policy(org_id,web_max_hours,updated_by,updated_at) VALUES(?,1,?,?)').bind(target,actor,now).run();
 if(mode==='sso'){
  await env.DB.prepare("INSERT INTO org_domains(domain,org_id,verify_token,verified_at,created_by,created_at) VALUES('example.test',?,'test',?,?,?)").bind(target,now,actor,now).run();
  await env.DB.prepare("INSERT INTO sso_connections(id,org_id,provider,issuer,allowed_domains,status,created_by,created_at,updated_at) VALUES('test-connection',?,'oidc','https://example.test','[\"example.test\"]','active',?,?,?)").bind(target,actor,now,now).run();
  await env.DB.prepare('INSERT INTO org_sso_policy(org_id,enforce,updated_at) VALUES(?,0,?)').bind(target,now).run();
 }
 forgetPolicies();forgetGovernance();
 const token=await createSession(env.DB,actor,'test'),key=await sessionKey(token);
 let armed=false,injected=false;
 const db={prepare(sql){if((operation==='issue'&&sql.startsWith('INSERT INTO hx_skill_shares'))||(operation==='import'&&sql.startsWith('INSERT INTO hx_skills ')))armed=true;return env.DB.prepare(sql)},
  async batch(stmts){
   if(armed&&!injected){injected=true;
    if(mode==='workspace policy')await env.DB.prepare("UPDATE sessions SET created_at='2000-01-01T00:00:00.000Z' WHERE token=?").bind(key).run();
    if(mode==='sso')await env.DB.prepare('UPDATE org_sso_policy SET enforce=1 WHERE org_id=?').bind(target).run();
    if(mode==='network'){await env.DB.prepare("INSERT INTO org_governance(org_id,ip_enforce,ip_allowlist,updated_by,updated_at) VALUES(?,1,'[\"192.0.2.0/24\"]',?,?)").bind(target,actor,now).run();forgetGovernance()}
   }
   return env.DB.batch(stmts);
  }};
 try {
  const path=operation==='issue'?`/skills/${skill.id}/shares`:`/skill-shares/${issued.token}/import`;
  const res=await worker.fetch(new Request(`https://example.com${path}`,{method:'POST',headers:{'x-session-token':token,'content-type':'application/json','cf-connecting-ip':'203.0.113.7'},body:JSON.stringify({orgId:target,confirmAnyoneWithLink:true})}),{...env,DB:db},{waitUntil(){}});
  expect(injected).toBe(true);expect([401,403,404,409]).toContain(res.status);
  const count=operation==='issue'?(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skill_shares WHERE skill_id=?').bind(skill.id).first()).n:(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skills WHERE org_id=?').bind(destination).first()).n;
  expect(count).toBe(operation==='issue'?1:0);
 } finally {forgetPolicies();forgetGovernance()}
});

test.each([
 ['issue','sso policy'],['import','sso policy'],['issue','sso connections'],['import','sso connections'],['issue','verified domains'],['import','verified domains'],
])('%s fails closed when %s cannot be read during policy proof',async(operation,failedRead)=>{
 const source='independent-policy-source',destination='independent-policy-destination',actor='9942',now=new Date().toISOString();
 await upsertUser(env.DB,{githubId:actor,login:'policy-user',name:'User',locale:'en'});
 await env.DB.prepare("UPDATE users SET email='policy-user@example.test' WHERE github_id=?").bind(actor).run();
 await upsertMembership(env.DB,source,actor,'member');await upsertMembership(env.DB,destination,actor,'member');
 const {skill}=await createSkill(env.DB,source,{name:'Procedure',description:'Private procedure',body:'Sensitive instructions',visibility:'private'},actor);
 const issued=await createSkillShare(env.DB,source,skill,actor,{confirmAnyoneWithLink:true});
 const target=operation==='issue'?source:destination;
 await env.DB.prepare("INSERT INTO org_domains(domain,org_id,verify_token,verified_at,created_by,created_at) VALUES('example.test',?,'test',?,?,?)").bind(target,now,actor,now).run();
 await env.DB.prepare("INSERT INTO sso_connections(id,org_id,provider,issuer,allowed_domains,status,created_by,created_at,updated_at) VALUES('test-connection',?,'oidc','https://example.test','[\"example.test\"]','active',?,?,?)").bind(target,actor,now,now).run();
 await env.DB.prepare('INSERT INTO org_sso_policy(org_id,enforce,updated_at) VALUES(?,0,?)').bind(target,now).run();
 forgetPolicies();forgetGovernance();
 const token=await createSession(env.DB,actor,'test');
 let armed=false,injected=false;
 const targetPrefix={
  'sso policy':'SELECT * FROM org_sso_policy WHERE',
  'sso connections':'SELECT * FROM sso_connections WHERE',
  'verified domains':'SELECT domain FROM org_domains WHERE',
 }[failedRead];
 const db={prepare(sql){const stmt=env.DB.prepare(sql);
  if(sql.startsWith('SELECT json_object('))return {bind(...args){const bound=stmt.bind(...args);return {async first(){
   if(!armed){armed=true;await env.DB.prepare('UPDATE org_sso_policy SET enforce=1 WHERE org_id=?').bind(target).run()}
   return bound.first();
  }}}};
  if(armed&&sql.startsWith(targetPrefix))return {bind(){return {first:async()=>{injected=true;throw Error('read unavailable')},all:async()=>{injected=true;throw Error('read unavailable')}}}};
  return stmt;
 },batch:stmts=>env.DB.batch(stmts)};
 try {
  const path=operation==='issue'?`/skills/${skill.id}/shares`:`/skill-shares/${issued.token}/import`;
  const res=await worker.fetch(new Request(`https://example.com${path}`,{method:'POST',headers:{'x-session-token':token,'content-type':'application/json'},body:JSON.stringify({orgId:target,confirmAnyoneWithLink:true})}),{...env,DB:db},{waitUntil(){}});
  expect(injected).toBe(true);
  expect((await ssoDenial(env,await getSession(env.DB,token),target))?.body.code).toBe('sso-required');
  expect(res.status).not.toBe(201);
  const count=operation==='issue'?(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skill_shares WHERE skill_id=?').bind(skill.id).first()).n:(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skills WHERE org_id=?').bind(destination).first()).n;
  expect(count).toBe(operation==='issue'?1:0);
 } finally {forgetPolicies();forgetGovernance()}
});

test.each(['issue','import'])('%s fails closed if legacy SSO migration cannot be read during policy proof',async operation=>{
 const source='independent-policy-source',destination='independent-policy-destination',actor='9942',now=new Date().toISOString();
 await upsertUser(env.DB,{githubId:actor,login:'policy-user',name:'User',locale:'en'});
 await env.DB.prepare("UPDATE users SET email='policy-user@example.test' WHERE github_id=?").bind(actor).run();
 await upsertMembership(env.DB,source,actor,'member');await upsertMembership(env.DB,destination,actor,'member');
 const {skill}=await createSkill(env.DB,source,{name:'Procedure',description:'Private procedure',body:'Sensitive instructions',visibility:'private'},actor);
 const issued=await createSkillShare(env.DB,source,skill,actor,{confirmAnyoneWithLink:true});
 const target=operation==='issue'?source:destination;
 await env.DB.prepare("INSERT INTO org_domains(domain,org_id,verify_token,verified_at,created_by,created_at) VALUES('example.test',?,'test',?,?,?)").bind(target,now,actor,now).run();
 forgetPolicies();forgetGovernance();const token=await createSession(env.DB,actor,'test');
 let armed=false,failed=false;
 const db={prepare(sql){const stmt=env.DB.prepare(sql);
  if(sql.startsWith('SELECT json_object('))return {bind(...args){const bound=stmt.bind(...args);return {async first(){
   if(!armed){armed=true;await env.DB.prepare("INSERT INTO org_sso(org_id,provider,issuer,client_id,client_secret,allowed_domains,enforce,status,created_by,updated_at) VALUES(?,'oidc','https://example.test','fake','fake','[\"example.test\"]',1,'active',?,?)").bind(target,actor,now).run()}
   return bound.first();
  }}}};
  if(armed&&sql.startsWith('SELECT * FROM org_sso WHERE'))return {bind(){return {first:async()=>{failed=true;throw Error('legacy unavailable')}}}};
  return stmt;
 },batch:stmts=>env.DB.batch(stmts)};
 try {
  const path=operation==='issue'?`/skills/${skill.id}/shares`:`/skill-shares/${issued.token}/import`;
  const res=await worker.fetch(new Request(`https://example.com${path}`,{method:'POST',headers:{'x-session-token':token,'content-type':'application/json'},body:JSON.stringify({orgId:target,confirmAnyoneWithLink:true})}),{...env,DB:db},{waitUntil(){}});
  expect(failed).toBe(true);
  expect((await ssoDenial(env,await getSession(env.DB,token),target))?.body.code).toBe('sso-required');
  expect(res.status).not.toBe(201);
 } finally {forgetPolicies();forgetGovernance()}
});

test.each([
 ['issue','scim','before commit'],['import','scim','before commit'],['issue','session','before commit'],['import','session','before commit'],
 ['issue','scim','before delivery'],['import','scim','before delivery'],['issue','session','before delivery'],['import','session','before delivery'],
])('%s blocks %s after a failed individual read %s',async(operation,kind,phase)=>{
 const source='independent-policy-source',destination='independent-policy-destination',actor='9942',now=new Date().toISOString();
 await upsertUser(env.DB,{githubId:actor,login:'policy-user',name:'User',locale:'en'});
 await upsertMembership(env.DB,source,actor,'member');await upsertMembership(env.DB,destination,actor,'member');
 const {skill}=await createSkill(env.DB,source,{name:'Procedure',description:'Private procedure',body:'Sensitive instructions',visibility:'private'},actor);
 const issued=await createSkillShare(env.DB,source,skill,actor,{confirmAnyoneWithLink:true});
 const target=operation==='issue'?source:destination;
 forgetPolicies();forgetGovernance();
 const token=await createSession(env.DB,actor,'test'),key=await sessionKey(token);
 let armed=false,injected=false,failed=false;
 const invalidate=async()=>{
  if(injected)return;injected=true;
  if(kind==='scim')await env.DB.prepare("INSERT INTO scim_users(org_id,id,user_github_id,user_name,active,created_at,updated_at) VALUES(?,'fake-scim',?,'policy-user',0,?,?)").bind(target,actor,now,now).run();
  else await env.DB.prepare("INSERT INTO session_workspaces(token,org_id,last_seen_at,ended_at) VALUES(?,?,?,?) ON CONFLICT(token,org_id) DO UPDATE SET ended_at=excluded.ended_at").bind(key,target,now,now).run();
 };
 const db={prepare(sql){const stmt=env.DB.prepare(sql);
  if(phase==='before commit'&&sql.startsWith('SELECT json_object('))return {bind(...args){const bound=stmt.bind(...args);return {async first(){if(!armed){armed=true;await invalidate()}return bound.first()}}}};
  if(phase==='before delivery'&&sql.startsWith('INSERT INTO audit_events'))return {bind(...args){const bound=stmt.bind(...args);return {async run(){if(!armed){armed=true;await invalidate()}return bound.run()}}}};
  const targetRead=kind==='scim'?sql.startsWith('SELECT 1 FROM scim_users WHERE'):(sql.startsWith('SELECT last_seen_at, ended_at FROM session_workspaces')||sql.includes('AS deletion_due')&&sql.includes('JOIN session_workspaces'));
  if(armed&&targetRead)return {bind(){return {first:async()=>{failed=true;throw Error('read unavailable')}}}};
  return stmt;
 },batch:stmts=>env.DB.batch(stmts)};
 try {
  const path=operation==='issue'?`/skills/${skill.id}/shares`:`/skill-shares/${issued.token}/import`;
  const res=await worker.fetch(new Request(`https://example.com${path}`,{method:'POST',headers:{'x-session-token':token,'content-type':'application/json'},body:JSON.stringify({orgId:target,confirmAnyoneWithLink:true})}),{...env,DB:db},{waitUntil(){}});
  expect(injected).toBe(true);expect(failed).toBe(true);expect(res.status).not.toBe(201);
  const body=await res.text();expect(body).not.toContain('Sensitive instructions');expect(body).not.toMatch(/skl_[a-f0-9]{64}/);
  if(phase==='before commit'){
   const count=operation==='issue'?(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skill_shares WHERE skill_id=?').bind(skill.id).first()).n:(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skills WHERE org_id=?').bind(destination).first()).n;
   expect(count).toBe(operation==='issue'?1:0);
  }
 } finally {forgetPolicies();forgetGovernance()}
});
