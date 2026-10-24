import {env} from 'cloudflare:test';
import {beforeEach, expect, test} from 'vitest';
import schema from '../schema.sql?raw';
import {beginAssignment, commitHandoff, claimHandoff, assignmentOwns, endAssignment} from '../src/harness/agentAssignments.js';
const row = {id:'request', channel:'b:room', author_login:'alice', parent_id:null, kind:'message', body:'Research and review'};
const origin = {orgId:'org',row,agentId:'researcher',actorId:'person',sessionKey:'h1:session'};
beforeEach(async () => {
  await env.DB.exec(schema.replace(/\n/g, ' '));
  await env.DB.prepare("INSERT INTO channel_messages(id,org_id,channel,author_login,kind,body,created_at) VALUES (?1,'org',?2,?3,'message',?4,'2026-10-24')")
    .bind(row.id,row.channel,row.author_login,row.body).run();
});
const start = async (extra={}) => (await beginAssignment(env.DB,{...origin,...extra})).assignment;
const move = (assignment, extra={}) => ({orgId:'org',assignmentId:assignment.id,generation:0,sourceAgentId:'researcher',targetAgentId:'reviewer',operationId:'operation-1',brief:'Check the evidence',messageBody:'Handing off to @reviewer: Check the evidence',...extra});
const owns = (a,generation=0,agentId='researcher') => assignmentOwns(env.DB,{orgId:'org',assignmentId:a.id,generation,agentId});

test('independent requested agents have independent assignments and retries never restart one',async()=>{
  const first=await beginAssignment(env.DB,origin),again=await beginAssignment(env.DB,origin);
  expect(first.started).toBe(true);expect(again.started).toBe(false);expect(again.assignment.id).toBe(first.assignment.id);
  const parallel=await start({agentId:'analyst'});expect(parallel.id).not.toBe(first.assignment.id);
  expect(await beginAssignment(env.DB,{...origin,row:{...row,body:'changed'}})).toMatchObject({status:409});
  expect(await beginAssignment(env.DB,{...origin,sessionKey:'raw-token'})).toMatchObject({status:400});
});

test('handoff atomically fences old ownership, creates a visible event and queues exactly one delivery',async()=>{
  const a=await start(),input=move(a),first=await commitHandoff(env.DB,input);
  expect(first.replayed).toBe(false);expect(await owns(a)).toBe(false);
  expect(await commitHandoff(env.DB,input)).toMatchObject({replayed:true,operation:{message_id:first.operation.message_id}});
  expect(await commitHandoff(env.DB,{...input,brief:'different'})).toMatchObject({status:409});
  expect(await commitHandoff(env.DB,{...input,messageBody:'different'})).toMatchObject({status:409});
  const event=await env.DB.prepare('SELECT * FROM channel_messages WHERE id=?1').bind(first.operation.message_id).first();
  expect(event).toMatchObject({channel:row.channel,kind:'agent',author_login:'agent:researcher',parent_id:row.id,body:input.messageBody});
  const pending=await env.DB.prepare('SELECT * FROM hx_agent_handoff_dispatch').all();expect(pending.results).toHaveLength(1);
  expect(await claimHandoff(env.DB,{orgId:'org',operationId:input.operationId})).not.toBeNull();
  expect(await claimHandoff(env.DB,{orgId:'org',operationId:input.operationId})).toBeNull();
  expect(await owns(a,1,'reviewer')).toBe(true);
  expect(await endAssignment(env.DB,{orgId:'org',assignmentId:a.id,generation:0,agentId:'researcher',status:'finished'})).toBe(false);
  expect(await owns(a,1,'reviewer')).toBe(true);
});

test('competing handoffs from one generation have only one winner',async()=>{
  const a=await start();const results=await Promise.all([commitHandoff(env.DB,move(a)),commitHandoff(env.DB,move(a,{operationId:'operation-2',targetAgentId:'analyst'}))]);
  expect(results.filter(r=>r.operation)).toHaveLength(1);expect(results.filter(r=>r.status===409)).toHaveLength(1);
  expect((await env.DB.prepare('SELECT * FROM hx_agent_handoff_dispatch').all()).results).toHaveLength(1);
  expect((await env.DB.prepare("SELECT * FROM channel_messages WHERE kind='agent'").all()).results).toHaveLength(1);
});

test('self-handoff, cycles and hop exhaustion do not transfer ownership',async()=>{
  const a=await start({hopLimit:1});
  expect(await commitHandoff(env.DB,move(a,{targetAgentId:'researcher'}))).toMatchObject({status:409});expect(await owns(a)).toBe(true);
  await commitHandoff(env.DB,move(a));await claimHandoff(env.DB,{orgId:'org',operationId:'operation-1'});
  expect(await commitHandoff(env.DB,move(a,{generation:1,sourceAgentId:'reviewer',targetAgentId:'analyst',operationId:'next'}))).toMatchObject({status:409});
  const b=await start({agentId:'analyst'});
  await commitHandoff(env.DB,move(b,{sourceAgentId:'analyst',operationId:'other'}));await claimHandoff(env.DB,{orgId:'org',operationId:'other'});
  expect(await commitHandoff(env.DB,move(b,{generation:1,sourceAgentId:'reviewer',targetAgentId:'analyst',operationId:'cycle'}))).toMatchObject({status:409});
  expect(await owns(b,1,'reviewer')).toBe(true);
});

test('outbox write failure rolls ownership, handoff and visible message back together',async()=>{
  const a=await start();
  await env.DB.exec("CREATE TRIGGER fail_handoff_dispatch BEFORE INSERT ON hx_agent_handoff_dispatch BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  await expect(commitHandoff(env.DB,move(a))).rejects.toThrow();
  expect(await owns(a)).toBe(true);
  expect((await env.DB.prepare('SELECT * FROM hx_agent_handoffs').all()).results).toEqual([]);
  expect((await env.DB.prepare("SELECT * FROM channel_messages WHERE kind='agent'").all()).results).toEqual([]);
});

test('a deleted source cannot start and a cancelled pending assignment cannot be claimed',async()=>{
  const a=await start();await commitHandoff(env.DB,move(a));
  expect(await endAssignment(env.DB,{orgId:'org',assignmentId:a.id,generation:1,agentId:'reviewer',status:'cancelled'})).toBe(true);
  expect(await claimHandoff(env.DB,{orgId:'org',operationId:'operation-1'})).toBeNull();
  await env.DB.prepare("UPDATE channel_messages SET deleted_at='now' WHERE id=?1").bind(row.id).run();
  expect(await beginAssignment(env.DB,{...origin,agentId:'other'})).toMatchObject({status:409});
});
