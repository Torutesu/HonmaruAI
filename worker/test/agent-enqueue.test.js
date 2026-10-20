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
