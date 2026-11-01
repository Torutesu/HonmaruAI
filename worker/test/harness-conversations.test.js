import {env} from 'cloudflare:test';
import {beforeEach,expect,test,vi} from 'vitest';
import schema from '../schema.sql?raw';
import worker from '../src/index.js';
import {createSession,upsertUser,upsertMembership} from '../src/db.js';
import {createApp} from '../src/harness/apps.js';
import {addRow} from '../src/harness/tables.js';
const org='personal:conversation';let owner,member,guest,other,app,row;
const pendingBackground=[];
const testContext={waitUntil(work){pendingBackground.push(Promise.resolve(work));}};
async function fetchWorker(request){
 const response=await worker.fetch(request,env,testContext);
 while(pendingBackground.length){
  const settled=await Promise.allSettled(pendingBackground.splice(0));
  const failed=settled.find(result=>result.status==='rejected');
  if(failed)throw failed.reason;
 }
 return response;
}
const request=(method,token,input={},target=app.id)=>fetchWorker(new Request('https://test/apps/'+target+'/conversation'+(method==='GET'?'?'+new URLSearchParams({orgId:org,...input}):''),{method,headers:{'x-session-token':token,'content-type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify({orgId:org,...input})})}));
beforeEach(async()=>{
 await env.DB.exec(schema.replace(/\n/g,' '));
 const tokens=[];
 for(const [id,role] of [['9201','admin'],['9202','member'],['9203','guest'],['9204','member']]){await upsertUser(env.DB,{githubId:id,login:'user'+id,name:'User '+id});await upsertMembership(env.DB,id==='9204'?'personal:other':org,id,role);tokens.push(await createSession(env.DB,id,'test-token'));}
 [owner,member,guest,other]=tokens;
 ({app}=await createApp(env.DB,{orgId:org,by:'9201',name:'Tasks',columns:[{id:'title',name:'Title',type:'text'}]}));
 ({row}=await addRow(env.DB,org,app.tableId,{title:'First'},'9201'));
});
const post=(token,body,requestId='request_0000000001',scope={},annotation)=>request('POST',token,{body,requestId,...scope,...(annotation?{annotation}:{})});
const createRequest=(path,token,input)=>fetchWorker(new Request('https://test'+path,{method:'POST',headers:{'x-session-token':token,'content-type':'application/json'},body:JSON.stringify({orgId:org,...input})}));
test.each(['/apps/generate','/app-generation-v2'])('generation route %s enforces the sample limit and retry identity',async path=>{
 const input={prompt:'A project tracker',requestId:'versioned_generation_001',sampleCount:0,useModel:false};
 const first=await createRequest(path,owner,input);expect(first.status).toBe(201);
 const created=(await first.json()).app;
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_rows WHERE org_id=? AND table_id=?').bind(org,created.tableId).first()).n).toBe(0);
 const alternate=path==='/apps/generate'?'/app-generation-v2':'/apps/generate';
 const replay=await createRequest(alternate,owner,input);expect(replay.status).toBe(200);
 expect((await replay.json()).app.id).toBe(created.id);
 expect((await createRequest(path,guest,{...input,requestId:'versioned_guest_request_01'})).status).toBe(403);
});
async function privateSource(){
 const {postMessage}=await import('../src/channels.js');
 await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,private,created_by,created_at) VALUES (?,'confidential','Confidential',1,'9201',?)").bind(org,new Date().toISOString()).run();
 await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES (?,'b:confidential','user9201',?)").bind(org,new Date().toISOString()).run();
 return (await postMessage(env.DB,{orgId:org,key:'b:confidential',authorLogin:'user9201',body:'Private app request'})).row;
}
test('source privacy governs direct, template and generated apps even with a conflicting public channel',async()=>{
 const root=await privateSource();
 const {appAccess,mayUseApp,mayUseTable}=await import('../src/harness/resourceAccess.js');
 const cases=[['/apps',{name:'Direct',columns:[{name:'Title',type:'text'}]}],['/apps',{template:'tracker',sample:false}],['/apps/generate',{prompt:'A task tracker',useModel:false}]];
 for(const [path,input] of cases){
  const response=await createRequest(path,owner,{...input,channel:'b:public',sourceThreadId:root.id});
  expect(response.status).toBe(201);
  const {app:made}=await response.json();
  expect(await appAccess(env.DB,org,made.id)).toMatchObject({ownerId:'9201',visibility:'private'});
  expect(await mayUseApp(env.DB,org,made.id,'9202')).toBe(false);
  expect(await mayUseTable(env.DB,org,made.tableId,'9202')).toBe(false);
  expect((await env.DB.prepare('SELECT channel FROM hx_app_links WHERE org_id=? AND app_id=?').bind(org,made.id).all()).results).toEqual([{channel:'b:confidential'}]);
 }
 const denied=await createRequest('/apps/generate',member,{prompt:'A task tracker',sourceThreadId:root.id,useModel:false});
 expect(denied.status).toBe(404);
});
test('private creation rolls back the app and table if its access policy cannot be saved',async()=>{
 const root=await privateSource();
 const before=await env.DB.prepare('SELECT (SELECT COUNT(*) FROM hx_apps) AS apps,(SELECT COUNT(*) FROM hx_tables) AS tables').first();
 await env.DB.exec("CREATE TRIGGER reject_app_policy BEFORE INSERT ON hx_app_access BEGIN SELECT RAISE(ABORT, 'policy unavailable'); END;");
 try {
  await expect(createApp(env.DB,{orgId:org,by:'9201',name:'Must not publish',columns:[{name:'Secret',type:'text'}],sourceThreadId:root.id})).rejects.toThrow();
  expect(await env.DB.prepare('SELECT (SELECT COUNT(*) FROM hx_apps) AS apps,(SELECT COUNT(*) FROM hx_tables) AS tables').first()).toEqual(before);
 } finally {await env.DB.exec('DROP TRIGGER reject_app_policy');}
});
test('room generation captures one source and replays the same app across sessions and concurrent sends',async()=>{
 await privateSource();
 const input={prompt:'A task tracker',channel:'b:confidential',captureSource:true,requestId:'generate_request_001',useModel:false};
 const responses=await Promise.all([createRequest('/apps/generate',owner,input),createRequest('/apps/generate',owner,input)]);
 expect(responses.map(r=>r.status)).toContain(201);
 expect(responses.every(r=>[200,201,409].includes(r.status))).toBe(true);
 const secondSession=await createSession(env.DB,'9201','generation-reconnect');
 const retry=await createRequest('/apps/generate',secondSession,input);expect(retry.status).toBe(200);
 const made=await retry.json();expect(made.replay).toBe(true);
 const history=await (await request('GET',owner,{},made.app.id)).json();
 expect(history.source.messages[0].body).toBe(input.prompt);
 expect(history.source.messages).toHaveLength(2);
 expect(history.source.messages[1].kind).toBe('ai');
 expect(history.source.messages[1].body).toContain(`](#/apps/${made.app.id}/${encodeURIComponent(org)})`);
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=? AND id=?").bind(org,`app-created-${made.app.id}`).first()).n).toBe(1);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=? AND body=?').bind(org,input.prompt).first()).n).toBe(1);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_apps WHERE org_id=?').bind(org).first()).n).toBe(2);
 expect((await createRequest('/apps/generate',owner,{...input,prompt:'A different app'})).status).toBe(409);
 await env.DB.prepare("DELETE FROM conversation_members WHERE org_id=? AND channel='b:confidential'").bind(org).run();
 expect((await createRequest('/apps/generate',owner,input)).status).toBe(403);
});
test('failed app commit keeps the generated definition and rechecks legacy sample rows on retry',async()=>{
 await privateSource();
 const input={prompt:'A project tracker, no sample data',channel:'b:confidential',captureSource:true,requestId:'generate_request_002',useModel:false};
 await env.DB.exec("CREATE TRIGGER fail_generated_version BEFORE INSERT ON hx_app_versions BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END;");
 try {expect((await createRequest('/apps/generate',owner,input)).status).toBe(500);}
 finally {await env.DB.exec('DROP TRIGGER fail_generated_version');}
 const failed=await env.DB.prepare('SELECT status,generated,app_id FROM hx_app_generation_jobs WHERE org_id=? AND user_id=? AND request_id=?').bind(org,'9201',input.requestId).first();
 expect(failed.status).toBe('failed');expect(failed.generated).toBeTruthy();expect(failed.app_id).toBeNull();
 // A proposal saved by an older version may contain samples the prompt forbids.
 const oldProposal=JSON.parse(failed.generated);oldProposal.spec.sample=[{Name:'Unexpected sample'}];
 await env.DB.prepare('UPDATE hx_app_generation_jobs SET generated=? WHERE org_id=? AND user_id=? AND request_id=?').bind(JSON.stringify(oldProposal),org,'9201',input.requestId).run();
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=? AND id LIKE 'app-created-%'").bind(org).first()).n).toBe(0);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_tables WHERE org_id=?').bind(org).first()).n).toBe(1);
 const retried=await createRequest('/apps/generate',owner,input);expect(retried.status).toBe(201);
 const retriedApp=(await retried.json()).app;
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_rows WHERE org_id=? AND table_id=?').bind(org,retriedApp.tableId).first()).n).toBe(0);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=? AND body=?').bind(org,input.prompt).first()).n).toBe(1);
});
test('an incomplete old-format proposal cannot publish on retry',async()=>{
 const input={prompt:'A project tracker',requestId:'legacy_app_generation_001',useModel:false};
 const initialCount=(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_apps WHERE org_id=?').bind(org).first()).n;
 await env.DB.exec("CREATE TRIGGER fail_old_proposal BEFORE INSERT ON hx_app_versions BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END;");
 try {expect((await createRequest('/apps/generate',owner,input)).status).toBe(500);}
 finally {await env.DB.exec('DROP TRIGGER fail_old_proposal');}
 const saved=await env.DB.prepare('SELECT generated FROM hx_app_generation_jobs WHERE org_id=? AND user_id=? AND request_id=?').bind(org,'9201',input.requestId).first();
 const old=JSON.parse(saved.generated);delete old.generationFormat;old.spec.name='Wrong legacy proposal';
 await env.DB.prepare('UPDATE hx_app_generation_jobs SET generated=? WHERE org_id=? AND user_id=? AND request_id=?').bind(JSON.stringify(old),org,'9201',input.requestId).run();
 const retry=await createRequest('/apps/generate',owner,input);
 expect(retry.status).toBe(409);
 expect(await retry.json()).toMatchObject({code:'APP_GENERATION_OBSOLETE_UNPUBLISHED'});
 // The old request stays fenced, including when the 409 response was lost.
 const repeated=await createRequest('/apps/generate',owner,input);
 expect(repeated.status).toBe(409);
 expect(await repeated.json()).toMatchObject({code:'APP_GENERATION_OBSOLETE_UNPUBLISHED'});
 const stopped=await env.DB.prepare('SELECT lease_token,lease_until FROM hx_app_generation_jobs WHERE org_id=? AND user_id=? AND request_id=?').bind(org,'9201',input.requestId).first();
 expect(stopped.lease_token).toMatch(/^obsolete:/);
 await expect(env.DB.prepare(`UPDATE hx_app_generation_jobs SET app_id=CASE WHEN lease_token=? AND lease_until>? AND status='running' THEN ? ELSE NULL END,status='complete' WHERE org_id=? AND user_id=? AND request_id=?`).bind('old-worker',Date.now(),'stale-app',org,'9201',input.requestId).run()).rejects.toThrow();
 const fresh=await createRequest('/apps/generate',owner,{...input,requestId:'legacy_app_generation_002'});
 expect(fresh.status).toBe(201);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_apps WHERE org_id=? AND name=?').bind(org,'Wrong legacy proposal').first()).n).toBe(0);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_apps WHERE org_id=?').bind(org).first()).n).toBe(initialCount+1);
});
test.each(['edited','deleted'])('an old proposal can be fenced when its source message was %s',async change=>{
 await privateSource();
 const input={prompt:'A project tracker in this room',channel:'b:confidential',captureSource:true,requestId:'legacy_room_generation_001',useModel:false};
 await env.DB.exec("CREATE TRIGGER fail_room_proposal BEFORE INSERT ON hx_app_versions BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END;");
 try {expect((await createRequest('/apps/generate',owner,input)).status).toBe(500);}
 finally {await env.DB.exec('DROP TRIGGER fail_room_proposal');}
 const oldRoot=await env.DB.prepare('SELECT id FROM channel_messages WHERE org_id=? AND channel=? AND body=?').bind(org,input.channel,input.prompt).first();
 const job=await env.DB.prepare('SELECT generated FROM hx_app_generation_jobs WHERE org_id=? AND user_id=? AND request_id=?').bind(org,'9201',input.requestId).first();
 const old=JSON.parse(job.generated);delete old.generationFormat;
 await env.DB.prepare('UPDATE hx_app_generation_jobs SET generated=? WHERE org_id=? AND user_id=? AND request_id=?').bind(JSON.stringify(old),org,'9201',input.requestId).run();
 if(change==='edited') await env.DB.prepare('UPDATE channel_messages SET body=? WHERE org_id=? AND id=?').bind('Edited request',org,oldRoot.id).run();
 else await env.DB.prepare('UPDATE channel_messages SET deleted_at=? WHERE org_id=? AND id=?').bind(new Date().toISOString(),org,oldRoot.id).run();
 const retry=await createRequest('/apps/generate',owner,input);
 expect(retry.status).toBe(409);
 expect(await retry.json()).toMatchObject({code:'APP_GENERATION_OBSOLETE_UNPUBLISHED'});
 expect((await env.DB.prepare('SELECT lease_token,app_id FROM hx_app_generation_jobs WHERE org_id=? AND user_id=? AND request_id=?').bind(org,'9201',input.requestId).first())).toMatchObject({lease_token:expect.stringMatching(/^obsolete:/),app_id:null});
 const fresh=await createRequest('/apps/generate',owner,{...input,requestId:'legacy_room_generation_002'});
 expect(fresh.status).toBe(201);
 const made=(await fresh.json()).app;
 const source=await env.DB.prepare('SELECT thread_id FROM hx_app_conversation_sources WHERE org_id=? AND app_id=?').bind(org,made.id).first();
 expect(source.thread_id).not.toBe(oldRoot.id);
 expect((await env.DB.prepare('SELECT body FROM channel_messages WHERE org_id=? AND id=?').bind(org,source.thread_id).first()).body).toBe(input.prompt);
 expect((await env.DB.prepare('SELECT parent_id FROM channel_messages WHERE org_id=? AND id=?').bind(org,`app-created-${made.id}`).first()).parent_id).toBe(source.thread_id);
 expect((await env.DB.prepare('SELECT visibility FROM hx_app_access WHERE org_id=? AND app_id=?').bind(org,made.id).first()).visibility).toBe('private');
});
test('a current proposal still rejects an edited source message',async()=>{
 await privateSource();
 const input={prompt:'Current project tracker',channel:'b:confidential',captureSource:true,requestId:'current_room_generation_001',useModel:false};
 await env.DB.exec("CREATE TRIGGER fail_current_proposal BEFORE INSERT ON hx_app_versions BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END;");
 try {expect((await createRequest('/apps/generate',owner,input)).status).toBe(500);}
 finally {await env.DB.exec('DROP TRIGGER fail_current_proposal');}
 await env.DB.prepare('UPDATE channel_messages SET body=? WHERE org_id=? AND channel=? AND body=?').bind('Edited request',org,input.channel,input.prompt).run();
 const retry=await createRequest('/apps/generate',owner,input);
 expect(retry.status).toBe(409);
 expect(await retry.json()).toMatchObject({message:'The source conversation changed. Start a new generation request.'});
 const job=await env.DB.prepare('SELECT status,app_id FROM hx_app_generation_jobs WHERE org_id=? AND user_id=? AND request_id=?').bind(org,'9201',input.requestId).first();
 expect(job).toMatchObject({status:'failed',app_id:null});
});
const oldRoomFingerprint=async input=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({prompt:input.prompt,name:'',channel:input.channel,sourceThreadId:null,captureSource:true,useModel:false}))))].map(value=>value.toString(16).padStart(2,'0')).join('');
test('a legacy pending room generation is fenced even without a saved proposal',async()=>{
 await privateSource();
 const input={prompt:'Legacy pending project',channel:'b:confidential',captureSource:true,requestId:'legacy_identity_pending_001',useModel:false};
 await env.DB.exec("CREATE TRIGGER fail_legacy_identity BEFORE INSERT ON hx_app_versions BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END;");
 try {expect((await createRequest('/apps/generate',owner,input)).status).toBe(500);}
 finally {await env.DB.exec('DROP TRIGGER fail_legacy_identity');}
 await env.DB.prepare("UPDATE hx_app_generation_jobs SET fingerprint=?,generated=NULL,status='running',lease_token='old-worker',lease_until=? WHERE org_id=? AND user_id=? AND request_id=?").bind(await oldRoomFingerprint(input),Date.now()+60000,org,'9201',input.requestId).run();
 const inFlight=await createRequest('/apps/generate',owner,input);expect(inFlight.status).toBe(409);
 expect(await inFlight.json()).not.toHaveProperty('code','APP_GENERATION_OBSOLETE_UNPUBLISHED');
 await env.DB.prepare("UPDATE hx_app_generation_jobs SET status='failed',lease_until=0 WHERE org_id=? AND user_id=? AND request_id=?").bind(org,'9201',input.requestId).run();
 const stopped=await createRequest('/apps/generate',owner,input);expect(stopped.status).toBe(409);
 expect(await stopped.json()).toMatchObject({code:'APP_GENERATION_OBSOLETE_UNPUBLISHED'});
 expect((await env.DB.prepare('SELECT lease_token FROM hx_app_generation_jobs WHERE org_id=? AND user_id=? AND request_id=?').bind(org,'9201',input.requestId).first()).lease_token).toMatch(/^obsolete:/);
 expect((await createRequest('/app-generation-v2',owner,{...input,requestId:'legacy_identity_pending_002'})).status).toBe(201);
});
test('a completed legacy room generation replays the original app',async()=>{
 await privateSource();
 const input={prompt:'Legacy completed project',channel:'b:confidential',captureSource:true,requestId:'legacy_identity_complete_01',useModel:false};
 const first=await createRequest('/apps/generate',owner,input);expect(first.status).toBe(201);
 const appId=(await first.json()).app.id;
 await env.DB.prepare('UPDATE hx_app_generation_jobs SET fingerprint=? WHERE org_id=? AND user_id=? AND request_id=?').bind(await oldRoomFingerprint(input),org,'9201',input.requestId).run();
 const replay=await createRequest('/apps/generate',owner,input);expect(replay.status).toBe(200);
 expect(await replay.json()).toMatchObject({app:{id:appId},replay:true});
});
test('recreating a room cannot replay a pending generation against its old source',async()=>{
 await privateSource();
 const input={prompt:'Room identity tracker',channel:'b:confidential',captureSource:true,requestId:'recreated_room_request_001',useModel:false};
 await env.DB.exec("CREATE TRIGGER fail_room_identity BEFORE INSERT ON hx_app_versions BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END;");
 try {expect((await createRequest('/app-generation-v2',owner,input)).status).toBe(500);}
 finally {await env.DB.exec('DROP TRIGGER fail_room_identity');}
 await env.DB.batch([
  env.DB.prepare("DELETE FROM businesses WHERE org_id=? AND slug='confidential'").bind(org),
  env.DB.prepare("INSERT INTO businesses(org_id,slug,name,private,created_by,created_at) VALUES (?,'confidential','Recreated',1,'9201','2000-01-01')").bind(org),
 ]);
 const retry=await createRequest('/app-generation-v2',owner,input);expect(retry.status).toBe(409);
 expect(await retry.json()).not.toHaveProperty('code','APP_GENERATION_OBSOLETE_UNPUBLISHED');
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=? AND body=?').bind(org,input.prompt).first()).n).toBe(1);
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=? AND id LIKE 'app-created-%'").bind(org).first()).n).toBe(0);
});
test.each(['existing','capture'])('a %s source cannot cross into a recreated room while the model runs',async kind=>{
 const root=await privateSource();
 const {generateApp}=await import('../src/harness/appGeneration.js');
 const who={session:{github_id:'9201'},user:{github_id:'9201',login:'user9201'}};
 const input={prompt:'Track projects',requestId:'model_room_identity_request_01',...(kind==='existing'?{sourceThreadId:root.id}:{channel:'b:confidential',captureSource:true})};
 const before=(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_apps WHERE org_id=?').bind(org).first()).n;
 const result=await generateApp(env,new Request('https://test/app-generation-v2'),org,who,input,{
  makeCompleter:async()=>async()=>{
   await env.DB.batch([
    env.DB.prepare("DELETE FROM businesses WHERE org_id=? AND slug='confidential'").bind(org),
    env.DB.prepare("INSERT INTO businesses(org_id,slug,name,private,created_by,created_at) VALUES (?,'confidential','Recreated',1,'9201','2000-01-01')").bind(org),
   ]);
   return JSON.stringify({name:'Projects',columns:[{name:'Title',type:'text'}],views:[{type:'table',name:'All'}]});
  },
 });
 expect(result).toMatchObject({status:409});
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_apps WHERE org_id=?').bind(org).first()).n).toBe(before);
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=? AND id LIKE 'app-created-%'").bind(org).first()).n).toBe(0);
});
test('the selected sample count is part of generation retry identity',async()=>{
 const input={prompt:'請求書を管理。サンプルデータを追加、1件だけ',requestId:'sample_count_request_001',sampleCount:3,useModel:false};
 const first=await createRequest('/apps/generate',owner,input);expect(first.status).toBe(201);
 const made=(await first.json()).app;
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_rows WHERE org_id=? AND table_id=?').bind(org,made.tableId).first()).n).toBe(1);
 expect((await createRequest('/apps/generate',owner,input)).status).toBe(200);
 expect((await createRequest('/apps/generate',owner,{...input,sampleCount:2})).status).toBe(409);
 const capped=await createRequest('/apps/generate',owner,{prompt:'請求書を管理。サンプルデータを追加、1件まで',requestId:'sample_count_cap_request_001',sampleCount:5,useModel:false});
 expect(capped.status).toBe(201);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_rows WHERE org_id=? AND table_id=?').bind(org,(await capped.json()).app.tableId).first()).n).toBe(1);
});
test('an invalid generated board fails before publishing an app',async()=>{
 const {generateApp}=await import('../src/harness/appGeneration.js');
 const who={session:{github_id:'9201'},user:{github_id:'9201',login:'user9201'}};
 const before=(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_apps WHERE org_id=?').bind(org).first()).n;
 const result=await generateApp(env,new Request('https://test/apps/generate'),org,who,{prompt:'タスクをボードで表示',requestId:'invalid_board_generation_01'}, {
  makeCompleter:async()=>async()=>JSON.stringify({name:'Tasks',columns:[{name:'Task',type:'text'}],views:[{type:'board',name:'Board'}]}),
 });
 expect(result.error).toContain('選択肢フィールド');
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_apps WHERE org_id=?').bind(org).first()).n).toBe(before);
});
test('DLP blocks generation before saving a source, job or app',async()=>{
 await privateSource();
 expect((await createRequest('/orgs/dlp',owner,{kind:'builtin',detector:'credit_card',action:'block'})).status).toBe(201);
 const input={prompt:'Track card 4111 1111 1111 1111',channel:'b:confidential',captureSource:true,requestId:'generate_request_003',useModel:false};
 expect((await createRequest('/apps/generate',owner,input)).status).toBe(422);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_app_generation_jobs WHERE org_id=?').bind(org).first()).n).toBe(0);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=? AND body=?').bind(org,input.prompt).first()).n).toBe(0);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_apps WHERE org_id=?').bind(org).first()).n).toBe(1);
});
test('model output survives a storage retry without a second model call, and revoked access cannot publish',async()=>{
 const {generateApp}=await import('../src/harness/appGeneration.js');
 await privateSource();
 const who={session:{github_id:'9201'},user:{github_id:'9201',login:'user9201'}};
 const req=new Request('https://test/apps/generate');
 const input={prompt:'Model app',name:'Friendly app title',channel:'b:confidential',captureSource:true,requestId:'generate_model_001'};
 const complete=vi.fn().mockResolvedValue(JSON.stringify({name:'Model app',tableName:'Records',columns:[{name:'Title',type:'text'}]}));
 const makeCompleter=vi.fn().mockResolvedValue(complete);
 await env.DB.exec("CREATE TRIGGER fail_model_app BEFORE INSERT ON hx_app_versions BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END;");
 try {await expect(generateApp(env,req,org,who,input,{makeCompleter})).rejects.toThrow();}
 finally {await env.DB.exec('DROP TRIGGER fail_model_app');}
 const generated=await generateApp(env,req,org,who,input,{makeCompleter});
 expect(generated.source).toBe('model');
 expect(generated.app.name).toBe('Friendly app title');
 const {getTable}=await import('../src/harness/tables.js');
 expect((await getTable(env.DB,org,generated.app.tableId)).name).toBe('Records');
 expect(complete).toHaveBeenCalledTimes(1);expect(makeCompleter).toHaveBeenCalledTimes(1);
 const revoke=async()=>async()=>{await env.DB.prepare("DELETE FROM conversation_members WHERE org_id=? AND channel='b:confidential'").bind(org).run();return JSON.stringify({name:'Cannot publish',columns:[{name:'Title',type:'text'}]});};
 expect((await generateApp(env,req,org,who,{...input,requestId:'generate_model_002'},{makeCompleter:revoke})).status).toBe(403);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_apps WHERE org_id=? AND name=?').bind(org,'Cannot publish').first()).n).toBe(0);
});
test.each(['membership','room','privacy','source'])('generation sends nothing to the model if %s changes while its provider is initialized',async change=>{
 const root=await privateSource();
 await env.DB.prepare('INSERT INTO hx_room_guidelines(org_id,channel,body,version,updated_by,updated_at) VALUES(?,?,?,1,?,?)').bind(org,'b:confidential','Private rule','9201',new Date().toISOString()).run();
 const {generateApp}=await import('../src/harness/appGeneration.js');
 const who={session:{github_id:'9201'},user:{github_id:'9201',login:'user9201'}};let calls=0;
 const made=await generateApp(env,new Request('https://test/app-generation-v2'),org,who,{prompt:'Track work',sourceThreadId:root.id,requestId:'provider_revocation_test_01'}, {
  makeCompleter:async()=>{
   if(change==='membership')await env.DB.prepare("DELETE FROM conversation_members WHERE org_id=? AND channel='b:confidential' AND login='user9201'").bind(org).run();
   if(change==='room')await env.DB.batch([env.DB.prepare("DELETE FROM businesses WHERE org_id=? AND slug='confidential'").bind(org),env.DB.prepare("INSERT INTO businesses(org_id,slug,name,private,created_by,created_at) VALUES (?,'confidential','New',1,'9201','2000-01-01')").bind(org)]);
   if(change==='privacy')await env.DB.prepare("UPDATE businesses SET private=0 WHERE org_id=? AND slug='confidential'").bind(org).run();
   if(change==='source')await env.DB.prepare('UPDATE channel_messages SET deleted_at=? WHERE id=?').bind(new Date().toISOString(),root.id).run();
   return async()=>{calls++;return JSON.stringify({name:'Not allowed',columns:[{name:'Title',type:'text'}]});};
  },
 });
 expect(made.status).toBe(403);expect(calls).toBe(0);
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_apps WHERE org_id=? AND name='Not allowed'").bind(org).first()).n).toBe(0);
});
test('generation rechecks room access after reading guidelines and before model dispatch',async()=>{
 const root=await privateSource();
 await env.DB.prepare('INSERT INTO hx_room_guidelines(org_id,channel,body,version,updated_by,updated_at) VALUES(?,?,?,1,?,?)').bind(org,'b:confidential','Private rule','9201',new Date().toISOString()).run();
 let checked=false,calls=0;
 const db=new Proxy(env.DB,{get(target,prop){
  if(prop==='prepare')return sql=>{
   const statement=target.prepare(sql);
   if(!sql.includes("SELECT COALESCE(g.body,'') AS body"))return statement;
   return {bind(...args){const bound=statement.bind(...args);return {async first(){const row=await bound.first();if(!checked){checked=true;await target.prepare("DELETE FROM conversation_members WHERE org_id=? AND channel='b:confidential' AND login='user9201'").bind(org).run();}return row;}};}};
  };
  const value=target[prop];return typeof value==='function'?value.bind(target):value;
 }});
 const {generateApp}=await import('../src/harness/appGeneration.js');
 const result=await generateApp({...env,DB:db},new Request('https://test/app-generation-v2'),org,{session:{github_id:'9201'},user:{github_id:'9201',login:'user9201'}},
  {prompt:'Track work',sourceThreadId:root.id,requestId:'before_dispatch_revoked_01'},
  {makeCompleter:async()=>async()=>{calls++;return JSON.stringify({name:'Not allowed',columns:[{name:'Title',type:'text'}]});}});
 expect(checked).toBe(true);expect(result.status).toBe(403);expect(calls).toBe(0);
});
test('generation gives the provider a live authorization callback for its own pre-network checks',async()=>{
 const root=await privateSource();let networkCalls=0,checked=false;
 const {generateApp}=await import('../src/harness/appGeneration.js');
 const result=await generateApp(env,new Request('https://test/app-generation-v2'),org,{session:{github_id:'9201'},user:{github_id:'9201',login:'user9201'}},
  {prompt:'Track work',sourceThreadId:root.id,requestId:'provider_live_auth_test_01'},
  {makeCompleter:async()=>async(_system,_user,options)=>{
   await env.DB.prepare("DELETE FROM conversation_members WHERE org_id=? AND channel='b:confidential' AND login='user9201'").bind(org).run();
   checked=typeof options.authorize==='function';
   if(await options.authorize())networkCalls++;
   return JSON.stringify({name:'Not allowed',columns:[{name:'Title',type:'text'}]});
  }});
 expect(checked).toBe(true);expect(result.status).toBe(403);expect(networkCalls).toBe(0);
});
test.each(['expired','reassigned'])('an %s generation lease cannot dispatch a model call and releases its reservation',async change=>{
 const {generateApp}=await import('../src/harness/appGeneration.js');let calls=0,disposed=0;
 const input={prompt:'Track work',requestId:'lease_model_dispatch_001'};
 const result=await generateApp(env,new Request('https://test/app-generation-v2'),org,{session:{github_id:'9201'},user:{github_id:'9201',login:'user9201'}},input,{
  makeCompleter:async()=>{
   if(change==='expired')await env.DB.prepare('UPDATE hx_app_generation_jobs SET lease_until=0 WHERE org_id=? AND request_id=?').bind(org,input.requestId).run();
   else await env.DB.prepare("UPDATE hx_app_generation_jobs SET lease_token='another-worker' WHERE org_id=? AND request_id=?").bind(org,input.requestId).run();
   const complete=async()=>{calls++;return '{}';};complete.dispose=async()=>{disposed++;};return complete;
  },
 });
 expect(result.status).toBe(403);expect(calls).toBe(0);expect(disposed).toBe(1);
});
test('a lease expiring while its authorization query is waiting cannot dispatch the model',async()=>{
 const {generateApp}=await import('../src/harness/appGeneration.js');
 let clock=Date.now(),reads=0,calls=0,disposed=0;
 const dateNow=vi.spyOn(Date,'now').mockImplementation(()=>clock);
 const db=new Proxy(env.DB,{get(target,prop){
  if(prop==='prepare')return sql=>{
   const statement=target.prepare(sql);
   if(!sql.includes('SELECT 1 AS allowed,') || !sql.includes('hx_app_generation_jobs j'))return statement;
   return {bind(...args){const bound=statement.bind(...args);return {async first(){const row=await bound.first();if(++reads===2)clock+=2000;return row;}};}};
  }
  const value=target[prop];return typeof value==='function'?value.bind(target):value;
 }});
 try {
  const input={prompt:'Track work',requestId:'lease_wait_dispatch_test_001'};
  const result=await generateApp({...env,DB:db},new Request('https://test/app-generation-v2'),org,{session:{github_id:'9201'},user:{github_id:'9201',login:'user9201'}},input,{
   makeCompleter:async()=>{
    await env.DB.prepare('UPDATE hx_app_generation_jobs SET lease_until=? WHERE org_id=? AND request_id=?').bind(clock+1000,org,input.requestId).run();
    const complete=async()=>{calls++;return '{}';};complete.dispose=async()=>{disposed++;};return complete;
   },
  });
  expect(reads).toBe(2);expect(result.status).toBe(403);expect(calls).toBe(0);expect(disposed).toBe(1);
 } finally {dateNow.mockRestore();}
});
test('editing a captured source during model execution prevents publication',async()=>{
 await privateSource();
 const {generateApp}=await import('../src/harness/appGeneration.js');
 const prompt='Generate this app';
 const result=await generateApp(env,new Request('https://test/app-generation-v2'),org,{session:{github_id:'9201'},user:{github_id:'9201',login:'user9201'}},
  {prompt,channel:'b:confidential',captureSource:true,requestId:'source_body_changed_001'},
  {makeCompleter:async()=>async()=>{
   await env.DB.prepare('UPDATE channel_messages SET body=? WHERE org_id=? AND channel=? AND body=?').bind('Edited request',org,'b:confidential',prompt).run();
   return JSON.stringify({name:'Stale source',columns:[{name:'Title',type:'text'}]});
  }});
 expect(result.status).toBe(409);
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_apps WHERE org_id=? AND name='Stale source'").bind(org).first()).n).toBe(0);
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=? AND id LIKE 'app-created-%'").bind(org).first()).n).toBe(0);
});
test('a business source is rejected if its room disappears after access is checked',async()=>{
 const root=await privateSource();let removed=false;
 const db=new Proxy(env.DB,{get(target,prop){
  if(prop==='prepare')return sql=>{
   const statement=target.prepare(sql);
   if(!sql.includes('SELECT private,created_at FROM businesses'))return statement;
   return {bind(...args){const bound=statement.bind(...args);return {async first(){if(!removed){removed=true;await target.prepare("DELETE FROM businesses WHERE org_id=? AND slug='confidential'").bind(org).run();}return bound.first();}};}};
  };
  const value=target[prop];return typeof value==='function'?value.bind(target):value;
 }});
 const {appCreationSource}=await import('../src/harness/apps.js');
 expect(await appCreationSource(db,org,'9201',root.id)).toMatchObject({status:404});expect(removed).toBe(true);
});
test('room guidelines accompany app generation and app replies only while the source room is accessible',async()=>{
 const root=await privateSource();
 const rule='Use the room-approved terminology and never include customer secrets.';
 await env.DB.prepare('INSERT INTO hx_room_guidelines(org_id,channel,body,version,updated_by,updated_at) VALUES(?,?,?,1,?,?)')
  .bind(org,'b:confidential',rule,'9201',new Date().toISOString()).run();
 const {generateApp}=await import('../src/harness/appGeneration.js');
 const {replyToApp,withAppRoomGuidelinesRequest}=await import('../src/harness/appConversationFeatures.js');
 const {appConversation}=await import('../src/harness/appConversations.js');
 const who={session:{github_id:'9201'},user:{github_id:'9201',login:'user9201'}};
 let generationPrompt='';
 const made=await generateApp(env,new Request('https://test/apps/generate'),org,who,{prompt:'Create an internal tracker',requestId:'guided_app_generation_001',sourceThreadId:root.id},{
  makeCompleter:async()=>async(_system,prompt)=>{generationPrompt=prompt;return JSON.stringify({name:'Guided tracker',columns:[{name:'Title',type:'text'}]});},
 });
 expect(generationPrompt).toContain('Current room guidelines (revision 1)');
 expect(generationPrompt).toContain(rule);
 const appActionPrompt=await withAppRoomGuidelinesRequest(env.DB,org,who.user,made.app.id,'Add an approved action');
 expect(appActionPrompt).toContain(rule);
 const input={body:'@AI summarize this app',requestId:'guided_app_chat_request_01'};
 const saved=await appConversation(env.DB,org,'9201',made.app.id,input,true);
 let answerSystem='';
 await replyToApp(env,org,who.user,made.app.id,input,saved.messageId,{makeCompleter:async()=>async(system)=>{answerSystem=system;return 'A focused answer.';}});
 expect(answerSystem).toContain(`<room_guidelines>\n${rule}\n</room_guidelines>`);

 await env.DB.prepare("DELETE FROM conversation_members WHERE org_id=? AND channel='b:confidential' AND login='user9201'").bind(org).run();
 expect(await withAppRoomGuidelinesRequest(env.DB,org,who.user,made.app.id,'Do not reveal room rules')).toBe('Do not reveal room rules');
 const inaccessible={body:'@AI answer without private room rules',requestId:'guided_app_chat_request_02'};
 const next=await appConversation(env.DB,org,'9201',made.app.id,inaccessible,true);
 await replyToApp(env,org,who.user,made.app.id,inaccessible,next.messageId,{makeCompleter:async()=>async(system)=>{answerSystem=system;return 'A focused answer.';}});
 expect(answerSystem).not.toContain(rule);

 await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES (?,'b:confidential','user9201',?)").bind(org,new Date().toISOString()).run();
 const revokedDuringGeneration={body:'@AI answer only while access is valid',requestId:'guided_app_chat_request_03'};
 const pending=await appConversation(env.DB,org,'9201',made.app.id,revokedDuringGeneration,true);
 await replyToApp(env,org,who.user,made.app.id,revokedDuringGeneration,pending.messageId,{makeCompleter:async()=>async()=>{
  await env.DB.prepare("DELETE FROM conversation_members WHERE org_id=? AND channel='b:confidential' AND login='user9201'").bind(org).run();
  return 'This must not be stored.';
 }});
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_app_messages WHERE org_id=? AND app_id=? AND author_id='__app_ai' AND body='This must not be stored.'").bind(org,made.app.id).first()).n).toBe(0);
});
test('long room guidelines do not replace the app request or determine its fallback template',async()=>{
 const root=await privateSource();
 const rule=('営業・請求書・カレンダー。担当者は自由記述。'+'規'.repeat(4096)).slice(0,4096);
 await env.DB.prepare('INSERT INTO hx_room_guidelines(org_id,channel,body,version,updated_by,updated_at) VALUES(?,?,?,1,?,?)')
  .bind(org,'b:confidential',rule,'9201',new Date().toISOString()).run();
 const {generateApp}=await import('../src/harness/appGeneration.js');
 const {getTable}=await import('../src/harness/tables.js');
 const who={session:{github_id:'9201'},user:{github_id:'9201',login:'user9201'}};
 const prompt='タスク管理。担当者をワークスペースのメンバーから選ぶ。'+'あ'.repeat(3800)+'末尾の要件';
 let received='';
 const generated=await generateApp(env,new Request('https://test/apps/generate'),org,who,{prompt,sourceThreadId:root.id,requestId:'long_guidelines_app_001'}, {
  makeCompleter:async()=>async(_system,request)=>{received=request;return JSON.stringify({name:'Tasks',columns:[{name:'担当者',type:'text'}]});},
 });
 expect(received).toContain(rule);
 expect(received.endsWith(prompt)).toBe(true);
 expect((await getTable(env.DB,org,generated.app.tableId)).columns[0].type).toBe('person');
 const governed=await generateApp(env,new Request('https://test/apps/generate'),org,who,{prompt:'担当者を記録するタスクアプリ',sourceThreadId:root.id,requestId:'long_guidelines_app_003'}, {
  makeCompleter:async()=>async()=>JSON.stringify({name:'Tasks',columns:[{name:'担当者',type:'text'}]}),
 });
 expect((await getTable(env.DB,org,governed.app.tableId)).columns[0].type).toBe('text');
 const fallback=await generateApp(env,new Request('https://test/apps/generate'),org,who,{prompt:'タスクを管理する',sourceThreadId:root.id,requestId:'long_guidelines_app_002',useModel:false});
 expect(fallback.app.template).toBe('tracker');
 expect(fallback.app.definition.views.map(view=>view.type)).toEqual(['table']);
});
test('an expired generation cannot publish after another request takes its lease',async()=>{
 const {generateApp}=await import('../src/harness/appGeneration.js');
 const who={session:{github_id:'9201'},user:{github_id:'9201',login:'user9201'}};
 const req=new Request('https://test/apps/generate');
 const input={prompt:'Create one app',requestId:'expired_generation_01'};
 const spec=name=>JSON.stringify({name,columns:[{name:'Title',type:'text'}]});
 const stale=await generateApp(env,req,org,who,input,{makeCompleter:async()=>async()=>{
  await env.DB.prepare('UPDATE hx_app_generation_jobs SET lease_until=0 WHERE org_id=? AND user_id=? AND request_id=?').bind(org,'9201',input.requestId).run();
  expect((await generateApp(env,req,org,who,input,{makeCompleter:async()=>async()=>spec('Winner')})).app.name).toBe('Winner');
  return spec('Stale result');
 }});
 expect(stale.status).toBe(409);
 expect((await env.DB.prepare('SELECT name FROM hx_apps WHERE org_id=? AND name IN (?,?)').bind(org,'Winner','Stale result').all()).results).toEqual([{name:'Winner'}]);
});
test('app and record conversations have stable identities, independent histories and idempotent sends',async()=>{
 const empty=await (await request('GET',owner)).json();expect(empty.messages).toEqual([]);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_app_messages').first()).n).toBe(0);
 expect((await post(owner,'Hello')).status).toBe(200);expect((await post(owner,'Hello')).status).toBe(200);
 expect((await post(owner,'Different')).status).toBe(409);
 const secondSession=await createSession(env.DB,'9201','test-second');
 const restored=await (await request('GET',secondSession)).json();expect(restored.threadId).toBe(empty.threadId);expect(restored.messages).toHaveLength(1);expect(restored.messages[0]).toMatchObject({authorId:'9201',body:'Hello'});
 const scope={tableId:app.tableId,rowId:row.id};expect((await post(member,'Record note','request_0000000001',scope)).status).toBe(200);
 const record=await (await request('GET',owner,scope)).json();expect(record.threadId).not.toBe(empty.threadId);expect(record.messages.map(m=>m.body)).toEqual(['Record note']);
 expect((await (await request('GET',member)).json()).messages.map(m=>m.body)).toEqual(['Hello']);
});
test('sent app annotations persist with their message, scope and access checks',async()=>{
 const marker={target:'列「Title」',x:28.5,y:64,section:'data'};
 expect((await (await request('GET',owner)).json()).annotations).toEqual([]);
 const body='注釈: Tasks · データビューアー · 列「Title」 · 画面位置 28.5% / 64%\nReview the title spacing';
 expect((await post(owner,body,'annotation_request_001',{},marker)).status).toBe(200);
 expect((await post(owner,body,'annotation_request_001',{},marker)).status).toBe(200);
 const history=await (await request('GET',owner)).json();expect(history.annotations).toHaveLength(1);
 expect(history.annotations[0]).toMatchObject({target:marker.target,x:marker.x,y:marker.y,section:marker.section,body,authorId:'9201',authorName:'User 9201',messageSource:'app'});
 const secondSession=await createSession(env.DB,'9201','annotation-second');expect((await (await request('GET',secondSession)).json()).annotations[0].id).toBe(history.annotations[0].id);
 expect((await (await request('GET',owner,{tableId:app.tableId,rowId:row.id})).json()).annotations).toEqual([]);
 expect((await post(owner,'Invalid marker','annotation_request_002',{}, {...marker,x:101})).status).toBe(400);
 expect((await post(owner,'Record marker','annotation_request_003',{tableId:app.tableId,rowId:row.id},marker)).status).toBe(400);
 expect((await (await request('GET',owner,{tableId:app.tableId,rowId:row.id})).json()).messages).toEqual([]);
 expect((await (await request('GET',owner)).json()).messages.map(message=>message.body)).toEqual([body]);
 await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES (?,?,'private',1)").bind(org,app.id).run();
 expect((await request('GET',member)).status).toBe(404);
 expect((await request('GET',owner)).status).toBe(200);
});
test('membership, current app visibility and record ownership gate reads and writes',async()=>{
 await post(owner,'Private later');
 for(const token of [guest,other]){expect((await request('GET',token)).status).toBe(403);expect((await post(token,'Blocked')).status).toBe(403);}
 await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES (?,?,'private',1)").bind(org,app.id).run();
 expect((await request('GET',member)).status).toBe(404);expect((await post(member,'Blocked')).status).toBe(404);expect((await request('GET',owner)).status).toBe(200);
 expect((await request('GET',owner,{tableId:app.tableId,rowId:'missing'})).status).toBe(404);
 expect((await request('GET',owner,{tableId:'foreign',rowId:row.id})).status).toBe(404);
 await env.DB.prepare('DELETE FROM hx_rows WHERE id=?').bind(row.id).run();expect((await request('GET',owner,{tableId:app.tableId,rowId:row.id})).status).toBe(404);
 await env.DB.prepare('DELETE FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,'9201').run();expect((await request('GET',owner)).status).toBe(403);
});
test('history pages are chronological with no duplicate boundaries; malformed input is rejected',async()=>{
 for(let n=0;n<52;n++)expect((await post(owner,'message '+n,'request_'+String(n).padStart(16,'0'))).status).toBe(200);
 const latest=await (await request('GET',owner)).json();expect(latest.messages).toHaveLength(50);expect(latest.hasMore).toBe(true);expect(latest.messages[0].body).toBe('message 2');
 const earlier=await (await request('GET',owner,{before:String(latest.messages[0].id)})).json();expect(earlier.messages.map(m=>m.body)).toEqual(['message 0','message 1']);expect(earlier.hasMore).toBe(false);
 for(const input of [{tableId:app.tableId},{before:'-1'},{before:'NaN'}])expect((await request('GET',owner,input)).status).toBe(400);
 expect((await post(owner,' ')).status).toBe(400);expect((await post(owner,'x'.repeat(4001))).status).toBe(400);expect((await post(owner,'Hi','short')).status).toBe(400);
});
test('simultaneous retries converge and other apps or records never share a thread',async()=>{
 const results=await Promise.all([post(owner,'One'),post(owner,'One')]);expect(results.map(r=>r.status)).toEqual([200,200]);
 expect((await (await request('GET',owner)).json()).messages).toHaveLength(1);
 const {row:second}=await addRow(env.DB,org,app.tableId,{title:'Second'},'9201');
 await post(owner,'Only first','request_record_01',{tableId:app.tableId,rowId:row.id});
 expect((await (await request('GET',owner,{tableId:app.tableId,rowId:second.id})).json()).messages).toEqual([]);
 const {app:another}=await createApp(env.DB,{orgId:org,by:'9201',name:'Another',columns:[{id:'title',name:'Title',type:'text'}]});
 expect((await (await request('GET',owner,{},another.id)).json()).messages).toEqual([]);
 expect((await request('GET',owner,{tableId:app.tableId,rowId:row.id},another.id)).status).toBe(404);
});

const featureRequest=(suffix,method,token,input={})=>fetchWorker(new Request('https://test/apps/'+app.id+'/'+suffix+(method==='GET'?'?orgId='+encodeURIComponent(org):''),{method,headers:{'x-session-token':token,'content-type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify({orgId:org,...input})})}));
test('source inheritance reuses the original thread and preserves room access, record separation and retries',async()=>{
 const {postMessage}=await import('../src/channels.js');
 const {linkApp}=await import('../src/harness/apps.js');
 await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,created_by,created_at) VALUES (?,'source','Source','9201',?)").bind(org,new Date().toISOString()).run();
 const root=await postMessage(env.DB,{orgId:org,key:'b:source',authorLogin:'user9201',body:'Original app request'});
 await linkApp(env.DB,org,app.id,'b:source','9201');
 expect((await featureRequest('conversation-source','POST',member,{messageId:root.row.id})).status).toBe(403);
 expect((await featureRequest('conversation-source','POST',owner,{messageId:root.row.id})).status).toBe(200);
 expect((await featureRequest('conversation-source','POST',owner,{messageId:root.row.id})).status).toBe(200);
 const history=await (await request('GET',owner)).json();expect(history.source.threadId).toBe(root.row.id);expect(history.source.messages[0].body).toBe('Original app request');
 const sourceMarker={target:'申請ボタン',x:81,y:22,section:'overview'};
 expect((await post(owner,'Continue here','source_request_001',{},sourceMarker)).status).toBe(200);
 expect((await post(owner,'Continue here','source_request_001',{},sourceMarker)).status).toBe(200);
 const sourcedHistory=await (await request('GET',owner)).json();expect(sourcedHistory.annotations).toHaveLength(1);expect(sourcedHistory.annotations[0]).toMatchObject({...sourceMarker,messageSource:'channel',body:'Continue here'});
 const memberHistory=await (await request('GET',member)).json();expect(memberHistory.annotations).toHaveLength(1);
 await env.DB.prepare('UPDATE businesses SET private=1 WHERE org_id=? AND slug=?').bind(org,'source').run();
 expect((await request('GET',member)).status).toBe(403);
 const replies=await env.DB.prepare('SELECT body FROM channel_messages WHERE parent_id=?').bind(root.row.id).all();expect(replies.results.map(r=>r.body)).toEqual(['Continue here']);
 expect((await (await request('GET',owner,{tableId:app.tableId,rowId:row.id})).json()).source).toBeNull();
 await env.DB.prepare('DELETE FROM businesses WHERE org_id=? AND slug=?').bind(org,'source').run();
 expect((await request('GET',owner)).status).toBe(403);expect((await post(owner,'No access','source_request_002')).status).toBe(403);
});
test('mentions notify only accessible members once and reads synchronize across sessions',async()=>{
 const scope={tableId:app.tableId,rowId:row.id};
 await post(owner,'@user9202 please review @user9203 @user9204','mention_request_01',scope);
 await post(owner,'@user9202 please review @user9203 @user9204','mention_request_01',scope);
 const notifications=await (await featureRequest('conversation-notifications','GET',member)).json();expect(notifications.items).toHaveLength(1);expect(notifications.items[0].rowId).toBe(row.id);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_app_notifications').first()).n).toBe(1);
 expect((await featureRequest('conversation-notifications','POST',member,{messageId:notifications.items[0].messageId})).status).toBe(200);
 const second=await createSession(env.DB,'9202','another-session');expect((await (await featureRequest('conversation-notifications','GET',second)).json()).items[0].readAt).toBeTruthy();
 await env.DB.prepare('DELETE FROM hx_rows WHERE id=?').bind(row.id).run();expect((await (await featureRequest('conversation-notifications','GET',member)).json()).items).toEqual([]);
});
test('creation records its supplied source thread but refuses an unavailable source before creating data',async()=>{
 const {postMessage}=await import('../src/channels.js');
 await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,created_by,created_at) VALUES (?,'creation','Creation','9201',?)").bind(org,new Date().toISOString()).run();
 const root=await postMessage(env.DB,{orgId:org,key:'b:creation',authorLogin:'user9201',body:'Create an app'});
 const made=await createApp(env.DB,{orgId:org,by:'9201',name:'Inherited',columns:[{id:'title',name:'Title',type:'text'}],sourceThreadId:root.row.id});expect(await env.DB.prepare('SELECT channel FROM hx_app_links WHERE app_id=?').bind(made.app.id).first()).toEqual({channel:'b:creation'});
 expect((await (await request('GET',owner,{},made.app.id)).json()).source.threadId).toBe(root.row.id);
 const count=await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_apps').first();
 expect((await createApp(env.DB,{orgId:org,by:'9201',name:'Invalid',columns:[],sourceThreadId:'missing'})).status).toBe(404);
 expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_apps').first()).toEqual(count);
});

test('Activity and app inbox share scoped mentions, read state and revoked access',async()=>{
 const activity=async(token)=>await (await fetchWorker(new Request('https://test/channels/activity?orgId='+encodeURIComponent(org),{headers:{'x-session-token':token}}))).json();
 const read=async(token,items)=>fetchWorker(new Request('https://test/channels/read',{method:'POST',headers:{'x-session-token':token,'content-type':'application/json'},body:JSON.stringify({orgId:org,channel:'activity',...(items?{items}:{})})}));
 await post(owner,'@user9202 record mention','activity_request_1',{tableId:app.tableId,rowId:row.id});
 const first=(await activity(member)).items.find(i=>i.app);expect(first).toMatchObject({type:'mention',unread:true,app:{id:app.id,tableId:app.tableId,rowId:row.id},message:{body:'@user9202 record mention'}});
 expect((await activity(owner)).items.filter(i=>i.app)).toEqual([]);
 await read(owner,[first.key]);expect((await activity(member)).items.find(i=>i.app).unread).toBe(true);
 expect((await read(member,[first.key])).status).toBe(200);
 expect((await (await featureRequest('conversation-notifications','GET',member)).json()).items[0].readAt).toBeTruthy();
 await post(owner,'@user9202 next','activity_request_2');
 const bell=(await (await featureRequest('conversation-notifications','GET',member)).json()).items[0];
 await featureRequest('conversation-notifications','POST',member,{messageId:bell.messageId});
 expect((await activity(member)).items.filter(i=>i.app&&i.unread)).toEqual([]);
 await post(owner,'@user9202 last','activity_request_3');await read(member);
 expect((await activity(member)).items.filter(i=>i.app&&i.unread)).toEqual([]);
 await env.DB.prepare('DELETE FROM hx_rows WHERE org_id=? AND id=?').bind(org,row.id).run();
 expect((await activity(member)).items.some(i=>i.key===first.key)).toBe(false);
 await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES (?,?,'private',1)").bind(org,app.id).run();
 expect((await activity(member)).items.filter(i=>i.app)).toEqual([]);
});


test('a missing source at commit rolls back app, table and completion announcement',async()=>{
 const root=await privateSource();
 const {createApp}=await import('../src/harness/apps.js');
 const before=await env.DB.prepare('SELECT (SELECT COUNT(*) FROM hx_apps) AS apps,(SELECT COUNT(*) FROM hx_tables) AS tables').first();
 await env.DB.exec(`CREATE TRIGGER remove_source_during_creation BEFORE INSERT ON hx_apps BEGIN UPDATE channel_messages SET deleted_at='gone' WHERE id='${root.id}'; END;`);
 try {
  expect(await createApp(env.DB,{orgId:org,by:'9201',name:'Must roll back',columns:[{name:'Task',type:'text'}],sourceThreadId:root.id},{announceInSource:true})).toMatchObject({status:409});
  expect(await env.DB.prepare('SELECT (SELECT COUNT(*) FROM hx_apps) AS apps,(SELECT COUNT(*) FROM hx_tables) AS tables').first()).toEqual(before);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM channel_messages WHERE id LIKE 'app-created-%'").first()).n).toBe(0);
 }finally{await env.DB.exec('DROP TRIGGER remove_source_during_creation');}
});

test.each([['source','revoked'],['source','private'],['source','public'],['channel','revoked'],['channel','private'],['channel','public']])('app publication rolls back if %s room access becomes %s immediately before commit',async(kind,change)=>{
 const root=await privateSource();
 await env.DB.prepare("UPDATE businesses SET private=? WHERE org_id=? AND slug='confidential'").bind(change==='public'?1:0,org).run();
 const room=await env.DB.prepare("SELECT created_at FROM businesses WHERE org_id=? AND slug='confidential'").bind(org).first();
 await env.DB.prepare("INSERT INTO hx_app_generation_jobs(org_id,user_id,request_id,fingerprint,lease_token,lease_until,status,generated) VALUES (?,'9201','race_request_0001','f','lease',9999999999999,'running','{}')").bind(org).run();
 const before=await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM hx_apps) apps,(SELECT COUNT(*) FROM hx_tables) tables,
  (SELECT COUNT(*) FROM hx_rows) rows,(SELECT COUNT(*) FROM hx_app_versions) versions,
  (SELECT COUNT(*) FROM hx_app_links) links,(SELECT COUNT(*) FROM channel_messages) messages`).first();
 let injected=false;
 const db=new Proxy(env.DB,{get(target,prop){
  if(prop==='batch')return async statements=>{
   if(!injected){injected=true;await target.prepare("UPDATE businesses SET private=? WHERE org_id=? AND slug='confidential'").bind(change==='public'?0:1,org).run();
    if(change==='revoked')await target.prepare("DELETE FROM conversation_members WHERE org_id=? AND channel='b:confidential' AND login='user9201'").bind(org).run();}
   return target.batch(statements);
  };
  const value=target[prop];return typeof value==='function'?value.bind(target):value;
 }});
 const made=await createApp(db,{orgId:org,by:'9201',name:'Must not publish',columns:[{name:'Title',type:'text'}],sample:[{Title:'Sample'}],
  ...(kind==='source'?{sourceThreadId:root.id}:{channel:'b:confidential',channelCreatedAt:room.created_at,privateByDefault:change==='public'})},
  {announceInSource:true,commitGuard:id=>db.prepare("UPDATE hx_app_generation_jobs SET status='complete',app_id=? WHERE org_id=? AND request_id='race_request_0001'").bind(id,org)});
 expect(injected).toBe(true);expect(made).toMatchObject({status:409});
 expect(await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM hx_apps) apps,(SELECT COUNT(*) FROM hx_tables) tables,
  (SELECT COUNT(*) FROM hx_rows) rows,(SELECT COUNT(*) FROM hx_app_versions) versions,
  (SELECT COUNT(*) FROM hx_app_links) links,(SELECT COUNT(*) FROM channel_messages) messages`).first()).toEqual(before);
 expect(await env.DB.prepare("SELECT status,app_id FROM hx_app_generation_jobs WHERE org_id=? AND request_id='race_request_0001'").bind(org).first()).toEqual({status:'running',app_id:null});
});
test.each([['plain','removed'],['source','removed'],['plain','Guest'],['source','Guest'],['plain','purging'],['source','purging']])('workspace %s app commit rolls back when membership is %s',async(kind,change)=>{
 const root=kind==='source'?await privateSource():null;
 expect(await env.DB.prepare('SELECT 1 FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,'9201').first()).toBeTruthy();
 await env.DB.prepare("INSERT INTO hx_app_generation_jobs(org_id,user_id,request_id,fingerprint,lease_token,lease_until,status,generated) VALUES (?,'9201','membership_race_001','f','lease',9999999999999,'running','{}')").bind(org).run();
 const counts=()=>env.DB.prepare(`SELECT (SELECT COUNT(*) FROM hx_apps) apps,(SELECT COUNT(*) FROM hx_tables) tables,(SELECT COUNT(*) FROM hx_rows) rows,
  (SELECT COUNT(*) FROM hx_app_versions) versions,(SELECT COUNT(*) FROM hx_app_links) links,(SELECT COUNT(*) FROM channel_messages) messages`).first();
 const before=await counts();
 let injected=false;
 const db=new Proxy(env.DB,{get(target,prop){
  if(prop==='batch')return async statements=>{
   if(!injected){injected=true;
    if(change==='removed')await target.prepare('DELETE FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,'9201').run();
    else if(change==='Guest')await target.prepare("UPDATE memberships SET role='Guest' WHERE org_id=? AND user_github_id=?").bind(org,'9201').run();
    else await target.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at,purge_started_at) VALUES(?,'now','9201','now','now')").bind(org).run();
   }
   return target.batch(statements);
  };
  const value=target[prop];return typeof value==='function'?value.bind(target):value;
 }});
 const result=await createApp(db,{orgId:org,by:'9201',name:'Removed member',columns:[{name:'Title',type:'text'}],sample:[{Title:'Sample'}],...(root?{sourceThreadId:root.id}:{})},
  {announceInSource:true,commitGuard:id=>db.prepare("UPDATE hx_app_generation_jobs SET status='complete',app_id=? WHERE org_id=? AND request_id='membership_race_001'").bind(id,org)});
 expect(injected).toBe(true);expect(result).toMatchObject({status:403});expect(await counts()).toEqual(before);
 expect(await env.DB.prepare("SELECT status,app_id FROM hx_app_generation_jobs WHERE org_id=? AND request_id='membership_race_001'").bind(org).first()).toEqual({status:'running',app_id:null});
});

test('publication preserves direct and private creation and supports DM, group and agent source threads',async()=>{
 const {postMessage}=await import('../src/channels.js');
 const plain=await createApp(env.DB,{orgId:org,by:'9201',name:'Plain',columns:[{name:'Title',type:'text'}]});
 expect(plain.app).toBeTruthy();
 expect(await env.DB.prepare('SELECT visibility FROM hx_app_access WHERE org_id=? AND app_id=?').bind(org,plain.app.id).first()).toBeNull();
 const restricted=await createApp(env.DB,{orgId:org,by:'9201',name:'Private',columns:[{name:'Title',type:'text'}],privateByDefault:true});
 expect((await env.DB.prepare('SELECT visibility FROM hx_app_access WHERE org_id=? AND app_id=?').bind(org,restricted.app.id).first()).visibility).toBe('private');
 const group='g:0123456789abcdef';
 await env.DB.prepare('INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES(?,?,?,?)').bind(org,group,'user9201',new Date().toISOString()).run();
 const at=new Date().toISOString();
 await env.DB.prepare("INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES(?,'agent1','agent1','Agent','','team','user9202',?,?)").bind(org,at,at).run();
 await env.DB.prepare("INSERT INTO hx_agent_profiles(org_id,agent_id,access,updated_at) VALUES(?,'agent1','everyone',?)").bind(org,at).run();
 for(const channel of ['dm:user9201|user9202',group,'ag:agent1|user9201']){
  const root=await postMessage(env.DB,{orgId:org,key:channel,authorLogin:'user9201',body:'Create app'});
  const made=await createApp(env.DB,{orgId:org,by:'9201',name:`From ${channel}`,columns:[{name:'Title',type:'text'}],sourceThreadId:root.row.id});
  expect(made.app).toBeTruthy();
  expect((await env.DB.prepare('SELECT visibility FROM hx_app_access WHERE org_id=? AND app_id=?').bind(org,made.app.id).first()).visibility).toBe('private');
 }
});

test.each(['guidelines','room membership','room rejoin','room replacement','source deletion','app access','workspace deletion'])('app generation fence blocks the model after %s changes',async change=>{
 const root=await privateSource();
 await env.DB.prepare('INSERT INTO hx_room_guidelines(org_id,channel,body,version,updated_by,updated_at) VALUES(?,?,?,1,?,?)').bind(org,'b:confidential','Sensitive room rule','9201',new Date().toISOString()).run();
 const made=await createApp(env.DB,{orgId:org,by:'9201',name:'Guided',columns:[{name:'Title',type:'text'}],sourceThreadId:root.id});
 const {prepareAppGuidelines}=await import('../src/harness/appGuidelinesFence.js');
 const guided=await prepareAppGuidelines(env.DB,org,{github_id:'9201',login:'user9201'},made.app.id,'Do work');
 expect(guided.request).toContain('Sensitive room rule');
 if(change==='guidelines')await env.DB.prepare("UPDATE hx_room_guidelines SET body='Changed',version=version+1 WHERE org_id=? AND channel='b:confidential'").bind(org).run();
 if(change==='room membership')await env.DB.prepare("DELETE FROM conversation_members WHERE org_id=? AND channel='b:confidential' AND login='user9201'").bind(org).run();
 if(change==='room rejoin')await env.DB.prepare("UPDATE conversation_members SET added_at='2000-01-01' WHERE org_id=? AND channel='b:confidential' AND login='user9201'").bind(org).run();
 if(change==='room replacement')await env.DB.prepare("UPDATE businesses SET created_at='2000-01-01' WHERE org_id=? AND slug='confidential'").bind(org).run();
 if(change==='source deletion')await env.DB.prepare('UPDATE channel_messages SET deleted_at=? WHERE id=?').bind(new Date().toISOString(),root.id).run();
 if(change==='app access')await env.DB.prepare("UPDATE memberships SET role='guest' WHERE org_id=? AND user_github_id='9201'").bind(org).run();
 if(change==='workspace deletion')await env.DB.prepare('INSERT INTO workspace_tombstones(org_id,deleted_at) VALUES (?,?)').bind(org,new Date().toISOString()).run();
 let dispatched=0;
 const provider=async(_system,_prompt,options)=>{if(await options.authorize())dispatched++;return '{}';};
 await guided.wrap(provider)('system',guided.request);
 expect(dispatched).toBe(0);
 expect(await guided.authorize()).toBe(false);
});

test('app generation fence composes model authorization and retains existing no-room behavior',async()=>{
 const root=await privateSource();
 await env.DB.prepare('INSERT INTO hx_room_guidelines(org_id,channel,body,version,updated_by,updated_at) VALUES(?,?,?,1,?,?)').bind(org,'b:confidential','Current rule','9201',new Date().toISOString()).run();
 const made=await createApp(env.DB,{orgId:org,by:'9201',name:'Guided',columns:[{name:'Title',type:'text'}],sourceThreadId:root.id});
 const {prepareAppGuidelines}=await import('../src/harness/appGuidelinesFence.js');
 const guided=await prepareAppGuidelines(env.DB,org,{github_id:'9201',login:'user9201'},made.app.id,'Do work');
 let calls=0;
 const provider=async(_system,_prompt,options)=>{if(await options.authorize())calls++;return '{}';};
 await guided.wrap(provider)('system',guided.request,{authorize:async()=>false});
 expect(calls).toBe(0);
 await guided.wrap(provider)('system',guided.request,{authorize:async()=>true});
 expect(calls).toBe(1);
 await env.DB.prepare("DELETE FROM conversation_members WHERE org_id=? AND channel='b:confidential' AND login='user9201'").bind(org).run();
 const plain=await prepareAppGuidelines(env.DB,org,{github_id:'9201',login:'user9201'},made.app.id,'Do work');
 expect(plain.request).toBe('Do work');
});

test.each(['database','actions','automations','custom'])('app %s generation checks captured room rules immediately before model dispatch',async kind=>{
 const root=await privateSource();
 await env.DB.prepare('INSERT INTO hx_room_guidelines(org_id,channel,body,version,updated_by,updated_at) VALUES(?,?,?,1,?,?)').bind(org,'b:confidential','Sensitive room rule','9201',new Date().toISOString()).run();
 const made=await createApp(env.DB,{orgId:org,by:'9201',name:'Guided',columns:[{name:'Title',type:'text'}],sourceThreadId:root.id});
 let checks=0,revoked=false;
 const racing=new Proxy(env.DB,{get(db,key){
  if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];
  return sql=>{const stmt=db.prepare(sql);if(!sql.startsWith('SELECT m.created_at AS memberSince'))return stmt;
   return {bind(...args){const bound=stmt.bind(...args);return {async first(){
    if(++checks===3){revoked=true;await db.prepare("DELETE FROM conversation_members WHERE org_id=? AND channel='b:confidential' AND login='user9201'").bind(org).run();}
    return bound.first();
   }}}};
  };
 }});
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 try {
  const response=await worker.fetch(new Request(`https://test/apps/${made.app.id}/${kind}`,{method:'POST',headers:{'x-session-token':owner,'content-type':'application/json'},body:JSON.stringify({orgId:org,action:'generate',prompt:'Create a tracker'})}),{...env,DB:racing,OPENAI_API_KEY:'sk-test'},testContext);
  expect(revoked).toBe(true);expect(response.status).toBe(403);expect(fetch).not.toHaveBeenCalled();
 } finally {vi.unstubAllGlobals()}
});

test('authorized app action generation sends the current room rule to the mocked model',async()=>{
 const root=await privateSource();
 await env.DB.prepare('INSERT INTO hx_room_guidelines(org_id,channel,body,version,updated_by,updated_at) VALUES(?,?,?,1,?,?)').bind(org,'b:confidential','Current approved rule','9201',new Date().toISOString()).run();
 const made=await createApp(env.DB,{orgId:org,by:'9201',name:'Guided',columns:[{name:'Title',type:'text'}],sourceThreadId:root.id});
 let sent='';
 const fetch=vi.fn(async(_url,init)=>{sent=init.body;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({name:'calculate',code:'return input;'})}}],usage:{prompt_tokens:1,completion_tokens:1}}),{headers:{'content-type':'application/json'}})});
 vi.stubGlobal('fetch',fetch);
 try {
  const response=await worker.fetch(new Request(`https://test/apps/${made.app.id}/actions`,{method:'POST',headers:{'x-session-token':owner,'content-type':'application/json'},body:JSON.stringify({orgId:org,action:'generate',prompt:'Create a calculation'})}),{...env,OPENAI_API_KEY:'sk-test'},testContext);
  expect(response.status).toBe(200);expect(fetch).toHaveBeenCalledTimes(1);expect(sent).toContain('Current approved rule');
 } finally {vi.unstubAllGlobals()}
});

