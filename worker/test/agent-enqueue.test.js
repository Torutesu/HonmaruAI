import {env,runInDurableObject} from "cloudflare:test";
import {expect,test} from "vitest";
const job={orgId:"personal:enqueue",rowId:"message-one",token:"h1:test-only"};
async function runner(){
 const stub=env.AGENT_RUNNER.get(env.AGENT_RUNNER.idFromName(crypto.randomUUID()));
 await runInDurableObject(stub,(_,state)=>state.storage.setAlarm(Date.now()+3600000));
 return stub;
}
const enqueue=(stub,value=job)=>stub.fetch("https://agents/enqueue",{method:"POST",body:JSON.stringify(value)});
const jobs=stub=>runInDurableObject(stub,async(_,state)=>[...(await state.storage.list({prefix:"job:"})).values()]);
test("concurrent duplicate requests enqueue once and remain accepted after dequeue",async()=>{
 const stub=await runner();
 const results=await Promise.all(Array.from({length:8},()=>enqueue(stub)));
 expect(results.map(r=>r.status)).toEqual(Array(8).fill(202));
 expect(await jobs(stub)).toHaveLength(1);
 await runInDurableObject(stub,async(_,state)=>state.storage.delete([...(await state.storage.list({prefix:"job:"})).keys()]));
 expect((await enqueue(stub)).status).toBe(202);
 expect(await jobs(stub)).toHaveLength(0);
 expect((await enqueue(stub,{...job,rowId:"message-two"})).status).toBe(202);
 expect(await jobs(stub)).toHaveLength(1);
});
test("proxy owners keep distinct jobs and a legacy queued job is not duplicated",async()=>{
 const stub=await runner();
 await runInDurableObject(stub,(_,state)=>state.storage.put("job:1:message-one",job));
 expect((await enqueue(stub)).status).toBe(202);
 for(const owner of ["toru","mika","toru"]) expect((await enqueue(stub,{...job,kind:"proxy",owner})).status).toBe(202);
 expect(await jobs(stub)).toHaveLength(3);
});
test("full queues accept an existing receipt but reject new work without recording it",async()=>{
 const stub=await runner();
 await enqueue(stub);
 await runInDurableObject(stub,async(_,state)=>{for(let i=1;i<50;i++)await state.storage.put(`job:fixture:${i}`,{...job,rowId:`fixture-${i}`})});
 expect((await enqueue(stub)).status).toBe(202);
 expect((await enqueue(stub,{...job,rowId:"later"})).status).toBe(503);
 await runInDurableObject(stub,(_,state)=>state.storage.delete("job:fixture:1"));
 expect((await enqueue(stub,{...job,rowId:"later"})).status).toBe(202);
 expect((await jobs(stub)).filter(j=>j.rowId==="later")).toHaveLength(1);
});


test("webhook jobs need no session and keep a separate durable receipt",async()=>{
 const stub=await runner();const hook={orgId:job.orgId,rowId:job.rowId,kind:'room_hook'};
 expect((await enqueue(stub,hook)).status).toBe(202);
 expect((await enqueue(stub,hook)).status).toBe(202);
 expect((await enqueue(stub)).status).toBe(202);
 expect(await jobs(stub)).toHaveLength(2);
 expect((await enqueue(stub,{...hook,kind:'unknown'})).status).toBe(400);
});
test("a webhook with a missing grant records cancellation and is never requeued",async()=>{
 const stub=await runner();const hook={orgId:job.orgId,rowId:'no-event',kind:'room_hook'};
 await enqueue(stub,hook);
 await runInDurableObject(stub,instance=>instance.alarm());
 const results=await runInDurableObject(stub,async(_,state)=>[...(await state.storage.list({prefix:'result:'})).values()]);
 expect(results).toMatchObject([{status:'cancelled',answered:0}]);
 expect(await jobs(stub)).toHaveLength(0);
 expect((await enqueue(stub,hook)).status).toBe(202);
 expect(await jobs(stub)).toHaveLength(0);
});

