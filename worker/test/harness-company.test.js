import { env } from 'cloudflare:test';
import { fetchMock } from './helpers/fetch-mock.js';
import { beforeEach,afterEach,test,expect } from 'vitest';
import worker from '../src/index.js';
import { createSession,upsertUser,upsertMembership } from '../src/db.js';
import { generateAction,connectionEndpoint } from '../src/harness/appCapabilities.js';
import { applyMigration } from '../src/harness/appDatabase.js';
const orgId='personal:company';let owner,member,app;
const call=(path,token,body)=>worker.fetch(new Request('https://example.com'+path+(body?'':`${path.includes('?')?'&':'?'}orgId=${orgId}`),{method:body?'POST':'GET',headers:{'content-type':'application/json','x-session-token':token},...(body?{body:JSON.stringify({orgId,...body})}:{})}),{...env});
const run=(sub,body,token=owner)=>call(`/apps/${app.id}/${sub}`,token,body);
beforeEach(async()=>{
 for(const [id,role] of [['1','admin'],['2','member']]){await upsertUser(env.DB,{githubId:id,login:'user'+id,name:id});await upsertMembership(env.DB,orgId,id,role);}
 owner=await createSession(env.DB,'1','gho1');member=await createSession(env.DB,'2','gho2');
 app=(await (await call('/apps',owner,{name:'Tasks',columns:[{name:'Task',type:'text'}]})).json()).app;
});
afterEach(()=>fetchMock.deactivate());
test('migration replay, conflict, partial failure and private entity ACL',async()=>{
 const operations=[{op:'create_entity',entity:'customers',name:'Customers',columns:[{name:'Name',type:'text'}]},{op:'add_columns',entity:'primary',columns:[{name:'Amount',type:'number'}]}];
 const req={action:'migrate',id:'customers_v1',version:0,operations};
 expect((await run('database',req,member)).status).toBe(403);
 expect(await (await run('database',req)).json()).toMatchObject({applied:true,version:1});
 expect(await (await run('database',req)).json()).toMatchObject({replay:true,version:1});
 expect((await run('database',{...req,operations:operations.slice(0,1)})).status).toBe(409);
 expect((await run('database',{...req,id:'another'})).status).toBe(409);
 const data=await (await run('database')).json();expect(data.entities).toHaveLength(2);expect(data.entities[0].table.columns).toHaveLength(2);
 const table=data.entities.find(e=>e.key==='customers').table;
 expect((await call('/tables/'+table.id,member)).status).toBe(200);
 await worker.fetch(new Request(`https://example.com/apps/${app.id}/access`,{method:'PUT',headers:{'content-type':'application/json','x-session-token':owner},body:JSON.stringify({orgId,version:0,visibility:'private'})}),{...env});
 expect((await call('/tables/'+table.id,member)).status).toBe(404);
 expect((await run('database',undefined,member)).status).toBe(404);
 expect((await run('database',{action:'migrate',id:'bad',version:1,operations:[{op:'create_entity',entity:'new_entity',name:'New',columns:[{name:'Name'}]},{op:'drop_entity',entity:'primary'}]})).status).toBe(400);
 expect((await (await run('database')).json()).entities).toHaveLength(2);
});
test('renaming a database column preserves its stable ID and existing row values',async()=>{
 const inserted=await worker.fetch(new Request(`https://example.com/tables/${app.tableId}/rows`,{method:'POST',headers:{'content-type':'application/json','x-session-token':owner},body:JSON.stringify({orgId,values:{task:'Keep this value'}})}),{...env});
 const row=(await inserted.json()).row;
 const request={id:'rename_task_v1',version:0,operations:[{op:'rename_column',entity:'primary',column:'task',name:'Title'}]};
 const preview=await (await run('database',{action:'preview',...request})).json();
 expect(preview).toMatchObject({canApply:true,changes:[{operations:['rename_column'],rowsScanned:0}]});
 expect(await (await run('database',{action:'migrate',...request,previewChecksum:preview.previewChecksum})).json()).toMatchObject({applied:true,version:1});
 const data=await (await call(`/tables/${app.tableId}`,owner)).json();
 expect(data.table.columns).toEqual([{id:'task',name:'Title',type:'text'}]);
 expect(data.rows[0]).toMatchObject({id:row.id,values:{task:'Keep this value'}});
});
test('data migrations preview strict conversions, reject stale rows, and only drop empty columns',async()=>{
 const add={action:'migrate',id:'amount_text_v1',version:0,operations:[{op:'add_columns',entity:'primary',columns:[{name:'Amount',type:'text'},{name:'Flag',type:'checkbox'},{name:'Score',type:'number'},{name:'Unused',type:'text'}]}]};
 expect((await run('database',add)).status).toBe(200);
 const addRow=async values=>worker.fetch(new Request(`https://example.com/tables/${app.tableId}/rows`,{method:'POST',headers:{'content-type':'application/json','x-session-token':owner},body:JSON.stringify({orgId,values})}),{...env});
 const first=await (await addRow({task:'first',amount:'12.5',flag:false,score:0,unused:null})).json();
 const second=await (await addRow({task:'second',amount:'invalid',flag:null,score:null,unused:null})).json();
 await env.DB.prepare("UPDATE hx_rows SET data=json_set(data,'$.unused','') WHERE org_id=?1 AND id=?2").bind(orgId,second.row.id).run();
 const convert={id:'convert_amount_v2',version:1,operations:[{op:'convert_column',entity:'primary',column:'amount',type:'number'}]};
 const blocked=await (await run('database',{action:'preview',...convert})).json();
 expect(blocked).toMatchObject({canApply:false,blockerCount:1});
 expect(blocked.blockers[0]).toMatchObject({id:second.row.id,column:'Amount'});
 expect((await run('database',{action:'migrate',...convert,previewChecksum:blocked.previewChecksum})).status).toBe(409);

 const repair=await worker.fetch(new Request(`https://example.com/tables/${app.tableId}/rows/${second.row.id}`,{method:'PATCH',headers:{'content-type':'application/json','x-session-token':owner},body:JSON.stringify({orgId,values:{amount:'0'},expectedUpdatedAt:second.row.updatedAt})}),{...env});
 expect(repair.status).toBe(200);
 const preview=await (await run('database',{action:'preview',...convert})).json();
 expect(preview).toMatchObject({canApply:true,blockerCount:0});
 expect(preview.changes[0].rowsChanged).toBe(2);
 expect(preview.changes[0].examples.find(example=>example.after.amount===12.5)).toBeTruthy();

 const staleRow=(await (await call(`/tables/${app.tableId}`,owner)).json()).rows.find(row=>row.id===first.row.id);
 const mutateAfterPreview=await worker.fetch(new Request(`https://example.com/tables/${app.tableId}/rows/${first.row.id}`,{method:'PATCH',headers:{'content-type':'application/json','x-session-token':owner},body:JSON.stringify({orgId,values:{amount:'6'},expectedUpdatedAt:staleRow.updatedAt})}),{...env});
 expect(mutateAfterPreview.status).toBe(200);
 expect((await run('database',{action:'migrate',...convert,previewChecksum:preview.previewChecksum})).status).toBe(409);
 expect((await (await call(`/tables/${app.tableId}`,owner)).json()).table.columns.find(column=>column.id==='amount').type).toBe('text');

 const fresh=await (await run('database',{action:'preview',...convert})).json();
 const raceDb={prepare:(...args)=>env.DB.prepare(...args),batch:async statements=>{
   const newer=new Date(Date.now()+1000).toISOString();
   await env.DB.prepare("UPDATE hx_rows SET data=json_set(data,'$.amount','8'),updated_at=?1 WHERE org_id=?2 AND id=?3").bind(newer,orgId,first.row.id).run();
   return env.DB.batch(statements);
 }};
 expect(await applyMigration(raceDb,orgId,app,{...convert,previewChecksum:fresh.previewChecksum},'1')).toMatchObject({status:409});
 expect((await (await run('database')).json()).version).toBe(1);
 const afterRace=await (await run('database',{action:'preview',...convert})).json();
 expect(await (await run('database',{action:'migrate',...convert,previewChecksum:afterRace.previewChecksum})).json()).toMatchObject({applied:true,version:2});
 expect(await (await run('database',{action:'migrate',...convert,previewChecksum:afterRace.previewChecksum})).json()).toMatchObject({replay:true,version:2});
 const migrated=await (await call(`/tables/${app.tableId}`,owner)).json();
 expect(migrated.table.columns.find(column=>column.id==='amount').type).toBe('number');
 expect(migrated.rows.find(row=>row.id===first.row.id).values.amount).toBe(8);
 expect(migrated.rows.find(row=>row.id===second.row.id).values.amount).toBe(0);

 const dropFlag={id:'drop_flag_v3',version:2,operations:[{op:'drop_empty_column',entity:'primary',column:'flag'}]};
 const flagPreview=await (await run('database',{action:'preview',...dropFlag})).json();
 expect(flagPreview).toMatchObject({canApply:false,blockerCount:1});
 expect(flagPreview.blockers[0]).toMatchObject({column:'Flag',id:first.row.id});
 const dropScore={id:'drop_score_v3',version:2,operations:[{op:'drop_empty_column',entity:'primary',column:'score'}]};
 expect((await (await run('database',{action:'preview',...dropScore})).json())).toMatchObject({canApply:false,blockerCount:1});
 const dropUnused={id:'drop_unused_v3',version:2,operations:[{op:'drop_empty_column',entity:'primary',column:'unused'}]};
 const emptyPreview=await (await run('database',{action:'preview',...dropUnused})).json();
 expect(emptyPreview).toMatchObject({canApply:true,blockerCount:0});
 expect((await run('database',{action:'migrate',...dropUnused,previewChecksum:emptyPreview.previewChecksum})).status).toBe(200);
 expect((await (await call(`/tables/${app.tableId}`,owner)).json()).table.columns.some(column=>column.id==='unused')).toBe(false);
});
test('data migrations convert person and exact-match relation references, guarding target rows at commit',async()=>{
 const created=await run('database',{action:'migrate',id:'people_entity_v1',version:0,operations:[{op:'create_entity',entity:'people',name:'People',columns:[{name:'Name',type:'text'}]}]});
 expect(created.status).toBe(200);
 const peopleTable=(await (await run('database')).json()).entities.find(entity=>entity.key==='people').table;
 const addPerson=async name=>(await call(`/tables/${peopleTable.id}/rows`,owner,{values:{name}})).json();
 const targetOne=await addPerson('One'),targetTwo=await addPerson('Two');
 expect(targetOne.row).toBeTruthy();expect(targetTwo.row).toBeTruthy();
 await run('database',{action:'migrate',id:'reference_sources_v2',version:1,operations:[{op:'add_columns',entity:'primary',columns:[{name:'Assignee text',type:'text'},{name:'Related text',type:'text'},{name:'Related many text',type:'text'}]}]});
 const source=(await (await call(`/tables/${app.tableId}/rows`,owner,{values:{task:'reference source','assignee_text':'@user1','related_text':'Missing','related_many_text':JSON.stringify(['One','Two'])}})).json()).row;
 const request={id:'convert_references_v3',version:2,operations:[
  {op:'convert_column',entity:'primary',column:'assignee_text',type:'person'},
  {op:'convert_column',entity:'primary',column:'related_text',type:'relation',targetEntity:'people',multiple:false,matchBy:'name'},
  {op:'convert_column',entity:'primary',column:'related_many_text',type:'relation',targetEntity:'people',multiple:true,matchBy:'name'},
 ]};
 const blocked=await (await run('database',{action:'preview',...request})).json();
 expect(blocked).toMatchObject({canApply:false,blockerCount:1});
 expect(blocked.blockers[0]).toMatchObject({entity:'primary',id:source.id,column:'Related text'});
 await env.DB.prepare("UPDATE hx_rows SET data=json_set(data,'$.related_text',?1),updated_at=?2 WHERE org_id=?3 AND id=?4").bind('One',new Date().toISOString(),orgId,source.id).run();
 const duplicate=await addPerson('One');
 const ambiguous=await (await run('database',{action:'preview',...request})).json();
 expect(ambiguous).toMatchObject({canApply:false,blockerCount:1});
 expect(ambiguous.blockers[0]).toMatchObject({id:source.id,column:'Related text'});
 await env.DB.prepare('DELETE FROM hx_rows WHERE org_id=?1 AND table_id=?2 AND id=?3').bind(orgId,peopleTable.id,duplicate.row.id).run();
 const preview=await (await run('database',{action:'preview',...request})).json();
 expect(preview).toMatchObject({canApply:true,blockerCount:0});
 const racingDb={prepare:(...args)=>env.DB.prepare(...args),batch:async statements=>{
   await env.DB.prepare('DELETE FROM hx_rows WHERE org_id=?1 AND table_id=?2 AND id=?3').bind(orgId,peopleTable.id,targetTwo.row.id).run();
   return env.DB.batch(statements);
 }};
 expect(await applyMigration(racingDb,orgId,app,{...request,previewChecksum:preview.previewChecksum},'1')).toMatchObject({status:409});
 const replacement=await addPerson('Replacement');
 await env.DB.prepare("UPDATE hx_rows SET data=json_set(data,'$.related_many_text',?1),updated_at=?2 WHERE org_id=?3 AND id=?4").bind(JSON.stringify(['One','Replacement']),new Date().toISOString(),orgId,source.id).run();
 const fresh=await (await run('database',{action:'preview',...request})).json();
 expect(fresh).toMatchObject({canApply:true,blockerCount:0});
 expect(fresh.changes[0].examples[0].relationMatches).toEqual(expect.arrayContaining([
  {column:'related_text',targetEntity:'people',matches:[{label:'One',recordId:targetOne.row.id,matchBy:'name'}]},
  {column:'related_many_text',targetEntity:'people',matches:[{label:'One',recordId:targetOne.row.id,matchBy:'name'},{label:'Replacement',recordId:replacement.row.id,matchBy:'name'}]},
 ]));
 expect(await (await run('database',{action:'migrate',...request,previewChecksum:fresh.previewChecksum})).json()).toMatchObject({applied:true,version:3});
 const migrated=await (await call(`/tables/${app.tableId}`,owner)).json();
 expect(migrated.table.columns.find(column=>column.id==='assignee_text').type).toBe('person');
 expect(migrated.table.columns.find(column=>column.id==='related_text')).toMatchObject({type:'relation',targetEntity:'people',multiple:false});
 expect(migrated.table.columns.find(column=>column.id==='related_many_text')).toMatchObject({type:'relation',targetEntity:'people',multiple:true});
 expect(migrated.rows.find(row=>row.id===source.id).values).toMatchObject({assignee_text:'user1',related_text:targetOne.row.id,related_many_text:[targetOne.row.id,replacement.row.id]});
 await run('database',{action:'migrate',id:'empty_relation_v4',version:3,operations:[{op:'add_columns',entity:'primary',columns:[{name:'Unused links',type:'relation',targetEntity:'people',multiple:true}]}]});
 const emptyRelation={id:'drop_empty_relation_v5',version:4,operations:[{op:'drop_empty_column',entity:'primary',column:'unused_links'}]};
 const emptyRelationPreview=await (await run('database',{action:'preview',...emptyRelation})).json();
 expect(emptyRelationPreview).toMatchObject({canApply:true,blockerCount:0});
 expect(await (await run('database',{action:'migrate',...emptyRelation,previewChecksum:emptyRelationPreview.previewChecksum})).json()).toMatchObject({applied:true,version:5});
 expect((await (await call(`/tables/${app.tableId}`,owner)).json()).table.columns.some(column=>column.id==='unused_links')).toBe(false);
});
test('private preview writes never affect production and reject stale or invalid data',async()=>{
 const {fork}=await (await run('database',{action:'fork'})).json();
 const req={action:'fork_write',forkId:fork.id,revision:fork.revision,entity:'primary',operation:'create',values:{task:'preview only'}};
 expect((await run('database',req)).status).toBe(200);expect((await run('database',req)).status).toBe(409);
 expect((await (await call('/tables/'+app.tableId,owner)).json()).rows).toEqual([]);
 expect((await (await run('database',undefined,member)).json()).fork).toBeNull();
 expect((await run('database',{...req,revision:2,values:{unknown:'x'}})).status).toBe(400);
 expect((await run('database',req,member)).status).toBe(403);
});
test('action publication, exact revision, idempotency and app/caller job isolation',async()=>{
 const draft={action:'draft',name:'sum',version:0,code:'return input.a + input.b'};
 expect((await run('actions',draft,member)).status).toBe(403);expect((await run('actions',draft)).status).toBe(200);
 const g=await (await call('/gateways',owner,{name:'Mac mini'})).json();
 const req={action:'run',name:'sum',version:2,gatewayId:g.gateway.id,input:{a:20,b:22},requestId:'run1'};
 expect((await run('actions',req)).status).toBe(404);
 expect((await run('actions',{action:'publish',name:'sum',version:1})).status).toBe(200);
 expect((await run('actions',{...req,version:1})).status).toBe(409);
 const {job}=await (await run('actions',req)).json();expect(job.status).toBe('queued');
 expect((await (await run('actions',req)).json()).job.id).toBe(job.id);
 expect((await run('actions',{...req,input:{a:1}})).status).toBe(409);
 expect((await run('actions?jobId='+job.id,undefined,member)).status).toBe(404);
 const b=(await (await call('/apps',owner,{name:'Other',columns:[{name:'X'}]})).json()).app;
 expect((await call(`/apps/${b.id}/actions?jobId=${job.id}`,owner)).status).toBe(404);
 expect((await run('actions',{action:'draft',name:'sum',version:2,code:'return 100'})).status).toBe(200);
 expect((await (await run('actions')).json()).actions[0].published).toBe(draft.code);
 expect(JSON.parse((await env.DB.prepare('SELECT payload FROM hx_gateway_jobs WHERE id=?1').bind(job.id).first()).payload).code).toBe(draft.code);
});
test('personal exact endpoint proxy refuses unsafe URLs, redirects and revoked connections',async()=>{
 for(const u of ['http://api.github.com/user','https://127.0.0.1/x','https://api.github.com.evil.test/x','https://api.github.com:8443/x','https://api.github.com/user?token=x','https://slack.com/api/chat.postMessage'])expect(connectionEndpoint(u)).toBeNull();
 const conf={action:'save',name:'github',version:0,endpoint:'https://api.github.com/repos/Torutesu/HonmaruAI'};
 expect((await run('connections',conf)).status).toBe(200);
 expect((await (await run('connections',undefined,member)).json()).connections).toEqual([]);
 expect((await run('connections',{action:'request',name:'github',version:1},member)).status).toBe(404);
 expect((await run('connections',{action:'request',name:'github',version:0})).status).toBe(409);
 fetchMock.activate();
 fetchMock.get('https://api.github.com').intercept({path:'/repos/Torutesu/HonmaruAI',method:'GET'}).reply(200,{name:'HonmaruAI'},{headers:{'content-type':'application/json'}});
 expect(await (await run('connections',{action:'request',name:'github',version:1})).json()).toEqual({data:{name:'HonmaruAI'}});
 fetchMock.get('https://api.github.com').intercept({path:'/repos/Torutesu/HonmaruAI',method:'GET'}).reply(302,'',{headers:{location:'https://evil.test'}});
 expect((await run('connections',{action:'request',name:'github',version:1})).status).toBe(502);
 expect((await run('connections',{...conf,version:1,enabled:false})).status).toBe(200);
 expect((await run('connections',{action:'request',name:'github',version:2})).status).toBe(404);
});
test('generation errors fail closed',async()=>{
 expect((await generateAction('sum',null)).status).toBe(503);
 expect(await generateAction('sum',async()=>'{"name":"sum","code":"return input.a + input.b"}')).toMatchObject({name:'sum'});
 expect((await generateAction('sum',async()=>'not json')).status).toBe(502);
 const wrapped=await generateAction('sum',async()=>JSON.stringify({name:'sum',code:'async function sum(input) { return input.a + input.b; }'}));
 expect(wrapped.code).toBe('return await (async function sum(input) { return input.a + input.b; })(input);');
});