test('app action generation discards the result when its source access ends during the mocked model request',async()=>{
 const root=await privateSource();
 await env.DB.prepare('INSERT INTO hx_room_guidelines(org_id,channel,body,version,updated_by,updated_at) VALUES(?,?,?,1,?,?)').bind(org,'b:confidential','Current rule','9201',new Date().toISOString()).run();
 const made=await createApp(env.DB,{orgId:org,by:'9201',name:'Guided',columns:[{name:'Title',type:'text'}],sourceThreadId:root.id});
 const fetch=vi.fn(async()=>{
  await env.DB.prepare("DELETE FROM conversation_members WHERE org_id=? AND channel='b:confidential' AND login='user9201'").bind(org).run();
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({name:'private_action',code:'return input;'})}}],usage:{prompt_tokens:1,completion_tokens:1}}),{headers:{'content-type':'application/json'}});
 });
 vi.stubGlobal('fetch',fetch);
 try {
  const response=await worker.fetch(new Request(`https://test/apps/${made.app.id}/actions`,{method:'POST',headers:{'x-session-token':owner,'content-type':'application/json'},body:JSON.stringify({orgId:org,action:'generate',prompt:'Create a calculation'})}),{...env,OPENAI_API_KEY:'sk-test'},testContext);
  expect(fetch).toHaveBeenCalledTimes(1);expect(response.status).toBe(403);expect(JSON.stringify(await response.json())).not.toContain('private_action');
 } finally {vi.unstubAllGlobals()}
});

