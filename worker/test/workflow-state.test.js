import {workflowActivationState} from '../src/harness/workflowActivationState.js';
import {env} from 'cloudflare:test';
import migrations from '../migrations.sql?raw';
import {upsertUser,upsertMembership} from '../src/db.js';
import {beforeEach,test,expect} from 'vitest';
import {claimWorkflowNode} from '../src/harness/workflowCheckpoints.js';
import {normalizeWorkflowState,saveWorkflowState,readWorkflowState} from '../src/harness/workflowState.js';
let lease;
const identity={orgId:'state-org',runId:'state-run',nodeId:'state-writer'};
const freeze=(runId)=>env.DB.prepare("INSERT INTO hx_workflow_run_definitions(run_id,org_id,definition,created_at) VALUES(?1,'state-org',?2,'now')").bind(runId,JSON.stringify({id:'state-workflow',createdBy:'owner',definitionRevision:1})).run();
const read=(extra={})=>readWorkflowState(env.DB,{...identity,...lease,at:2000,...extra});
const save=(extra={})=>saveWorkflowState(env.DB,{...identity,...lease,expectedRevision:0,state:{items:[]},at:2000,...extra});
beforeEach(async()=>{
 await upsertUser(env.DB,{githubId:'owner',login:'state-owner',name:'Owner'});
 await upsertMembership(env.DB,'state-org','owner','member');
 await env.DB.prepare("INSERT INTO hx_workflows(id,org_id,name,enabled,trigger,steps,created_by,created_at,updated_at) VALUES('state-workflow','state-org','State',1,'{}','[]','owner','now','now')").run();
 await env.DB.prepare("INSERT INTO hx_workflow_runs(id,org_id,workflow_id,trigger,status,log,started_at) VALUES('state-run','state-org','state-workflow','manual','running','[]','now')").run();
 await freeze('state-run');
 lease=await claimWorkflowNode(env.DB,{...identity,fingerprint:'state-definition',at:1000,ttl:10000});
});
test('pending progress, committed results and failed progress have separate read semantics',async()=>{
 expect(await read()).toEqual({found:false,revision:0});
 expect(await save()).toMatchObject({saved:true,revision:1});
 expect(await read()).toEqual({found:false,revision:1});
 expect(await read({view:'checkpoint'})).toMatchObject({found:true,stateRevision:1,validationStatus:'pending'});
 await save({expectedRevision:1,validationStatus:'passed',state:{items:['accepted']}});
 expect((await read()).found).toBe(false);
 expect(await read({runId:'next-run'})).toEqual({available:false,found:false});
 expect((await read({includeCurrentRun:true})).found).toBe(true);
 await save({expectedRevision:2,validationStatus:'failed',state:{reason:'incomplete'}});
 expect(await read({view:'checkpoint'})).toEqual({found:false,revision:3});
 expect(await read({includeCurrentRun:true})).toMatchObject({found:true,revision:3,stateRevision:2});
});
test('concurrent writes use global workflow CAS and never overwrite a winner',async()=>{
 const results=await Promise.all([save({state:{winner:'a'}}),save({state:{winner:'b'}})]);
 expect(results.filter(result=>result.saved)).toHaveLength(1);
 expect(await save({state:{winner:'stale'}})).toEqual({saved:false});
 expect((await read({view:'checkpoint'})).revision).toBe(1);
});
test('stale owners, expired leases, stopped runs and cross-workspace writes cannot save',async()=>{
 expect(await save({owner:'wrong'})).toEqual({saved:false});
 expect(await save({attempt:lease.attempt+1})).toEqual({saved:false});
 expect(await save({at:11000})).toEqual({saved:false});
 expect(await save({orgId:'other'})).toEqual({saved:false});
 await env.DB.prepare("UPDATE hx_workflow_runs SET status='failed' WHERE id='state-run'").run();
 expect(await save()).toEqual({saved:false});
 expect(await read()).toEqual({available:false,found:false});
});
test('state rejects lossy JSON values and enforces size and structure limits',()=>{
 const sparse=[];sparse.length=2;
 for(const value of [[],null,{x:undefined},{x:Infinity},{x:new Date()},{x:sparse},JSON.parse('{"__proto__":1}'),{x:'あ'.repeat(50000)}])expect(()=>normalizeWorkflowState(value)).toThrow();
 expect(JSON.parse(normalizeWorkflowState({a:[0,false,null,''],b:{}}))).toEqual({a:[0,false,null,''],b:{}});
});

