import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import schemaSql from '../schema.sql?raw';
import worker from '../src/index.js';
import { createSession, upsertMembership, upsertUser } from '../src/db.js';

const orgId='personal:relations';let owner,app;
const headers=token=>({'content-type':'application/json','x-session-token':token});
const call=(path,token,body,method)=>worker.fetch(new Request(`https://example.com${path}${body?'':`${path.includes('?')?'&':'?'}orgId=${orgId}`}`,{
  method:method||(body?'POST':'GET'),headers:headers(token),...(body?{body:JSON.stringify({orgId,...body})}:{})
}),{...env});
const dbCall=(body)=>call(`/apps/${app.id}/database`,owner,body);
async function installRelations(){
  const migration=await dbCall({action:'migrate',id:'relations_v1',version:0,operations:[
    {op:'create_entity',entity:'customers',name:'Customers',columns:[{name:'Name',type:'text'}]},
    {op:'add_columns',entity:'primary',columns:[{name:'Customer',type:'relation',targetEntity:'customers'},{name:'Watchers',type:'relation',targetEntity:'customers',multiple:true}]},
  ]});
  expect(migration.status).toBe(200);
  const database=await (await call(`/apps/${app.id}/database`,owner)).json();
  return database.entities.find(entity=>entity.key==='customers');
}
async function deleteRow(tableId,row){return call(`/tables/${tableId}/rows/${row.id}?orgId=${orgId}&expectedUpdatedAt=${encodeURIComponent(row.updatedAt)}`,owner,undefined,'DELETE')}

beforeEach(async()=>{
  await env.DB.exec(schemaSql.replace(/\n/g,' '));
  await upsertUser(env.DB,{githubId:'8101',login:'relation-owner',name:'Relation Owner'});
  await upsertMembership(env.DB,orgId,'8101','admin');
  owner=await createSession(env.DB,'8101','gho_relation_owner');
  app=(await (await call('/apps',owner,{name:'Relation app',columns:[{name:'Task',type:'text'}]})).json()).app;
});

test('app relations require valid same-app targets and protect linked records from deletion',async()=>{
  const invalid=await dbCall({action:'migrate',id:'invalid_relation',version:0,operations:[{op:'add_columns',entity:'primary',columns:[{name:'Broken',type:'relation',targetEntity:'missing'}]}]});
  expect(invalid.status).toBe(400);
  const customerEntity=await installRelations();
  const customer=(await (await call(`/tables/${customerEntity.table.id}/rows`,owner,{values:{name:'Acme'}})).json()).row;
  const foreignApp=(await (await call('/apps',owner,{name:'Other app',columns:[{name:'Name',type:'text'}]})).json()).app;
  const foreign=(await (await call(`/tables/${foreignApp.tableId}/rows`,owner,{values:{name:'Outside'}})).json()).row;
  expect((await call(`/tables/${app.tableId}/rows`,owner,{values:{task:'Bad',customer:'row_missing'}})).status).toBe(400);
  expect((await call(`/tables/${app.tableId}/rows`,owner,{values:{task:'Bad',customer:foreign.id}})).status).toBe(400);
  expect((await call(`/tables/${app.tableId}/rows`,owner,{values:{task:'Bad multi',watchers:'not-an-array'},validation:'strict'})).status).toBe(400);

  const row=(await (await call(`/tables/${app.tableId}/rows`,owner,{values:{task:'Linked',customer:customer.id,watchers:[customer.id]}})).json()).row;
  expect(row.values).toMatchObject({customer:customer.id,watchers:[customer.id]});
  expect((await deleteRow(customerEntity.table.id,customer)).status).toBe(409);
  const unlinked=(await (await call(`/tables/${app.tableId}/rows/${row.id}`,owner,{values:{customer:null,watchers:[]},expectedUpdatedAt:row.updatedAt},'PATCH')).json()).row;
  expect(unlinked.values).toMatchObject({customer:null,watchers:[]});
  expect((await deleteRow(customerEntity.table.id,customer)).status).toBe(200);

  const raceTarget=(await (await call(`/tables/${customerEntity.table.id}/rows`,owner,{values:{name:'Concurrent'}})).json()).row;
  const {deleteRow:deleteRecord}=await import('../src/harness/tables.js');
  const racingDb={prepare(sql){const statement=env.DB.prepare(sql);if(!sql.startsWith('DELETE FROM hx_rows'))return statement;return {bind(...values){const bound=statement.bind(...values);return {first:async()=>{await env.DB.prepare('INSERT INTO hx_rows (id,table_id,org_id,data,position,created_by,updated_by,created_at,updated_at) VALUES (?1,?2,?3,?4,0,?5,?5,?6,?6)').bind('row_race',app.tableId,orgId,JSON.stringify({customer:raceTarget.id}),'8101',new Date().toISOString()).run();return bound.first()}}}}}};
  expect((await deleteRecord(racingDb,orgId,customerEntity.table.id,raceTarget.id,raceTarget.updatedAt)).status).toBe(409);
  await env.DB.prepare('DELETE FROM hx_rows WHERE org_id=?1 AND id=?2').bind(orgId,'row_race').run();
  expect((await deleteRecord(env.DB,orgId,customerEntity.table.id,raceTarget.id,raceTarget.updatedAt)).deleted).toBe(true);
});

