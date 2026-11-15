import { mayRunAgent } from './agents.js';
import { completer } from './model.js';
import { recordWorkflowUsage } from './workflowUsage.js';
import { readWorkflowState } from './workflowState.js';

const MAX_SCHEMA_BYTES = 16 * 1024;
const MAX_PROMPT_BYTES = 12_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_SCHEMA_NODES = 128;
const MAX_AGENT_INVOKES = 5;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const byteLength = value => new TextEncoder().encode(value).length;

export function validateWorkflowAgentSchema(schema) {
  let serialized;
  try { serialized = JSON.stringify(schema); } catch { return false; }
  if (!isObject(schema) || !serialized || byteLength(serialized) > MAX_SCHEMA_BYTES) return false;
  let nodes = 0;
  const visit = (node, depth, root = false) => {
    if (!isObject(node) || depth > 5 || ++nodes > MAX_SCHEMA_NODES) return false;
    const allowedKeys = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum']);
    if (Object.keys(node).some(key => !allowedKeys.has(key))) return false;
    if (!['object', 'string', 'number', 'integer', 'boolean', 'null', 'array'].includes(node.type)) return false;
    if (root && node.type !== 'object') return false;
    if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length < 1 || node.enum.length > 100 || node.enum.some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value)))) return false;
    if (node.type === 'object') {
      if (!isObject(node.properties) || Object.keys(node.properties).length > 32 || node.additionalProperties !== false) return false;
      if (node.required !== undefined && (!Array.isArray(node.required) || node.required.length > 32 || node.required.some(key => typeof key !== 'string' || !Object.hasOwn(node.properties, key)) || new Set(node.required).size !== node.required.length)) return false;
      if (node.items !== undefined || node.maxItems !== undefined || node.minLength !== undefined || node.maxLength !== undefined || node.minimum !== undefined || node.maximum !== undefined) return false;
      return Object.entries(node.properties).every(([key, child]) => key.length > 0 && key.length <= 100 && visit(child, depth + 1));
    }
    if (node.properties !== undefined || node.required !== undefined || node.additionalProperties !== undefined) return false;
    if (node.type === 'array') {
      if (!visit(node.items, depth + 1) || node.maxItems !== undefined && (!Number.isInteger(node.maxItems) || node.maxItems < 0 || node.maxItems > 100)) return false;
      return node.minLength === undefined && node.maxLength === undefined && node.minimum === undefined && node.maximum === undefined;
    }
    if (node.items !== undefined || node.maxItems !== undefined) return false;
    if (node.type === 'string') return (node.minLength === undefined || Number.isInteger(node.minLength) && node.minLength >= 0 && node.minLength <= 10_000)
      && (node.maxLength === undefined || Number.isInteger(node.maxLength) && node.maxLength >= 0 && node.maxLength <= 10_000)
      && (node.minLength === undefined || node.maxLength === undefined || node.minLength <= node.maxLength)
      && node.minimum === undefined && node.maximum === undefined;
    if (['number', 'integer'].includes(node.type)) return (node.minimum === undefined || Number.isFinite(node.minimum))
      && (node.maximum === undefined || Number.isFinite(node.maximum))
      && (node.minimum === undefined || node.maximum === undefined || node.minimum <= node.maximum)
      && node.minLength === undefined && node.maxLength === undefined;
    return node.minLength === undefined && node.maxLength === undefined && node.minimum === undefined && node.maximum === undefined;
  };
  return visit(schema, 1, true);
}