test('serialization never invokes getters or silently drops hidden and symbol state',()=>{
 let accessed=false;
 const getter=Object.defineProperty({},'value',{enumerable:true,get(){accessed=true;return 1}});
 const customJSON=Object.defineProperty({value:1},'toJSON',{value:()=>({value:2})});
 const hidden=Object.defineProperty({},'hidden',{value:1});
 const symbol={[Symbol('state')]:1};
 for(const value of [getter,customJSON,hidden,symbol])expect(()=>normalizeWorkflowState(value)).toThrow();
 expect(accessed).toBe(false);
});

test('state reads require a current lease and recover prior accepted state for a subsequent run',async()=>{
 await save({validationStatus:'passed',state:{accepted:1}});
 for(const override of [{owner:'wrong'},{orgId:'other'},{attempt:lease.attempt+1},{at:11000}])expect(await read(override)).toEqual({available:false,found:false});
 await env.DB.prepare("UPDATE hx_workflow_runs SET status='done' WHERE id='state-run'").run();
 expect(await read()).toEqual({available:false,found:false});
 await env.DB.prepare("INSERT INTO hx_workflow_runs(id,org_id,workflow_id,trigger,status,log,started_at) VALUES('next-run','state-org','state-workflow','manual','running','[]','later')").run();
 await freeze('next-run');
 const next=await claimWorkflowNode(env.DB,{...identity,runId:'next-run',fingerprint:'state-definition',at:2000,ttl:10000});
 expect(await read({...next,runId:'next-run',at:3000})).toMatchObject({found:true,sourceRunId:'state-run',state:{accepted:1}});
});

test('membership revocation and guest downgrade fence reads and writes after a lease was issued',async()=>{
 await save({validationStatus:'passed',state:{private:true}});
 await env.DB.prepare("DELETE FROM memberships WHERE org_id='state-org' AND user_github_id='owner'").run();
 expect(await save({expectedRevision:1})).toEqual({saved:false});
 expect(await read({includeCurrentRun:true})).toEqual({available:false,found:false});
 await upsertMembership(env.DB,'state-org','owner','guest');
 expect(await save({expectedRevision:1})).toEqual({saved:false});
 expect(await read({includeCurrentRun:true})).toEqual({available:false,found:false});
 await upsertMembership(env.DB,'state-org','owner','member');
 expect(await read({includeCurrentRun:true})).toMatchObject({found:true,state:{private:true}});
});


test('execution history retention preserves business state and monotonic revisions',async()=>{
 await save({validationStatus:'passed',state:{cursor:'accepted'}});
 await env.DB.prepare("UPDATE hx_workflow_runs SET status='done' WHERE id='state-run'").run();
 await env.DB.prepare("INSERT INTO hx_workflow_runs(id,org_id,workflow_id,trigger,status,log,started_at) VALUES('retained-run','state-org','state-workflow','manual','running','[]','later')").run();
 await freeze('retained-run');
 const next=await claimWorkflowNode(env.DB,{...identity,runId:'retained-run',fingerprint:'state-definition',at:2000,ttl:10000});
 await env.DB.prepare("DELETE FROM hx_workflow_runs WHERE id='state-run'").run();
 expect(await read({...next,runId:'retained-run',at:3000})).toMatchObject({found:true,revision:1,sourceRunId:'state-run',state:{cursor:'accepted'}});
 expect(await save({...next,runId:'retained-run',at:3000,expectedRevision:0})).toEqual({saved:false});
 expect(await save({...next,runId:'retained-run',at:3000,expectedRevision:1})).toMatchObject({saved:true,revision:2});
 await env.DB.prepare("DELETE FROM hx_workflow_runs WHERE workflow_id='state-workflow'").run();
 await env.DB.prepare("DELETE FROM hx_workflows WHERE id='state-workflow'").run();
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_workflow_state_versions WHERE workflow_id='state-workflow'").first()).n).toBe(0);
});