test('revoked app access prevents a queued server action from being claimed',async()=>{
 await run('actions',{action:'draft',name:'sum',version:0,code:'return input'});
 await run('actions',{action:'publish',name:'sum',version:1});
 const g=await (await call('/gateways',owner,{name:'Mac'})).json();
 const result=await (await run('actions',{action:'run',name:'sum',version:2,gatewayId:g.gateway.id,input:42,requestId:'r'},member)).json();
 await worker.fetch(new Request(`https://example.com/apps/${app.id}/access`,{method:'PUT',headers:{'content-type':'application/json','x-session-token':owner},body:JSON.stringify({orgId,version:0,visibility:'private'})}),{...env});
 const claim=await worker.fetch(new Request('https://example.com/gateways/claim',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+g.token},body:'{}'}),{...env});
 expect(await claim.json()).toEqual({job:null});
 expect((await env.DB.prepare('SELECT status FROM hx_gateway_jobs WHERE id=?1').bind(result.job.id).first()).status).toBe('failed');
 expect((await call('/gateways/jobs/'+result.job.id,member)).status).toBe(404);
 const original=await env.DB.prepare('SELECT request_id FROM hx_gateway_jobs WHERE id=?1').bind(result.job.id).first();
 expect((await call('/gateways/jobs',member,{gatewayId:g.gateway.id,code:'return input',input:42,requestId:original.request_id})).status).toBe(404);
});
test('secrets require encryption, are omitted from responses, and clear on origin change',async()=>{
 const req={action:'save',name:'private_api',version:0,endpoint:'https://api.github.com/user',token:'secret-value'};
 const response=await run('connections',req);
 // This fixture has no DATA_KEY; production must never store plaintext on a missing-key deployment.
 expect(response.status).toBe(503);
 expect((await (await run('connections')).json()).connections).toEqual([]);
});