test('a preview can add linked records together and merge rejects an orphaned final state',async()=>{
  const customerEntity=await installRelations();
  let {fork}=await (await dbCall({action:'fork'})).json();
  let changed=await (await dbCall({action:'fork_write',forkId:fork.id,revision:fork.revision,entity:'customers',operation:'create',values:{name:'Draft customer'}})).json();
  const customerId=changed.result.id;fork.revision=changed.revision;
  changed=await (await dbCall({action:'fork_write',forkId:fork.id,revision:fork.revision,entity:'primary',operation:'create',values:{task:'Draft task',customer:customerId,watchers:[customerId]}})).json();
  fork.revision=changed.revision;
  let review=await (await dbCall({action:'merge_preview',forkId:fork.id,revision:fork.revision})).json();
  expect(review.changes.map(change=>change.operation)).toEqual(['create','create']);
  expect(review.conflicts).toEqual([]);
  expect((await dbCall({action:'merge_apply',forkId:fork.id,revision:fork.revision,checksum:review.checksum})).status).toBe(200);
  const appRows=await (await call(`/tables/${app.tableId}`,owner)).json();
  const customerRows=await (await call(`/tables/${customerEntity.table.id}`,owner)).json();
  expect(appRows.rows[0].values.customer).toBe(customerRows.rows[0].id);

  const fresh=(await (await dbCall({action:'fork'})).json()).fork;
  expect((await dbCall({action:'fork_write',forkId:fresh.id,revision:fresh.revision,entity:'customers',operation:'remove',rowId:customerRows.rows[0].id})).status).toBe(409);
  const broken=fresh.entities.map(entity=>entity.key==='customers'?{...entity,rows:[]}:entity);
  await env.DB.prepare('UPDATE hx_app_forks SET data=?1,revision=revision+1 WHERE org_id=?2 AND app_id=?3 AND created_by=?4 AND id=?5')
    .bind(JSON.stringify(broken),orgId,app.id,'8101',fresh.id).run();
  const rejected=await dbCall({action:'merge_preview',forkId:fresh.id,revision:fresh.revision+1});
  expect(rejected.status).toBe(409);
  expect((await rejected.json()).message).toMatch(/linked|relation/i);
});

