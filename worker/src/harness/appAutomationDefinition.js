import {normalizeTrigger, normalizeSteps} from './workflows.js';
import {isTimeZone,isIsoInstant,MIN_SCHEDULE_INTERVAL_MS,MAX_SCHEDULE_INTERVAL_MS,validateCronExpression} from '../schedule.js';

export const MAX_APP_AUTOMATIONS = 12;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const jsonValue = (value, depth = 0) => depth <= 24 && (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (Array.isArray(value) ? value.every(item => jsonValue(item, depth + 1)) : object(value) && Object.values(value).every(item => jsonValue(item, depth + 1))));

// No workflow IDs, credentials or live run state are accepted in a portable
// declaration. A draft is data only: this module cannot enable any work.
export function normalizeAppAutomations(raw) {
  const fail = error => ({error, status: 400});
  if (!keys(raw, ['version','items']) || raw.version !== 1 || !Array.isArray(raw.items)) return fail('Automations need version 1 and an items array.');
  if (raw.items.length > MAX_APP_AUTOMATIONS) return fail(`An app can declare at most ${MAX_APP_AUTOMATIONS} automations.`);
  if (!jsonValue(raw) || JSON.stringify(raw).length > 64000) return fail('Automation declarations are too large or invalid.');
  const used = new Set(), items = [];
  for (const item of raw.items) {
    if (!keys(item, ['key','name','enabled','trigger','steps']) || typeof item.key !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(item.key) || used.has(item.key)) return fail('Each automation needs a unique stable key.');
    if (!text(item.name, 80) || typeof item.enabled !== 'boolean') return fail('Each automation needs a name and explicit enabled state.');
    used.add(item.key);
    const trigger = item.trigger;
    if (!object(trigger)) return fail('Each automation needs a trigger.');
    const triggerKeys = trigger.type === 'schedule' ? (trigger.kind==='cron'?['type','kind','expr','timezone']:trigger.kind==='every'?['type','kind','everyMs']:trigger.kind==='at'?['type','kind','at']:['type','cadence','hour','minute','timezone','weekday','monthday']) : trigger.type === 'row' ? ['type','tableId','on','where','column'] : trigger.type === 'app_record_change' ? ['type','appId','entityId','events','when'] : ['type'];
    if (!keys(trigger, triggerKeys)) return fail('Unknown trigger fields.');
    if (trigger.type === 'schedule' && trigger.kind === 'cron' && (!text(trigger.expr,240) || !isTimeZone(trigger.timezone) || validateCronExpression(trigger.expr).error)) return fail('The automation cron schedule is invalid.');
    if (trigger.type === 'schedule' && trigger.kind === 'every' && (!integer(trigger.everyMs,MIN_SCHEDULE_INTERVAL_MS,MAX_SCHEDULE_INTERVAL_MS))) return fail('The automation interval is outside the supported range.');
    if (trigger.type === 'schedule' && trigger.kind === 'at' && !isIsoInstant(trigger.at)) return fail('The one-time automation timestamp is invalid.');
    if (trigger.type === 'schedule' && trigger.kind === undefined && (!integer(trigger.hour,0,23) || !integer(trigger.minute,0,59) || !isTimeZone(trigger.timezone) || (trigger.cadence === 'weekly' && !integer(trigger.weekday,0,6)) || (trigger.cadence === 'monthly' && !integer(trigger.monthday,1,31)))) return fail('The automation schedule is invalid.');
    if (trigger.type === 'row' && (!text(trigger.tableId,64) || !['added','changed','deleted','any'].includes(trigger.on) || (trigger.where !== undefined && !object(trigger.where)) || (trigger.column !== undefined && !text(trigger.column,64)))) return fail('The row trigger is invalid.');
    if (trigger.type === 'app_record_change' && (!text(trigger.appId,64) || !text(trigger.entityId,64) || !Array.isArray(trigger.events) || !trigger.events.length || trigger.events.length>3 || trigger.events.some(event=>!['insert','update','delete'].includes(event)) || new Set(trigger.events).size!==trigger.events.length || (trigger.when!==undefined && (!object(trigger.when)||!keys(trigger.when,['where'])||!object(trigger.when.where))))) return fail('The app record trigger is invalid.');
    const normalizedTrigger = normalizeTrigger(trigger);
    if (normalizedTrigger.error) return fail(normalizedTrigger.error);
    if (!Array.isArray(item.steps)) return fail('Each automation needs steps.');
    const fields = {
      post: {channel:200,text:4000}, agent: {agentId:64,prompt:4000,channel:200},
      add_row: {tableId:64}, update_row: {tableId:64,rowId:64},
      approval: {to:64,title:200,summary:1000}, followup: {channel:200,text:4000,agentId:64},
    };
    for (const step of item.steps) {
      const field = fields[step?.type];
      if (!field || !keys(step, ['type',...Object.keys(field),...(['add_row','update_row'].includes(step.type)?['values']:[]),...(step.type==='followup'?['minutes']:[])])) return fail('Invalid automation step fields.');
      if (Object.entries(field).some(([key,max]) => step[key] !== undefined && (typeof step[key] !== 'string' || step[key].length > max))) return fail('An automation step field is too long or invalid.');
      if (['add_row','update_row'].includes(step.type) && !object(step.values)) return fail('Row values must be an object.');
      if (step.type === 'followup' && (!Number.isFinite(step.minutes) || step.minutes < 1 || step.minutes > 129600)) return fail('Follow-up minutes are outside the supported range.');
    }
    const normalizedSteps = normalizeSteps(item.steps);
    if (normalizedSteps.error) return fail(normalizedSteps.error);
    items.push({key:item.key,name:item.name.trim(),enabled:item.enabled,trigger:normalizedTrigger.trigger,steps:normalizedSteps.steps});
  }
  return {automations:{version:1,items}};
}