test("a previously started webhook job is marked interrupted without executing again",async()=>{
 const stub=await runner();const hook={orgId:job.orgId,rowId:'interrupted-event',kind:'room_hook'};
 await enqueue(stub,hook);
 const resultKey=`result:${JSON.stringify([hook.orgId,'room_hook',hook.rowId])}`;
 await runInDurableObject(stub,(_,state)=>state.storage.put(resultKey,{status:'running',at:1}));
 await runInDurableObject(stub,instance=>instance.alarm());
 expect(await runInDurableObject(stub,(_,state)=>state.storage.get(resultKey))).toMatchObject({status:'interrupted'});
 expect(await jobs(stub)).toHaveLength(0);
});

test('webhook status separates queued, finished and unknown without exposing job tokens',async()=>{
 const stub=await runner();await enqueue(stub,{orgId:job.orgId,rowId:'queued',kind:'room_hook'});
 await runInDurableObject(stub,(_,state)=>state.storage.put(`result:${JSON.stringify([job.orgId,'room_hook','done'])}`,{status:'finished',answered:1,privateDetail:'not returned'}));
 const response=await stub.fetch('https://agents/room-hook-status',{method:'POST',body:JSON.stringify({orgId:job.orgId,rowIds:['queued','done','missing']})});
 expect(await response.json()).toEqual({results:[{rowId:'queued',status:'queued',answered:0},{rowId:'done',status:'finished',answered:1},{rowId:'missing',status:'unknown',answered:0}]});
});

test('concurrent retries use the observed terminal version once and retain its history',async()=>{
 const {queueRoomHookRetry}=await import('../src/harness/roomHookRetry.js');
 const stub=await runner();
 const input={orgId:job.orgId,rowId:'retry',expectedAt:123};
 const resultKey=`result:${JSON.stringify([job.orgId,'room_hook','retry'])}`;
 await runInDurableObject(stub,(_,state)=>state.storage.put(resultKey,{status:'failed',at:123}));
 const results=await runInDurableObject(stub,(_,state)=>Promise.all(Array.from({length:4},()=>queueRoomHookRetry(state.storage,input))));
 expect(results.filter(r=>r.status===202)).toHaveLength(1);
 expect(results.filter(r=>r.status===409)).toHaveLength(3);
 expect(await jobs(stub)).toHaveLength(1);
 expect(await runInDurableObject(stub,(_,state)=>state.storage.get(`history:${JSON.stringify([job.orgId,'retry',123])}`))).toMatchObject({status:'failed',at:123});
});
test('retry rejects running/successful/stale results and requires acknowledgement of interruption',async()=>{
 const {queueRoomHookRetry}=await import('../src/harness/roomHookRetry.js');
 const stub=await runner();const input={orgId:job.orgId,rowId:'guarded-retry',expectedAt:123};
 const key=`result:${JSON.stringify([job.orgId,'room_hook',input.rowId])}`;
 for(const status of ['running','finished','cancelled','interrupted']){
  await runInDurableObject(stub,(_,state)=>state.storage.put(key,{status,at:123}));
  expect(await runInDurableObject(stub,(_,state)=>queueRoomHookRetry(state.storage,input))).toEqual({status:409});
 }
 expect(await runInDurableObject(stub,(_,state)=>queueRoomHookRetry(state.storage,{...input,expectedAt:122,confirmInterrupted:true}))).toEqual({status:409});
 expect(await runInDurableObject(stub,(_,state)=>queueRoomHookRetry(state.storage,{...input,confirmInterrupted:true}))).toEqual({status:202});
});

test('handoff receipt is distinct, deduplicated and cancellation cannot restart it',async()=>{
 const stub=await runner(),handoff={orgId:job.orgId,rowId:job.rowId,kind:'handoff'};
 expect((await enqueue(stub,handoff)).status).toBe(202);
 expect((await enqueue(stub,handoff)).status).toBe(202);
 expect((await enqueue(stub)).status).toBe(202);
 expect(await jobs(stub)).toHaveLength(2);
 await runInDurableObject(stub,instance=>instance.alarm());
 expect(await jobs(stub)).toHaveLength(0);
 expect(await runInDurableObject(stub,(_,state)=>state.storage.get(`result:${JSON.stringify([job.orgId,'handoff',job.rowId])}`))).toMatchObject({status:'cancelled',answered:0});
 expect((await enqueue(stub,handoff)).status).toBe(202);
 expect(await jobs(stub)).toHaveLength(0);
});
