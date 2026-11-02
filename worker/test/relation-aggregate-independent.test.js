import { env } from 'cloudflare:test';
import { expect, test } from 'vitest';
import schema from '../schema.sql?raw';
import worker from '../src/index.js';
import { createSession, upsertMembership, upsertUser } from '../src/db.js';

const org = 'personal:aggregate-independent';
const request = (path, token, body, method='POST', db=env.DB) => worker.fetch(new Request(`https://example.com${path}${method==='DELETE'?`?orgId=${encodeURIComponent(org)}`:''}`, { method, headers:{'content-type':'application/json','x-session-token':token}, ...(body?{body:JSON.stringify({orgId:org,...body})}:{}) }), {...env,DB:db});
async function setup({multiple=false}={}) {
  await env.DB.exec(schema.replace(/\n/g,' '));
  await upsertUser(env.DB,{githubId:'bind-owner',login:'bind-owner',name:'Bind Owner'});
  await upsertMembership(env.DB,org,'bind-owner','admin');
  const token=await createSession(env.DB,'bind-owner','gho_bind');
  const made=await request('/apps',token,{name:'Many relations',columns:[{name:'Task',type:'text'}]});expect(made.status).toBe(201);
  const app=(await made.json()).app;
  const columns=Array.from({length:39},(_,i)=>({name:`Link ${i}`,type:'relation',targetEntity:'primary',multiple:multiple&&i%2===0}));
  let response=await request(`/apps/${app.id}/database`,token,{action:'migrate',id:'many_relations',version:0,operations:[{op:'add_columns',entity:'primary',columns}]});expect(response.status).toBe(200);
  const operations=[{op:'convert_column',entity:'primary',column:'task',type:'relation',targetEntity:'primary',multiple}];
  response=await request(`/apps/${app.id}/database`,token,{action:'preview',id:'convert_initial',version:1,operations});expect(response.status).toBe(200);
  const preview=await response.json();expect(preview.canApply).toBe(true);
  response=await request(`/apps/${app.id}/database`,token,{action:'migrate',id:'convert_initial',version:1,operations,previewChecksum:preview.previewChecksum});expect(response.status).toBe(200);
  response=await request(`/tables/${app.tableId}/rows`,token,{values:{}});expect(response.status).toBe(201);const target=(await response.json()).row;
  response=await request(`/tables/${app.tableId}/rows`,token,{values:{}});expect(response.status).toBe(201);const source=(await response.json()).row;
  return {token,app,target,source};
}
function valuesFor(target,n,multiple) {
  const values={task:multiple?[target.id]:target.id};
  for(let i=0;i<n-1;i++)values[`link_${i}`]=multiple&&i%2===0?[target.id]:target.id;
  return values;
}
function observe() {
  const hits=[];const db=new Proxy(env.DB,{get(target,prop){
    if(prop==='prepare')return sql=>{const stmt=target.prepare(sql);if(!/\b(?:INSERT INTO hx_rows|UPDATE hx_rows SET data)\b/.test(sql))return stmt;
      return {bind(...args){hits.push({count:args.length});return stmt.bind(...args)}}};
    const value=target[prop];return typeof value==='function'?value.bind(target):value;
  }});return {db,hits};
}
test.each([[31,false],[40,false],[31,true],[40,true]])('%s relation columns write, including multiple=%s',async(n,multiple)=>{
 const {token,app,target,source}=await setup({multiple});const values=valuesFor(target,n,multiple), seen=observe();
 let response=await request(`/tables/${app.tableId}/rows`,token,{values},'POST',seen.db);expect(response.status).toBe(201);
 response=await request(`/tables/${app.tableId}/rows/${source.id}`,token,{values,expectedUpdatedAt:source.updatedAt},'PATCH',seen.db);expect(response.status).toBe(200);
 const changed=(await response.json()).row;for(const [key,value] of Object.entries(values))expect(changed.values[key]).toEqual(value);
 expect(seen.hits).toHaveLength(2);expect(seen.hits.every(x=>x.count<=100)).toBe(true);
},60000);

test.each([false,true])('foreign workspace target is rejected for multiple=%s',async multiple=>{
 const {token,app}=await setup({multiple});const other='personal:foreign-aggregate';
 await upsertMembership(env.DB,other,'bind-owner','admin');
 const created=await worker.fetch(new Request('https://example.com/apps',{method:'POST',headers:{'content-type':'application/json','x-session-token':token},body:JSON.stringify({orgId:other,name:'Foreign',columns:[{name:'Name',type:'text'}]})}),env);expect(created.status).toBe(201);
 const foreignApp=(await created.json()).app;
 const added=await worker.fetch(new Request(`https://example.com/tables/${foreignApp.tableId}/rows`,{method:'POST',headers:{'content-type':'application/json','x-session-token':token},body:JSON.stringify({orgId:other,values:{name:'Foreign'}})}),env);expect(added.status).toBe(201);
 const foreign=(await added.json()).row;
 const result=await request(`/tables/${app.tableId}/rows`,token,{values:valuesFor(foreign,31,multiple)});expect(result.status).toBe(400);
});