test('source room revocation is fenced inside state reads and writes',async()=>{
 await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,created_at,private) VALUES('state-org','private','Private','now',1)").run();
 await env.DB.prepare("INSERT INTO hx_workflow_sources(org_id,workflow_id,channel,thread_id,created_by) VALUES('state-org','state-workflow','b:private','thread','owner')").run();
 expect(await save()).toEqual({saved:false});
 await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES('state-org','b:private','state-owner','now')").run();
 expect(await save({validationStatus:'passed'})).toMatchObject({saved:true});
 await env.DB.prepare("DELETE FROM conversation_members WHERE org_id='state-org' AND channel='b:private'").run();
 expect(await read({includeCurrentRun:true})).toEqual({available:false,found:false});
 expect(await save({expectedRevision:1})).toEqual({saved:false});
 await env.DB.prepare("UPDATE businesses SET private=0 WHERE org_id='state-org' AND slug='private'").run();
 expect(await read({includeCurrentRun:true})).toMatchObject({found:true});
 await env.DB.prepare("UPDATE businesses SET archived_at='later' WHERE org_id='state-org' AND slug='private'").run();
 expect(await save({expectedRevision:1})).toEqual({saved:false});
 expect(await read({includeCurrentRun:true})).toEqual({available:false,found:false});
});

test('unknown source channels and mismatched source creators fail closed',async()=>{
 await env.DB.prepare("INSERT INTO hx_workflow_sources(org_id,workflow_id,channel,thread_id,created_by) VALUES('state-org','state-workflow','unknown:room','thread','owner')").run();
 expect(await save()).toEqual({saved:false});
 await env.DB.prepare("UPDATE hx_workflow_sources SET channel='g:room',created_by='other'").run();
 await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES('state-org','g:room','state-owner','now')").run();
 expect(await save()).toEqual({saved:false});
 await env.DB.prepare("UPDATE hx_workflow_sources SET created_by='owner'").run();
 expect(await save()).toMatchObject({saved:true});
 await env.DB.prepare("DELETE FROM conversation_members WHERE channel='g:room'").run();
 expect(await read({view:'checkpoint'})).toEqual({available:false,found:false});
});

test('DM source access ends when the other participant leaves the workspace',async()=>{
 await upsertUser(env.DB,{githubId:'peer',login:'peer',name:'Peer'});
 await upsertMembership(env.DB,'state-org','peer','member');
 await env.DB.prepare("INSERT INTO hx_workflow_sources(org_id,workflow_id,channel,thread_id,created_by) VALUES('state-org','state-workflow','dm:peer|state-owner','thread','owner')").run();
 expect(await save({validationStatus:'passed'})).toMatchObject({saved:true});
 await env.DB.prepare("DELETE FROM memberships WHERE org_id='state-org' AND user_github_id='peer'").run();
 expect(await read({includeCurrentRun:true})).toEqual({available:false,found:false});
 expect(await save({expectedRevision:1})).toEqual({saved:false});
});

