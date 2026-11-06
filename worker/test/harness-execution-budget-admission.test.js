import { env } from 'cloudflare:test';
import { beforeEach, expect, test, vi } from 'vitest';
import schemaSql from '../schema.sql?raw';
import { setMode } from '../src/harness/mode.js';
import { runAction, invokeConnection } from '../src/harness/appCapabilities.js';
import { enqueueAcpExecution } from '../src/harness/executions.js';
import { saveWorkspaceAIBudget, workspaceBudgetAdmission } from '../src/workspaceAIBudget.js';

const ORG = 'workspace:execution-budget';
const USER = '8501';
const APP = 'app_budget_test';
const at = () => new Date(Date.now() - 1_000).toISOString();

async function exceedWorkspaceBudget(action = 'pause') {
  const createdAt = at();
  await saveWorkspaceAIBudget(env.DB, ORG, {
    revision: 0, dailyLimitUsd: 0.5, weeklyLimitUsd: 0, monthlyLimitUsd: 0, action,
  }, USER, createdAt);
  await env.DB.prepare(`INSERT INTO ai_calls(org_id,user_github_id,purpose,provider,model,input_tokens,output_tokens,usd,byok,created_at)
    VALUES(?1,?2,'ask','OpenAI','gpt-4o-mini',100,100,0.5,0,?3)`).bind(ORG, USER, createdAt).run();
}

async function appFixtures() {
  const createdAt = at();
  await env.DB.prepare(`INSERT INTO hx_apps(id,org_id,name,description,icon,table_id,template,version,definition,created_by,created_at,updated_at)
    VALUES(?1,?2,'Budget app','','📋','table_test','crm',1,'{}',?3,?4,?4)`).bind(APP, ORG, USER, createdAt).run();
  await env.DB.prepare(`INSERT INTO hx_app_actions(org_id,app_id,name,version,draft,published,published_version,updated_at)
    VALUES(?1,?2,'calculate',1,'return input.value;','return input.value;',1,?3)`).bind(ORG, APP, createdAt).run();
  await env.DB.prepare(`INSERT INTO hx_gateways(id,org_id,name,token_hash,created_by,created_at)
    VALUES('node_budget_test',?1,'Test node','hash_budget_test',?2,1)`).bind(ORG, USER).run();
  await env.DB.prepare(`INSERT INTO hx_app_connections(org_id,app_id,created_by,name,version,endpoint,method,enabled)
    VALUES(?1,?2,?3,'lookup',1,'https://api.github.com/repos/example/project/issues','GET',1)`).bind(ORG, APP, USER).run();
}

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, ' '));
  await env.DB.prepare('INSERT INTO memberships(org_id,user_github_id,role,created_at) VALUES(?1,?2,\'member\',?3)')
    .bind(ORG, USER, at()).run();
  await setMode(env.DB, ORG, 'harness', USER);
  await appFixtures();
});

test('an exceeded workspace pause blocks app action enqueue and external fetch before side effects', async () => {
  await exceedWorkspaceBudget('pause');
  const denied = await workspaceBudgetAdmission(env.DB, ORG);
  expect(denied).toMatchObject({ allowed: false, reason: 'workspace_ai_budget', status: 409 });

  const action = await runAction(env.DB, ORG, APP, {
    name: 'calculate', version: 1, gatewayId: 'node_budget_test', requestId: 'paused-action', input: { value: 1 },
  }, USER);
  expect(action).toMatchObject({ status: 409, error: expect.stringContaining('estimated AI usage limit') });
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_gateway_jobs WHERE org_id=?1').bind(ORG).first()).toMatchObject({ n: 0 });
  await env.DB.prepare('UPDATE hx_gateways SET last_seen_at=?1 WHERE id=\'node_budget_test\'').bind(Date.now()).run();
  await env.DB.prepare('INSERT INTO hx_gateway_acp_agents(org_id,gateway_id,agent_key,last_seen_at) VALUES(?1,\'node_budget_test\',\'local-codex\',?2)')
    .bind(ORG, Date.now()).run();
  const acp = await enqueueAcpExecution(env.DB, ORG, USER, {
    gatewayId: 'node_budget_test', agentKey: 'local-codex', prompt: 'Review this change', workspaceTools: true, agentId: 'agent-test',
  });
  expect(acp).toMatchObject({ status: 409, error: expect.stringContaining('estimated AI usage limit') });
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_gateway_jobs WHERE org_id=?1').bind(ORG).first()).toMatchObject({ n: 0 });

  const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  try {
    const connection = await invokeConnection(env.DB, ORG, APP, USER, { name: 'lookup', version: 1 });
    expect(connection).toMatchObject({ status: 409, error: expect.stringContaining('estimated AI usage limit') });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

test('warn-only limits permit app actions and connections, and Simple mode keeps its prior execution behavior', async () => {
  await exceedWorkspaceBudget('warn');
  expect(await workspaceBudgetAdmission(env.DB, ORG)).toMatchObject({ allowed: true });
  const action = await runAction(env.DB, ORG, APP, {
    name: 'calculate', version: 1, gatewayId: 'node_budget_test', requestId: 'warn-action', input: { value: 1 },
  }, USER);
  expect(action.job?.id).toBeTruthy();
  const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  try {
    const connection = await invokeConnection(env.DB, ORG, APP, USER, { name: 'lookup', version: 1 });
    expect(connection).toMatchObject({ data: { ok: true } });
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }

  await env.DB.prepare('DELETE FROM ai_calls WHERE org_id=?1').bind(ORG).run();
  await exceedWorkspaceBudget('pause');
  await setMode(env.DB, ORG, 'simple', USER);
  const legacy = await runAction(env.DB, ORG, APP, {
    name: 'calculate', version: 1, gatewayId: 'node_budget_test', requestId: 'simple-action', input: { value: 2 },
  }, USER);
  expect(legacy.job?.id).toBeTruthy();
});
