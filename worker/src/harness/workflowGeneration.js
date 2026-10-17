import { normalizeTrigger, normalizeSteps, mayViewWorkflow } from './workflows.js';

// Model output is a proposal, never executable code. Validate all references as
// the requesting member and always save paused so generation cannot send posts.
export async function workflowFromPrompt(db, orgId, by, { prompt, channel, timezone = 'UTC', complete, tables = [], agents = [] }) {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text || text.length > 4000) return { error: 'Describe the automation in 1–4000 characters.' };
  if (!complete) return { error: 'AI generation is unavailable within the current allowance. Use the manual builder or try again later.', status: 503 };
  let spec;
  try {
    const raw = await complete([
      'Design a workflow as JSON only: {name, trigger, steps}. Use the language of the request.',
      'trigger: {type:"manual"|"schedule"|"row"|"webhook"}. Schedule additionally needs cadence (daily, weekdays, weekly, monthly), hour 0-23, minute 0-59, timezone, weekday 0-6 for weekly, monthday 1-28 for monthly. Row needs tableId and on (added, changed, any).',
      'Steps (1-12): {type:"post",channel,text}, {type:"agent",agentId,prompt,channel?}, {type:"add_row",tableId,values}, {type:"update_row",tableId?,rowId?,values}, {type:"approval",to,title,summary}, {type:"followup",channel,text,minutes}.',
      'Use only supplied table and agent IDs. Column values use column IDs. Outputs can reference {{input.text}}, {{row.Column name}}, {{steps.1.output}}. update_row without rowId requires a row trigger.',
      'Do not invent integrations or capabilities. If the request cannot be implemented, return {error: a brief explanation in the user language}. No external network, shell, email or code execution steps exist.',
      'Return the exact requested behavior, not a generic notification as a substitute. Do not add sample data or extra steps. Scheduling is reviewed before activation.',
      JSON.stringify({ defaultChannel: channel || null, defaultTimezone: timezone, tables, agents }),
    ].join('\n'), text);
    spec = JSON.parse(String(raw).replace(/^```(?:json)?|```$/gm, '').trim());
  } catch { return { error: 'The automation could not be generated. Try a more specific description.' }; }
  if (spec?.error) return { error: String(spec.error).slice(0, 500) };
  if (!spec?.name || typeof spec.name !== 'string') return { error: 'The generated automation has no name.' };
  const t = normalizeTrigger(spec.trigger), s = normalizeSteps(spec.steps);
  if (t.error || s.error) return { error: t.error || s.error };
  if (t.trigger.type === 'schedule') {
    const tr = t.trigger;
    if (tr.hour < 0 || tr.hour > 23 || tr.minute < 0 || tr.minute > 59 || (tr.cadence === 'weekly' && (tr.weekday < 0 || tr.weekday > 6)) || (tr.cadence === 'monthly' && (tr.monthday < 1 || tr.monthday > 28))) return { error: 'The generated schedule is invalid.' };
  }
  for (const step of s.steps) {
    if (step.type === 'update_row' && !step.rowId && t.trigger.type !== 'row') return { error: 'A row update needs a row trigger or a specific row.' };
  }
  const workflow = { name: spec.name.trim().slice(0, 80), trigger: t.trigger, steps: s.steps, enabled: false };
  if (!(await mayViewWorkflow(db, orgId, workflow, by))) return { error: 'The automation references a resource you cannot access.', status: 403 };
  return { workflow, source: 'model' };
}