test('agent source access follows current people grants, explicit roles and deletion',async()=>{
 await env.DB.prepare("INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES('state-org','state-agent','state-agent','Agent','','team','someone-else','now','now')").run();
 await env.DB.prepare("INSERT INTO hx_agent_profiles(org_id,agent_id,access,people,updated_at) VALUES('state-org','state-agent','people','[\"state-owner\"]','now')").run();
 await env.DB.prepare("INSERT INTO hx_workflow_sources(org_id,workflow_id,channel,thread_id,created_by) VALUES('state-org','state-workflow','ag:state-agent|state-owner','thread','owner')").run();
 expect(await save({validationStatus:'passed'})).toMatchObject({saved:true});
 await env.DB.prepare("UPDATE hx_agent_profiles SET people='[]' WHERE agent_id='state-agent'").run();
 expect(await read({includeCurrentRun:true})).toEqual({available:false,found:false});
 expect(await save({expectedRevision:1})).toEqual({saved:false});
 await env.DB.prepare("INSERT INTO hx_agent_members(org_id,agent_id,user_id,role,member_since,updated_by,updated_at) SELECT org_id,'state-agent',user_github_id,'member',created_at,'owner','now' FROM memberships WHERE org_id='state-org' AND user_github_id='owner'").run();
 expect(await read({includeCurrentRun:true})).toMatchObject({found:true});
 await env.DB.prepare("UPDATE hx_agent_members SET member_since='obsolete' WHERE agent_id='state-agent'").run();
 expect(await read({includeCurrentRun:true})).toEqual({available:false,found:false});
 await env.DB.prepare("UPDATE hx_agent_profiles SET people='[\"state-owner\"]' WHERE agent_id='state-agent'").run();
 await env.DB.prepare("UPDATE custom_agents SET deleted_at='later' WHERE id='state-agent'").run();
 expect(await read({includeCurrentRun:true})).toEqual({available:false,found:false});
 expect(await save({expectedRevision:1})).toEqual({saved:false});
});

test('state receipts retain schema, business date and validation evidence for readback',async()=>{
 const state={orders:[{id:'order-1',complete:false}]};
 const receipt=await save({state,schemaVersion:'orders/v2',businessDate:'2026-10-25',validationErrors:[{record:'order-1',reason:'Missing invoice'}]});
 const checkpoint=await read({view:'checkpoint'});
 expect(receipt).toMatchObject({saved:true,currentRunId:'state-run'});
 expect(receipt.contentHash).toMatch(/^[a-f0-9]{64}$/);
 expect(checkpoint).toMatchObject({state,currentRunId:'state-run',metadata:{schemaVersion:'orders/v2',businessDate:'2026-10-25',validationErrors:[{record:'order-1',reason:'Missing invoice'}],contentHash:receipt.contentHash}});
 for(const invalid of [{schemaVersion:''},{businessDate:3},{validationErrors:['error']},{validationErrors:[{reason:'x'.repeat(17000)}]}])await expect(save({...invalid,expectedRevision:1})).rejects.toThrow();
 expect((await read({view:'checkpoint'})).revision).toBe(1);
});

test('validation metadata rejects accessors without evaluating them',async()=>{
 let accessed=false;
 const errors=[];Object.defineProperty(errors,'0',{enumerable:true,get(){accessed=true;return {reason:'bad'};}});
 await expect(save({validationErrors:errors})).rejects.toThrow();
 expect(accessed).toBe(false);
 expect((await read()).revision).toBe(0);
});

test('metadata migration retains existing committed state without inventing receipts',async()=>{
 await env.DB.exec('DROP TABLE hx_workflow_state_versions');
 await env.DB.exec('CREATE TABLE hx_workflow_state_versions (org_id TEXT NOT NULL,workflow_id TEXT NOT NULL,revision INTEGER NOT NULL,run_id TEXT NOT NULL,state TEXT NOT NULL,validation_status TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(org_id,workflow_id,revision))');
 await env.DB.prepare("INSERT INTO hx_workflow_state_versions VALUES('state-org','state-workflow',1,'previous-run','{\"accepted\":true}','passed',1000)").run();
 const statement=migrations.split('\n').find(line=>line.startsWith('ALTER TABLE hx_workflow_state_versions ADD COLUMN metadata'));
 expect(statement).toBeTruthy();await env.DB.exec(statement);
 expect(await read()).toMatchObject({found:true,revision:1,state:{accepted:true},sourceRunId:'previous-run',metadata:{}});
 await save({expectedRevision:1,schemaVersion:'v2'});
 expect(await read({view:'checkpoint'})).toMatchObject({found:true,stateRevision:2,metadata:{schemaVersion:'v2'}});
});