test('agent and MCP calls use published actions and recheck app visibility',async()=>{
 const {callExecutionTool}=await import('../src/harness/executionTools.js');
 const {HARNESS_TOOL_SCOPE}=await import('../src/harness/mcpTools.js');
 await env.DB.prepare("INSERT INTO org_settings (org_id,mode,updated_at) VALUES (?1,'harness','now')").bind(orgId).run();
 await run('actions',{action:'draft',name:'sum',version:0,code:'return input'});await run('actions',{action:'publish',name:'sum',version:1});
 const actor={orgId,githubId:'2'};
 const found=await callExecutionTool(env,actor,'list_app_actions',{});expect(found.structuredContent.apps[0].actions[0].publishedVersion).toBe(2);
 expect(HARNESS_TOOL_SCOPE.run_app_action).toBe('execute');
 await worker.fetch(new Request(`https://example.com/apps/${app.id}/access`,{method:'PUT',headers:{'content-type':'application/json','x-session-token':owner},body:JSON.stringify({orgId,version:0,visibility:'private'})}),{...env});
 expect((await callExecutionTool(env,actor,'list_app_actions',{})).structuredContent.apps).toEqual([]);
 expect((await callExecutionTool(env,actor,'run_app_action',{appId:app.id})).isError).toBe(true);
});

