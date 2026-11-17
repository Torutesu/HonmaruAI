import { env } from 'cloudflare:test';
import { fetchMock } from './helpers/fetch-mock.js';
import { beforeEach,afterEach,test,expect } from 'vitest';
import worker from '../src/index.js';
import { createSession,upsertUser,upsertMembership } from '../src/db.js';
import { generateAction,connectionEndpoint,listAppActionRuns } from '../src/harness/appCapabilities.js';
import { normalizeAppHostname } from '../src/harness/appHosting.js';
import { applyMigration, databaseView } from '../src/harness/appDatabase.js';
import { setDisplayPreference } from '../src/harness/displayPreferences.js';
const orgId='personal:company';let owner,member,app;
const call=(path,token,body)=>worker.fetch(new Request('https://example.com'+path+(body?'':`${path.includes('?')?'&':'?'}orgId=${orgId}`),{method:body?'POST':'GET',headers:{'content-type':'application/json','x-session-token':token},...(body?{body:JSON.stringify({orgId,...body})}:{})}),{...env});
const run=(sub,body,token=owner)=>call(`/apps/${app.id}/${sub}`,token,body);
test('custom hosts are normalized and reserved or malformed names are rejected',()=>{
 expect(normalizeAppHostname('Tools.Example.com')).toBe('tools.example.com');
 expect(normalizeAppHostname('app.honmaruai.com')).toBeNull();
 expect(normalizeAppHostname('preview.pages.dev')).toBeNull();
 expect(normalizeAppHostname('localhost')).toBeNull();
 expect(normalizeAppHostname('https://tools.example.com')).toBeNull();
 expect(normalizeAppHostname('bad_name.example.com')).toBeNull();
 expect(normalizeAppHostname(`${'x'.repeat(64)}.example.com`)).toBeNull();
});
beforeEach(async()=>{
 for(const [id,role] of [['1','admin'],['2','member']]){await upsertUser(env.DB,{githubId:id,login:'user'+id,name:id});await upsertMembership(env.DB,orgId,id,role);}
 owner=await createSession(env.DB,'1','gho1');member=await createSession(env.DB,'2','gho2');
 app=(await (await call('/apps',owner,{name:'Tasks',columns:[{name:'Task',type:'text'}]})).json()).app;
});
afterEach(()=>fetchMock.deactivate());

test('public domain attach requires an affirmative confirmation at the API',async()=>{
 for(const publicDataConfirmed of [undefined,false]){
  const input={action:'attach',hostname:'tools.example.com',...(publicDataConfirmed===undefined?{}:{publicDataConfirmed})};
  const response=await run('hosting',input);
  expect(response.status).toBe(409);
  expect((await response.json()).message).toMatch(/公開|確認/);
 }
});

