import {env} from 'cloudflare:test';
import {beforeEach,expect,test} from 'vitest';
import schema from '../schema.sql?raw';
import {drainWorkflowRowEvents,prepareWorkflowRowEvent} from '../src/harness/workflowRowEventDispatch.js';

beforeEach(async()=>{
 await env.DB.exec(schema.replace(/\n/g,' '));
 await env.DB.exec('CREATE TABLE row_event_test_runs(event_hash TEXT NOT NULL,workflow_id TEXT NOT NULL,PRIMARY KEY(event_hash,workflow_id));');
});

const event=overrides=>({orgId:'outbox-org',table:{id:'table-1',columns:[{id:'name',name:'Name',type:'text'}]},before:null,
 row:{id:'row-1',values:{name:'Example'},updatedAt:'2026-11-10T00:00:00.000Z'},by:'9302',depth:1,...overrides});
async function enqueue(payload,at=1000){
 const prepared=await prepareWorkflowRowEvent(env.DB,{...payload,at});
 await env.DB.batch([prepared.statement]);
 return prepared.id;
}

test('a row write committed before delivery survives a worker crash and cron drains it later',async()=>{
 const payload=event(),prepared=await prepareWorkflowRowEvent(env.DB,{...payload,at:1000});
 await env.DB.batch([prepared.statement]);
 const id=prepared.id;
 expect(await env.DB.prepare('SELECT status,attempts FROM hx_workflow_row_event_outbox WHERE id=?1').bind(id).first())
  .toEqual({status:'pending',attempts:0});
 expect((await env.DB.prepare('SELECT event_hash FROM hx_workflow_row_event_outbox WHERE id=?1').bind(id).first()).event_hash)
  .toMatch(/^[0-9a-f]{64}$/);
 const seen=[];
 const result=await drainWorkflowRowEvents(env,{eventId:id,now:1001,deliver:async(_env,payload)=>seen.push(payload)});
 expect(result).toEqual({claimed:1,delivered:1,retried:0});
 expect(seen).toEqual([event()]);
 expect(await env.DB.prepare('SELECT status,attempts,last_error FROM hx_workflow_row_event_outbox WHERE id=?1').bind(id).first())
  .toMatchObject({status:'done',attempts:1,last_error:null});
});

test('a retry after partial fan-out does not duplicate workflows already started',async()=>{
 const id=await enqueue(event(),1000),starts=[];
 let failMidFanout=true;
 const deliver=async(_env,payload)=>{
  for(const workflowId of ['workflow-a','workflow-b']){
   const eventHash=`${payload.table.id}:${payload.row.id}:${workflowId}`;
   await env.DB.prepare('INSERT OR IGNORE INTO row_event_test_runs(event_hash,workflow_id) VALUES(?1,?2)').bind(eventHash,workflowId).run();
   starts.push([workflowId,(await env.DB.prepare('SELECT changes() AS changed').first()).changed]);
   if(workflowId==='workflow-a'&&failMidFanout){failMidFanout=false;throw new Error('temporary database read failure after first workflow');}
  }
 };
 const first=await drainWorkflowRowEvents(env,{eventId:id,now:1001,deliver});
 expect(first).toEqual({claimed:1,delivered:0,retried:1});
 expect(await env.DB.prepare('SELECT status,attempts,next_attempt,last_error FROM hx_workflow_row_event_outbox WHERE id=?1').bind(id).first())
  .toMatchObject({status:'pending',attempts:1,next_attempt:2001,last_error:'temporary database read failure after first workflow'});
 const second=await drainWorkflowRowEvents(env,{eventId:id,now:2001,deliver});
 expect(second).toEqual({claimed:1,delivered:1,retried:0});
 expect((await env.DB.prepare('SELECT workflow_id FROM row_event_test_runs ORDER BY workflow_id').all()).results)
  .toEqual([{workflow_id:'workflow-a'},{workflow_id:'workflow-b'}]);
 expect(starts).toHaveLength(3);
});

test('a transient trigger-read failure releases its lease and is retried with backoff',async()=>{
 const id=await enqueue(event(),1000);
 let calls=0;
 const deliver=async()=>{calls+=1;if(calls===1)throw new Error('D1 read unavailable');};
 await drainWorkflowRowEvents(env,{eventId:id,now:1001,deliver});
 expect(await drainWorkflowRowEvents(env,{eventId:id,now:1500,deliver})).toEqual({claimed:0,delivered:0,retried:0});
 expect(await drainWorkflowRowEvents(env,{eventId:id,now:2001,deliver})).toEqual({claimed:1,delivered:1,retried:0});
 expect(calls).toBe(2);
});

test('outbox payloads are bounded before they enter the row-write batch',async()=>{
 await expect(prepareWorkflowRowEvent(env.DB,event({row:{id:'row-1',values:{blob:'x'.repeat(200_001)},updatedAt:'2026-11-10T00:00:00.000Z'}})))
  .rejects.toThrow(/exceeds 200000 bytes/);
 expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_row_event_outbox').first()).toEqual({n:0});
});

test('pending events are capped per workspace so a stuck drain cannot grow without bound',async()=>{
 const insert=env.DB.prepare(`INSERT INTO hx_workflow_row_event_outbox(id,org_id,table_id,event_hash,payload,status,attempts,next_attempt,lease_until,created_at)
  VALUES(?1,'outbox-org','table-1','test-hash','{}','pending',0,0,0,1000)`);
 await env.DB.batch(Array.from({length:100},(_,index)=>insert.bind(`queued-${index}`)));
 const next=await prepareWorkflowRowEvent(env.DB,event());
 expect((await next.statement.run()).meta.changes).toBe(0);
 expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_workflow_row_event_outbox WHERE org_id='outbox-org' AND status='pending'").first())
  .toEqual({n:100});
});