test('combined schema and room checks discard custom output when room access ends during the final schema check',async()=>{
 const root=await privateSource();
 await env.DB.prepare('INSERT INTO hx_room_guidelines(org_id,channel,body,version,updated_by,updated_at) VALUES(?,?,?,1,?,?)').bind(org,'b:confidential','Current rule','9201',new Date().toISOString()).run();
 const made=await createApp(env.DB,{orgId:org,by:'9201',name:'Guided',columns:[{name:'Title',type:'text'}],sourceThreadId:root.id});
 let sent=false,afterModelChecks=0,revoked=false;
 const racing=new Proxy(env.DB,{get(db,key){
  if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];
  return sql=>{const stmt=db.prepare(sql);if(!sql.startsWith('SELECT 1 AS allowed FROM memberships m'))return stmt;
   return {bind(...args){const bound=stmt.bind(...args);return {async first(){
    const result=await bound.first();
    if(sent && ++afterModelChecks===2){revoked=true;await db.prepare("DELETE FROM conversation_members WHERE org_id=? AND channel='b:confidential' AND login='user9201'").bind(org).run()}
    return result;
   }}}};
  };
 }});
 const fetch=vi.fn(async()=>{sent=true;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({html:'<p>Private result</p>'})}}],usage:{prompt_tokens:1,completion_tokens:1}}),{headers:{'content-type':'application/json'}})});
 vi.stubGlobal('fetch',fetch);
 try {
  const response=await worker.fetch(new Request(`https://test/apps/${made.app.id}/custom`,{method:'POST',headers:{'x-session-token':owner,'content-type':'application/json'},body:JSON.stringify({orgId:org,action:'generate',prompt:'Create a tracker'})}),{...env,DB:racing,OPENAI_API_KEY:'sk-test'},testContext);
  expect(revoked).toBe(true);expect(response.status).toBe(403);expect(JSON.stringify(await response.json())).not.toContain('Private result');
 } finally {vi.unstubAllGlobals()}
});