test('encrypted credentials are context-bound and cleared when the API origin changes',async()=>{
 const {useSecretKey,isSealed}=await import('../src/secrets.js');
 const {saveConnection,connections}=await import('../src/harness/appCapabilities.js');
 useSecretKey({...env,DATA_KEY:btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))});
 try {
  expect(await saveConnection(env.DB,orgId,app.id,'1',{name:'service',version:0,endpoint:'https://api.github.com/user',token:'test-credential'})).toMatchObject({saved:true});
  const row=await env.DB.prepare('SELECT token FROM hx_app_connections WHERE app_id=?1').bind(app.id).first();expect(isSealed(row.token)).toBe(true);expect(row.token).not.toContain('test-credential');
  expect(JSON.stringify(await connections(env.DB,orgId,app.id,'1'))).not.toContain('test-credential');
  expect(await saveConnection(env.DB,orgId,app.id,'1',{name:'service',version:1,endpoint:'https://api.notion.com/v1/users/me'})).toMatchObject({saved:true});
  expect((await env.DB.prepare('SELECT token FROM hx_app_connections WHERE app_id=?1').bind(app.id).first()).token).toBeNull();
 }finally{useSecretKey({});}
});

test('external writes are constrained to the approved method/path and never replayed after uncertain failures',async()=>{
 const endpoint='https://api.github.com/repos/owner/repo/issues';
 expect((await run('connections',{action:'save',name:'issues',version:0,endpoint,method:'POST'})).status).toBe(200);
 expect(connectionEndpoint('https://www.googleapis.com/compute/v1/projects/x','POST')).toBeNull();
 fetchMock.activate();
 let calls=0;
 fetchMock.get('https://api.github.com').intercept({path:'/repos/owner/repo/issues',method:'POST'}).reply(201,opts=>{calls++;expect(JSON.parse(opts.body)).toEqual({title:'Test only'});return {number:1};},{headers:{'content-type':'application/json'}});
 const req={action:'request',name:'issues',version:1,requestId:'write1',body:{title:'Test only'}};
 expect((await run('connections',req)).status).toBe(200);
 expect((await run('connections',req)).status).toBe(409);expect(calls).toBe(1);
 fetchMock.get('https://api.github.com').intercept({path:'/repos/owner/repo/issues',method:'POST'}).replyWithError(new Error('network failure'));
 expect((await run('connections',{...req,requestId:'write2'})).status).toBe(502);
 expect((await run('connections',{...req,requestId:'write2'})).status).toBe(409);
 expect((await env.DB.prepare("SELECT status FROM hx_app_connection_requests WHERE request_id='write2'").first()).status).toBe('unknown');
});

