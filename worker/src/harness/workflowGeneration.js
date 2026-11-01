import { normalizeTrigger, normalizeSteps, mayViewWorkflow } from './workflows.js';
import { withRoomGuidelinesRequest } from './guidelines.js';

// Model output is a proposal, never executable code. Validate all references as
// the requesting member and always save paused so generation cannot send posts.
export async function workflowFromPrompt(db, orgId, by, { prompt, channel, timezone = 'UTC', complete, tables = [], agents = [], appRecords = [] }) {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text || text.length > 4000) return { error: 'Describe the automation in 1–4000 characters.' };
  if (!complete) return { error: 'AI generation is unavailable within the current allowance. Use the manual builder or try again later.', status: 503 };
  const requestText=channel?await withRoomGuidelinesRequest(db,orgId,channel,text):text;
  let spec;
  try {
    const raw = await complete([
      'Design a workflow as JSON only: {name, trigger, steps}. Use the language of the request.',
      `trigger: {type:"manual"|"schedule"|"row"|"webhook"${appRecords.length?'|"app_record_change"':''}}. Schedule additionally needs cadence (daily, weekdays, weekly, monthly), hour 0-23, minute 0-59, timezone, weekday 0-6 for weekly, monthday 1-28 for monthly. Row needs tableId and on (added, changed, any).${appRecords.length?' App record needs appId, entityId and events (insert/update/delete); optional when is {where:{field:value}} with flat AND scalar equality/array membership. Use only supplied app/entity/column IDs. Delete events have no data, so omit when if deletion must trigger. App record payload is input.records: [{event,appId,entityId,recordId,data}].':''}`,
      'Steps (1-12): {type:"post",channel,text}, {type:"agent",agentId,prompt,channel?}, {type:"add_row",tableId,values}, {type:"update_row",tableId?,rowId?,values}, {type:"approval",to,title,summary}, {type:"followup",channel,text,minutes}.',
      'Any step may have optional when: {path:["input","amount"],op:"gte",value:100}. Conditions support {all:[conditions]}, {any:[conditions]}, {not:condition}; leaves use path, op, value. Operators: eq, neq, gt, gte, lt, lte, contains, in, exists. Use typed JSON values, never JavaScript or template expressions in conditions. Numeric comparisons require numbers, contains requires text, in requires a nonempty array of scalar candidates, exists requires a boolean. Missing values do not match comparisons, including neq; use exists:false to test absence.',
      'Condition paths start with input (manual/webhook payload), row or before (current/previous row for row triggers), or steps (one-based earlier step, e.g. ["steps","1","output"]). Use supplied stable column IDs for row/before paths, not dotted column names. Conditions skip only their own step when false, keep step numbers unchanged, and do not stop later steps. If several actions share a condition, put it on each action. Do not invent branch, loop or parallel step types. Limits: 64 condition nodes, 8 nesting levels, 16 children per group, 100 in candidates.',
      'Use only supplied table and agent IDs. Column values use column IDs. Outputs can reference {{input.text}}, {{input.recordId}} for a row event, {{input.records.0.recordId}} for an app record event, {{row.Column name}}, {{steps.1.output}}. A user column named id may occupy {{row.id}} and {{input.row.id}}; do not use either as the triggering record ID. Omit rowId to update the triggering record; this requires a row or app record trigger. To intentionally target the ID held in a user column, use {{input.rowFields.id}} for a row event or {{input.records.0.data.id}} for an app record event; use its actual column ID if renamed.',
      'Do not invent integrations or capabilities. If the request cannot be implemented, return {error: a brief explanation in the user language}. No external network, shell, email or code execution steps exist.',
      'Return the exact requested behavior, not a generic notification as a substitute. Do not add sample data or extra steps. Scheduling is reviewed before activation.',
      JSON.stringify({ defaultChannel: channel || null, defaultTimezone: timezone, tables, agents, appRecords }),
    ].join('\n'), requestText);
    spec = JSON.parse(String(raw).replace(/^```(?:json)?|```$/gm, '').trim());
  } catch { return { error: 'The automation could not be generated. Try a more specific description.' }; }
  if (spec?.error) return { error: String(spec.error).slice(0, 500) };
  if (!spec?.name || typeof spec.name !== 'string') return { error: 'The generated automation has no name.' };
  const t = normalizeTrigger(spec.trigger), s = normalizeSteps(spec.steps);
  if (t.error || s.error) return { error: t.error || s.error };
  if (t.trigger.type === 'app_record_change') {
    const app=appRecords.find(value=>value.id===t.trigger.appId);
    if (!app || !app.entities?.some(entity=>entity.id===t.trigger.entityId)) return {error:'The generated app record trigger references an unavailable app entity.'};
    const entity=app.entities.find(value=>value.id===t.trigger.entityId);
    if (t.trigger.when?.where && Object.keys(t.trigger.when.where).some(key=>!entity.columns?.some(column=>column.id===key||column.name.toLowerCase()===key.toLowerCase()))) return {error:'The generated app record condition references an unknown field.'};
  }
  if (t.trigger.type === 'schedule') {
    const tr = t.trigger;
    if (tr.hour < 0 || tr.hour > 23 || tr.minute < 0 || tr.minute > 59 || (tr.cadence === 'weekly' && (tr.weekday < 0 || tr.weekday > 6)) || (tr.cadence === 'monthly' && (tr.monthday < 1 || tr.monthday > 28))) return { error: 'The generated schedule is invalid.' };
  }
  for (const step of s.steps) {
    if (step.type === 'update_row' && !step.rowId && !['row','app_record_change'].includes(t.trigger.type)) return { error: 'A row update needs a row trigger or a specific row.' };
  }
  const workflow = { name: spec.name.trim().slice(0, 80), trigger: t.trigger, steps: s.steps, enabled: false };
  if (!(await mayViewWorkflow(db, orgId, workflow, by))) return { error: 'The automation references a resource you cannot access.', status: 403 };
  return { workflow, source: 'model' };
}