export async function validateAutomationAppScope(db,orgId,appId,automations) {
  for(const item of automations?.items||[]) {
    const trigger=item.trigger;
    if(trigger?.type!=='app_record_change')continue;
    if(trigger.appId!==appId)return {error:'An app automation can only watch its own app records.',status:400};
    const table=trigger.entityId==='primary'
      ?await db.prepare('SELECT t.columns FROM hx_apps a JOIN hx_tables t ON t.org_id=a.org_id AND t.id=a.table_id WHERE a.org_id=?1 AND a.id=?2').bind(orgId,appId).first()
      :await db.prepare('SELECT t.columns FROM hx_app_entities e JOIN hx_tables t ON t.org_id=e.org_id AND t.id=e.table_id WHERE e.org_id=?1 AND e.app_id=?2 AND e.entity_key=?3').bind(orgId,appId,trigger.entityId).first();
    if(!table)return {error:'An app record trigger must reference an entity in this app.',status:400};
    let columns;try{columns=JSON.parse(table.columns)}catch{return {error:'The app record entity schema is invalid.',status:409}}
    if(Object.keys(trigger.when?.where||{}).some(key=>!columns.some(column=>column.id===key||column.name.toLowerCase()===key.toLowerCase())))return {error:'An app record condition references an unknown field.',status:400};
  }
  return null;
}

// Stable comparison ignores JSON object insertion order, but retains step
// order and all values. Never include hook secrets or run metadata.
export function automationDefinition(value) {
  return {name:value.name,enabled:value.enabled,trigger:value.trigger,steps:value.steps};
}
const stable = value => JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item);
export const sameAutomation = (a,b) => Boolean(a && b && stable(automationDefinition(a)) === stable(automationDefinition(b)));

// Inputs must already be scoped to the same authorized app/workspace by the
// caller. This reports a plan only; it never mutates a live workflow.
export function diffAppAutomations({draft, published, bindings, workflows}) {
  const proposed = new Map(draft.items.map(item => [item.key,item]));
  const released = new Map((published?.items || []).map(item => [item.key,item]));
  const links = new Map(bindings.map(binding => [binding.key,binding]));
  const live = new Map(workflows.map(workflow => [workflow.id,workflow]));
  return [...new Set([...proposed.keys(),...released.keys(),...links.keys()])].map(key => {
    const declaration = proposed.get(key), previous = released.get(key), binding = links.get(key);
    const workflow = binding && live.get(binding.workflowId);
    let status;
    if ((previous || binding) && (!binding || !workflow)) status = 'missing';
    else if (binding && !sameAutomation(binding.applied,workflow)) status = 'drifted';
    else if (!previous && !declaration) status = 'retired';
    else if (!previous) status = 'added';
    else if (!declaration) status = 'removed';
    else status = sameAutomation(declaration,previous) ? 'unchanged' : 'changed';
    return {key,status,workflowId:binding?.workflowId || null,
      declared:declaration ? automationDefinition(declaration) : null,
      published:previous ? automationDefinition(previous) : null,
      live:workflow ? automationDefinition(workflow) : null};
  });
}