test('database generation releases the model reservation when the prompt is rejected before dispatch',async()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 try {
  const response=await worker.fetch(new Request(`https://test/apps/${app.id}/database`,{method:'POST',headers:{'x-session-token':owner,'content-type':'application/json'},body:JSON.stringify({orgId:org,action:'generate',prompt:''})}),{...env,OPENAI_API_KEY:'sk-test'},testContext);
  expect(response.status).toBe(400);expect(fetch).not.toHaveBeenCalled();
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM ai_reservations WHERE user_github_id=?').bind('9201').first()).toEqual({count:0});
 } finally {vi.unstubAllGlobals()}
});

test.each(['schema','room'])('database generation rechecks %s access after reservation cleanup',async changed=>{
 const root=await privateSource();
 await env.DB.prepare('INSERT INTO hx_room_guidelines(org_id,channel,body,version,updated_by,updated_at) VALUES(?,?,?,1,?,?)').bind(org,'b:confidential','Current rule','9201',new Date().toISOString()).run();
 const made=await createApp(env.DB,{orgId:org,by:'9201',name:'Guided',columns:[{name:'Title',type:'text'}],sourceThreadId:root.id});
 let injected=false;
 const racing=new Proxy(env.DB,{get(db,key){
  if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];
  return sql=>{const stmt=db.prepare(sql);if(sql!=='DELETE FROM ai_reservations WHERE id = ?1')return stmt;
   return {bind(...args){const bound=stmt.bind(...args);return {async run(){
    const result=await bound.run();injected=true;
    if(changed==='schema')await db.prepare("UPDATE hx_tables SET name='Changed after cleanup' WHERE org_id=? AND id=?").bind(org,made.app.tableId).run();
    else await db.prepare("DELETE FROM conversation_members WHERE org_id=? AND channel='b:confidential' AND login='user9201'").bind(org).run();
    return result;
   }}}};
  };
 }});
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 try {
  const response=await worker.fetch(new Request(`https://test/apps/${made.app.id}/database`,{method:'POST',headers:{'x-session-token':owner,'content-type':'application/json'},body:JSON.stringify({orgId:org,action:'generate',prompt:'x'.repeat(4001)})}),{...env,DB:racing,OPENAI_API_KEY:'sk-test'},testContext);
  expect(injected).toBe(true);expect(response.status).toBe(changed==='schema'?404:403);expect(fetch).not.toHaveBeenCalled();
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM ai_reservations WHERE user_github_id=?').bind('9201').first()).toEqual({count:0});
 } finally {vi.unstubAllGlobals()}
});

