import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import schemaSql from '../schema.sql?raw';
import worker from '../src/index.js';
import { createSession, getSession, sessionKey, upsertMembership, upsertUser } from '../src/db.js';
import {currentSkillPolicy} from '../src/harness/skillPolicyProof.js';
import {deleteRow as deleteRecord} from '../src/harness/tables.js';

const org='personal:row-guard';let owner,member,app,row;
const request=(path,token,{method='GET',body,db=env.DB}={})=>worker.fetch(new Request(`https://example.com${path}${path.includes('?')?'&':'?'}orgId=${encodeURIComponent(org)}`,{method,headers:{'content-type':'application/json','x-session-token':token},...(body?{body:JSON.stringify({orgId:org,...body})}:{})}),{...env,DB:db});
const add=(path,body,token=owner)=>request(path,token,{method:'POST',body});
const erase=(db=env.DB,version=row.updatedAt)=>request(`/tables/${app.tableId}/rows/${row.id}?expectedUpdatedAt=${encodeURIComponent(version)}`,member,{method:'DELETE',db});
function beforeDelete(fn){let injected=false;return {get injected(){return injected},db:new Proxy(env.DB,{get(target,prop){
 if(prop==='prepare')return sql=>{const stmt=target.prepare(sql);if(!sql.startsWith('DELETE FROM hx_rows WHERE id')||injected)return stmt;return {bind(...values){const bound=stmt.bind(...values);return {first:async()=>{if(!injected){injected=true;await fn()}return bound.first()}}}}};
 const value=target[prop];return typeof value==='function'?value.bind(target):value;
}})}}
beforeEach(async()=>{
 await env.DB.exec(schemaSql.replace(/\n/g,' '));
 for(const [id,role] of [['9101','admin'],['9102','member'],['9103','member']]){await upsertUser(env.DB,{githubId:id,login:`user${id}`,name:`user${id}`});await upsertMembership(env.DB,org,id,role)}
 owner=await createSession(env.DB,'9101','gho_owner');member=await createSession(env.DB,'9102','gho_member');
 app=(await (await add('/apps',{name:'Tasks',columns:[{name:'Task',type:'text'}]})).json()).app;
 row=(await (await add(`/tables/${app.tableId}/rows`,{values:{task:'Example'}})).json()).row;
});


test('stale text update is rejected after schema migration and target deletion',async()=>{
 let updated=await request(`/tables/${app.tableId}/rows/${row.id}`,member,{method:'PATCH',body:{values:{task:null},expectedUpdatedAt:row.updatedAt}});
 expect(updated.status).toBe(200);row=(await updated.json()).row;
 const source=(await (await add(`/tables/${app.tableId}/rows`,{values:{task:null}})).json()).row;
 const operations=[{op:'convert_column',entity:'primary',column:'task',type:'relation',targetEntity:'primary',multiple:false}];
 let injected=false;
 const db=new Proxy(env.DB,{get(target,prop){if(prop==='prepare')return sql=>{const stmt=target.prepare(sql);if(!sql.startsWith('UPDATE hx_rows SET data = ?1')||injected)return stmt;return {bind(...values){const bound=stmt.bind(...values);return {first:async()=>{
  injected=true;
  const preview=await add(`/apps/${app.id}/database`,{action:'preview',id:'race_migration',version:0,operations});expect(preview.status).toBe(200);const data=await preview.json();expect(data.canApply).toBe(true);
  const migration=await add(`/apps/${app.id}/database`,{action:'migrate',id:'race_migration',version:0,operations,previewChecksum:data.previewChecksum});expect(migration.status).toBe(200);
  expect((await erase()).status).toBe(200);
  return bound.first();
 }}}}};const value=target[prop];return typeof value==='function'?value.bind(target):value}});
 updated=await request(`/tables/${app.tableId}/rows/${source.id}`,member,{method:'PATCH',body:{values:{task:row.id},expectedUpdatedAt:source.updatedAt},db});
 expect(injected).toBe(true);expect(updated.status).toBe(409);
 expect(await env.DB.prepare('SELECT id FROM hx_rows WHERE id=?').bind(row.id).first()).toBeNull();
 expect(JSON.parse((await env.DB.prepare('SELECT data FROM hx_rows WHERE id=?').bind(source.id).first()).data).task).toBeNull();
});

test('stale text insert is rejected after schema migration and target deletion',async()=>{
 let updated=await request(`/tables/${app.tableId}/rows/${row.id}`,member,{method:'PATCH',body:{values:{task:null},expectedUpdatedAt:row.updatedAt}});
 expect(updated.status).toBe(200);row=(await updated.json()).row;
 const operations=[{op:'convert_column',entity:'primary',column:'task',type:'relation',targetEntity:'primary',multiple:false}];let injected=false;
 const db=new Proxy(env.DB,{get(target,prop){if(prop==='prepare')return sql=>{const stmt=target.prepare(sql);if(!sql.startsWith('INSERT INTO hx_rows (id, table_id')||injected)return stmt;return {bind(...values){const bound=stmt.bind(...values);return {run:async()=>{
  injected=true;
  const preview=await add(`/apps/${app.id}/database`,{action:'preview',id:'race_insert',version:0,operations});expect(preview.status).toBe(200);const data=await preview.json();expect(data.canApply).toBe(true);
  const migration=await add(`/apps/${app.id}/database`,{action:'migrate',id:'race_insert',version:0,operations,previewChecksum:data.previewChecksum});expect(migration.status).toBe(200);
  expect((await erase()).status).toBe(200);return bound.run();
 }}}}};const value=target[prop];return typeof value==='function'?value.bind(target):value}});
 const response=await request(`/tables/${app.tableId}/rows`,member,{method:'POST',body:{values:{task:row.id}},db});
 expect(injected).toBe(true);expect(response.status).toBe(409);
 expect(await env.DB.prepare('SELECT id FROM hx_rows WHERE id=?').bind(row.id).first()).toBeNull();
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_rows WHERE table_id=?').bind(app.tableId).first()).n).toBe(0);
});

test('pending record creation is rejected after the owning app and table are deleted',async()=>{
 let injected=false;
 const db=new Proxy(env.DB,{get(target,prop){if(prop==='prepare')return sql=>{const stmt=target.prepare(sql);if(!sql.startsWith('INSERT INTO hx_rows (id, table_id')||injected)return stmt;return {bind(...values){const bound=stmt.bind(...values);return {run:async()=>{
  injected=true;
  const deleted=await request(`/apps/${app.id}`,owner,{method:'DELETE'});expect(deleted.status).toBe(200);
  return bound.run();
 }}}}};const value=target[prop];return typeof value==='function'?value.bind(target):value}});
 const response=await request(`/tables/${app.tableId}/rows`,member,{method:'POST',body:{values:{task:'Orphan'}},db});
 expect(injected).toBe(true);expect(response.status).toBe(409);
 expect(await env.DB.prepare('SELECT id FROM hx_tables WHERE id=?').bind(app.tableId).first()).toBeNull();
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_rows WHERE table_id=?').bind(app.tableId).first()).n).toBe(0);
});