test('saved state and receipts cannot be overwritten in place',async()=>{
 const receipt=await save({state:{accepted:1},validationStatus:'passed',schemaVersion:'v1'});
 for(const field of ['state','metadata','validation_status','run_id'])await expect(env.DB.prepare(`UPDATE hx_workflow_state_versions SET ${field}=?1 WHERE org_id='state-org'`).bind('changed').run()).rejects.toThrow('immutable');
 expect(await read({includeCurrentRun:true})).toMatchObject({state:{accepted:1},metadata:{contentHash:receipt.contentHash,schemaVersion:'v1'}});
 expect(await save({expectedRevision:1,state:{accepted:2},validationStatus:'passed'})).toMatchObject({saved:true,revision:2});
});

test('state is bound to the frozen definition identity and records its revision',async()=>{
 await save({state:{accepted:1}});
 await env.DB.prepare("UPDATE hx_workflows SET name='Edited' WHERE id='state-workflow'").run();
 expect(await read({view:'checkpoint'})).toMatchObject({metadata:{definitionRevision:1}});
 await env.DB.prepare("UPDATE hx_workflow_run_definitions SET definition=json_set(definition,'$.id','other-workflow') WHERE run_id='state-run'").run();
 expect(await read({view:'checkpoint'})).toEqual({available:false,found:false});
 expect(await save({expectedRevision:1})).toEqual({saved:false});
 await env.DB.prepare("DELETE FROM hx_workflow_run_definitions WHERE run_id='state-run'").run();
 expect(await save({expectedRevision:1})).toEqual({saved:false});
});
test('changing the live owner does not transfer an existing activation',async()=>{
 await upsertUser(env.DB,{githubId:'new-owner',login:'new-state-owner',name:'New owner'});
 await upsertMembership(env.DB,'state-org','new-owner','member');
 await env.DB.prepare("UPDATE hx_workflows SET created_by='new-owner' WHERE id='state-workflow'").run();
 expect(await read()).toEqual({available:false,found:false});
 expect(await save()).toEqual({saved:false});
});

const activation={jobId:'state-job',gatewayId:'state-gateway',leaseHash:'state-job-lease'};
async function bindActivation(){
 await upsertMembership(env.DB,'state-org','owner','admin');
 await env.DB.prepare("INSERT INTO hx_gateways(id,org_id,name,token_hash,created_by,created_at) VALUES('state-gateway','state-org','Node','token-hash','owner',1000)").run();
 await env.DB.prepare("INSERT INTO hx_gateway_jobs(id,org_id,gateway_id,created_by,request_id,payload,status,created_at,lease_hash,lease_until,deadline) VALUES('state-job','state-org','state-gateway','owner','state-request','{}','running',1000,'state-job-lease',5000,6000)").run();
 await env.DB.prepare("INSERT INTO hx_workflow_activations(org_id,job_id,run_id,node_id,node_owner,node_attempt) VALUES('state-org','state-job','state-run','state-writer',?1,?2)").bind(lease.owner,lease.attempt).run();
}
test('activation state resolves identity privately and requires both live leases',async()=>{
 await bindActivation();
 const call=(method,params,auth=activation,at=2000)=>workflowActivationState(env.DB,auth,method,params,at);
 expect(await call('state.set',{state:{saved:1},expectedRevision:0})).toMatchObject({saved:true});
 expect(await call('state.get',{view:'checkpoint'})).toMatchObject({state:{saved:1}});
 for(const auth of [{...activation,jobId:'other'},{...activation,gatewayId:'other'},{...activation,leaseHash:'other'}])expect(await call('state.get',{},auth)).toMatchObject({status:409});
 expect(await call('state.get',{runId:'other'})).toMatchObject({status:400});
 expect(await call('state.get',{},activation,5000)).toEqual({available:false,found:false});
 await env.DB.prepare("UPDATE hx_gateway_jobs SET status='cancelled' WHERE id='state-job'").run();
 expect(await call('state.set',{state:{bad:1},expectedRevision:1})).toEqual({saved:false});
});
test('gateway revocation and checkpoint reassignment fence activation access in D1',async()=>{
 await bindActivation();
 await env.DB.prepare("UPDATE hx_gateways SET revoked_at=1500 WHERE id='state-gateway'").run();
 expect(await save({activation})).toEqual({saved:false});
 expect(await read({activation})).toEqual({available:false,found:false});
 await env.DB.prepare("UPDATE hx_gateways SET revoked_at=NULL WHERE id='state-gateway'").run();
 await env.DB.prepare("UPDATE hx_workflow_node_checkpoints SET owner='next-owner',attempt=attempt+1 WHERE run_id='state-run'").run();
 expect(await read({activation,owner:'next-owner',attempt:lease.attempt+1})).toEqual({available:false,found:false});
});