test('reviewed preview merge is atomic, scoped, replayable and seals the preview',async()=>{
 await env.DB.prepare("INSERT INTO org_settings (org_id,mode,updated_at) VALUES (?1,'harness','now') ON CONFLICT(org_id) DO UPDATE SET mode='harness',updated_at='now'").bind(orgId).run();
 const automation=await call('/workflows',owner,{name:'Handle merged app records',enabled:true,trigger:{type:'app_record_change',appId:app.id,entityId:'primary',events:['insert']},steps:[{type:'update_row',values:{task:'Handled by workflow'}}]});
 expect(automation.status).toBe(201);
 const {workflow}=await automation.json();
 const {fork}=await (await run('database',{action:'fork'})).json();
 await run('database',{action:'fork_write',forkId:fork.id,revision:1,entity:'primary',operation:'create',values:{task:'Merged record'}});
 const request={forkId:fork.id,revision:2};
 expect((await run('database',{action:'merge_preview',...request},member)).status).toBe(403);
 const review=await (await run('database',{action:'merge_preview',...request})).json();
 expect(review.changes).toMatchObject([{operation:'create',after:{task:'Merged record'}}]);expect(review.conflicts).toEqual([]);expect(review.snapshots).toBeUndefined();
 expect((await (await call('/tables/'+app.tableId,owner)).json()).rows).toEqual([]);
 expect((await run('database',{action:'merge_apply',...request,checksum:'wrong'})).status).toBe(409);
 const merge={action:'merge_apply',...request,checksum:review.checksum};
 const applied=await (await run('database',merge)).json();
 expect(applied).toMatchObject({merged:true,changed:1});
 expect(applied).not.toHaveProperty('changedRecords');
 expect(await (await run('database',merge)).json()).toMatchObject({merged:true,replay:true});
 expect((await (await call('/tables/'+app.tableId,owner)).json()).rows).toMatchObject([{values:{task:'Handled by workflow'}}]);
 const {runs}=await (await call(`/workflows/${workflow.id}`,owner)).json();
 expect(runs).toHaveLength(1);
 expect(runs[0]).toMatchObject({trigger:'app_record_change',input:{records:[{event:'insert',recordId:review.changes[0].id,data:{task:'Merged record'}}]}});
 expect((await run('database',{action:'fork_write',...request,entity:'primary',operation:'create',values:{task:'late'}})).status).toBe(409);
});

