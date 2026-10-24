import {checkpointWorkflowCondition} from '../src/harness/workflowConditions.js';
import {env} from 'cloudflare:test';
import {beforeEach,expect,test} from 'vitest';
import schema from '../schema.sql?raw';
import {claimWorkflowNode as claim,finishWorkflowNode as finish,renewWorkflowNode as renew,commitWorkflowNodeEffects as commit} from '../src/harness/workflowCheckpoints.js';
const id={orgId:'cp',runId:'run',nodeId:'step:1',fingerprint:'definition-1'};
beforeEach(async()=>{
 await env.DB.exec(schema.replace(/\n/g,' '));
 await env.DB.exec("CREATE TABLE checkpoint_test_effects(id TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO checkpoint_test_effects VALUES('effect','Test');");
 await env.DB.prepare("INSERT INTO hx_workflows(id,org_id,name,enabled,trigger,steps,created_by,created_at,updated_at) VALUES('wf','cp','Test',1,'{}','[]','owner','now','now')").run();
 await env.DB.prepare("INSERT INTO hx_workflow_runs(id,org_id,workflow_id,trigger,status,log,started_at) VALUES('run','cp','wf','manual','running','[]','now')").run();
});
test('concurrent claimants cannot both acquire a node; completed results are immutable',async()=>{
 const results=await Promise.all([claim(env.DB,{...id,at:1000}),claim(env.DB,{...id,at:1000})]);
 expect(results.map(r=>r.status).sort()).toEqual(['acquired','busy']);const winner=results.find(r=>r.status==='acquired');
 expect(await finish(env.DB,{...id,...winner,at:2000,result:{edge:'yes'}})).toBe(true);
 expect(await finish(env.DB,{...id,...winner,at:2001,result:{edge:'no'}})).toBe(false);
 expect(await claim(env.DB,{...id,at:40000})).toEqual({status:'done',result:{edge:'yes'}});
});
test('expired pure nodes can be reclaimed but stale owners cannot commit or renew',async()=>{
 const first=await claim(env.DB,{...id,at:1000,ttl:1000});const second=await claim(env.DB,{...id,at:2000,ttl:1000});
 expect(second.status).toBe('acquired');expect(second.attempt).toBe(2);
 expect(await finish(env.DB,{...id,...first,at:2001,result:'old'})).toBe(false);
 expect(await renew(env.DB,{...id,...first,at:2001})).toBe(false);
 expect(await renew(env.DB,{...id,...second,at:2001})).toBe(true);
 expect(await finish(env.DB,{...id,...second,at:4000,result:'new'})).toBe(true);
});
test('ambiguous external effects are never automatically repeated or completed by an expired lease',async()=>{
 const first=await claim(env.DB,{...id,effect:true,at:1000,ttl:1000});
 expect(await claim(env.DB,{...id,effect:true,at:2000})).toEqual({status:'unknown'});
 expect(await claim(env.DB,{...id,effect:true,at:90000})).toEqual({status:'unknown'});
 expect(await finish(env.DB,{...id,...first,at:2001,result:'late'})).toBe(false);
});
test('scope, definition and terminal run status fence checkpoints',async()=>{
 expect(await claim(env.DB,{...id,orgId:'other',at:1000})).toEqual({status:'unavailable'});
 const first=await claim(env.DB,{...id,at:1000});
 expect(await claim(env.DB,{...id,fingerprint:'different',at:1001})).toEqual({status:'conflict'});
 await env.DB.prepare("UPDATE hx_workflow_runs SET status='failed' WHERE id='run'").run();
 expect(await finish(env.DB,{...id,...first,at:2000,result:'late'})).toBe(false);
 expect(await renew(env.DB,{...id,...first,at:2000})).toBe(false);
 expect(await claim(env.DB,{...id,nodeId:'step:2',at:2000})).toEqual({status:'unavailable'});
});
test('a mismatched retry cannot steal an expired pure node before reporting conflict',async()=>{
 await claim(env.DB,{...id,at:1000,ttl:1000});
 expect(await claim(env.DB,{...id,effect:true,at:2000})).toEqual({status:'conflict'});
 const next=await claim(env.DB,{...id,at:2000});expect(next.status).toBe('acquired');expect(next.attempt).toBe(2);
 await expect(finish(env.DB,{...id,...next,at:2001,result:'x'.repeat(128001)})).rejects.toThrow();
 expect(await finish(env.DB,{...id,...next,at:2002,result:'ok'})).toBe(true);
});