async function previewPending(){
  const {fork}=await (await dbCall({action:'fork'})).json();
  const changed=await (await dbCall({action:'fork_write',forkId:fork.id,revision:fork.revision,entity:'primary',operation:'create',values:{task:'Pending'}})).json();
  const req={forkId:fork.id,revision:changed.revision};
  const review=await (await dbCall({action:'merge_preview',...req})).json();
  return {...req,checksum:review.checksum,rowId:changed.result.id};
}
test('merge preview and apply refuse tables linked to an inaccessible private app',async()=>{
  const pending=await previewPending();
  await upsertUser(env.DB,{githubId:'8102',login:'private-owner',name:'Private Owner'});
  await upsertMembership(env.DB,orgId,'8102','member');
  const other=await createSession(env.DB,'8102','gho_private_owner');
  const hidden=(await (await call('/apps',other,{name:'Private app',columns:[{name:'Name',type:'text'}],privateByDefault:true})).json()).app;
  await env.DB.prepare('UPDATE hx_apps SET table_id=?1 WHERE org_id=?2 AND id=?3').bind(app.tableId,orgId,hidden.id).run();
  expect((await call(`/tables/${app.tableId}`,owner)).status).toBe(404);
  expect((await dbCall({action:'merge_preview',forkId:pending.forkId,revision:pending.revision})).status).toBe(404);
  expect((await dbCall({action:'merge_apply',...pending})).status).toBe(404);
  expect(await env.DB.prepare('SELECT id FROM hx_rows WHERE id=?').bind(pending.rowId).first()).toBeNull();
});
test('merge is fenced when membership is revoked before its transaction',async()=>{
  const pending=await previewPending();
  const {mergeFork}=await import('../src/harness/appMerge.js');
  let injected=false;
  const racingDb=new Proxy(env.DB,{get(target,prop){
    if(prop==='batch')return async statements=>{
      if(!injected){injected=true;await target.prepare("UPDATE memberships SET role='guest' WHERE org_id=?1 AND user_github_id='8101'").bind(orgId).run();}
      return target.batch(statements);
    };
    const value=target[prop];return typeof value==='function'?value.bind(target):value;
  }});
  expect((await mergeFork(racingDb,orgId,app,'8101',pending)).status).toBe(409);
  expect(injected).toBe(true);
  expect(await env.DB.prepare('SELECT id FROM hx_rows WHERE id=?').bind(pending.rowId).first()).toBeNull();
  expect(await env.DB.prepare('SELECT nonce FROM hx_app_fork_merges WHERE fork_id=?').bind(pending.forkId).first()).toBeNull();
});
test('merge is fenced when another private app is linked before its transaction',async()=>{
  const pending=await previewPending();
  await upsertUser(env.DB,{githubId:'8102',login:'private-owner',name:'Private Owner'});
  await upsertMembership(env.DB,orgId,'8102','member');
  const other=await createSession(env.DB,'8102','gho_private_owner');
  const hidden=(await (await call('/apps',other,{name:'Private app',columns:[{name:'Name',type:'text'}],privateByDefault:true})).json()).app;
  const {mergeFork}=await import('../src/harness/appMerge.js');
  let injected=false;
  const racingDb=new Proxy(env.DB,{get(target,prop){
    if(prop==='batch')return async statements=>{
      if(!injected){injected=true;await target.prepare('UPDATE hx_apps SET table_id=?1 WHERE org_id=?2 AND id=?3').bind(app.tableId,orgId,hidden.id).run();}
      return target.batch(statements);
    };
    const value=target[prop];return typeof value==='function'?value.bind(target):value;
  }});
  expect((await mergeFork(racingDb,orgId,app,'8101',pending)).status).toBe(409);
  expect(injected).toBe(true);
  expect(await env.DB.prepare('SELECT id FROM hx_rows WHERE id=?').bind(pending.rowId).first()).toBeNull();
  expect(await env.DB.prepare('SELECT nonce FROM hx_app_fork_merges WHERE fork_id=?').bind(pending.forkId).first()).toBeNull();
});
test('merge preview checks access to secondary entities, including unchanged ones',async()=>{
  const entity=await installRelations();
  const pending=await previewPending();
  await upsertUser(env.DB,{githubId:'8102',login:'private-owner',name:'Private Owner'});
  await upsertMembership(env.DB,orgId,'8102','member');
  const other=await createSession(env.DB,'8102','gho_private_owner');
  const hidden=(await (await call('/apps',other,{name:'Private app',columns:[{name:'Name',type:'text'}],privateByDefault:true})).json()).app;
  await env.DB.prepare('UPDATE hx_apps SET table_id=?1 WHERE org_id=?2 AND id=?3').bind(entity.table.id,orgId,hidden.id).run();
  expect((await dbCall({action:'merge_preview',forkId:pending.forkId,revision:pending.revision})).status).toBe(404);
  expect((await dbCall({action:'merge_apply',...pending})).status).toBe(404);
});

test.each(['purging','tombstone'])('merge is fenced when workspace becomes %s before its transaction',async state=>{
  const pending=await previewPending();
  const {mergeFork}=await import('../src/harness/appMerge.js');
  let injected=false;
  const racingDb=new Proxy(env.DB,{get(target,prop){
    if(prop==='batch')return async statements=>{
      if(!injected){injected=true;
        if(state==='purging')await target.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at,purge_started_at) VALUES (?,'2026-01-01','8101','2026-01-01','2026-01-01')").bind(orgId).run();
        else await target.prepare("INSERT INTO workspace_tombstones(org_id,deleted_at,requested_by) VALUES (?,'2026-01-01','8101')").bind(orgId).run();
      }
      return target.batch(statements);
    };
    const value=target[prop];return typeof value==='function'?value.bind(target):value;
  }});
  expect((await mergeFork(racingDb,orgId,app,'8101',pending)).status).toBe(409);
  expect(injected).toBe(true);
  expect(await env.DB.prepare('SELECT id FROM hx_rows WHERE id=?').bind(pending.rowId).first()).toBeNull();
  expect(await env.DB.prepare('SELECT nonce FROM hx_app_fork_merges WHERE fork_id=?').bind(pending.forkId).first()).toBeNull();
});