test('merge detects production updates/deletes/schema changes and rejects the entire batch',async()=>{
 const row=(await (await call('/tables/'+app.tableId+'/rows',owner,{values:{task:'Original'}})).json()).row;
 const {fork}=await (await run('database',{action:'fork'})).json();
 await run('database',{action:'fork_write',forkId:fork.id,revision:1,entity:'primary',operation:'update',rowId:row.id,values:{task:'Edited'}});
 await run('database',{action:'fork_write',forkId:fork.id,revision:2,entity:'primary',operation:'create',values:{task:'New'}});
 const req={forkId:fork.id,revision:3};
 const review=await (await run('database',{action:'merge_preview',...req})).json();expect(review.changes).toHaveLength(2);
 await env.DB.prepare("UPDATE hx_rows SET data=?,updated_at=? WHERE id=?").bind('{"task":"Concurrent"}','later',row.id).run();
 expect((await run('database',{action:'merge_apply',...req,checksum:review.checksum})).status).toBe(409);
 const conflict=await (await run('database',{action:'merge_preview',...req})).json();expect(conflict.conflicts).toHaveLength(1);
 expect((await (await call('/tables/'+app.tableId,owner)).json()).rows).toMatchObject([{values:{task:'Concurrent'}}]);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_app_fork_merges').first()).n).toBe(0);
 await env.DB.prepare('DELETE FROM hx_rows WHERE id=?').bind(row.id).run();
 expect((await (await run('database',{action:'merge_preview',...req})).json()).conflicts).toHaveLength(1);
 await run('database',{action:'migrate',id:'schema_change',version:0,operations:[{op:'add_columns',entity:'primary',columns:[{name:'More',type:'text'}]}]});
 expect((await run('database',{action:'merge_preview',...req})).status).toBe(409);
});