test('non-managers cannot read app hosting or environment variable names',async()=>{
 const dataKey=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
 const saved=await worker.fetch(new Request(`https://example.com/apps/${app.id}/hosting`,{method:'POST',headers:{'content-type':'application/json','x-session-token':owner},body:JSON.stringify({orgId,action:'set_env',name:'API_TOKEN',value:'private-value',version:0})}),{...env,DATA_KEY:dataKey});
 expect(saved.status).toBe(200);
 const response=await run('hosting',undefined,member);
 expect(response.status).toBe(403);
 expect(JSON.stringify(await response.json())).not.toContain('API_TOKEN');
});
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
test('additive migration rollback is an integrity-bound new migration and refuses populated columns',async()=>{
 const add={action:'migrate',id:'add_priority_v1',version:0,operations:[{op:'add_columns',entity:'primary',columns:[{name:'Priority',type:'text'}]}]};
 expect(await (await run('database',add)).json()).toMatchObject({applied:true,version:1});
 let state=await databaseView(env.DB,orgId,app);
 const migration=state.migrations[0];
 expect(migration).toMatchObject({id:'add_priority_v1',integrityValid:true,plan:add.operations,inverseOperations:[{op:'drop_empty_column',entity:'primary',column:'priority'}]});
 const rowResponse=await worker.fetch(new Request(`https://example.com/tables/${app.tableId}/rows`,{method:'POST',headers:{'content-type':'application/json','x-session-token':owner},body:JSON.stringify({orgId,values:{task:'Keep me',priority:'urgent'}})}),{...env});
 const row=(await rowResponse.json()).row;
 const inverse={action:'preview',id:'rollback_add_priority_v1',version:1,operations:migration.inverseOperations};
 let preview=await (await run('database',inverse)).json();
 expect(preview).toMatchObject({canApply:false,blockerCount:1});
 expect(preview.blockers[0]).toMatchObject({id:row.id,column:'Priority'});
 expect((await run('database',{...inverse,action:'migrate',previewChecksum:preview.previewChecksum})).status).toBe(409);
 await env.DB.prepare("UPDATE hx_rows SET data=json_set(data,'$.priority',NULL) WHERE org_id=?1 AND table_id=?2 AND id=?3").bind(orgId,app.tableId,row.id).run();
 preview=await (await run('database',inverse)).json();
 expect(preview).toMatchObject({canApply:true,blockerCount:0});
 const rollback={...inverse,action:'migrate',previewChecksum:preview.previewChecksum};
 expect(await (await run('database',rollback)).json()).toMatchObject({applied:true,version:2});
 expect(await (await run('database',rollback)).json()).toMatchObject({replay:true,version:2});
 state=await databaseView(env.DB,orgId,app);
 expect(state.entities[0].table.columns.map(column=>column.id)).toEqual(['task']);
 expect(state.migrations[0]).toMatchObject({id:'rollback_add_priority_v1',inverseOperations:null,integrityValid:true});
 const stored=(await (await call(`/tables/${app.tableId}`,owner)).json()).rows[0];
 expect(stored).toMatchObject({id:row.id,values:{task:'Keep me'}});
 await env.DB.prepare("UPDATE hx_app_migrations SET plan=json_set(plan,'$.inverseOperations[0].column','task') WHERE org_id=?1 AND app_id=?2 AND migration_id=?3").bind(orgId,app.id,'add_priority_v1').run();
 state=await databaseView(env.DB,orgId,app);
 expect(state.migrations.find(item=>item.id==='add_priority_v1')).toMatchObject({integrityValid:false,plan:null,inverseOperations:null});
 expect(await applyMigration(env.DB,orgId,app,{id:add.id,version:0,operations:add.operations},'1')).toMatchObject({status:409,error:'Migration journal integrity check failed.'});
});
test('tampered migration journal plans are flagged and cannot be replayed',async()=>{
 const req={action:'migrate',id:'integrity_check_v1',version:0,operations:[{op:'add_columns',entity:'primary',columns:[{name:'Memo',type:'text'}]}]};
 expect(await (await run('database',req)).json()).toMatchObject({applied:true,version:1});
 await env.DB.prepare('UPDATE hx_app_migrations SET plan=?1 WHERE org_id=?2 AND app_id=?3 AND migration_id=?4')
  .bind('[{"op":"drop_empty_column","entity":"primary","column":"task"}]',orgId,app.id,req.id).run();
 const journal=await (await run('database')).json();
 expect(journal.migrations[0]).toMatchObject({id:req.id,integrityValid:false,plan:null});
 const replay=await run('database',req);
 expect(replay.status).toBe(409);
 expect(await replay.json()).toMatchObject({message:'Migration journal integrity check failed.'});
 const current=await (await run('database')).json();
 expect(current.version).toBe(1);
 expect(current.entities[0].table.columns.map(column=>column.id)).toEqual(['task','memo']);
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
test('rename rollback is a checksummed new schema migration and leaves row data unchanged',async()=>{
 const inserted=await worker.fetch(new Request(`https://example.com/tables/${app.tableId}/rows`,{method:'POST',headers:{'content-type':'application/json','x-session-token':owner},body:JSON.stringify({orgId,values:{task:'Keep this value'}})}),{...env});
 const row=(await inserted.json()).row;
 const rename={id:'rename_task_v1',version:0,operations:[{op:'rename_column',entity:'primary',column:'task',name:'Title'}]};
 let preview=await (await run('database',{action:'preview',...rename})).json();
 expect(preview).toMatchObject({canApply:true,blockerCount:0});
 expect(await (await run('database',{action:'migrate',...rename,previewChecksum:preview.previewChecksum})).json()).toMatchObject({applied:true,version:1});
 let state=await databaseView(env.DB,orgId,app);
 const applied=state.migrations.find(item=>item.id===rename.id);
 expect(applied).toMatchObject({integrityValid:true,inverseOperations:[{op:'rename_column',entity:'primary',column:'task',name:'Task'}]});
 const rollback={id:'rollback_rename_task_v1',version:1,operations:applied.inverseOperations};
 preview=await (await run('database',{action:'preview',...rollback})).json();
 expect(preview).toMatchObject({canApply:true,blockerCount:0});
 expect(await (await run('database',{action:'migrate',...rollback,previewChecksum:preview.previewChecksum})).json()).toMatchObject({applied:true,version:2});
 state=await databaseView(env.DB,orgId,app);
 expect(state.entities[0].table.columns).toEqual([{id:'task',name:'Task',type:'text'}]);
 expect(state.migrations.find(item=>item.id===rollback.id)).toMatchObject({integrityValid:true,inverseOperations:[{op:'rename_column',entity:'primary',column:'task',name:'Title'}]});
 const data=await (await call(`/tables/${app.tableId}`,owner)).json();
 expect(data.rows[0]).toMatchObject({id:row.id,values:{task:'Keep this value'}});
});
test('empty-column conversion rollback restores the prior type through a new previewed migration',async()=>{
 const add={id:'add_blank_amount_v1',version:0,operations:[{op:'add_columns',entity:'primary',columns:[{name:'Amount',type:'text'}]}]};
 expect((await run('database',{action:'migrate',...add})).status).toBe(200);
 const inserted=await worker.fetch(new Request(`https://example.com/tables/${app.tableId}/rows`,{method:'POST',headers:{'content-type':'application/json','x-session-token':owner},body:JSON.stringify({orgId,values:{task:'blank',amount:null}})}),{...env});
 expect(inserted.status).toBe(201);
 const convert={id:'convert_blank_amount_v1',version:1,operations:[{op:'convert_column',entity:'primary',column:'amount',type:'number'}]};
 let preview=await (await run('database',{action:'preview',...convert})).json();
 expect(preview).toMatchObject({canApply:true,blockerCount:0});
 expect((await run('database',{action:'migrate',...convert,previewChecksum:preview.previewChecksum})).status).toBe(200);
 let state=await databaseView(env.DB,orgId,app);
 expect(state.migrations.find(item=>item.id===convert.id).inverseOperations).toEqual([{op:'convert_column',entity:'primary',column:'amount',type:'text'}]);
 const rollback={id:'rollback_blank_amount_v1',version:2,operations:state.migrations.find(item=>item.id===convert.id).inverseOperations};
 preview=await (await run('database',{action:'preview',...rollback})).json();
 expect(preview).toMatchObject({canApply:true,blockerCount:0});
 expect((await run('database',{action:'migrate',...rollback,previewChecksum:preview.previewChecksum})).status).toBe(200);
 state=await databaseView(env.DB,orgId,app);
 expect(state.entities[0].table.columns.find(column=>column.id==='amount')).toMatchObject({type:'text',name:'Amount'});
 expect(state.migrations.find(item=>item.id===rollback.id)).toMatchObject({integrityValid:true,inverseOperations:[{op:'convert_column',entity:'primary',column:'amount',type:'number'}]});
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
 expect(ambiguous.blockers[0].resolution).toMatchObject({entity:'primary',columnId:'related_text',label:'One',candidates:expect.arrayContaining([targetOne.row.id,duplicate.row.id])});
 const resolvedRequest={...request,operations:request.operations.map(operation=>operation.column==='related_text'||operation.column==='related_many_text'?{...operation,matchResolutions:{One:targetOne.row.id}}:operation)};
 const resolvedPreview=await (await run('database',{action:'preview',...resolvedRequest})).json();
 expect(resolvedPreview).toMatchObject({canApply:true,blockerCount:0});
 expect(resolvedPreview.changes[0].examples[0].relationMatches).toEqual(expect.arrayContaining([{column:'related_text',targetEntity:'people',matches:[{label:'One',recordId:targetOne.row.id,matchBy:'name'}]}]));
 const staleChoice={...resolvedRequest,operations:resolvedRequest.operations.map(operation=>operation.column==='related_text'?{...operation,matchResolutions:{One:'deleted_record'}}:operation)};
 expect((await (await run('database',{action:'preview',...staleChoice})).json()).canApply).toBe(false);
 await env.DB.prepare('DELETE FROM hx_rows WHERE org_id=?1 AND table_id=?2 AND id=?3').bind(orgId,peopleTable.id,duplicate.row.id).run();
 const preview=await (await run('database',{action:'preview',...request})).json();
 expect(preview).toMatchObject({canApply:true,blockerCount:0});
 const racingDb={prepare:(...args)=>env.DB.prepare(...args),batch:async statements=>{
   await env.DB.prepare('DELETE FROM hx_rows WHERE org_id=?1 AND table_id=?2 AND id=?3').bind(orgId,peopleTable.id,targetTwo.row.id).run();
   return env.DB.batch(statements);
 }};
 expect(await applyMigration(racingDb,orgId,app,{...resolvedRequest,previewChecksum:resolvedPreview.previewChecksum},'1')).toMatchObject({status:409});
 const replacement=await addPerson('Replacement');
 await env.DB.prepare("UPDATE hx_rows SET data=json_set(data,'$.related_many_text',?1),updated_at=?2 WHERE org_id=?3 AND id=?4").bind(JSON.stringify(['One','Replacement']),new Date().toISOString(),orgId,source.id).run();
 const fresh=await (await run('database',{action:'preview',...resolvedRequest})).json();
 expect(fresh).toMatchObject({canApply:true,blockerCount:0});
 expect(fresh.changes[0].examples[0].relationMatches).toEqual(expect.arrayContaining([
  {column:'related_text',targetEntity:'people',matches:[{label:'One',recordId:targetOne.row.id,matchBy:'name'}]},
  {column:'related_many_text',targetEntity:'people',matches:[{label:'One',recordId:targetOne.row.id,matchBy:'name'},{label:'Replacement',recordId:replacement.row.id,matchBy:'name'}]},
 ]));
 expect(await (await run('database',{action:'migrate',...resolvedRequest,previewChecksum:fresh.previewChecksum})).json()).toMatchObject({applied:true,version:3});
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
test('app action history is paged, creator scoped, retained, and omits job payload and result until detail is requested',async()=>{
 await run('actions',{action:'draft',name:'report',version:0,code:'return input.secret'});
 await run('actions',{action:'publish',name:'report',version:1});
 const gateway=(await(await call('/gateways',owner,{name:'History node'})).json()).gateway;
 const rows=[];
 for(let i=0;i<52;i++){
  const id=`history-${String(i).padStart(2,'0')}`,createdAt=1000+i;
  rows.push(env.DB.prepare(`INSERT INTO hx_gateway_jobs(id,org_id,gateway_id,created_by,request_id,payload,status,result,created_at,started_at,finished_at)
    VALUES(?1,?2,?3,'1',?1,?4,?5,?6,?7,?8,?9)`).bind(id,orgId,gateway.id,JSON.stringify({code:'PRIVATE_CODE',input:{secret:'PRIVATE_INPUT'}}),i%2?'failed':'succeeded',JSON.stringify({stdout:'PRIVATE_RESULT',stderr:'PRIVATE_STDERR'}),createdAt,createdAt+1,createdAt+2));
  rows.push(env.DB.prepare(`INSERT INTO hx_app_action_jobs(org_id,app_id,job_id,action_name,action_version,created_by)
    VALUES(?1,?2,?3,'report',2,'1')`).bind(orgId,app.id,id));
 }
 rows.push(env.DB.prepare(`INSERT INTO hx_gateway_jobs(id,org_id,gateway_id,created_by,request_id,payload,status,created_at)
   VALUES('history-old',?1,?2,'1','history-old','{}','succeeded',0)`).bind(orgId,gateway.id));
 rows.push(env.DB.prepare(`INSERT INTO hx_app_action_jobs(org_id,app_id,job_id,action_name,action_version,created_by)
   VALUES(?1,?2,'history-old','report',1,'1')`).bind(orgId,app.id));
 rows.push(env.DB.prepare(`INSERT INTO hx_gateway_jobs(id,org_id,gateway_id,created_by,request_id,payload,status,created_at)
   VALUES('history-member',?1,?2,'2','history-member','{"input":"private to member"}','queued',99999)`).bind(orgId,gateway.id));
 rows.push(env.DB.prepare(`INSERT INTO hx_app_action_jobs(org_id,app_id,job_id,action_name,action_version,created_by)
   VALUES(?1,?2,'history-member','report',2,'2')`).bind(orgId,app.id));
 for(let offset=0;offset<rows.length;offset+=80)await env.DB.batch(rows.slice(offset,offset+80));

 const first=await(await call(`/apps/${app.id}/actions?runs=1&limit=50`,owner)).json();
 expect(first.runs).toHaveLength(50);
 expect(first.runs[0]).toMatchObject({id:'history-51',actionName:'report',actionVersion:2,status:'failed',createdAt:1051,startedAt:1052,finishedAt:1053});
 expect(first.runs.at(-1).id).toBe('history-02');
 expect(first.nextCursor).toEqual(expect.any(String));
 expect(JSON.stringify(first)).not.toMatch(/PRIVATE_(?:CODE|INPUT|RESULT|STDERR)/);
 expect(first.runs[0]).not.toHaveProperty('result');
 expect(first.runs[0]).not.toHaveProperty('payload');
 const second=await(await call(`/apps/${app.id}/actions?runs=1&limit=50&cursor=${encodeURIComponent(first.nextCursor)}`,owner)).json();
 expect(second.runs.map(item=>item.id)).toEqual(['history-01','history-00','history-old']);
 expect(second.nextCursor).toBeUndefined();
 const memberHistory=await(await call(`/apps/${app.id}/actions?runs=1`,member)).json();
 expect(memberHistory.runs.map(item=>item.id)).toEqual(['history-member']);
 expect((await call(`/apps/${app.id}/actions?jobId=history-51`,member)).status).toBe(404);
 expect((await call(`/apps/${app.id}/actions?runs=1&limit=51`,owner)).status).toBe(400);
 expect((await call(`/apps/${app.id}/actions?runs=1&cursor=not-a-cursor`,owner)).status).toBe(400);
 await worker.fetch(new Request(`https://example.com/apps/${app.id}/access`,{method:'PUT',headers:{'content-type':'application/json','x-session-token':owner},body:JSON.stringify({orgId,version:0,visibility:'private'})}),{...env});
 expect((await call(`/apps/${app.id}/actions?runs=1`,member)).status).toBe(404);
});
test('action run history rechecks build permission and current app access at its boundary',async()=>{
 await upsertUser(env.DB,{githubId:'3',login:'user3',name:'3'});
 await upsertMembership(env.DB,orgId,'3','guest');
 const noBuild=await listAppActionRuns(env.DB,orgId,app.id,'3');
 expect(noBuild).toMatchObject({error:'You cannot build in this workspace.',status:403});

 await worker.fetch(new Request(`https://example.com/apps/${app.id}/access`,{method:'PUT',headers:{'content-type':'application/json','x-session-token':owner},body:JSON.stringify({orgId,version:0,visibility:'private'})}),{...env});
 const revokedApp=await listAppActionRuns(env.DB,orgId,app.id,'2');
 expect(revokedApp).toMatchObject({error:'No such app.',status:404});
});

test('an action created or updated elsewhere cannot be overwritten with a stale draft revision',async()=>{
 const original={action:'draft',name:'report',version:0,code:'return "original"'};
 expect((await run('actions',original)).status).toBe(200);
 expect((await run('actions',{...original,code:'return "unseen"'})).status).toBe(409);
 expect((await run('actions',{...original,version:1,code:'return "external"'})).status).toBe(200);
 expect((await run('actions',{...original,version:1,code:'return "stale edit"'})).status).toBe(409);
 const actions=(await (await run('actions')).json()).actions;
 expect(actions.find(action=>action.name==='report')).toMatchObject({version:2,draft:'return "external"'});
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
 const typed=await generateAction('calculate',async()=>JSON.stringify({name:'calculate',language:'typescript',code:'export default async function(input: unknown, env: Readonly<Record<string,string>>): Promise<unknown> { return input; }'}),'typescript');
 expect(typed).toMatchObject({name:'calculate',language:'typescript'});
 expect((await generateAction('calculate',async()=>JSON.stringify({name:'calculate',language:'typescript',code:'return input;'}),'typescript')).status).toBe(502);
 expect((await generateAction('calculate',async()=>JSON.stringify({name:'calculate',language:'javascript',code:'return input;'}),'typescript')).status).toBe(502);
});

test('TypeScript action language is versioned, published and carried into gateway jobs',async()=>{
 const source='export default async function(input: unknown, env: Readonly<Record<string,string>>): Promise<unknown> { return input; }';
 expect(await (await run('actions',{action:'draft',name:'typed',version:0,language:'typescript',code:source})).json()).toMatchObject({saved:true,version:1});
 expect(await (await run('actions',{action:'publish',name:'typed',version:1})).json()).toMatchObject({saved:true,version:2});
 let listed=await (await run('actions')).json();
 expect(listed.actions[0]).toMatchObject({name:'typed',language:'typescript',publishedLanguage:'typescript',published:source});
 const history=await (await worker.fetch(new Request(`https://example.com/apps/${app.id}/actions?orgId=${orgId}&history=typed`,{headers:{'x-session-token':owner}}),{...env})).json();
 expect(history.versions.map(v=>v.language)).toEqual(['typescript','typescript']);
 const gateway=await (await call('/gateways',owner,{name:'Typed action gateway'})).json();
 const requested=await (await run('actions',{action:'run',name:'typed',version:2,gatewayId:gateway.gateway.id,input:{ok:true},requestId:'typed-run'},owner)).json();
 const job=await env.DB.prepare('SELECT payload FROM hx_gateway_jobs WHERE id=?1').bind(requested.job.id).first();
 expect(JSON.parse(job.payload)).toMatchObject({language:'typescript',code:source,input:{ok:true}});
 expect(await (await run('actions',{action:'restore',name:'typed',version:2,restoreVersion:1})).json()).toMatchObject({saved:true,version:3});
 listed=await (await run('actions')).json();
 expect(listed.actions[0]).toMatchObject({version:3,language:'typescript'});
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

test('app environment values are sealed, hidden from reads, and injected only when a node claims the app action',async()=>{
 await run('actions',{action:'draft',name:'use_secret',version:0,code:'return env.API_TOKEN'});
 await run('actions',{action:'publish',name:'use_secret',version:1});
 const g=await (await call('/gateways',owner,{name:'Mac mini'})).json();
 const queued=await (await run('actions',{action:'run',name:'use_secret',version:2,gatewayId:g.gateway.id,input:null,requestId:'secret-job'})).json();
 const dataKey=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
 const save=await worker.fetch(new Request(`https://example.com/apps/${app.id}/hosting`,{method:'POST',headers:{'content-type':'application/json','x-session-token':owner},body:JSON.stringify({orgId,action:'set_env',name:'API_TOKEN',value:'vault-only-secret',version:0})}),{...env,DATA_KEY:dataKey});
 expect(save.status).toBe(200);
 const stored=await env.DB.prepare('SELECT value FROM hx_app_env_vars WHERE org_id=?1 AND app_id=?2 AND name=?3').bind(orgId,app.id,'API_TOKEN').first();
 expect(stored.value).not.toContain('vault-only-secret');expect(stored.value.startsWith('enc:v2:')).toBe(true);
 const listed=await (await call(`/apps/${app.id}/hosting`,owner)).json();
 expect(listed.environment).toEqual([{name:'API_TOKEN',version:1,updatedAt:expect.any(String),hasValue:true}]);
 expect(JSON.stringify(listed)).not.toContain('vault-only-secret');
 const jobRow=await env.DB.prepare('SELECT payload FROM hx_gateway_jobs WHERE id=?1').bind(queued.job.id).first();
 expect(JSON.stringify(JSON.parse(jobRow.payload))).not.toContain('vault-only-secret');
 const {useSecretKey}=await import('../src/secrets.js');useSecretKey({...env,DATA_KEY:dataKey});
 const {handleGateways}=await import('../src/harness/gateways.js');
 const claim=await handleGateways(new Request('https://example.com/gateways/claim',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+g.token},body:'{}'}),{...env,DATA_KEY:dataKey},new URL('https://example.com/gateways/claim'),{});
 expect(await claim.json()).toMatchObject({job:{id:queued.job.id,payload:{code:'return env.API_TOKEN'},environment:{API_TOKEN:'vault-only-secret'}}});
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

test('a preview can add a nullable column and merge its reviewed schema and records atomically',async()=>{
 await env.DB.prepare("INSERT INTO org_settings (org_id,mode,updated_at) VALUES (?1,'harness','now') ON CONFLICT(org_id) DO UPDATE SET mode='harness',updated_at='now'").bind(orgId).run();
 const workflow=await call('/workflows',owner,{name:'Observe merged schema row',enabled:true,trigger:{type:'app_record_change',appId:app.id,entityId:'primary',events:['insert']},steps:[{type:'update_row',values:{task:'Schema-aware event'}}]});
 expect(workflow.status).toBe(201);
 const {fork}=await (await run('database',{action:'fork'})).json();
 const added=await run('database',{action:'fork_schema',forkId:fork.id,revision:fork.revision,operations:[{op:'add_columns',entity:'primary',columns:[{name:'Review status',type:'select',options:['Open','Done']}]}]});
 expect(added.status).toBe(200);
 const isolated=await (await run('database')).json();
 const preview=isolated.fork;
 expect(preview.revision).toBe(2);
 const statusColumn=preview.entities.find(entity=>entity.key==='primary').table.columns.find(column=>column.name==='Review status');
 expect(statusColumn).toMatchObject({type:'select',options:['Open','Done']});
 await run('database',{action:'fork_write',forkId:preview.id,revision:preview.revision,entity:'primary',operation:'create',values:{task:'Schema-aware row',[statusColumn.id]:'Open'}});
 const request={forkId:preview.id,revision:3};
 const review=await (await run('database',{action:'merge_preview',...request})).json();
 expect(review.schemaChanges).toMatchObject([expect.objectContaining({entity:'primary',before:expect.any(Array),after:expect.arrayContaining([statusColumn])})]);
 expect(review.changes).toHaveLength(1);
 const merged=await (await run('database',{action:'merge_apply',...request,checksum:review.checksum})).json();
 expect(merged).toMatchObject({merged:true,changed:1,schemaChanged:1});
 const current=await (await run('database')).json();
 expect(current.version).toBeGreaterThanOrEqual(1);
 expect(current.entities.find(entity=>entity.key==='primary').table.columns).toContainEqual(statusColumn);
 expect(current.migrations[0]).toMatchObject({integrityValid:true,inverseOperations:[{op:'drop_empty_column',entity:'primary',column:statusColumn.id}]});
 expect((await (await call('/tables/'+app.tableId,owner)).json()).rows).toMatchObject([{values:{task:'Schema-aware event',[statusColumn.id]:'Open'}}]);
 const event=await env.DB.prepare('SELECT payload FROM hx_workflow_row_event_outbox WHERE org_id=?1 AND table_id=?2 ORDER BY created_at DESC LIMIT 1').bind(orgId,app.tableId).first();
 expect(JSON.parse(event.payload).table.columns).toContainEqual(statusColumn);
});

test('schema-only preview merges are accepted and a changed database version invalidates the review',async()=>{
 await env.DB.prepare("INSERT INTO org_settings (org_id,mode,updated_at) VALUES (?1,'harness','now') ON CONFLICT(org_id) DO UPDATE SET mode='harness',updated_at='now'").bind(orgId).run();
 const {fork}=await (await run('database',{action:'fork'})).json();
 await run('database',{action:'fork_schema',forkId:fork.id,revision:fork.revision,operations:[{op:'add_columns',entity:'primary',columns:[{name:'Internal note',type:'text'}]}]});
 const isolated=await (await run('database')).json(),previewFork=isolated.fork;
 const review=await (await run('database',{action:'merge_preview',forkId:previewFork.id,revision:previewFork.revision})).json();
 expect(review.changes).toEqual([]);expect(review.schemaChanges).toHaveLength(1);
 await env.DB.prepare('INSERT INTO hx_app_database_state (org_id,app_id,version) VALUES (?1,?2,9) ON CONFLICT(org_id,app_id) DO UPDATE SET version=9').bind(orgId,app.id).run();
 expect((await run('database',{action:'merge_apply',forkId:previewFork.id,revision:previewFork.revision,checksum:review.checksum})).status).toBe(409);
 expect((await (await run('database')).json()).entities.find(entity=>entity.key==='primary').table.columns.some(column=>column.name==='Internal note')).toBe(false);
});

test('an old private DB preview can explicitly adopt a fenced production baseline without losing its diff',async()=>{
 const created=await call(`/tables/${app.tableId}/rows`,owner,{values:{task:'Original'}}),original=(await created.json()).row;
 const {fork}=await (await run('database',{action:'fork'})).json();
 const row=fork.entities.find(entity=>entity.key==='primary').rows.find(item=>item.id===original.id);
 expect(await run('database',{action:'fork_write',forkId:fork.id,revision:fork.revision,entity:'primary',operation:'update',rowId:row.id,expectedUpdatedAt:row.updatedAt,values:{task:'Draft'}})).toMatchObject({status:200});
 let current=(await (await run('database')).json()).fork;
 expect((await run('database',{action:'fork_schema',forkId:current.id,revision:current.revision,operations:[{op:'add_columns',entity:'primary',columns:[{name:'Priority',type:'text'}]}]})).status).toBe(200);
 current=(await (await run('database')).json()).fork;
 const priority=current.entities.find(entity=>entity.key==='primary').table.columns.find(column=>column.name==='Priority');
 expect((await run('database',{action:'fork_write',forkId:current.id,revision:current.revision,entity:'primary',operation:'update',rowId:row.id,values:{[priority.id]:'P1'}})).status).toBe(200);
 current=(await (await run('database')).json()).fork;
 await env.DB.prepare('DELETE FROM hx_app_fork_bases WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND fork_id=?4').bind(orgId,app.id,'1',current.id).run();
 current=(await (await run('database')).json()).fork;
 expect(current).toMatchObject({id:fork.id,revision:4,hasBaseline:false});
 expect((await run('database',{action:'merge_preview',forkId:current.id,revision:current.revision})).status).toBe(409);
 expect((await run('database',{action:'fork_rebase_legacy',forkId:current.id,revision:current.revision-1})).status).toBe(409);
 expect((await (await run('database')).json()).fork.hasBaseline).toBe(false);
 const rebased=await run('database',{action:'fork_rebase_legacy',forkId:current.id,revision:current.revision});
 expect(rebased.status).toBe(200);
 expect(await (await run('database',{action:'fork_rebase_legacy',forkId:current.id,revision:current.revision})).json()).toMatchObject({rebased:true,replay:true});
 current=(await (await run('database')).json()).fork;
 expect(current).toMatchObject({id:fork.id,revision:4,hasBaseline:true});
 expect(current.entities.find(entity=>entity.key==='primary').rows.find(item=>item.id===row.id).values).toEqual({task:'Draft',[priority.id]:'P1'});
 let review=await (await run('database',{action:'merge_preview',forkId:current.id,revision:current.revision})).json();
 expect(review.changes).toMatchObject([{entity:'primary',id:row.id,operation:'update',after:{task:'Draft',[priority.id]:'P1'}}]);
 expect(review.schemaChanges).toMatchObject([{entity:'primary',operations:[{op:'add_columns',columns:[{name:'Priority',type:'text'}]}]}]);
 expect(review.conflicts).toEqual([]);
 const live=await (await call(`/tables/${app.tableId}`,owner)).json(),liveRow=live.rows.find(item=>item.id===row.id);
 expect((await worker.fetch(new Request(`https://example.com/tables/${app.tableId}/rows/${row.id}`,{method:'PATCH',headers:{'content-type':'application/json','x-session-token':owner},body:JSON.stringify({orgId,expectedUpdatedAt:liveRow.updatedAt,values:{task:'Live'}})}),{...env})).status).toBe(200);
 review=await (await run('database',{action:'merge_preview',forkId:current.id,revision:current.revision})).json();
 expect(review.conflicts).toMatchObject([{changeId:`primary:${row.id}`,production:{task:'Live'},preview:{task:'Draft',[priority.id]:'P1'}}]);
 review=await (await run('database',{action:'merge_preview',forkId:current.id,revision:current.revision,resolutions:{[`primary:${row.id}`]:'preview'}})).json();
 expect(review.resolved).toBe(true);
 const applied=await (await run('database',{action:'merge_apply',forkId:current.id,revision:current.revision,checksum:review.checksum,resolutions:{[`primary:${row.id}`]:'preview'}})).json();
 expect(applied).toMatchObject({merged:true,changed:1});
 expect((await (await call(`/tables/${app.tableId}`,owner)).json()).rows.find(item=>item.id===row.id).values).toEqual({task:'Draft',[priority.id]:'P1'});
});

test('private preview supports rename, strict conversion and an empty-column drop before atomic merge',async()=>{
 await env.DB.prepare("INSERT INTO org_settings (org_id,mode,updated_at) VALUES (?1,'harness','now') ON CONFLICT(org_id) DO UPDATE SET mode='harness',updated_at='now'").bind(orgId).run();
 const {fork}=await (await run('database',{action:'fork'})).json();
 await run('database',{action:'fork_write',forkId:fork.id,revision:fork.revision,entity:'primary',operation:'create',values:{task:'42'}});
 let current=(await (await run('database')).json()).fork;
 expect((await run('database',{action:'fork_schema',forkId:current.id,revision:current.revision,operations:[{op:'rename_column',entity:'primary',column:'task',name:'Estimate'}]})).status).toBe(200);
 current=(await (await run('database')).json()).fork;
 expect((await run('database',{action:'fork_schema',forkId:current.id,revision:current.revision,operations:[{op:'convert_column',entity:'primary',column:'task',type:'number'}]})).status).toBe(200);
 current=(await (await run('database')).json()).fork;
 const numberColumn=current.entities[0].table.columns[0];
 expect(current.entities[0].rows[0].values.task).toBe(42);
 const review=await (await run('database',{action:'merge_preview',forkId:current.id,revision:current.revision})).json();
 expect(review.schemaChanges).toMatchObject([{entity:'primary',before:[{id:'task',name:'Task',type:'text'}],after:[{id:'task',name:'Estimate',type:'number'}]}]);
 const merged=await (await run('database',{action:'merge_apply',forkId:current.id,revision:current.revision,checksum:review.checksum})).json();
 expect(merged).toMatchObject({merged:true,changed:1,schemaChanged:1});
 expect((await (await call(`/tables/${app.tableId}`,owner)).json()).rows).toMatchObject([{values:{task:42}}]);
 expect((await databaseView(env.DB,orgId,app)).entities[0].table.columns).toEqual([numberColumn]);
 expect((await databaseView(env.DB,orgId,app)).migrations[0]).toMatchObject({integrityValid:true,inverseOperations:null,plan:[{op:'convert_column',entity:'primary',column:'task',type:'number'},{op:'rename_column',entity:'primary',column:'task',name:'Estimate'}]});
});

test('empty-column drop and a new private entity merge with rows under the reviewed receipt',async()=>{
 await env.DB.prepare("INSERT INTO org_settings (org_id,mode,updated_at) VALUES (?1,'harness','now') ON CONFLICT(org_id) DO UPDATE SET mode='harness',updated_at='now'").bind(orgId).run();
 const {fork}=await (await run('database',{action:'fork'})).json();
 await run('database',{action:'fork_schema',forkId:fork.id,revision:fork.revision,operations:[{op:'add_columns',entity:'primary',columns:[{name:'Unused',type:'text'}]}]});
 let current=(await (await run('database')).json()).fork;
 const unused=current.entities[0].table.columns.find(column=>column.name==='Unused');
 expect((await run('database',{action:'fork_schema',forkId:current.id,revision:current.revision,operations:[{op:'drop_empty_column',entity:'primary',column:unused.id}]})).status).toBe(200);
 current=(await (await run('database')).json()).fork;
 expect((await run('database',{action:'fork_schema',forkId:current.id,revision:current.revision,operations:[{op:'create_entity',entity:'people',name:'People',columns:[{name:'Name',type:'text'}]}]})).status).toBe(200);
 current=(await (await run('database')).json()).fork;
 const people=current.entities.find(entity=>entity.key==='people');
 expect(people).toBeDefined();
 const write=await run('database',{action:'fork_write',forkId:current.id,revision:current.revision,entity:'people',operation:'create',values:{name:'Mika'}});
 expect(write.status).toBe(200);
 current=(await (await run('database')).json()).fork;
 const review=await (await run('database',{action:'merge_preview',forkId:current.id,revision:current.revision})).json();
 expect(review.schemaChanges).toContainEqual(expect.objectContaining({entity:'people',newEntity:true,tableName:'People'}));
 expect(review.changes).toContainEqual(expect.objectContaining({entity:'people',operation:'create',after:{name:'Mika'}}));
 const merged=await run('database',{action:'merge_apply',forkId:current.id,revision:current.revision,checksum:review.checksum});
 expect(merged.status).toBe(200);
 expect(await merged.json()).toMatchObject({merged:true,changed:1,schemaChanged:1});
 const live=(await (await run('database')).json()).entities.find(entity=>entity.key==='people');
 expect(live.table.name).toBe('People');
 expect((await call(`/tables/${live.table.id}`,owner)).status).toBe(200);
 expect((await (await call(`/tables/${live.table.id}`,owner)).json()).rows).toMatchObject([{values:{name:'Mika'}}]);
 expect((await databaseView(env.DB,orgId,app)).migrations[0]).toMatchObject({integrityValid:true,inverseOperations:null});
});

test('private preview can delete an entity after its rows are removed and records the deletion atomically',async()=>{
 await run('database',{action:'migrate',id:'people_v1',version:0,operations:[{op:'create_entity',entity:'people',name:'People',columns:[{name:'Name',type:'text'}]}]});
 const people=(await (await run('database')).json()).entities.find(entity=>entity.key==='people');
 const inserted=await call(`/tables/${people.table.id}/rows`,owner,{values:{name:'Mika'}});
 const row=(await inserted.json()).row;
 let {fork}=await (await run('database',{action:'fork'})).json();
 await run('database',{action:'fork_write',forkId:fork.id,revision:fork.revision,entity:'people',operation:'remove',rowId:row.id});
 fork=(await (await run('database')).json()).fork;
 const rejected=await run('database',{action:'fork_schema',forkId:fork.id,revision:fork.revision,operations:[{op:'drop_entity',entity:'people'}]});
 expect(rejected.status).toBe(200);
 fork=(await (await run('database')).json()).fork;
 expect(fork.entities.some(entity=>entity.key==='people')).toBe(false);
 const request={forkId:fork.id,revision:fork.revision};
 const review=await (await run('database',{action:'merge_preview',...request})).json();
 expect(review.schemaChanges).toContainEqual(expect.objectContaining({entity:'people',deletedEntity:true,operations:[{op:'drop_entity',entity:'people'}]}));
 expect(review.changes).toContainEqual(expect.objectContaining({entity:'people',id:row.id,operation:'remove'}));
 const applied=await (await run('database',{action:'merge_apply',...request,checksum:review.checksum})).json();
 expect(applied).toMatchObject({merged:true,changed:1,schemaChanged:1});
 expect((await (run('database')).then(response=>response.json())).entities.some(entity=>entity.key==='people')).toBe(false);
 expect(await env.DB.prepare('SELECT 1 FROM hx_tables WHERE org_id=?1 AND id=?2').bind(orgId,people.table.id).first()).toBeNull();
 expect(await env.DB.prepare('SELECT 1 FROM hx_rows WHERE org_id=?1 AND table_id=?2').bind(orgId,people.table.id).first()).toBeNull();
 expect((await databaseView(env.DB,orgId,app)).migrations[0]).toMatchObject({integrityValid:true,plan:[{op:'drop_entity',entity:'people'}],inverseOperations:null});
});

test('entity deletion is blocked while records or any Workflow trigger references the entity',async()=>{
 await run('database',{action:'migrate',id:'people_v1',version:0,operations:[{op:'create_entity',entity:'people',name:'People',columns:[{name:'Name',type:'text'}]}]});
 let state=await (await run('database')).json(),people=state.entities.find(entity=>entity.key==='people');
 let fork=(await (await run('database',{action:'fork'})).json()).fork;
 const addRow=await run('database',{action:'fork_write',forkId:fork.id,revision:fork.revision,entity:'people',operation:'create',values:{name:'Non-empty'}});
 expect(addRow.status).toBe(200);
 fork=(await (await run('database')).json()).fork;
 expect((await run('database',{action:'fork_schema',forkId:fork.id,revision:fork.revision,operations:[{op:'drop_entity',entity:'people'}]})).status).toBe(409);
 await call('/workflows',owner,{name:'Watch people rows',enabled:true,trigger:{type:'app_record_change',appId:app.id,entityId:'people',events:['delete']},steps:[{type:'update_row',values:{task:'Observed'}}]});
 fork=(await (await run('database',{action:'fork'})).json()).fork;
 expect((await run('database',{action:'fork_schema',forkId:fork.id,revision:fork.revision,operations:[{op:'drop_entity',entity:'people'}]})).status).toBe(409);
 state=await (await run('database')).json();
 expect(state.fork.entities.some(entity=>entity.key==='people')).toBe(true);
 expect(people.table.id).toBe(state.entities.find(entity=>entity.key==='people').table.id);
});

test('ordinary migration requires an empty unreferenced entity and journals its destructive plan',async()=>{
 await run('database',{action:'migrate',id:'people_v1',version:0,operations:[{op:'create_entity',entity:'people',name:'People',columns:[{name:'Name',type:'text'}]}]});
 const {entities,version}=await (await run('database')).json(),people=entities.find(entity=>entity.key==='people');
 const request={id:'drop_people_v2',version,operations:[{op:'drop_entity',entity:'people'}]};
 const preview=await (await run('database',{action:'preview',...request})).json();
 expect(preview).toMatchObject({canApply:true,changes:[{entity:'people',operations:['drop_entity'],rowsScanned:0,rowsChanged:0}]});
 expect(await (await run('database',{action:'migrate',...request,previewChecksum:preview.previewChecksum})).json()).toMatchObject({applied:true,version:2});
 expect((await (await run('database')).json()).entities.some(entity=>entity.key==='people')).toBe(false);
 expect((await databaseView(env.DB,orgId,app)).migrations[0]).toMatchObject({plan:[{op:'drop_entity',entity:'people'}],inverseOperations:null,integrityValid:true});
 expect(await env.DB.prepare('SELECT 1 FROM hx_tables WHERE org_id=?1 AND id=?2').bind(orgId,people.table.id).first()).toBeNull();
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

test('reviewed merge resolves production conflicts per record and makes the choice part of the checksum',async()=>{
 const insert=async task=>(await (await call(`/tables/${app.tableId}/rows`,owner,{values:{task}})).json()).row;
 const conflicted=await insert('Original'), independent=await insert('Independent');
 const {fork}=await (await run('database',{action:'fork'})).json();
 await run('database',{action:'fork_write',forkId:fork.id,revision:1,entity:'primary',operation:'update',rowId:conflicted.id,values:{task:'Preview choice'}});
 await run('database',{action:'fork_write',forkId:fork.id,revision:2,entity:'primary',operation:'update',rowId:independent.id,values:{task:'Independent preview'}});
 await env.DB.prepare('UPDATE hx_rows SET data=?1,updated_at=?2 WHERE org_id=?3 AND table_id=?4 AND id=?5').bind(JSON.stringify({task:'Production choice'}),'later',orgId,app.tableId,conflicted.id).run();
 const request={forkId:fork.id,revision:3};
 const unresolved=await (await run('database',{action:'merge_preview',...request})).json();
 expect(unresolved).toMatchObject({resolved:false,conflicts:[{changeId:`primary:${conflicted.id}`,production:{task:'Production choice'},preview:{task:'Preview choice'}}]});
 expect((await run('database',{action:'merge_apply',...request,checksum:unresolved.checksum})).status).toBe(409);
 const resolutions={[`primary:${conflicted.id}`]:'production'};
 const reviewed=await (await run('database',{action:'merge_preview',...request,resolutions})).json();
 expect(reviewed.resolved).toBe(true);expect(reviewed.checksum).not.toBe(unresolved.checksum);
 expect((await run('database',{action:'merge_apply',...request,checksum:reviewed.checksum})).status).toBe(409);
 const merge={action:'merge_apply',...request,checksum:reviewed.checksum,resolutions};
 expect(await (await run('database',merge)).json()).toMatchObject({merged:true,changed:1,keptProduction:1});
 const rows=(await (await call(`/tables/${app.tableId}`,owner)).json()).rows;
 expect(rows).toMatchObject([{id:conflicted.id,values:{task:'Production choice'}},{id:independent.id,values:{task:'Independent preview'}}]);
 expect(await (await run('database',merge)).json()).toMatchObject({merged:true,replay:true});
});

test('a reviewed merge can explicitly choose the preview version of a conflicted row',async()=>{
 const row=(await (await call(`/tables/${app.tableId}/rows`,owner,{values:{task:'Original'}})).json()).row;
 const {fork}=await (await run('database',{action:'fork'})).json();
 await run('database',{action:'fork_write',forkId:fork.id,revision:1,entity:'primary',operation:'update',rowId:row.id,values:{task:'Preview wins'}});
 await env.DB.prepare('UPDATE hx_rows SET data=?1,updated_at=?2 WHERE org_id=?3 AND table_id=?4 AND id=?5').bind(JSON.stringify({task:'Production changed'}),'later',orgId,app.tableId,row.id).run();
 const request={forkId:fork.id,revision:2},resolutions={[`primary:${row.id}`]:'preview'};
 const reviewed=await (await run('database',{action:'merge_preview',...request,resolutions})).json();
 expect(reviewed.resolved).toBe(true);
 expect(await (await run('database',{action:'merge_apply',...request,checksum:reviewed.checksum,resolutions})).json()).toMatchObject({merged:true,changed:1,keptProduction:0});
 expect((await (await call(`/tables/${app.tableId}`,owner)).json()).rows).toMatchObject([{id:row.id,values:{task:'Preview wins'}}]);
});

test('preview wins safely replaces a colliding live row ID',async()=>{
 const {fork}=await (await run('database',{action:'fork'})).json();
 const created=await (await run('database',{action:'fork_write',forkId:fork.id,revision:1,entity:'primary',operation:'create',values:{task:'Preview row'}})).json();
 const id=created.result.id;
 await env.DB.prepare('INSERT INTO hx_rows (id,table_id,org_id,data,position,created_by,updated_by,created_at,updated_at) VALUES (?1,?2,?3,?4,0,?5,?5,?6,?6)').bind(id,app.tableId,orgId,JSON.stringify({task:'Independent live row'}),'1','now').run();
 const request={forkId:fork.id,revision:2},resolutions={[`primary:${id}`]:'preview'};
 const reviewed=await (await run('database',{action:'merge_preview',...request,resolutions})).json();
 expect(reviewed).toMatchObject({resolved:true,conflicts:[{changeId:`primary:${id}`,production:{task:'Independent live row'},preview:{task:'Preview row'}}]});
 expect(await (await run('database',{action:'merge_apply',...request,checksum:reviewed.checksum,resolutions})).json()).toMatchObject({merged:true,changed:1});
 expect((await (await call(`/tables/${app.tableId}`,owner)).json()).rows).toMatchObject([{id,values:{task:'Preview row'}}]);
});

test('keeping production can finish a preview without writing any rows',async()=>{
 const row=(await (await call(`/tables/${app.tableId}/rows`,owner,{values:{task:'Original'}})).json()).row;
 const {fork}=await (await run('database',{action:'fork'})).json();
 await run('database',{action:'fork_write',forkId:fork.id,revision:1,entity:'primary',operation:'update',rowId:row.id,values:{task:'Preview'}});
 await env.DB.prepare('UPDATE hx_rows SET data=?1,updated_at=?2 WHERE org_id=?3 AND table_id=?4 AND id=?5').bind(JSON.stringify({task:'Production'}),'later',orgId,app.tableId,row.id).run();
 const request={forkId:fork.id,revision:2},resolutions={[`primary:${row.id}`]:'production'};
 const reviewed=await (await run('database',{action:'merge_preview',...request,resolutions})).json();
 expect(await (await run('database',{action:'merge_apply',...request,checksum:reviewed.checksum,resolutions})).json()).toMatchObject({merged:true,changed:0,keptProduction:1});
 expect((await (await call(`/tables/${app.tableId}`,owner)).json()).rows).toMatchObject([{id:row.id,values:{task:'Production'}}]);
 expect((await (await run('database')).json()).fork.mergedAt).toBeTruthy();
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

test('a merge rejected at transaction time queues no workflow events; an accepted one queues one per row',async()=>{
 const {mergeFork}=await import('../src/harness/appMerge.js');
 await env.DB.prepare("INSERT INTO org_settings (org_id,mode,updated_at) VALUES (?1,'harness','now') ON CONFLICT(org_id) DO UPDATE SET mode='harness',updated_at='now'").bind(orgId).run();
 expect((await call('/workflows',owner,{name:'Watch merged records',enabled:true,trigger:{type:'app_record_change',appId:app.id,entityId:'primary',events:['insert']},steps:[{type:'update_row',values:{task:'Handled'}}]})).status).toBe(201);
 const {fork}=await (await run('database',{action:'fork'})).json();
 await run('database',{action:'fork_write',forkId:fork.id,revision:1,entity:'primary',operation:'create',values:{task:'Draft one'}});
 await run('database',{action:'fork_write',forkId:fork.id,revision:2,entity:'primary',operation:'create',values:{task:'Draft two'}});
 const req={forkId:fork.id,revision:3},review=await (await run('database',{action:'merge_preview',...req})).json();
 const outbox=async()=>(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_row_event_outbox WHERE org_id=?1').bind(orgId).first()).n;
 let raced=false;
 const racing={prepare:sql=>env.DB.prepare(sql),batch:async statements=>{
   if(!raced){raced=true;await env.DB.prepare('INSERT INTO hx_rows (id,table_id,org_id,data,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').bind('concurrent',app.tableId,orgId,'{"task":"Live"}','1','now','now').run();}
   return env.DB.batch(statements);
 }};
 expect((await mergeFork(racing,orgId,app,'1',{...req,checksum:review.checksum})).status).toBe(409);
 expect(await outbox()).toBe(0);
 const fresh=await (await run('database',{action:'merge_preview',...req})).json();
 const applied=await mergeFork(env.DB,orgId,app,'1',{...req,checksum:fresh.checksum});
 expect(applied.merged).toBe(true);
 expect(applied.changedRecords.every(record=>record.rowEventId)).toBe(true);
 expect(await outbox()).toBe(2);
});

test('a single reviewed preview atomically merges 800 record changes under the D1 batch ceiling',async()=>{
 const {mergeFork,MAX_FORK_MERGE_RECORDS}=await import('../src/harness/appMerge.js');
 expect(MAX_FORK_MERGE_RECORDS).toBe(800);
 await env.DB.prepare("INSERT INTO org_settings (org_id,mode,updated_at) VALUES (?1,'harness','now') ON CONFLICT(org_id) DO UPDATE SET mode='harness',updated_at='now'").bind(orgId).run();
 const ids=Array.from({length:MAX_FORK_MERGE_RECORDS},(_,i)=>`bulk_${i}`);
 const seededAt=new Date().toISOString();
 await env.DB.batch(ids.map((id,i)=>env.DB.prepare(`INSERT INTO hx_rows (id,table_id,org_id,data,position,created_by,updated_by,created_at,updated_at)
   VALUES (?1,?2,?3,?4,?5,'1','1',?6,?6)`).bind(id,app.tableId,orgId,JSON.stringify({task:`Original ${i}`}),i,seededAt)));
 const {fork}=await (await run('database',{action:'fork'})).json();
 const stored=await env.DB.prepare('SELECT data FROM hx_app_forks WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND id=?4').bind(orgId,app.id,'1',fork.id).first();
 const preview=JSON.parse(stored.data),previewRows=preview.find(entity=>entity.key==='primary').rows;
 for(let i=0;i<previewRows.length;i++)previewRows[i].values.task=`Reviewed ${i}`;
 const revision=fork.revision+1;
 await env.DB.prepare('UPDATE hx_app_forks SET data=?1,revision=?2 WHERE org_id=?3 AND app_id=?4 AND created_by=?5 AND id=?6').bind(JSON.stringify(preview),revision,orgId,app.id,'1',fork.id).run();
 const request={forkId:fork.id,revision},review=await (await run('database',{action:'merge_preview',...request})).json();
 expect(review.changes).toHaveLength(MAX_FORK_MERGE_RECORDS);
 expect(review.resolved).toBe(true);
 const applied=await mergeFork(env.DB,orgId,app,'1',{...request,checksum:review.checksum});
 expect(applied).toMatchObject({merged:true,changed:MAX_FORK_MERGE_RECORDS});
 expect(applied.changedRecords).toHaveLength(MAX_FORK_MERGE_RECORDS);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_row_event_outbox WHERE org_id=?1').bind(orgId).first()).n).toBe(0);
 const rows=await env.DB.prepare('SELECT id,data FROM hx_rows WHERE org_id=?1 AND table_id=?2 ORDER BY id').bind(orgId,app.tableId).all();
 expect(rows.results).toHaveLength(MAX_FORK_MERGE_RECORDS);
 expect(rows.results.every(row=>JSON.parse(row.data).task.startsWith('Reviewed '))).toBe(true);
});

test('a reviewed merge refuses more Workflow events than the durable queue can accept',async()=>{
 const {mergeFork}=await import('../src/harness/appMerge.js');
 await env.DB.prepare("INSERT INTO org_settings (org_id,mode,updated_at) VALUES (?1,'harness','now') ON CONFLICT(org_id) DO UPDATE SET mode='harness',updated_at='now'").bind(orgId).run();
 expect((await call('/workflows',owner,{name:'Watch queue capacity',enabled:true,trigger:{type:'app_record_change',appId:app.id,entityId:'primary',events:['update']},steps:[{type:'update_row',values:{task:'Observed'}}]})).status).toBe(201);
 const ids=Array.from({length:101},(_,i)=>`queue_${i}`),seededAt=new Date().toISOString();
 await env.DB.batch(ids.map((id,i)=>env.DB.prepare(`INSERT INTO hx_rows (id,table_id,org_id,data,position,created_by,updated_by,created_at,updated_at)
   VALUES (?1,?2,?3,?4,?5,'1','1',?6,?6)`).bind(id,app.tableId,orgId,JSON.stringify({task:`Original ${i}`}),i,seededAt)));
 const {fork}=await (await run('database',{action:'fork'})).json();
 const stored=await env.DB.prepare('SELECT data FROM hx_app_forks WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND id=?4').bind(orgId,app.id,'1',fork.id).first();
 const preview=JSON.parse(stored.data),previewRows=preview.find(entity=>entity.key==='primary').rows;
 for(let i=0;i<previewRows.length;i++)previewRows[i].values.task=`Reviewed ${i}`;
 const revision=fork.revision+1;
 await env.DB.prepare('UPDATE hx_app_forks SET data=?1,revision=?2 WHERE org_id=?3 AND app_id=?4 AND created_by=?5 AND id=?6').bind(JSON.stringify(preview),revision,orgId,app.id,'1',fork.id).run();
 const request={forkId:fork.id,revision},review=await (await run('database',{action:'merge_preview',...request})).json();
 expect(review.changes).toHaveLength(101);
 const result=await mergeFork(env.DB,orgId,app,'1',{...request,checksum:review.checksum});
 expect(result).toMatchObject({status:409});
 expect(result.error).toMatch(/Workflow event queue/);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_rows WHERE org_id=?1 AND table_id=?2').bind(orgId,app.tableId).first()).n).toBe(101);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_row_event_outbox WHERE org_id=?1').bind(orgId).first()).n).toBe(0);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_app_fork_merges WHERE org_id=?1 AND app_id=?2').bind(orgId,app.id).first()).n).toBe(0);
});

test('a concurrent Workflow queue fill cannot race an accepted merge past the atomic capacity fence',async()=>{
 const {mergeFork}=await import('../src/harness/appMerge.js');
 await env.DB.prepare("INSERT INTO org_settings (org_id,mode,updated_at) VALUES (?1,'harness','now') ON CONFLICT(org_id) DO UPDATE SET mode='harness',updated_at='now'").bind(orgId).run();
 const created=await call(`/tables/${app.tableId}/rows`,owner,{values:{task:'Original'}}),original=(await created.json()).row;
 expect((await call('/workflows',owner,{name:'Watch one merge event',enabled:true,trigger:{type:'app_record_change',appId:app.id,entityId:'primary',events:['update']},steps:[{type:'update_row',values:{task:'Observed'}}]})).status).toBe(201);
 const {fork}=await (await run('database',{action:'fork'})).json();
 const forkRow=fork.entities.find(entity=>entity.key==='primary').rows.find(row=>row.id===original.id);
 const changed=await run('database',{action:'fork_write',forkId:fork.id,revision:fork.revision,entity:'primary',operation:'update',rowId:forkRow.id,expectedUpdatedAt:forkRow.updatedAt,values:{task:'Draft'}});
 expect(changed.status).toBe(200);
 const current=(await (await run('database')).json()).fork,request={forkId:current.id,revision:current.revision};
 const review=await (await run('database',{action:'merge_preview',...request})).json();
 await env.DB.batch(Array.from({length:99},(_,i)=>env.DB.prepare(`INSERT INTO hx_workflow_row_event_outbox
   (id,org_id,table_id,event_hash,payload,status,attempts,next_attempt,lease_until,created_at)
   VALUES (?1,?2,?3,'pending-capacity','{}','pending',0,0,0,?4)`).bind(`pending_${i}`,orgId,app.tableId,Date.now())));
 let injected=false;
 const racing={prepare:(...args)=>env.DB.prepare(...args),batch:async statements=>{
   if(!injected){injected=true;await env.DB.prepare(`INSERT INTO hx_workflow_row_event_outbox
     (id,org_id,table_id,event_hash,payload,status,attempts,next_attempt,lease_until,created_at)
     VALUES (?1,?2,?3,'racing-capacity','{}','pending',0,0,0,?4)`).bind('pending_race',orgId,app.tableId,Date.now()).run();}
   return env.DB.batch(statements);
 }};
 expect((await mergeFork(racing,orgId,app,'1',{...request,checksum:review.checksum})).status).toBe(409);
 expect(JSON.parse((await env.DB.prepare('SELECT data FROM hx_rows WHERE org_id=?1 AND table_id=?2 AND id=?3').bind(orgId,app.tableId,original.id).first()).data)).toEqual({task:'Original'});
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_row_event_outbox WHERE org_id=?1 AND status=\'pending\'').bind(orgId).first()).n).toBe(100);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_app_fork_merges WHERE org_id=?1 AND app_id=?2').bind(orgId,app.id).first()).n).toBe(0);
});


test('display preference compare-and-set rejects an older request that reaches the database after revision 3',async()=>{
 const get=await call('/orgs/mode',owner);
 expect(await (await get.json()).revision).toBe(0);
 let injected=false;
 const racingDb={
  prepare:(...args)=>env.DB.prepare(...args),
  batch:async statements=>{
   if(!injected){
    injected=true;
    expect(await setDisplayPreference(env.DB,orgId,'1',false,0,'remote-1')).toMatchObject({simpleOnly:false,revision:1});
    expect(await setDisplayPreference(env.DB,orgId,'1',true,1,'remote-2')).toMatchObject({simpleOnly:true,revision:2});
    expect(await setDisplayPreference(env.DB,orgId,'1',false,2,'remote-3')).toMatchObject({simpleOnly:false,revision:3});
   }
   return env.DB.batch(statements);
  },
 };
 const stale=await worker.fetch(new Request('https://example.com/hx/display-preference',{method:'PUT',headers:{'content-type':'application/json','x-session-token':owner},body:JSON.stringify({orgId,simpleOnly:true,expectedRevision:0})}),{...env,DB:racingDb});
 expect(stale.status).toBe(409);
 expect(await stale.json()).toMatchObject({code:'stale_revision',current:{simpleOnly:false,revision:3}});
 expect(await (await (await call('/orgs/mode',owner)).json())).toMatchObject({simpleOnly:false,revision:3});
});
