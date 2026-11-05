import {env} from 'cloudflare:test';
import {beforeEach,expect,test} from 'vitest';
import schema from '../schema.sql?raw';
import {beginAssignment,claimHandoff,commitHandoff,endAssignment} from '../src/harness/agentAssignments.js';
import {AGENT_TOOL_TRACE_RETENTION_DAYS,MAX_AGENT_TOOL_STEPS_PER_GENERATION,finishAgentToolTrace,pruneAgentToolTraces,readAgentToolTrace,startAgentToolTrace} from '../src/harness/agentToolTrace.js';

const ORG='agent-tool-trace-test';
const row={id:'trace-source',channel:'b:room',author_login:'alice',kind:'message',body:'Review this item',parent_id:null};
let assignment;
const stamp=at=>new Date(at).toISOString();
const start=(stepIndex,extra={})=>startAgentToolTrace(env.DB,{orgId:ORG,assignmentId:assignment.id,generation:0,agentId:'researcher',stepIndex,toolName:'search_items',startedAt:stamp(Date.now()),...extra});
const finish=(stepIndex,status='completed',extra={})=>finishAgentToolTrace(env.DB,{orgId:ORG,assignmentId:assignment.id,generation:0,stepIndex,status,finishedAt:stamp(Date.now()),durationMs:12,...extra});

beforeEach(async()=>{
  await env.DB.exec(schema.replace(/\n/g,' '));
  await env.DB.prepare("INSERT INTO channel_messages(id,org_id,channel,author_login,kind,body,created_at) VALUES (?1,?2,?3,?4,'message',?5,'2026-10-24')")
    .bind(row.id,ORG,row.channel,row.author_login,row.body).run();
  for(const [id,handle,name] of [['researcher','researcher','Researcher'],['reviewer','reviewer','Reviewer']])
    await env.DB.prepare("INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES (?1,?2,?3,?4,'instructions','team','alice','2026-10-24','2026-10-24')")
      .bind(ORG,id,handle,name).run();
  assignment=(await beginAssignment(env.DB,{orgId:ORG,row,agentId:'researcher',actorId:'actor',sessionKey:'h1:trace-session',hopLimit:2})).assignment;
});

test('records only ordered tool metadata, keeps it generation-scoped across handoff, and never stores arguments or results',async()=>{
  expect(await start(0)).toBe(true);
  expect(await finish(0,'handed_off')).toBe(true);
  const transferred=await commitHandoff(env.DB,{orgId:ORG,assignmentId:assignment.id,generation:0,sourceAgentId:'researcher',targetAgentId:'reviewer',operationId:'trace-handoff',brief:'Review the result',messageBody:'Handing off.'});
  expect(transferred.operation).toBeTruthy();
  expect(await claimHandoff(env.DB,{orgId:ORG,operationId:'trace-handoff'})).toBeTruthy();
  const generationOne=await startAgentToolTrace(env.DB,{orgId:ORG,assignmentId:assignment.id,generation:1,agentId:'reviewer',stepIndex:0,toolName:'check_result',startedAt:stamp(Date.now())});
  expect(generationOne).toBe(true);
  expect(await finishAgentToolTrace(env.DB,{orgId:ORG,assignmentId:assignment.id,generation:1,stepIndex:0,status:'completed',finishedAt:stamp(Date.now()),durationMs:25})).toBe(true);
  const trace=await readAgentToolTrace(env.DB,{orgId:ORG,assignmentId:assignment.id,generation:1});
  expect(trace.map(step=>[step.generation,step.stepIndex,step.agent.id,step.toolName,step.status])).toEqual([
    [0,0,'researcher','search_items','handed_off'],[1,0,'reviewer','check_result','completed'],
  ]);
  expect(JSON.stringify(trace)).not.toMatch(/arguments|output|secret|token|Review the result/);
  expect(await readAgentToolTrace(env.DB,{orgId:'wrong-org',assignmentId:assignment.id,generation:1})).toEqual([]);
});

test('rejects stale owner, duplicate, malformed, and out-of-budget writes; closes outstanding work as interrupted',async()=>{
  expect(await startAgentToolTrace(env.DB,{orgId:ORG,assignmentId:assignment.id,generation:1,agentId:'reviewer',stepIndex:0,toolName:'read',startedAt:stamp(Date.now())})).toBe(false);
  expect(await startAgentToolTrace(env.DB,{orgId:ORG,assignmentId:assignment.id,generation:0,agentId:'reviewer',stepIndex:0,toolName:'read',startedAt:stamp(Date.now())})).toBe(false);
  expect(await start(0,{toolName:'search secret-token'})).toBe(true);
  expect(await start(0)).toBe(false);
  for(let index=1;index<MAX_AGENT_TOOL_STEPS_PER_GENERATION;index++)expect(await start(index)).toBe(true);
  expect(await start(MAX_AGENT_TOOL_STEPS_PER_GENERATION)).toBe(false);
  const count=await env.DB.prepare('SELECT COUNT(*) AS count FROM hx_agent_tool_steps WHERE org_id=?1 AND assignment_id=?2').bind(ORG,assignment.id).first();
  expect(count.count).toBe(MAX_AGENT_TOOL_STEPS_PER_GENERATION);
  expect(await endAssignment(env.DB,{orgId:ORG,assignmentId:assignment.id,generation:0,agentId:'researcher',status:'cancelled'})).toBe(true);
  const steps=await env.DB.prepare('SELECT status,finished_at,duration_ms FROM hx_agent_tool_steps WHERE org_id=?1 AND assignment_id=?2 ORDER BY step_index').bind(ORG,assignment.id).all();
  expect(steps.results.every(step=>step.status==='interrupted'&&step.finished_at&&Number.isInteger(step.duration_ms))).toBe(true);
});

test('prunes old traces and converts abandoned running steps to an honest interrupted state',async()=>{
  const now=Date.now();
  expect(await startAgentToolTrace(env.DB,{orgId:ORG,assignmentId:assignment.id,generation:0,agentId:'researcher',stepIndex:0,toolName:'active',startedAt:stamp(now-11*60_000)})).toBe(true);
  expect(await startAgentToolTrace(env.DB,{orgId:ORG,assignmentId:assignment.id,generation:0,agentId:'researcher',stepIndex:1,toolName:'old',startedAt:stamp(now-(AGENT_TOOL_TRACE_RETENTION_DAYS+1)*24*60*60_000)})).toBe(true);
  const result=await pruneAgentToolTraces(env.DB,{now});
  expect(result).toEqual({interrupted:1,deleted:1});
  const rows=await env.DB.prepare('SELECT step_index,status FROM hx_agent_tool_steps WHERE org_id=?1 AND assignment_id=?2').bind(ORG,assignment.id).all();
  expect(rows.results).toEqual([{step_index:0,status:'interrupted'}]);
});
