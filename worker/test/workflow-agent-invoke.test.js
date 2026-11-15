import { env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { fetchMock } from './helpers/fetch-mock.js';
import { upsertMembership, upsertUser } from '../src/db.js';
import { claimWorkflowNode } from '../src/harness/workflowCheckpoints.js';
import { invokeWorkflowAgent, validateWorkflowAgentSchema, workflowAgentOutputMatches, workflowAgentInvocationKey } from '../src/harness/workflowAgentInvoke.js';
import { ensureWorkflowSafety } from '../src/harness/workflowSafety.js';

const ORG = 'agent-invoke-org';
const JOB = 'agent-invoke-job';
const AGENT = 'agent-invoke-target';
const schema = { type: 'object', properties: { answer: { type: 'string', maxLength: 100 } }, required: ['answer'], additionalProperties: false };
let activation;
let binding;
let identity;

beforeEach(async () => {
  fetchMock.activate();
  await upsertUser(env.DB, { githubId: 'agent-invoke-owner', login: 'agent-invoke-owner', name: 'Owner' });
  await upsertMembership(env.DB, ORG, 'agent-invoke-owner', 'admin');
  await env.DB.prepare(`INSERT INTO hx_workflows(id,org_id,name,enabled,trigger,steps,created_by,created_at,updated_at)
    VALUES('agent-invoke-workflow',?1,'Agent invoke',1,'{}','[]','agent-invoke-owner','now','now')`).bind(ORG).run();
  await env.DB.prepare(`INSERT INTO hx_workflow_runs(id,org_id,workflow_id,trigger,status,log,started_at)
    VALUES('agent-invoke-run',?1,'agent-invoke-workflow','manual','running','[]','now')`).bind(ORG).run();
  const safety = await ensureWorkflowSafety(env.DB, ORG, 'agent-invoke-workflow');
  const definition = { id: 'agent-invoke-workflow', createdBy: 'agent-invoke-owner', safetyGeneration: safety.generation, steps: [{ type: 'code', sourceAgents: [AGENT] }] };
  await env.DB.prepare(`INSERT INTO hx_workflow_run_definitions(run_id,org_id,definition,created_at) VALUES('agent-invoke-run',?1,?2,'now')`).bind(ORG, JSON.stringify(definition)).run();
  const lease = await claimWorkflowNode(env.DB, { orgId: ORG, runId: 'agent-invoke-run', nodeId: 'program', fingerprint: 'frozen-program', at: 1000, ttl: 30000 });
  await env.DB.prepare(`INSERT INTO hx_gateways(id,org_id,name,token_hash,created_by,created_at) VALUES('agent-invoke-gateway',?1,'Node','token','agent-invoke-owner',1000)`).bind(ORG).run();
  await env.DB.prepare(`INSERT INTO hx_gateway_jobs(id,org_id,gateway_id,created_by,request_id,payload,status,created_at,lease_hash,lease_until,deadline)
    VALUES(?1,?2,'agent-invoke-gateway','agent-invoke-owner','request','{}','running',1000,'lease',30000,40000)`).bind(JOB, ORG).run();
  await env.DB.prepare(`INSERT INTO hx_workflow_activations(org_id,job_id,run_id,node_id,node_owner,node_attempt)
    VALUES(?1,?2,'agent-invoke-run','program',?3,?4)`).bind(ORG, JOB, lease.owner, lease.attempt).run();
  await env.DB.prepare(`INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at)
    VALUES(?1,?2,'helper','Helper','Answer plainly','team','another-owner','now','now')`).bind(ORG, AGENT).run();
  activation = { jobId: JOB, gatewayId: 'agent-invoke-gateway', leaseHash: 'lease' };
  binding = { org_id: ORG, run_id: 'agent-invoke-run', workflow_id: 'agent-invoke-workflow', node_owner: 'agent-invoke-owner', definition: JSON.stringify(definition) };
  identity = { orgId: ORG, runId: 'agent-invoke-run', nodeId: 'program', owner: lease.owner, attempt: lease.attempt, activation, at: 2000 };
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

test('Agent schemas are bounded, strict, and enforced on generated output', () => {
  expect(validateWorkflowAgentSchema(schema)).toBe(true);
  expect(workflowAgentOutputMatches({ answer: 'ok' }, schema)).toBe(true);
  expect(workflowAgentOutputMatches({ answer: 'ok', extra: 1 }, schema)).toBe(false);
  expect(workflowAgentOutputMatches({ answer: 1 }, schema)).toBe(false);
  expect(validateWorkflowAgentSchema({ type: 'object', properties: {}, additionalProperties: true })).toBe(false);
  expect(validateWorkflowAgentSchema({ type: 'object', properties: { x: { type: 'string', pattern: '.*' } }, additionalProperties: false })).toBe(false);
  expect(validateWorkflowAgentSchema({ type: 'object', properties: {}, additionalProperties: false, required: ['missing'] })).toBe(false);
});

test('Worker rejects prompts above the SDK UTF-8 byte limit before provider use', async () => {
  const params = { agentId: AGENT, prompt: 'あ'.repeat(5000), schema, tier: 'medium' };
  expect(await invokeWorkflowAgent(env, { activation, binding, identity, params, at: 2000 })).toMatchObject({ status: 400 });
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_agent_invocations WHERE org_id=?1 AND job_id=?2').bind(ORG, JOB).first()).n).toBe(0);
});

test('Agent invocation requires a frozen binding and current ACL before calling a provider', async () => {
  const params = { agentId: AGENT, prompt: 'Return an answer', schema, tier: 'medium' };
  binding.definition = JSON.stringify({ ...JSON.parse(binding.definition), steps: [{ type: 'code', sourceAgents: [] }] });
  expect(await invokeWorkflowAgent(env, { activation, binding, identity, params, at: 2000 })).toMatchObject({ status: 403 });
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_agent_invocations WHERE org_id=?1 AND job_id=?2').bind(ORG, JOB).first()).n).toBe(0);

  binding.definition = JSON.stringify({ ...JSON.parse(binding.definition), steps: [{ type: 'code', sourceAgents: [AGENT] }] });
  await env.DB.prepare(`INSERT INTO hx_agent_profiles(org_id,agent_id,access,people,updated_at) VALUES(?1,?2,'people','[]','now')`).bind(ORG, AGENT).run();
  expect(await invokeWorkflowAgent(env, { activation, binding, identity, params, at: 2000 })).toMatchObject({ status: 403 });
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_agent_invocations WHERE org_id=?1 AND job_id=?2').bind(ORG, JOB).first()).n).toBe(0);
});

test('successful invocation checkpoints validated output and an identical retry does not call the model again', async () => {
  const params = { agentId: AGENT, prompt: 'Return an answer', schema, tier: 'medium' };
  fetchMock.get('https://api.openai.com').intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
    model: 'gpt-4o-mini', choices: [{ message: { content: '{"answer":"done"}' } }], usage: { prompt_tokens: 20, completion_tokens: 4 },
  });
  const aiEnv = { ...env, OPENAI_API_KEY: 'sk-workflow-agent-invoke-test' };
  expect(await invokeWorkflowAgent(aiEnv, { activation, binding, identity, params, at: 2000 })).toEqual({ output: { answer: 'done' } });
  expect(await invokeWorkflowAgent(aiEnv, { activation, binding, identity, params: { tier: 'medium', schema, prompt: 'Return an answer', agentId: AGENT }, at: 3000 })).toEqual({ output: { answer: 'done' } });
  expect(await env.DB.prepare('SELECT status,agent_id,output FROM hx_workflow_agent_invocations WHERE org_id=?1 AND job_id=?2').bind(ORG, JOB).first())
    .toMatchObject({ status: 'complete', agent_id: AGENT, output: '{"answer":"done"}' });
  expect((await env.DB.prepare('SELECT COUNT(*) AS calls FROM hx_workflow_usage WHERE org_id=?1 AND run_id=?2').bind(ORG, 'agent-invoke-run').first()).calls).toBe(1);
});

test('an identical in-flight invocation is never repeated and the durable per-job limit is enforced', async () => {
  const params = { agentId: AGENT, prompt: 'Return an answer', schema, tier: 'medium' };
  const key = await workflowAgentInvocationKey(params);
  await env.DB.prepare(`INSERT INTO hx_workflow_agent_invocations(org_id,job_id,id,agent_id,status,created_at)
    VALUES(?1,?2,?3,?4,'running','now')`).bind(ORG, JOB, key, AGENT).run();
  expect(await invokeWorkflowAgent(env, { activation, binding, identity, params, at: 2000 })).toMatchObject({ status: 409 });
  await env.DB.prepare('DELETE FROM hx_workflow_agent_invocations WHERE org_id=?1 AND job_id=?2').bind(ORG, JOB).run();
  for (let index = 0; index < 5; index++) {
    await env.DB.prepare(`INSERT INTO hx_workflow_agent_invocations(org_id,job_id,id,agent_id,status,created_at)
      VALUES(?1,?2,?3,?4,'failed','now')`).bind(ORG, JOB, String(index).padStart(64, '0'), AGENT).run();
  }
  expect(await invokeWorkflowAgent({ ...env, OPENAI_API_KEY: 'sk-workflow-agent-invoke-test' }, { activation, binding, identity, params, at: 3000 }))
    .toMatchObject({ status: 429, error: 'This program reached its Agent call limit.' });
});

test('provider output that violates the requested schema is retained as failed and cannot be retried', async () => {
  const params = { agentId: AGENT, prompt: 'Return an answer', schema, tier: 'low' };
  fetchMock.get('https://api.openai.com').intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
    model: 'gpt-4o-mini', choices: [{ message: { content: '{"answer":7}' } }], usage: { prompt_tokens: 20, completion_tokens: 4 },
  });
  const aiEnv = { ...env, OPENAI_API_KEY: 'sk-workflow-agent-invoke-test' };
  expect(await invokeWorkflowAgent(aiEnv, { activation, binding, identity, params, at: 2000 })).toMatchObject({ status: 502 });
  expect(await invokeWorkflowAgent(aiEnv, { activation, binding, identity, params, at: 3000 })).toMatchObject({ status: 409 });
  expect((await env.DB.prepare('SELECT status FROM hx_workflow_agent_invocations WHERE org_id=?1 AND job_id=?2').bind(ORG, JOB).first()).status).toBe('failed');
});