test('local effects and their checkpoint commit once in the same transaction',async()=>{
 const lease=await claim(env.DB,{...id,effect:true,at:1000});
 const statements=[env.DB.prepare("UPDATE checkpoint_test_effects SET value=value||'!' WHERE id='effect'")];
 const competing=await Promise.allSettled([commit(env.DB,{...id,...lease,at:2000,result:{changed:true},statements}),commit(env.DB,{...id,...lease,at:2000,result:{changed:true},statements})]);
 expect(competing.map(value=>value.status).sort()).toEqual(['fulfilled','rejected']);
 expect(competing.find(value=>value.status==='fulfilled').value).toEqual({status:'done',result:{changed:true}});
 await expect(commit(env.DB,{...id,...lease,at:2001,result:{changed:true},statements})).rejects.toThrow();
 expect((await env.DB.prepare("SELECT value FROM checkpoint_test_effects WHERE id='effect'").first()).value).toBe('Test!');
 expect(await claim(env.DB,{...id,effect:true,at:40000})).toEqual({status:'done',result:{changed:true}});
});
test('a failed local effect rolls back earlier writes and checkpoint completion',async()=>{
 const lease=await claim(env.DB,{...id,effect:true,at:1000});
 await expect(commit(env.DB,{...id,...lease,at:2000,result:'done',statements:[
  env.DB.prepare("UPDATE checkpoint_test_effects SET value='changed' WHERE id='effect'"),
  env.DB.prepare("UPDATE checkpoint_test_effects SET value=NULL WHERE id='effect'"),
 ]})).rejects.toThrow();
 expect((await env.DB.prepare("SELECT value FROM checkpoint_test_effects WHERE id='effect'").first()).value).toBe('Test');
 expect((await env.DB.prepare("SELECT status,result FROM hx_workflow_node_checkpoints WHERE run_id='run'").first())).toEqual({status:'running',result:null});
});
test('expired, wrong-owner, pure and stopped claims cannot commit local effects',async()=>{
 const lease=await claim(env.DB,{...id,effect:true,at:1000,ttl:1000});
 const statements=[env.DB.prepare("UPDATE checkpoint_test_effects SET value='changed' WHERE id='effect'")];
 for(const patch of [{at:2000},{at:1001,owner:'wrong'},{at:1001,nodeId:'missing'},{at:1001,orgId:'other'}]) {
  await expect(commit(env.DB,{...id,...lease,result:'done',statements,...patch})).rejects.toThrow();
 }
 const pure=await claim(env.DB,{...id,nodeId:'pure',at:1000});
 await expect(commit(env.DB,{...id,...pure,nodeId:'pure',at:1001,result:'done',statements})).rejects.toThrow();
 await env.DB.prepare("UPDATE hx_workflow_runs SET status='failed' WHERE id='run'").run();
 await expect(commit(env.DB,{...id,...lease,at:1001,result:'done',statements})).rejects.toThrow();
 expect((await env.DB.prepare("SELECT value FROM checkpoint_test_effects WHERE id='effect'").first()).value).toBe('Test');
});

test('saved conditions replay their original decision and reject definition drift',async()=>{
 const condition={path:['input','amount'],op:'gt',value:100};
 expect(await checkpointWorkflowCondition(env.DB,{...id,condition,scope:{input:{amount:200}},at:1000})).toEqual({status:'done',matches:true});
 expect(await checkpointWorkflowCondition(env.DB,{...id,condition,scope:{input:{amount:0}},at:2000})).toEqual({status:'done',matches:true});
 await expect(checkpointWorkflowCondition(env.DB,{...id,condition:{...condition,value:300},scope:{input:{amount:200}},at:2000})).rejects.toThrow('conflicts');
});