test('merge can delete an unchanged production row and rejects later changes after review',async()=>{
 const row=(await (await call('/tables/'+app.tableId+'/rows',owner,{values:{task:'Remove me'}})).json()).row;
 let {fork}=await (await run('database',{action:'fork'})).json();
 await run('database',{action:'fork_write',forkId:fork.id,revision:1,entity:'primary',operation:'remove',rowId:row.id});
 let req={forkId:fork.id,revision:2},review=await (await run('database',{action:'merge_preview',...req})).json();
 expect(review.changes[0]).toMatchObject({operation:'remove',before:{task:'Remove me'},after:null});
 expect((await run('database',{action:'merge_apply',...req,checksum:review.checksum})).status).toBe(200);
 expect((await (await call('/tables/'+app.tableId,owner)).json()).rows).toEqual([]);
 ({fork}=await (await run('database',{action:'fork'})).json());
 await run('database',{action:'fork_write',forkId:fork.id,revision:fork.revision,entity:'primary',operation:'create',values:{task:'Draft'}});
 req={forkId:fork.id,revision:fork.revision+1};review=await (await run('database',{action:'merge_preview',...req})).json();
 await call('/tables/'+app.tableId+'/rows',owner,{values:{task:'Unrelated new production row'}});
 expect((await run('database',{action:'merge_apply',...req,checksum:review.checksum})).status).toBe(409);
});

