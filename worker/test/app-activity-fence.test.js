import {env} from 'cloudflare:test';
import {beforeEach,expect,test} from 'vitest';
import schema from '../schema.sql?raw';
import {upsertUser,upsertMembership,createSession,sessionKey} from '../src/db.js';
import {createApp} from '../src/harness/apps.js';
import {addRow} from '../src/harness/tables.js';
import {appConversation} from '../src/harness/appConversations.js';
import {appActivity,readAppActivity,activityProofRequiresIp,appActivityProof} from '../src/harness/appActivity.js';
import {caller,handleChannels} from '../src/channelRoutes.js';
import {appNotifications} from '../src/harness/appConversationFeatures.js';
import {currentSkillPolicy} from '../src/harness/skillPolicyProof.js';
import {postMessage} from '../src/channels.js';
import {handleHarness} from '../src/harness/routes.js';
const org='personal:activity-fence';let owner,member,token,app,row;
beforeEach(async()=>{
 await env.DB.exec(schema.replace(/\n/g,' '));
 for(const [id,login,role] of [['8101','owner','admin'],['8102','member','member'],['8103','guest','guest']]){
  await upsertUser(env.DB,{githubId:id,login,name:login});await upsertMembership(env.DB,org,id,role);
 }
 owner='8101';member='8102';token=await createSession(env.DB,member,'fixture');
 ({app}=await createApp(env.DB,{orgId:org,by:owner,name:'Restricted app',columns:[{id:'title',name:'Title',type:'text'}]}));
 ({row}=await addRow(env.DB,org,app.tableId,{title:'Entry'},owner));
});
async function add(scope={},body='Secret activity'){
 const sent=await appConversation(env.DB,org,owner,app.id,{...scope,body,requestId:`activity_${crypto.randomUUID()}`},true);
 await env.DB.prepare("INSERT INTO hx_app_notifications(org_id,app_id,message_id,user_id,kind) VALUES (?,?,?,?,'mention')").bind(org,app.id,sent.messageId,member).run();
 return sent.messageId;
}
async function proof(){
 const key=await sessionKey(token),session=await env.DB.prepare('SELECT created_at FROM sessions WHERE token=?').bind(key).first();
 const m=await env.DB.prepare('SELECT created_at FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,member).first();
 const p=await currentSkillPolicy(env,org,member,key);return {memberSince:m.created_at,key,sessionCreatedAt:session.created_at,fingerprint:p.fingerprint,ssoDeadline:p.ssoDeadline};
}
function beforeRead(change){let injected=false;return {get injected(){return injected},db:{prepare(sql){const stmt=env.DB.prepare(sql);if(!sql.startsWith('SELECT n.message_id,'))return stmt;return {bind(...args){const bound=stmt.bind(...args);return {async all(){injected=true;await change();return bound.all()}}}}},batch:env.DB.batch.bind(env.DB)}}}

test.each(['membership','session','app','row','table-sharing','sso','network','session-policy','workspace-deletion'])('the final Activity read withholds app content if %s changes',async change=>{
 await add({tableId:app.tableId,rowId:row.id});const p=await proof();
 const changes={
  membership:()=>env.DB.prepare('DELETE FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,member).run(),
  session:()=>env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(p.key).run(),
  app:()=>env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES (?,?,'private',1)").bind(org,app.id).run(),
  row:()=>env.DB.prepare('DELETE FROM hx_rows WHERE org_id=? AND table_id=? AND id=?').bind(org,app.tableId,row.id).run(),
  'table-sharing':async()=>{const other=await createApp(env.DB,{orgId:org,by:owner,name:'Private link',columns:[{name:'Title',type:'text'}]});await env.DB.prepare('UPDATE hx_apps SET table_id=? WHERE id=?').bind(app.tableId,other.app.id).run();await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES (?,?,'private',1)").bind(org,other.app.id).run()},
  sso:()=>env.DB.prepare("INSERT INTO org_sso_policy(org_id,enforce,updated_at) VALUES (?,1,'2090-01-01')").bind(org).run(),
  network:()=>env.DB.prepare("INSERT INTO org_governance(org_id,ip_enforce,ip_allowlist,updated_by,updated_at) VALUES (?,1,'[\"192.0.2.0/24\"]',?,'2090-01-01')").bind(org,owner).run(),
  'session-policy':()=>env.DB.prepare("INSERT INTO org_session_policy(org_id,web_max_hours,updated_by,updated_at) VALUES (?,1,?,'2090-01-01')").bind(org,owner).run(),
  'workspace-deletion':()=>env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at) VALUES (?,'2090-01-01',?,'2026-01-01')").bind(org,owner).run(),
 };
 const injected=beforeRead(changes[change]);expect(await appActivity(injected.db,org,member,p)).toEqual([]);expect(injected.injected).toBe(true);
});

test('source room denial hides app-level activity but not an independent record conversation',async()=>{
 await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,private,created_by,created_at) VALUES (?,'private','Private',1,?,'2026-01-01')").bind(org,owner).run();
 await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES (?,'b:private','owner','2026-01-01'),(?,'b:private','member','2026-01-01')").bind(org,org).run();
 const root=(await postMessage(env.DB,{orgId:org,key:'b:private',authorLogin:'owner',body:'Source'})).row;
 await env.DB.prepare("INSERT INTO hx_app_conversation_sources(org_id,app_id,channel,thread_id,created_by) VALUES (?,?,'b:private',?,?)").bind(org,app.id,root.id,owner).run();
 await add({},'App note');await add({tableId:app.tableId,rowId:row.id},'Record note');const p=await proof();
 expect((await appActivity(env.DB,org,member,p)).map(x=>x.message.body).sort()).toEqual(['App note','Record note']);
 const injected=beforeRead(()=>env.DB.prepare("DELETE FROM conversation_members WHERE org_id=? AND channel='b:private' AND login='member'").bind(org).run());
 expect((await appActivity(injected.db,org,member,p)).map(x=>x.message.body)).toEqual(['Record note']);
});

test('malformed record scope cannot disclose app notifications',async()=>{
 await add({},'Unrelated');const bad=await add({},'Bad scope');
 await env.DB.prepare("UPDATE hx_app_messages SET table_id=? WHERE sequence=?").bind(app.tableId,bad).run();
 expect((await appActivity(env.DB,org,member,await proof())).map(x=>x.message.body)).toEqual(['Unrelated']);
});

test('guest and mismatched or missing request proof cannot receive app activity',async()=>{
 await add();const p=await proof();
 expect(await appActivity(env.DB,org,'8103',p)).toEqual([]);
 expect(await appActivity(env.DB,org,member,null)).toEqual([]);
 expect(await appActivity(env.DB,org,member,{...p,memberSince:'other'})).toEqual([]);
 expect(activityProofRequiresIp('{"network":{"enforce":1}}')).toBe(true);
 expect(activityProofRequiresIp('not-json')).toBe(true);
});

test('revocation between list and marking read prevents the update and response key',async()=>{
 const id=await add();let injected=false;
 const db={prepare:env.DB.prepare.bind(env.DB),batch:async statements=>{injected=true;await env.DB.prepare('DELETE FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,member).run();return env.DB.batch(statements)}};
 expect(await readAppActivity(db,org,member,[`a:${id}`])).toEqual([]);expect(injected).toBe(true);
 expect((await env.DB.prepare('SELECT read_at FROM hx_app_notifications WHERE message_id=? AND user_id=?').bind(id,member).first()).read_at).toBeNull();
});


test.each(['session','policy','deletion'])('proof is checked again inside the read update after %s revocation',async change=>{
 const id=await add();const p=await proof();let injected=false;
 const db={prepare:env.DB.prepare.bind(env.DB),batch:async statements=>{
  injected=true;
  if(change==='session')await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(p.key).run();
  else if(change==='policy')await env.DB.prepare("INSERT INTO org_session_policy(org_id,web_max_hours,updated_by,updated_at) VALUES (?,1,?,'2090-01-01')").bind(org,owner).run();
  else await env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at) VALUES (?,'2090-01-01',?,'2026-01-01')").bind(org,owner).run();
  return env.DB.batch(statements);
 }};
 expect(await readAppActivity(db,org,member,[`a:${id}`],p)).toEqual([]);expect(injected).toBe(true);
 expect((await env.DB.prepare('SELECT read_at FROM hx_app_notifications WHERE message_id=? AND user_id=?').bind(id,member).first()).read_at).toBeNull();
});

test('mixed visible and inaccessible record notifications mark only the visible item',async()=>{
 const visible=await add({},'Allowed');const hidden=await add({tableId:app.tableId,rowId:row.id},'Deleted row');
 await env.DB.prepare('DELETE FROM hx_rows WHERE org_id=? AND table_id=? AND id=?').bind(org,app.tableId,row.id).run();
 const p=await proof();expect((await appActivity(env.DB,org,member,p)).map(x=>x.message.body)).toEqual(['Allowed']);
 expect(await readAppActivity(env.DB,org,member,[`a:${visible}`,`a:${hidden}`],p)).toEqual([`a:${visible}`]);
 const results=await env.DB.prepare('SELECT message_id,read_at FROM hx_app_notifications WHERE user_id=? ORDER BY message_id').bind(member).all();
 expect(results.results.map(r=>Boolean(r.read_at))).toEqual([true,false]);
});

test('deleting the source root suppresses app-level notifications',async()=>{
 await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,private,created_by,created_at) VALUES (?,'private','Private',1,?,'2026-01-01')").bind(org,owner).run();
 await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES (?,'b:private','owner','2026-01-01'),(?,'b:private','member','2026-01-01')").bind(org,org).run();
 const root=(await postMessage(env.DB,{orgId:org,key:'b:private',authorLogin:'owner',body:'Source'})).row;
 await env.DB.prepare("INSERT INTO hx_app_conversation_sources(org_id,app_id,channel,thread_id,created_by) VALUES (?,?,'b:private',?,?)").bind(org,app.id,root.id,owner).run();
 await add({},'App note');const p=await proof();expect(await appActivity(env.DB,org,member,p)).toHaveLength(1);
 const injected=beforeRead(()=>env.DB.prepare("UPDATE channel_messages SET deleted_at='2026-01-01' WHERE org_id=? AND id=?").bind(org,root.id).run());
 expect(await appActivity(injected.db,org,member,p)).toEqual([]);
});


test('app bell does not return notification content when ACL changes before the final select',async()=>{
 await add({},'Secret');const p=await proof();
 const injected=beforeRead(()=>env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES (?,?,'private',1)").bind(org,app.id).run());
 expect(await appNotifications(injected.db,org,member,app.id,null,false,p)).toEqual({items:[],marked:false});expect(injected.injected).toBe(true);
});

test('app bell cannot mark a now-inaccessible row as read and does not expose it',async()=>{
 const id=await add({tableId:app.tableId,rowId:row.id});const p=await proof();let injected=false;
 const db={prepare:env.DB.prepare.bind(env.DB),batch:async statements=>{injected=true;await env.DB.prepare('DELETE FROM hx_rows WHERE org_id=? AND table_id=? AND id=?').bind(org,app.tableId,row.id).run();return env.DB.batch(statements)}};
 expect(await appNotifications(db,org,member,app.id,{messageId:id},true,p)).toEqual({items:[],marked:false});expect(injected).toBe(true);
 expect((await env.DB.prepare('SELECT read_at FROM hx_app_notifications WHERE message_id=?').bind(id).first()).read_at).toBeNull();
});

test('app bell filters by app before applying its 100 item limit',async()=>{
 const my=await add({},'My app');
 const other=(await createApp(env.DB,{orgId:org,by:owner,name:'Other',columns:[{name:'Name',type:'text'}]})).app;
 let oldest;
 for(let i=0;i<101;i++){
  const sent=await appConversation(env.DB,org,owner,other.id,{body:`Other ${i}`,requestId:`other_activity_${String(i).padStart(4,'0')}`},true);
  await env.DB.prepare("INSERT INTO hx_app_notifications(org_id,app_id,message_id,user_id,kind) VALUES (?,?,?,?,'mention')").bind(org,other.id,sent.messageId,member).run();
  if(i===0)oldest=sent.messageId;
 }
 const p=await proof();const myItems=await appNotifications(env.DB,org,member,app.id,null,false,p);
 expect(myItems.items.map(r=>r.messageId)).toEqual([my]);
 const otherItems=await appNotifications(env.DB,org,member,other.id,null,false,p);expect(otherItems.items).toHaveLength(100);
 const req=new Request('https://test/channels/read',{method:'POST',headers:{'x-session-token':token,'content-type':'application/json'},body:JSON.stringify({orgId:org,channel:'activity',items:[`a:${oldest}`]})});
 const response=await handleChannels(req,env,new URL(req.url),{after:()=>{}});expect((await response.json()).items).toEqual([`a:${oldest}`]);
 const marked=await appNotifications(env.DB,org,member,other.id,{messageId:oldest},true,p);expect(marked.marked).toBe(true);
 expect((await env.DB.prepare('SELECT read_at FROM hx_app_notifications WHERE message_id=?').bind(oldest).first()).read_at).toBeTruthy();
});


test.each(['session','app','row'])('bell POST rechecks %s after the relay await before returning bodies',async change=>{
 const id=await add({tableId:app.tableId,rowId:row.id});const key=await sessionKey(token);let delivered=false;
 const fakeEnv={...env,ORG_RELAY:{idFromName:()=>'',get:()=>({fetch:async()=>{
  delivered=true;
  if(change==='session')await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(key).run();
  if(change==='app')await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES (?,?,'private',1)").bind(org,app.id).run();
  if(change==='row')await env.DB.prepare('DELETE FROM hx_rows WHERE org_id=? AND table_id=? AND id=?').bind(org,app.tableId,row.id).run();
  return new Response('{}');
 }})}};
 const req=new Request(`https://test/apps/${app.id}/conversation-notifications`,{method:'POST',headers:{'x-session-token':token,'content-type':'application/json'},body:JSON.stringify({orgId:org,messageId:id})});
 const response=await handleHarness(req,fakeEnv,new URL(req.url));
 expect(delivered).toBe(true);expect(await response.text()).not.toContain('Secret activity');
});


test('bell suppresses relay if access is revoked between read update and announcement',async()=>{
 const id=await add({tableId:app.tableId,rowId:row.id});let count=0,delivered=false;
 const db={prepare(sql){
  const stmt=env.DB.prepare(sql);if(!sql.startsWith('SELECT n.message_id,'))return stmt;
  return {bind(...args){const bound=stmt.bind(...args);return {async all(){
   if(++count===3)await env.DB.prepare('DELETE FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,member).run();
   return bound.all();
  }}}};
 },batch:env.DB.batch.bind(env.DB)};
 const fakeEnv={...env,DB:db,ORG_RELAY:{idFromName:()=>'',get:()=>({fetch:async()=>{delivered=true;return new Response('{}')}})}};
 const req=new Request(`https://test/apps/${app.id}/conversation-notifications`,{method:'POST',headers:{'x-session-token':token,'content-type':'application/json'},body:JSON.stringify({orgId:org,messageId:id})});
 const response=await handleHarness(req,fakeEnv,new URL(req.url));
 expect(count).toBeGreaterThanOrEqual(3);expect(delivered).toBe(false);expect(await response.text()).not.toContain('Secret activity');
});


test('workspace owner retains notification access during a cancellable deletion',async()=>{
 await env.DB.prepare("UPDATE memberships SET role='owner' WHERE org_id=? AND user_github_id=?").bind(org,member).run();
 await add({},'Owner note');const p=await proof();
 const injected=beforeRead(()=>env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at) VALUES (?,'2090-01-01',?,'2026-01-01')").bind(org,member).run());
 expect((await appActivity(injected.db,org,member,p)).map(x=>x.message.body)).toEqual(['Owner note']);
});


async function prepareLegacyAdmin(){
 await env.DB.prepare("UPDATE memberships SET role='member' WHERE org_id=? AND user_github_id=?").bind(org,owner).run();
 await env.DB.prepare("UPDATE memberships SET role='admin' WHERE org_id=? AND user_github_id=?").bind(org,member).run();
 await add({},'Legacy owner note');
 const request=new Request('https://test/channels/activity',{headers:{'x-session-token':token}});
 return caller(env,request,org,{withMembership:true});
}

test('the canonical legacy owner promotion runs before a concurrent deletion reservation',async()=>{
 const who=await prepareLegacyAdmin();const p=await appActivityProof(env,org,who);expect(p).toBeTruthy();
 expect((await env.DB.prepare('SELECT role FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,member).first()).role).toBe('owner');
 const injected=beforeRead(()=>env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at) VALUES (?,'2090-01-01',?,'2026-01-01')").bind(org,member).run());
 expect((await appActivity(injected.db,org,member,p)).map(x=>x.message.body)).toEqual(['Legacy owner note']);
});

test('owner promotion respects another owner added concurrently',async()=>{
 const who=await prepareLegacyAdmin();let injected=false;
 const db={prepare(sql){
  const stmt=env.DB.prepare(sql);if(!sql.startsWith("SELECT 1 FROM memberships WHERE org_id = ?1 AND role = 'owner'"))return stmt;
  return {bind(...args){const bound=stmt.bind(...args);return {async first(){
   injected=true;await env.DB.prepare("UPDATE memberships SET role='owner' WHERE org_id=? AND user_github_id=?").bind(org,owner).run();return bound.first();
  }}}};
 },batch:env.DB.batch.bind(env.DB)};
 const p=await appActivityProof({...env,DB:db},org,who);expect(p).toBeTruthy();expect(injected).toBe(true);
 expect((await env.DB.prepare('SELECT role FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,member).first()).role).toBe('admin');
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE org_id=? AND role='owner'").bind(org).first()).n).toBe(1);
});

test('membership removed during legacy owner promotion is never revived or delivered',async()=>{
 const who=await prepareLegacyAdmin();let injected=false;
 const db={prepare(sql){
  const stmt=env.DB.prepare(sql);if(!sql.startsWith("UPDATE memberships SET role = 'owner'"))return stmt;
  return {bind(...args){const bound=stmt.bind(...args);return {async run(){
   injected=true;await env.DB.prepare('DELETE FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,member).run();return bound.run();
  }}}};
 },batch:env.DB.batch.bind(env.DB)};
 const p=await appActivityProof({...env,DB:db},org,who);expect(injected).toBe(true);
 expect(await env.DB.prepare('SELECT role FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,member).first()).toBeNull();
 expect(p?await appActivity(env.DB,org,member,p):[]).toEqual([]);
});


test('activity read rechecks app keys in the delayed relay and preserves channel keys',async()=>{
 const id=await add();const pending=[];let deliveries=[];
 const fakeEnv={...env,ORG_RELAY:{idFromName:()=>'',get:()=>({fetch:async(_url,options)=>{deliveries=JSON.parse(options.body).deliveries;return new Response('{}')}})}};
 const req=new Request('https://test/channels/read',{method:'POST',headers:{'x-session-token':token,'content-type':'application/json'},body:JSON.stringify({orgId:org,channel:'activity',items:['m:ordinary',`a:${id}`]})});
 const response=await handleChannels(req,fakeEnv,new URL(req.url),{after:fn=>pending.push(fn)});
 expect((await response.json()).items).toEqual(['m:ordinary',`a:${id}`]);
 await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(await sessionKey(token)).run();
 await Promise.all(pending.map(fn=>fn()));
 expect(JSON.stringify(deliveries)).toContain('m:ordinary');expect(JSON.stringify(deliveries)).not.toContain(`a:${id}`);
});

test('activity read removes a revoked app key from the HTTP response while preserving channel keys',async()=>{
 const id=await add();let count=0;
 const db={prepare(sql){const stmt=env.DB.prepare(sql);if(!sql.startsWith('SELECT n.message_id,'))return stmt;
  return {bind(...args){const bound=stmt.bind(...args);return {async all(){
   if(++count===2)await env.DB.prepare('DELETE FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,member).run();
   return bound.all();
  }}}};
 },batch:env.DB.batch.bind(env.DB)};
 const req=new Request('https://test/channels/read',{method:'POST',headers:{'x-session-token':token,'content-type':'application/json'},body:JSON.stringify({orgId:org,channel:'activity',items:['m:ordinary',`a:${id}`]})});
 const response=await handleChannels(req,{...env,DB:db},new URL(req.url),{after:()=>{}});
 const body=await response.json();expect(body.items).toEqual(['m:ordinary']);expect(body.appActivityUnavailable).toBe(true);
});


test('activity returns an explicit partial status when app policy verification fails',async()=>{
 await add();let injected=false;
 const db={prepare(sql){
  if(sql.startsWith('SELECT json_object(')){injected=true;throw new Error('policy read unavailable')}
  return env.DB.prepare(sql);
 },batch:env.DB.batch.bind(env.DB)};
 const req=new Request(`https://test/channels/activity?orgId=${encodeURIComponent(org)}`,{headers:{'x-session-token':token}});
 const response=await handleChannels(req,{...env,DB:db},new URL(req.url),{after:()=>{}});
 const body=await response.json();expect(response.status).toBe(200);expect(injected).toBe(true);expect(body.appActivityUnavailable).toBe(true);expect(body.items.filter(x=>x.app)).toEqual([]);
});


test('concurrent loss of the previous owner fails closed until the next canonical promotion',async()=>{
 const who=await prepareLegacyAdmin();
 await env.DB.prepare("UPDATE memberships SET role='owner' WHERE org_id=? AND user_github_id=?").bind(org,owner).run();
 const p=await appActivityProof(env,org,who);
 const injected=beforeRead(async()=>{
  await env.DB.prepare('DELETE FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,owner).run();
  await env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at) VALUES (?,'2090-01-01',?,'2026-01-01')").bind(org,member).run();
 });
 expect(await appActivity(injected.db,org,member,p)).toEqual([]);
 const request=new Request('https://test/channels/activity',{headers:{'x-session-token':token}});
 const again=await caller(env,request,org,{withMembership:true});expect(again.denied).toBeUndefined();
 const refreshed=await appActivityProof(env,org,again);
 expect((await appActivity(env.DB,org,member,refreshed)).map(x=>x.message.body)).toEqual(['Legacy owner note']);
});