test.each([['POST',false],['PATCH',false],['POST',true],['PATCH',true]])('target deletion before %s commit fails closed (multiple=%s)',async(method,multiple)=>{
 const {token,app,target,source}=await setup({multiple});let injected=false;const seen=observe();
 const db=new Proxy(seen.db,{get(inner,prop){if(prop==='prepare')return sql=>{const stmt=inner.prepare(sql);const isWrite=method==='POST'?/\bINSERT INTO hx_rows\b/.test(sql):/\bUPDATE hx_rows SET data\b/.test(sql);if(!isWrite||injected)return stmt;
  return {bind(...args){const bound=stmt.bind(...args);const operation=method==='POST'?'run':'first';return {[operation]:async()=>{injected=true;const deleted=await request(`/tables/${app.tableId}/rows/${target.id}`,token,null,'DELETE');expect(deleted.status).toBe(200);return bound[operation]()}}}}};return inner[prop]}});
 const path=method==='POST'?`/tables/${app.tableId}/rows`:`/tables/${app.tableId}/rows/${source.id}`;
 const response=await request(path,token,{values:valuesFor(target,31,multiple),...(method==='PATCH'?{expectedUpdatedAt:source.updatedAt}:{})},method,db);
 expect(injected).toBe(true);expect(response.status).toBe(409);
 const row=await env.DB.prepare('SELECT data FROM hx_rows WHERE org_id=?1 AND id=?2').bind(org,source.id).first();expect(JSON.parse(row.data)).toEqual({});
},60000);

test('null, empty arrays and duplicate IDs retain legacy normalisation',async()=>{
 const {token,app,target}=await setup({multiple:true});
 const values={task:null,link_0:[],link_1:null,link_2:[target.id,target.id]};
 const response=await request(`/tables/${app.tableId}/rows`,token,{values});expect(response.status).toBe(201);
 expect((await response.json()).row.values).toEqual({task:null,link_0:[],link_1:null,link_2:[target.id]});
});

test.each([false,true])('missing and malformed relation values are not stored, multiple=%s',async multiple=>{
 const {token,app,target}=await setup({multiple});
 for(const value of multiple?[[target.id,'row_missing'],[target.id,null],[target.id,5],[target.id,{}]]:['row_missing',5,{}]) {
  const response=await request(`/tables/${app.tableId}/rows`,token,{values:{task:value}});expect(response.status).toBe(400);
 }
 const count=await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_rows WHERE org_id=?1 AND table_id=?2').bind(org,app.tableId).first();expect(count.n).toBe(2);
});

test('non-JSON numeric and undefined inputs fail before array serialisation',async()=>{
 const {app,target}=await setup({multiple:true});const {addRow}=await import('../src/harness/tables.js');
 for(const item of [undefined,NaN,Infinity,{id:target.id},[target.id]]) {
  const result=await addRow(env.DB,org,app.tableId,{task:[target.id,item]},'bind-owner');expect(result.status).toBe(400);
 }
 const count=await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_rows WHERE org_id=?1 AND table_id=?2').bind(org,app.tableId).first();expect(count.n).toBe(2);
});

test('an invalid legacy stored relation cannot pass by updating another field',async()=>{
 const {token,app,source}=await setup({multiple:true});
 await env.DB.prepare('UPDATE hx_rows SET data=?1 WHERE org_id=?2 AND id=?3').bind(JSON.stringify({link_0:[12]}),org,source.id).run();
 const response=await request(`/tables/${app.tableId}/rows/${source.id}`,token,{values:{task:null},expectedUpdatedAt:source.updatedAt},'PATCH');
 expect(response.status).toBe(400);
 const stored=await env.DB.prepare('SELECT data FROM hx_rows WHERE org_id=?1 AND id=?2').bind(org,source.id).first();expect(JSON.parse(stored.data)).toEqual({link_0:[12]});
});

test('one deleted target among a grouped set blocks the whole multi-relation write',async()=>{
 const {token,app,target}=await setup({multiple:true});
 const next=await request(`/tables/${app.tableId}/rows`,token,{values:{}});expect(next.status).toBe(201);const second=(await next.json()).row;
 let injected=false;
 const db=new Proxy(env.DB,{get(inner,prop){if(prop==='prepare')return sql=>{const stmt=inner.prepare(sql);if(!/\bINSERT INTO hx_rows\b/.test(sql)||injected)return stmt;
  return {bind(...args){const bound=stmt.bind(...args);return {run:async()=>{injected=true;const deleted=await request(`/tables/${app.tableId}/rows/${second.id}`,token,null,'DELETE');expect(deleted.status).toBe(200);return bound.run()}}}}};const value=inner[prop];return typeof value==='function'?value.bind(inner):value}});
 const values=valuesFor(target,40,true);for(let i=0;i<39;i+=2)values[`link_${i}`]=[target.id,second.id];
 const response=await request(`/tables/${app.tableId}/rows`,token,{values},'POST',db);expect(injected).toBe(true);expect(response.status).toBe(409);
 const count=await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_rows WHERE org_id=?1 AND table_id=?2').bind(org,app.tableId).first();expect(count.n).toBe(2);
});