test('transaction-time guard prevents partial merge when production changes after validation',async()=>{
 const {mergeFork}=await import('../src/harness/appMerge.js');
 await run('database',{action:'migrate',id:'secondary',version:0,operations:[{op:'create_entity',entity:'people',name:'People',columns:[{name:'Name',type:'text'}]}]});
 const {fork}=await (await run('database',{action:'fork'})).json();
 await run('database',{action:'fork_write',forkId:fork.id,revision:1,entity:'primary',operation:'create',values:{task:'Draft task'}});
 await run('database',{action:'fork_write',forkId:fork.id,revision:2,entity:'people',operation:'create',values:{name:'Draft person'}});
 const req={forkId:fork.id,revision:3},review=await (await run('database',{action:'merge_preview',...req})).json();
 const racing={prepare:sql=>env.DB.prepare(sql),batch:async statements=>{
   await env.DB.prepare('INSERT INTO hx_rows (id,table_id,org_id,data,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').bind('concurrent',app.tableId,orgId,'{"task":"Live"}','1','now','now').run();
   return env.DB.batch(statements);
 }};
 expect((await mergeFork(racing,orgId,app,'1',{...req,checksum:review.checksum})).status).toBe(409);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_rows').first()).n).toBe(1);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_app_fork_merges').first()).n).toBe(0);
 const fresh=await (await run('database',{action:'merge_preview',...req})).json();
 expect((await run('database',{action:'merge_apply',...req,checksum:fresh.checksum})).status).toBe(200);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_rows').first()).n).toBe(3);
});
