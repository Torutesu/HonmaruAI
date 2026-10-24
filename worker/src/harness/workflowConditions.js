import {claimWorkflowNode,finishWorkflowNode} from './workflowCheckpoints.js';
// Declarative predicates only: never evaluate user code or coerce input types.
// Runtime integration must persist the decision before following its edge.
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const scalar = value => value === null || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 4000) || (typeof value === 'number' && Number.isFinite(value));
const own = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key);
export function normalizeWorkflowCondition(raw) {
 let nodes = 0;
 const walk = (node, depth) => {
  if (++nodes > 64 || depth > 8) throw new Error('Condition exceeds the node or nesting limit.');
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Condition must be an object.');
  const keys = Object.keys(node);
  for (const group of ['all', 'any', 'not']) {
   if (!own(node, group)) continue;
   if (keys.length !== 1) throw new Error('A condition group cannot have extra properties.');
   if (group === 'not') return {not: walk(node.not, depth + 1)};
   if (!Array.isArray(node[group]) || !node[group].length || node[group].length > 16) throw new Error('Condition groups need 1–16 children.');
   return {[group]: node[group].map(child => walk(child, depth + 1))};
  }
  if (keys.some(key => !['path', 'op', 'value'].includes(key))) throw new Error('Unknown condition property.');
  const path = node.path;
  if (!Array.isArray(path) || path.length < 2 || path.length > 12 || !['input', 'row', 'before', 'steps'].includes(path[0]) || path.some(key => typeof key !== 'string' || !key.length || key.length > 200 || forbidden.has(key))) throw new Error('Condition path must reference an input, row, before value or step output.');
  if (!['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'exists'].includes(node.op)) throw new Error('Unknown condition operator.');
  if (!own(node, 'value')) throw new Error('Condition value is required.');
  const value = node.value;
  if (node.op === 'exists') { if (typeof value !== 'boolean') throw new Error('exists requires a boolean.'); }
  else if (node.op === 'in') { if (!Array.isArray(value) || !value.length || value.length > 100 || !value.every(scalar)) throw new Error('in requires 1–100 scalar values.'); }
  else if (!scalar(value)) throw new Error('Condition value must be a finite scalar.');
  if (['gt', 'gte', 'lt', 'lte'].includes(node.op) && typeof value !== 'number') throw new Error('Ordered comparisons require numbers.');
  if (node.op === 'contains' && typeof value !== 'string') throw new Error('contains requires text.');
  return {path: [...path], op: node.op, value: Array.isArray(value) ? [...value] : value};
 };
 try { return {condition: walk(raw, 0)}; } catch (error) { return {error: error.message}; }
}
export function evaluateWorkflowCondition(raw, scope) {
 const parsed = normalizeWorkflowCondition(raw);
 if (parsed.error) throw new Error(parsed.error);
 const walk = condition => {
  if (condition.all) return condition.all.every(walk);
  if (condition.any) return condition.any.some(walk);
  if (condition.not) return !walk(condition.not);
  let value = scope, found = true;
  for (const key of condition.path) {
   if (!own(value, key)) { found = false; break; }
   value = value[key];
  }
  if (condition.op === 'exists') return found === condition.value;
  if (!found) return false;
  const expected = condition.value;
  switch (condition.op) {
   case 'eq': return scalar(value) && value === expected;
   case 'neq': return scalar(value) && typeof value === typeof expected && value !== expected;
   case 'in': return scalar(value) && expected.some(item => item === value);
   case 'contains': return typeof value === 'string' && value.includes(expected);
   case 'gt': return typeof value === 'number' && Number.isFinite(value) && value > expected;
   case 'gte': return typeof value === 'number' && Number.isFinite(value) && value >= expected;
   case 'lt': return typeof value === 'number' && Number.isFinite(value) && value < expected;
   case 'lte': return typeof value === 'number' && Number.isFinite(value) && value <= expected;
  }
 };
 return walk(parsed.condition);
}

// Persist a pure decision before an executor follows it. Replays use the saved
// answer even if their reconstructed scope differs; definitions are fingerprinted.
export async function checkpointWorkflowCondition(db,{orgId,runId,nodeId,condition,scope,at}) {
 const parsed=normalizeWorkflowCondition(condition);
 if(parsed.error)throw Error(parsed.error);
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parsed.condition)));
 const fingerprint=[...new Uint8Array(bytes)].map(value=>value.toString(16).padStart(2,'0')).join('');
 const identity={orgId,runId,nodeId,fingerprint};
 const claim=await claimWorkflowNode(db,{...identity,at:at??Date.now()});
 if(claim.status==='done') {
  if(typeof claim.result?.matches!=='boolean')throw Error('Invalid saved workflow condition.');
  return {status:'done',matches:claim.result.matches};
 }
 if(claim.status==='busy'||claim.status==='unavailable')return {status:'pending'};
 if(claim.status!=='acquired')throw Error('Workflow condition checkpoint conflicts with its definition.');
 const result={matches:evaluateWorkflowCondition(parsed.condition,scope)};
 if(!await finishWorkflowNode(db,{...identity,...claim,result,at:at??Date.now()}))return {status:'pending'};
 return {status:'done',...result};
}