test.each(['before dispatch','before response'])('combined generation rejects schema access revoked during the last room check %s',async phase=>{
 const root=await privateSource();
 await env.DB.prepare('INSERT INTO hx_room_guidelines(org_id,channel,body,version,updated_by,updated_at) VALUES(?,?,?,1,?,?)').bind(org,'b:confidential','Current rule','9201',new Date().toISOString()).run();
 const made=await createApp(env.DB,{orgId:org,by:'9201',name:'Guided',columns:[{name:'Secret Schema',type:'text'}],sourceThreadId:root.id});
 const otherApp=await createApp(env.DB,{orgId:org,by:'9202',name:'Private owner app',columns:[{name:'Title',type:'text'}]});
 await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES(?,?,'private',1) ON CONFLICT(org_id,app_id) DO UPDATE SET visibility='private'").bind(org,otherApp.app.id).run();
 let sent=false,checks=0,revoked=false;
 const racing=new Proxy(env.DB,{get(db,key){
  if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];
  return sql=>{const stmt=db.prepare(sql);
   if(sql.startsWith('SELECT 1 AS allowed FROM memberships m'))return {bind(...args){const bound=stmt.bind(...args);return {async first(){const result=await bound.first();checks++;return result;}}}};
   if(!sql.startsWith('SELECT m.created_at AS memberSince'))return stmt;
   return {bind(...args){const bound=stmt.bind(...args);return {async first(){
    if(!revoked && ((phase==='before dispatch' && !sent && checks>=2) || (phase==='before response' && sent && checks>=4))){
     revoked=true;await db.prepare("INSERT INTO hx_app_entities(org_id,app_id,entity_key,table_id) VALUES(?,?,'linked',?)").bind(org,otherApp.app.id,made.app.tableId).run();
    }
    return bound.first();
   }}}};
  };
 }});
 const fetch=vi.fn(async()=>{sent=true;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({html:'<p>Secret result</p>'})}}],usage:{prompt_tokens:1,completion_tokens:1}}),{headers:{'content-type':'application/json'}})});
 vi.stubGlobal('fetch',fetch);
 try {
  const response=await worker.fetch(new Request(`https://test/apps/${made.app.id}/custom`,{method:'POST',headers:{'x-session-token':owner,'content-type':'application/json'},body:JSON.stringify({orgId:org,action:'generate',prompt:'Create a tracker'})}),{...env,DB:racing,OPENAI_API_KEY:'sk-test'},testContext);
  expect(revoked).toBe(true);
  if(phase==='before dispatch')expect(fetch).not.toHaveBeenCalled();
  expect(response.status).toBe(404);
  expect(JSON.stringify(await response.json())).not.toContain('Secret result');
 } finally {vi.unstubAllGlobals()}
});