export function workflowAgentOutputMatches(value, schema) {
  if (!validateWorkflowAgentSchema(schema)) return false;
  const visit = (item, rule) => {
    if (rule.enum && !rule.enum.some(candidate => Object.is(candidate, item))) return false;
    switch (rule.type) {
      case 'object':
        if (!isObject(item) || Object.keys(item).some(key => !Object.hasOwn(rule.properties, key))) return false;
        if ((rule.required || []).some(key => !Object.hasOwn(item, key))) return false;
        return Object.entries(item).every(([key, child]) => visit(child, rule.properties[key]));
      case 'array': return Array.isArray(item) && item.length <= (rule.maxItems ?? 100) && item.every(child => visit(child, rule.items));
      case 'string': return typeof item === 'string' && item.length >= (rule.minLength ?? 0) && item.length <= (rule.maxLength ?? 10_000);
      case 'number': return typeof item === 'number' && Number.isFinite(item) && (rule.minimum === undefined || item >= rule.minimum) && (rule.maximum === undefined || item <= rule.maximum);
      case 'integer': return Number.isSafeInteger(item) && (rule.minimum === undefined || item >= rule.minimum) && (rule.maximum === undefined || item <= rule.maximum);
      case 'boolean': return typeof item === 'boolean';
      case 'null': return item === null;
      default: return false;
    }
  };
  return visit(value, schema);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export async function workflowAgentInvocationKey(params) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(params)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function claimInvocation(db, { orgId, jobId, agentId, id, at }) {
  const result = await db.prepare(`INSERT INTO hx_workflow_agent_invocations(org_id,job_id,id,agent_id,status,created_at)
    SELECT ?1,?2,?3,?4,'running',?5 WHERE (SELECT COUNT(*) FROM hx_workflow_agent_invocations WHERE org_id=?1 AND job_id=?2) < ?6
    ON CONFLICT(org_id,job_id,id) DO NOTHING`)
    .bind(orgId, jobId, id, agentId, new Date(at).toISOString(), MAX_AGENT_INVOKES).run();
  if (result.meta?.changes) return { claimed: true };
  const existing = await db.prepare(`SELECT status,output FROM hx_workflow_agent_invocations WHERE org_id=?1 AND job_id=?2 AND id=?3`)
    .bind(orgId, jobId, id).first();
  return existing ? { claimed: false, existing } : { claimed: false, existing: null };
}

async function readInvocation(db, orgId, jobId, id) {
  return db.prepare(`SELECT status,output FROM hx_workflow_agent_invocations WHERE org_id=?1 AND job_id=?2 AND id=?3`).bind(orgId, jobId, id).first();
}

async function replayInvocation(existing, schema) {
  if (existing?.status === 'complete') {
    let cached;
    try { cached = JSON.parse(existing.output); } catch { return { error: 'The saved Agent result is unavailable.', status: 409 }; }
    return workflowAgentOutputMatches(cached, schema) ? { output: cached } : { error: 'The saved Agent result no longer matches its schema.', status: 409 };
  }
  return { error: existing ? 'This Agent invocation is already in progress or failed; it will not be repeated.' : 'This program reached its Agent call limit.', status: existing ? 409 : 429 };
}

async function finishInvocation(db, { orgId, jobId, id, status = 'failed', output = null }) {
  await db.prepare(`UPDATE hx_workflow_agent_invocations SET status=?1,output=?2 WHERE org_id=?3 AND job_id=?4 AND id=?5 AND status='running'`)
    .bind(status, output, orgId, jobId, id).run();
}

export async function invokeWorkflowAgent(env, { db = env?.DB, activation, binding, identity, params, at = Date.now() }) {
  if (!env || !db || !isObject(params) || Object.keys(params).some(key => !['agentId', 'prompt', 'schema', 'tier'].includes(key))
    || Object.keys(params).length !== 4 || typeof params.agentId !== 'string' || !params.agentId.trim() || params.agentId.length > 200
    || typeof params.prompt !== 'string' || !params.prompt.trim() || byteLength(params.prompt) > MAX_PROMPT_BYTES
    || !['low', 'medium', 'high'].includes(params.tier) || !validateWorkflowAgentSchema(params.schema)) {
    return { error: 'Invalid Agent invocation.', status: 400 };
  }
  let definition;
  try { definition = JSON.parse(binding.definition); } catch { return { error: 'The saved Workflow definition is unavailable.', status: 409 }; }
  const step = definition.steps?.[0];
  if (definition.id !== binding.workflow_id || step?.type !== 'code' || !Array.isArray(step.sourceAgents) || !step.sourceAgents.includes(params.agentId)) return { error: 'This Agent is not explicitly bound to the Workflow program.', status: 403 };
  const agent = await db.prepare(`SELECT id,name,handle,instructions,scope,owner_login FROM custom_agents
    WHERE org_id=?1 AND id=?2 AND deleted_at IS NULL`).bind(binding.org_id, params.agentId).first();
  if (!agent || !(await mayRunAgent(db, binding.org_id, agent, binding.node_owner))) return { error: 'Agent access required.', status: 403 };
  const allowed = await readWorkflowState(db, { ...identity, view: 'committed', includeCurrentRun: false });
  if (allowed.available === false) return { error: 'Workflow execution is no longer authorized.', status: 409 };
  const id = await workflowAgentInvocationKey(params);
  const previous = await readInvocation(db, binding.org_id, activation.jobId, id);
  if (previous) return replayInvocation(previous, params.schema);

  let budgetDeniedReason = null;
  const stepNumber = 1;
  const authorize = async () => {
    const [current, workflow] = await Promise.all([
      db.prepare(`SELECT id,name,handle,instructions,scope,owner_login FROM custom_agents WHERE org_id=?1 AND id=?2 AND deleted_at IS NULL`).bind(binding.org_id, agent.id).first(),
      readWorkflowState(db, { ...identity, view: 'committed', includeCurrentRun: false }),
    ]);
    return Boolean(current && workflow.available !== false && await mayRunAgent(db, binding.org_id, current, binding.node_owner));
  };
  const complete = await completer(env, binding.org_id, binding.node_owner, 'workflow_agent_invoke', {
    json: true,
    maxTokens: params.tier === 'high' ? 1200 : params.tier === 'medium' ? 800 : 400,
    timeoutMs: 25_000,
    usageContext: { workflowId: binding.workflow_id, agentId: agent.id },
    budgetContext: { runId: binding.run_id, stepNumber, onDenied: reason => { budgetDeniedReason = reason; } },
  });
  if (!complete) return { error: budgetDeniedReason ? 'The AI usage budget denied this Agent call.' : 'No configured AI provider or allowance is available.', status: 429 };
  let claimed;
  try { claimed = await claimInvocation(db, { orgId: binding.org_id, jobId: activation.jobId, agentId: agent.id, id, at }); }
  catch { await complete.dispose?.(); return { error: 'The Agent invocation checkpoint is unavailable.', status: 503 }; }
  if (!claimed.claimed) {
    await complete.dispose?.();
    return claimed.existing ? replayInvocation(claimed.existing, params.schema) : { error: 'This program reached its Agent call limit.', status: 429 };
  }
  const user = `Prompt:\n${params.prompt}\n\nReturn one JSON value that strictly matches this schema:\n${JSON.stringify(params.schema)}`;
  let result;
  try { result = await complete(
    `You are ${agent.name || 'an Agent'} (@${agent.handle || 'agent'}), invoked by a workflow program. Follow your Agent instructions and answer the prompt. Return only JSON matching the supplied schema. You cannot call tools, invoke other Agents, or delegate work.\n\n<agent_instructions>\n${String(agent.instructions || '').slice(0, 12_000)}\n</agent_instructions>`,
    user,
    {
      authorize,
      recordUsage: (data, provider) => recordWorkflowUsage(db, {
        orgId: binding.org_id, workflowId: binding.workflow_id, runId: binding.run_id,
        stepNumber, data, provider, reservationId: provider.reservationId,
      }),
    },
  ); } catch { await finishInvocation(db,{orgId:binding.org_id,jobId:activation.jobId,id}); return {error:'Agent invocation failed and will not be repeated.',status:502}; }
  if (!await authorize()) { await finishInvocation(db,{orgId:binding.org_id,jobId:activation.jobId,id}); return { error: 'Workflow or Agent access changed during invocation.', status: 409 }; }
  if (result === null && budgetDeniedReason) { await finishInvocation(db,{orgId:binding.org_id,jobId:activation.jobId,id}); return { error: 'The AI usage budget denied this Agent call.', status: 429 }; }
  if (typeof result !== 'string' || byteLength(result) > MAX_OUTPUT_BYTES) { await finishInvocation(db,{orgId:binding.org_id,jobId:activation.jobId,id}); return { error: 'Agent returned no bounded JSON result.', status: 502 }; }
  let output;
  try { output = JSON.parse(result); } catch { await finishInvocation(db,{orgId:binding.org_id,jobId:activation.jobId,id}); return { error: 'Agent returned invalid JSON.', status: 502 }; }
  if (!workflowAgentOutputMatches(output, params.schema)) { await finishInvocation(db,{orgId:binding.org_id,jobId:activation.jobId,id}); return { error: 'Agent result did not match its schema.', status: 502 }; }
  if (!await authorize()) { await finishInvocation(db,{orgId:binding.org_id,jobId:activation.jobId,id}); return { error: 'Workflow or Agent access changed before the Agent result was saved.', status: 409 }; }
  const saved = await db.prepare(`UPDATE hx_workflow_agent_invocations SET status='complete',output=?1
    WHERE org_id=?2 AND job_id=?3 AND id=?4 AND status='running' AND EXISTS(
      SELECT 1 FROM hx_workflow_activations a JOIN hx_gateway_jobs j ON j.org_id=a.org_id AND j.id=a.job_id
      WHERE a.org_id=?2 AND a.job_id=?3 AND j.gateway_id=?5 AND j.lease_hash=?6 AND j.status='running')`)
    .bind(JSON.stringify(output), binding.org_id, activation.jobId, id, activation.gatewayId, activation.leaseHash).run();
  if (!saved.meta?.changes) { await finishInvocation(db,{orgId:binding.org_id,jobId:activation.jobId,id}); return { error: 'Workflow activation ended before the Agent result was checkpointed.', status: 409 }; }
  return { output };
}
