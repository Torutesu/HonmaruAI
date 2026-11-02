import { env } from 'cloudflare:test';
import { expect, test } from 'vitest';
import schema from '../schema.sql?raw';
import worker from '../src/index.js';
import { createSession, upsertMembership, upsertUser } from '../src/db.js';

const org = 'personal:bind-boundary';
const call = (path, token, body, method='POST', db=env.DB) => worker.fetch(new Request(`https://example.com${path}`, { method, headers:{'content-type':'application/json','x-session-token':token}, body:JSON.stringify({orgId:org,...body}) }), {...env,DB:db});
function observe(limit=Infinity) {
  const hits=[];
  const db=new Proxy(env.DB,{get(target,prop){
    if(prop==='prepare')return sql=>{
      const stmt=target.prepare(sql);
      if(!sql.startsWith('INSERT INTO hx_rows (id, table_id')&&!sql.startsWith('UPDATE hx_rows SET data = ?1'))return stmt;
      return {bind(...args){ hits.push({kind:sql.startsWith('INSERT')?'add':'update',count:args.length}); if(args.length>limit) throw new Error('simulated 100 bind quota'); return stmt.bind(...args); }};
    };
    const value=target[prop];return typeof value==='function'?value.bind(target):value;
  }});
  return {db,hits};
}

test('records actual and simulated 100-bind outcomes for normal relation writes',async()=>{
  await env.DB.exec(schema.replace(/\n/g,' '));
  await upsertUser(env.DB,{githubId:'bind-owner',login:'bind-owner',name:'Bind Owner'});
  await upsertMembership(env.DB,org,'bind-owner','admin');
  const token=await createSession(env.DB,'bind-owner','gho_bind');
  const created=await call('/apps',token,{name:'Many relations',columns:[{name:'Task',type:'text'}]});expect(created.status).toBe(201);
  const app=(await created.json()).app;
  const relations=Array.from({length:39},(_,i)=>({name:`Link ${i}`,type:'relation',targetEntity:'primary'}));
  const migration=await call(`/apps/${app.id}/database`,token,{action:'migrate',id:'many_relations',version:0,operations:[{op:'add_columns',entity:'primary',columns:relations}]});
  expect(migration.status).toBe(200);
  const madeTarget=await call(`/tables/${app.tableId}/rows`,token,{values:{task:'Target'}});expect(madeTarget.status).toBe(201);
  const target=(await madeTarget.json()).row;
  const outcomes=[];
  for(const n of [30,31,32,33,39]) {
    const values={task:`Candidate ${n}`};for(let i=0;i<n;i++)values[`link_${i}`]=target.id;
    const actual=observe();
    const add=await call(`/tables/${app.tableId}/rows`,token,{values},'POST',actual.db);
    const updateStatus=(await call(`/tables/${app.tableId}/rows/${target.id}`,token,{values},'PATCH',actual.db)).status;
    const capped=observe(100);
    const addCap=await call(`/tables/${app.tableId}/rows`,token,{values},'POST',capped.db);
    const updateCap=await call(`/tables/${app.tableId}/rows/${target.id}`,token,{values},'PATCH',capped.db);
    outcomes.push({n,actualAdd:add.status,actualUpdate:updateStatus,actualBinds:actual.hits,simulatedAdd:addCap.status,simulatedUpdate:updateCap.status,simulatedBinds:capped.hits});
  }
  const fixed=11;
  for(const o of outcomes) {
    const count=fixed;
    expect(o.actualBinds).toEqual([{kind:'add',count},{kind:'update',count}]);
    expect(o.actualAdd).toBe(count<=100?201:500);
    expect(o.actualUpdate).toBe(count<=100?200:500);
    expect(o.simulatedAdd).toBe(count<=100?201:500);
    expect(o.simulatedUpdate).toBe(count<=100?200:500);
  }
},60000);
