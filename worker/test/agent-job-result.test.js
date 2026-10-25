import {env} from 'cloudflare:test';
import {AgentRunner} from '../src/agentRunner.js';
import {expect,test,vi} from 'vitest';
import {runTrackedAgentJob} from '../src/agentJobResult.js';
const job={orgId:'org',rowId:'request',queuedAt:100};
const key='job:100:agent:request',resultKey='result:["org","agent","request"]';
function store(){const data=new Map([[key,job]]);return {data,get:async k=>data.get(k),put:async(k,v)=>{data.set(k,v)},delete:async k=>{data.delete(k)}}}
test('a normal job persists running and terminal results before removal',async()=>{
 const storage=store();
 await runTrackedAgentJob(storage,key,job,async()=>{
  expect(await storage.get(resultKey)).toMatchObject({status:'running',at:101});
  expect(await storage.get(key)).toEqual(job);
  return {status:'finished',answered:1};
 },{now:()=>100});
 expect(await storage.get(resultKey)).toEqual({status:'finished',answered:1,at:102});
 expect(await storage.get(key)).toBeUndefined();
});
test('an interrupted running job is not executed again',async()=>{
 const storage=store(),execute=vi.fn();
 await storage.put(resultKey,{status:'running',at:120});
 await runTrackedAgentJob(storage,key,job,execute,{now:()=>110});
 expect(execute).not.toHaveBeenCalled();
 expect(await storage.get(resultKey)).toEqual({status:'interrupted',at:121});
 expect(await storage.get(key)).toBeUndefined();
});
test('failed execution records no sensitive error and cannot replay',async()=>{
 const storage=store(),execute=vi.fn().mockRejectedValue(new Error('private provider detail'));
 await runTrackedAgentJob(storage,key,job,execute);
 expect(await storage.get(resultKey)).toMatchObject({status:'failed',answered:0});
 expect(JSON.stringify(await storage.get(resultKey))).not.toContain('private provider');
 await storage.put(key,job);
 await runTrackedAgentJob(storage,key,job,execute);
 expect(execute).toHaveBeenCalledTimes(1);
});
test('lost terminal persistence retains the queued job and recovers without repeating work',async()=>{
 const storage=store(),put=storage.put,execute=vi.fn().mockResolvedValue({status:'finished',answered:1});
 storage.put=async(k,v)=>{if(v.status==='finished')throw Error('storage unavailable');return put(k,v)};
 await expect(runTrackedAgentJob(storage,key,job,execute)).rejects.toThrow('storage unavailable');
 expect(await storage.get(key)).toEqual(job);
 expect(await storage.get(resultKey)).toMatchObject({status:'running'});
 storage.put=put;
 await runTrackedAgentJob(storage,key,job,execute);
 expect(execute).toHaveBeenCalledTimes(1);
 expect(await storage.get(resultKey)).toMatchObject({status:'interrupted'});
});


test('failure to record execution start prevents any external work',async()=>{
 const storage=store(),execute=vi.fn();
 storage.put=async()=>{throw Error('storage unavailable')};
 await expect(runTrackedAgentJob(storage,key,job,execute)).rejects.toThrow('storage unavailable');
 expect(execute).not.toHaveBeenCalled();
 expect(await storage.get(key)).toEqual(job);
});

test('alarm backs off when a job result cannot be persisted',async()=>{
 const setAlarm=vi.fn(),started=Date.now();
 const storage={list:async()=>new Map([[key,job]]),delete:async()=>{},get:async()=>{throw Error('storage unavailable')},setAlarm};
 const runner=new AgentRunner({storage},env);
 await runner.alarm();
 expect(setAlarm).toHaveBeenCalledTimes(1);
 expect(setAlarm.mock.calls[0][0]).toBeGreaterThanOrEqual(started+15000);
});

test('assignment cancellation aborts only its exact generation and validates internal input',async()=>{
 const runner=new AgentRunner({storage:store()},env);
 const first=new AbortController(),other=new AbortController();
 const unregister=runner.registerAssignment({orgId:'org',assignmentId:'assignment-one',generation:3},first);
 runner.registerAssignment({orgId:'org',assignmentId:'assignment-one',generation:4},other);
 const response=await runner.fetch(new Request('https://agents/cancel-assignment',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({orgId:'org',assignmentId:'assignment-one',generation:3})}));
 expect(response.status).toBe(200);expect(await response.json()).toEqual({cancelled:true,active:true});
 expect(first.signal.aborted).toBe(true);expect(other.signal.aborted).toBe(false);
 expect((await runner.fetch(new Request('https://agents/cancel-assignment',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}))).status).toBe(400);
 unregister();
});

import assert from 'node:assert/strict';
test('settlement failure retains work, recovery settles interruption without repeating execution',async()=>{
 const s=store();let calls=0;const execute=async()=>{calls++;return {status:'finished',answered:1}};
 await assert.rejects(runTrackedAgentJob(s,key,job,execute,{onSettled:async()=>{throw Error('D1 unavailable')}}));
 assert.equal((await s.get(resultKey)).status,'running');assert.deepEqual(await s.get(key),job);
 let settled;await runTrackedAgentJob(s,key,job,execute,{onSettled:async result=>{settled=result.status}});
 assert.equal(settled,'interrupted');assert.equal(calls,1);assert.equal(await s.get(key),undefined);
});
test('failed interruption settlement remains recoverable',async()=>{
 const s=store();await s.put(resultKey,{status:'running',at:2});let calls=0;
 const execute=async()=>{calls++};
 await assert.rejects(runTrackedAgentJob(s,key,job,execute,{onSettled:async()=>{throw Error('D1 unavailable')}}));
 assert.equal((await s.get(resultKey)).status,'running');assert.deepEqual(await s.get(key),job);assert.equal(calls,0);
});
test('terminal result retries settlement and removal without executing',async()=>{
 const s=store();await s.put(resultKey,{status:'finished',answered:1,at:2});let settled;
 await runTrackedAgentJob(s,key,job,()=>{throw Error('must not execute')},{onSettled:async result=>{settled=result.status}});
 assert.equal(settled,'finished');assert.equal((await s.get(resultKey)).status,'finished');assert.equal(await s.get(key),undefined);
});
test('handoff result uses separate namespace',async()=>{
 const s=store();await runTrackedAgentJob(s,key,job,async()=>({status:'finished'}),{kind:'handoff'});
 assert.equal(await s.get(resultKey),undefined);assert.equal((await s.get('result:["org","handoff","request"]')).status,'finished');
});