test('ordinary jobs, changed requesters and elapsed deadlines cannot access workflow state',async()=>{
 await bindActivation();
 await env.DB.prepare("DELETE FROM hx_workflow_activations WHERE job_id='state-job'").run();
 expect(await workflowActivationState(env.DB,activation,'state.get',{},2000)).toMatchObject({status:409});
 await env.DB.prepare("INSERT INTO hx_workflow_activations(org_id,job_id,run_id,node_id,node_owner,node_attempt) VALUES('state-org','state-job','state-run','state-writer',?1,?2)").bind(lease.owner,lease.attempt).run();
 await env.DB.prepare("UPDATE hx_gateway_jobs SET created_by='other' WHERE id='state-job'").run();
 expect(await read({activation})).toEqual({available:false,found:false});
 await env.DB.prepare("UPDATE hx_gateway_jobs SET created_by='owner',lease_until=10000,deadline=2000 WHERE id='state-job'").run();
 expect(await save({activation})).toEqual({saved:false});
});

test('paused or replaced safety generations revoke ongoing state operations',async()=>{
 const {ensureWorkflowSafety}=await import('../src/harness/workflowSafety.js');
 const safety=await ensureWorkflowSafety(env.DB,'state-org','state-workflow');
 await env.DB.prepare("UPDATE hx_workflow_run_definitions SET definition=json_set(definition,'$.safetyGeneration',?1) WHERE run_id='state-run'").bind(safety.generation).run();
 expect(await save()).toMatchObject({saved:true});
 await env.DB.prepare("UPDATE hx_workflow_safety SET paused_at='now' WHERE workflow_id='state-workflow'").run();
 expect(await read({view:'checkpoint'})).toEqual({available:false,found:false});
 expect(await save({expectedRevision:1})).toEqual({saved:false});
 await env.DB.prepare("UPDATE hx_workflow_safety SET paused_at=NULL,generation='replacement' WHERE workflow_id='state-workflow'").run();
 expect(await read({view:'checkpoint'})).toEqual({available:false,found:false});
});

test('SDK state writes commit by default while explicit pending remains progress',async()=>{
 await bindActivation();
 const call=(method,params)=>workflowActivationState(env.DB,activation,method,params,2000);
 expect(await call('state.set',{state:{value:'committed'},expectedRevision:0})).toMatchObject({saved:true});
 expect(await call('state.get',{includeCurrentRun:true})).toMatchObject({state:{value:'committed'},validationStatus:'passed'});
 expect(await call('state.set',{state:{value:'progress'},expectedRevision:1,validationStatus:'pending'})).toMatchObject({saved:true});
 expect(await call('state.get',{includeCurrentRun:true})).toMatchObject({state:{value:'committed'}});
 expect(await call('state.get',{view:'checkpoint'})).toMatchObject({state:{value:'progress'},validationStatus:'pending'});
 await expect(call('state.set',{state:{value:'invalid'},expectedRevision:2,validationStatus:null})).rejects.toThrow('Invalid workflow state request');
});
