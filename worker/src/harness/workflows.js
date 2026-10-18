import { mayUseTable } from './resourceAccess.js';
import { mayUseConversation } from './conversationAccess.js';
// Workflows (docs/kylon-gap-plan.md): a saved piece of work with a trigger
// and steps, and every run kept where anyone can read what it did.
//
// Triggers: by hand, on a schedule (the routines' calendar), a webhook
// someone outside calls, or a row added to or changed in a table. Steps:
// post in a room, ask an agent, add or change a row, wait for a person's
// approval, schedule a follow-up. Steps read what started them through
// {{placeholders}}: {{row.Company}}, {{input.text}}, {{steps.1.output}}.
//
// An approval is a decision card. The run stops there; the person's swipe
// is what carries it on (or ends it) — afterDecision in relay.js calls
// settleWorkflowApproval.

import { saveCard, getUserByLogin, isMember } from "../db.js";
import { postMessage } from "../channels.js";
import { nextRunAt, CADENCES, isTimeZone } from "../schedule.js";
import { appendCardEvent } from "../events.js";
import { announceCards } from "../announce.js";
import { localizeForRecipient } from "../localize.js";
import { notifyCard, anyChannelConfigured } from "../notify.js";
import { addRow, updateRow, getTable } from "./tables.js";
import { completer } from "./model.js";
import { prepareAgent, mayRunAgent } from "./agents.js";
import { scheduleFollowup } from "./followups.js";
import { withRoomGuidelines } from "./guidelines.js";

export const TRIGGERS = ["manual", "schedule", "webhook", "row"];
export const STEP_TYPES = ["post", "agent", "add_row", "update_row", "approval", "followup"];
export const MAX_STEPS = 12;
export const MAX_WORKFLOWS = 100;
/// A step that changes a row may start another workflow; a chain longer
/// than this is a loop, and stops.
export const MAX_DEPTH = 3;

const now = () => new Date().toISOString();
const newId = (p) => `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
const parse = (s, f) => { try { return JSON.parse(s); } catch { return f; } };
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

// ── Definitions ─────────────────────────────────────────────────────────

export function normalizeTrigger(raw) {
  const type = TRIGGERS.includes(raw?.type) ? raw.type : null;
  if (!type) return { error: `trigger.type must be one of ${TRIGGERS.join(", ")}` };
  if (type === "schedule") {
    if (!CADENCES.includes(raw.cadence)) return { error: `A schedule needs a cadence: ${CADENCES.join(", ")}` };
    const t = { type, cadence: raw.cadence, hour: Number.isInteger(raw.hour) ? raw.hour : 9, minute: Number.isInteger(raw.minute) ? raw.minute : 0, timezone: isTimeZone(raw.timezone) ? raw.timezone : "UTC" };
    if (raw.cadence === "weekly") t.weekday = Number.isInteger(raw.weekday) ? raw.weekday : 1;
    if (raw.cadence === "monthly") t.monthday = Number.isInteger(raw.monthday) ? raw.monthday : 1;
    return { trigger: t };
  }
  if (type === "row") {
    if (!raw.tableId) return { error: "A row trigger names its table." };
    const on = ["added", "changed", "any"].includes(raw.on) ? raw.on : "any";
    const t = { type, tableId: String(raw.tableId), on };
    if (raw.where && typeof raw.where === "object") t.where = raw.where;
    if (raw.column) t.column = String(raw.column);
    return { trigger: t };
  }
  return { trigger: { type } };
}

export function normalizeSteps(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "A workflow needs at least one step." };
  if (raw.length > MAX_STEPS) return { error: `A workflow has at most ${MAX_STEPS} steps.` };
  const steps = [];
  for (const s of raw) {
    if (!STEP_TYPES.includes(s?.type)) return { error: `Each step's type is one of ${STEP_TYPES.join(", ")}` };
    const text = (k, max = 4000) => String(s[k] ?? "").slice(0, max);
    switch (s.type) {
      case "post":
        if (!s.channel || !s.text) return { error: "A post step names a channel and its text." };
        steps.push({ type: "post", channel: text("channel", 200), text: text("text") });
        break;
      case "agent":
        if (!s.agentId || !s.prompt) return { error: "An agent step names the agent and what to ask it." };
        steps.push({ type: "agent", agentId: text("agentId", 64), prompt: text("prompt"), ...(s.channel ? { channel: text("channel", 200) } : {}) });
        break;
      case "add_row":
        if (!s.tableId) return { error: "An add_row step names its table." };
        steps.push({ type: "add_row", tableId: text("tableId", 64), values: s.values && typeof s.values === "object" ? s.values : {} });
        break;
      case "update_row":
        steps.push({ type: "update_row", values: s.values && typeof s.values === "object" ? s.values : {}, ...(s.tableId ? { tableId: text("tableId", 64) } : {}), ...(s.rowId ? { rowId: text("rowId", 64) } : {}) });
        break;
      case "approval":
        if (!s.to || !s.title) return { error: "An approval step names who approves and what." };
        steps.push({ type: "approval", to: text("to", 64).replace(/^@/, ""), title: text("title", 200), summary: text("summary", 1000) });
        break;
      case "followup": {
        const minutes = Number(s.minutes);
        if (!s.channel || !s.text || !Number.isFinite(minutes) || minutes < 1) return { error: "A follow-up step names a channel, its text, and minutes from now." };
        steps.push({ type: "followup", channel: text("channel", 200), text: text("text"), minutes: Math.min(minutes, 60 * 24 * 90), ...(s.agentId ? { agentId: text("agentId", 64) } : {}) });
        break;
      }
    }
  }
  return { steps };
}

const publicWorkflow = (r, { withSecret = false } = {}) => r && ({
  id: r.id, orgId: r.org_id, name: r.name, enabled: Boolean(r.enabled),
  trigger: parse(r.trigger, {}), steps: parse(r.steps, []),
  nextRunAt: r.next_run_at, lastRunAt: r.last_run_at,
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  ...(withSecret && r.hook_secret ? { hookSecret: r.hook_secret } : {}),
});

const publicRun = (r) => r && ({
  id: r.id, workflowId: r.workflow_id, trigger: r.trigger, status: r.status,
  input: parse(r.input, null), log: parse(r.log, []), nextStep: r.next_step, cardId: r.card_id,
  startedBy: r.started_by, startedAt: r.started_at, finishedAt: r.finished_at,
});

/// Who an approval goes to: a login is global, so it names someone only
/// while they belong to this workspace. Anyone else would be sent its title
/// and summary, and the run would wait on a decision they cannot reach.
async function approverIn(db, orgId, login) {
  const user = await getUserByLogin(db, login);
  return user && (await isMember(db, orgId, user.github_id)) ? user : null;
}

/// An approval written to a fixed login is checked when it is saved; one
/// written as a {{placeholder}} can only be checked when it runs.
async function unknownApprover(db, orgId, steps) {
  for (const step of steps) {
    if (step.type !== "approval" || step.to.includes("{{")) continue;
    if (!(await approverIn(db, orgId, step.to))) return { error: `Nobody by that name here: @${step.to}` };
  }
  return null;
}

export async function mayViewWorkflow(db, orgId, workflow, viewerId) {
  if (!workflow) return false;
  if (workflow.trigger?.tableId && !(await mayUseTable(db, orgId, workflow.trigger.tableId, viewerId))) return false;
  for (const step of workflow.steps || []) {
    if (step.tableId && !(await mayUseTable(db, orgId, step.tableId, viewerId))) return false;
    if (step.channel && !(await mayUseConversation(db, orgId, viewerId, step.channel))) return false;
    if (step.agentId) {
      const agent = await db.prepare("SELECT * FROM custom_agents WHERE org_id = ?1 AND id = ?2 AND deleted_at IS NULL").bind(orgId, step.agentId).first();
      if (!agent || !(await mayRunAgent(db, orgId, agent, viewerId))) return false;
    }
  }
  return true;
}

export async function getWorkflow(db, orgId, id, opts = {}) {
  const wf = publicWorkflow(await db.prepare("SELECT * FROM hx_workflows WHERE id = ?1 AND org_id = ?2").bind(id, orgId).first(), opts);
  return opts.viewerId && !(await mayViewWorkflow(db, orgId, wf, opts.viewerId)) ? null : wf;
}

export async function listWorkflows(db, orgId, { viewerId } = {}) {
  const { results } = await db.prepare("SELECT * FROM hx_workflows WHERE org_id = ?1 ORDER BY created_at ASC").bind(orgId).all();
  const visible = [];
  for (const row of results || []) {
    const wf = publicWorkflow(row);
    if (!viewerId || await mayViewWorkflow(db, orgId, wf, viewerId)) visible.push(wf);
  }
  return visible;
}

export async function createWorkflow(db, orgId, input, by) {
  const name = String(input?.name || "").trim().slice(0, 80);
  if (!name) return { error: "Give the workflow a name." };
  const t = normalizeTrigger(input?.trigger);
  if (t.error) return t;
  const s = normalizeSteps(input?.steps);
  if (s.error) return s;
  const nobody = await unknownApprover(db, orgId, s.steps);
  if (nobody) return nobody;
  if (t.trigger.type === "row" && !(await getTable(db, orgId, t.trigger.tableId))) return { error: "No such table." };
  const n = await db.prepare("SELECT COUNT(*) AS n FROM hx_workflows WHERE org_id = ?1").bind(orgId).first();
  if (Number(n?.n || 0) >= MAX_WORKFLOWS) return { error: "This workspace has as many workflows as it can hold." };
  const id = newId("wf");
  const at = now();
  const secret = t.trigger.type === "webhook" ? hex(crypto.getRandomValues(new Uint8Array(24))) : null;
  const next = t.trigger.type === "schedule" && input?.enabled !== false ? nextRunAt(t.trigger) : null;
  await db
    .prepare(`INSERT INTO hx_workflows (id, org_id, name, enabled, trigger, steps, hook_secret, next_run_at, created_by, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`)
    .bind(id, orgId, name, input?.enabled === false ? 0 : 1, JSON.stringify(t.trigger), JSON.stringify(s.steps), secret, next, String(by), at)
    .run();
  return { workflow: await getWorkflow(db, orgId, id, { withSecret: true }) };
}

export async function updateWorkflow(db, orgId, id, input) {
  const wf = await getWorkflow(db, orgId, id);
  if (!wf) return { error: "No such workflow.", status: 404 };
  const name = input.name !== undefined ? String(input.name).trim().slice(0, 80) || wf.name : wf.name;
  let trigger = wf.trigger;
  if (input.trigger !== undefined) {
    const t = normalizeTrigger(input.trigger);
    if (t.error) return t;
    trigger = t.trigger;
  }
  let steps = wf.steps;
  if (input.steps !== undefined) {
    const s = normalizeSteps(input.steps);
    if (s.error) return s;
    const nobody = await unknownApprover(db, orgId, s.steps);
    if (nobody) return nobody;
    steps = s.steps;
  }
  const enabled = input.enabled !== undefined ? Boolean(input.enabled) : wf.enabled;
  const next = trigger.type === "schedule" && enabled ? nextRunAt(trigger) : null;
  await db
    .prepare("UPDATE hx_workflows SET name = ?1, enabled = ?2, trigger = ?3, steps = ?4, next_run_at = ?5, updated_at = ?6 WHERE id = ?7 AND org_id = ?8")
    .bind(name, enabled ? 1 : 0, JSON.stringify(trigger), JSON.stringify(steps), next, now(), id, orgId)
    .run();
  if (trigger.type === "webhook") {
    await db.prepare("UPDATE hx_workflows SET hook_secret = COALESCE(hook_secret, ?1) WHERE id = ?2 AND org_id = ?3").bind(hex(crypto.getRandomValues(new Uint8Array(24))), id, orgId).run();
  }
  return { workflow: await getWorkflow(db, orgId, id, { withSecret: true }) };
}

export async function deleteWorkflow(db, orgId, id) {
  await db.batch([
    db.prepare("DELETE FROM hx_workflow_runs WHERE workflow_id = ?1 AND org_id = ?2").bind(id, orgId),
    db.prepare("DELETE FROM hx_workflows WHERE id = ?1 AND org_id = ?2").bind(id, orgId),
  ]);
  return { deleted: true };
}

export async function listRuns(db, orgId, workflowId, limit = 50, viewerId) {
  const { results } = await db
    .prepare("SELECT * FROM hx_workflow_runs WHERE org_id = ?1 AND workflow_id = ?2 ORDER BY started_at DESC LIMIT ?3")
    .bind(orgId, workflowId, Math.min(Number(limit) || 50, 200))
    .all();
  const visible = [];
  for (const row of results || []) {
    const run = viewerId ? await getRun(db, orgId, row.id, { viewerId }) : publicRun(row);
    if (run) visible.push(run);
  }
  return visible;
}

export async function getRun(db, orgId, runId, { viewerId } = {}) {
  const run = publicRun(await db.prepare("SELECT * FROM hx_workflow_runs WHERE id = ?1 AND org_id = ?2").bind(runId, orgId).first());
  if (run && viewerId) {
    const frozen = await db.prepare("SELECT definition FROM hx_workflow_run_definitions WHERE run_id = ?1 AND org_id = ?2").bind(runId, orgId).first();
    const definition = frozen ? JSON.parse(frozen.definition) : await getWorkflow(db, orgId, run.workflowId);
    if (!(await mayViewWorkflow(db, orgId, definition, viewerId))) return null;
    if (run.input?.tableId && !(await mayUseTable(db, orgId, run.input.tableId, viewerId))) return null;
  }
  return run;
}

// ── Running ─────────────────────────────────────────────────────────────

/// "{{row.Company}} owes {{row.Amount}}" against what the run knows. A
/// name that is not there reads as nothing, never as the braces.
export function render(template, scope) {
  return String(template ?? "").replace(/\{\{\s*([\p{L}\p{N}_.# -]+?)\s*\}\}/gu, (_, path) => {
    const parts = path.split(".");
    let v = scope;
    for (const p of parts) {
      if (v == null) break;
      if (typeof v === "object" && p in v) { v = v[p]; continue; }
      // A row is keyed by column id; let people write the column's name.
      const key = typeof v === "object" ? Object.keys(v).find((k) => k.toLowerCase() === p.toLowerCase() || k === p.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_")) : null;
      v = key ? v[key] : undefined;
    }
    return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

const renderValues = (values, scope) => Object.fromEntries(Object.entries(values || {}).map(([k, v]) => [k, typeof v === "string" ? render(v, scope) : v]));

/// What a row looks like to a template: its values by column id and by
/// column name, so {{row.company}} and {{row.Company}} both work.
async function rowScope(db, orgId, tableId, row) {
  if (!row) return null;
  const table = await getTable(db, orgId, tableId);
  const out = { id: row.id, ...row.values };
  for (const c of table?.columns || []) out[c.name] = row.values[c.id];
  return out;
}

/// Start a run. `input` is what started it: { text } by hand, the posted
/// JSON for a webhook, { row, before } for a row.
export async function startRun(env, { orgId, workflow, trigger, input = null, startedBy = null, depth = 0 }) {
  const id = newId("run");
  // Store the definition and the run atomically. An approval always resumes
  // the same steps that were presented when the run started.
  const definition = { id: workflow.id, name: workflow.name, steps: workflow.steps, trigger: workflow.trigger, createdBy: workflow.createdBy };
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO hx_workflow_runs (id, org_id, workflow_id, trigger, status, input, log, next_step, started_by, started_at)
      VALUES (?1, ?2, ?3, ?4, 'running', ?5, '[]', 0, ?6, ?7)`)
      .bind(id, orgId, workflow.id, trigger, input ? JSON.stringify(input).slice(0, 20000) : null, startedBy ? String(startedBy) : null, now()),
    env.DB.prepare("INSERT INTO hx_workflow_run_definitions (run_id, org_id, definition, created_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(id, orgId, JSON.stringify(definition), now()),
  ]);
  await env.DB.prepare("UPDATE hx_workflows SET last_run_at = ?1 WHERE id = ?2 AND org_id = ?3").bind(now(), workflow.id, orgId).run();
  return continueRun(env, { orgId, runId: id, workflow, depth });
}

/// Run steps from where the run stands until it finishes, fails, or waits.
export async function continueRun(env, { orgId, runId, workflow, depth = 0 }) {
  const db = env.DB;
  const run = await getRun(db, orgId, runId);
  if (!run) return null;
  const frozen = await db.prepare("SELECT definition FROM hx_workflow_run_definitions WHERE run_id = ?1 AND org_id = ?2").bind(runId, orgId).first();
  // Runs created before this table existed retain their previous behavior.
  workflow = frozen ? JSON.parse(frozen.definition) : (workflow || await getWorkflow(db, orgId, run.workflowId));
  if (!workflow) return null;
  const sourceTable = workflow.trigger?.tableId || run.input?.tableId;
  if (sourceTable && !(await mayUseTable(db, orgId, sourceTable, workflow.createdBy))) {
    await db.prepare("UPDATE hx_workflow_runs SET status = 'failed', finished_at = ?1 WHERE id = ?2 AND org_id = ?3").bind(now(), runId, orgId).run();
    return getRun(db, orgId, runId);
  }
  const log = run.log;
  const scope = { input: run.input || {}, steps: {}, workflow: { name: workflow.name } };
  if (run.input?.row) scope.row = run.input.row;
  if (run.input?.before) scope.before = run.input.before;
  log.forEach((entry, i) => { scope.steps[i + 1] = entry; });
  let status = "done";
  let cardId = null;
  let index = run.nextStep;
  for (; index < workflow.steps.length; index += 1) {
    const step = workflow.steps[index];
    let entry;
    try {
      entry = await runStep(env, { orgId, workflow, step, number: index + 1, scope, runId, depth, owner: workflow.createdBy });
    } catch (e) {
      entry = { status: "failed", error: String(e?.message || e).slice(0, 300) };
    }
    entry = { step: index + 1, type: step.type, at: now(), ...entry };
    log[index] = entry;
    scope.steps[index + 1] = entry;
    if (entry.status === "failed") { status = "failed"; index += 1; break; }
    if (entry.status === "waiting") { status = "waiting"; cardId = entry.cardId; index += 1; break; }
  }
  await db
    .prepare("UPDATE hx_workflow_runs SET status = ?1, log = ?2, next_step = ?3, card_id = COALESCE(?4, card_id), finished_at = ?5 WHERE id = ?6 AND org_id = ?7")
    .bind(status, JSON.stringify(log), index, cardId, status === "waiting" ? null : now(), runId, orgId)
    .run();
  return getRun(db, orgId, runId);
}

async function say(env, orgId, channel, body, { authorLogin = null, kind = "ai", parentId = null } = {}) {
  const out = await postMessage(env.DB, { orgId, key: channel, authorLogin, body: String(body).slice(0, 8000), kind, parentId });
  if (out?.row) {
    const { broadcastStored } = await import("../channelRoutes.js");
    await broadcastStored(env, orgId, channel, out.row).catch(() => {});
  }
  return out?.row || null;
}

async function runStep(env, { orgId, workflow, step, number, scope, runId, depth, owner }) {
  const db = env.DB;
  if (step.channel && !(await mayUseConversation(db, orgId, owner, step.channel))) {
    return { status: "failed", error: "Conversation access required." };
  }
  switch (step.type) {
    case "post": {
      const row = await say(env, orgId, step.channel, render(step.text, scope));
      return row ? { status: "ok", output: render(step.text, scope), messageId: row.id } : { status: "failed", error: "Could not post there." };
    }
    case "agent": {
      const agentRow = await db.prepare("SELECT * FROM custom_agents WHERE org_id = ?1 AND id = ?2 AND deleted_at IS NULL").bind(orgId, step.agentId).first();
      if (!agentRow) return { status: "failed", error: "That agent is gone." };
      if (!(await mayRunAgent(db, orgId, agentRow, owner))) return { status: "failed", error: "Agent access required." };
      const complete = await completer(env, orgId, owner, "workflow_agent", { json: false, maxTokens: 1200 });
      if (!complete) return { status: "failed", error: "No AI model, or none left today." };
      const prepared = await prepareAgent(env, orgId, { id: agentRow.id, name: agentRow.name, handle: agentRow.handle, instructions: agentRow.instructions }, null, { channel: step.channel || "" });
      const agent = await withRoomGuidelines(db, orgId, step.channel, prepared.agent);
      const answer = await complete(
        `You are ${agent.name} (@${agent.handle}), doing one step of the workflow "${workflow.name}". Do what the step asks and answer with the result only.\n\n<agent_instructions>\n${String(agent.instructions).slice(0, 12000)}\n</agent_instructions>`,
        `${render(step.prompt, scope)}\n\n<context>\n${JSON.stringify({ input: scope.input, row: scope.row || null }).slice(0, 6000)}\n</context>`,
      );
      if (!answer) return { status: "failed", error: "The agent gave no answer." };
      if (step.channel) await say(env, orgId, step.channel, answer, { authorLogin: `agent:${agentRow.id}`, kind: "agent" });
      return { status: "ok", output: String(answer).slice(0, 4000) };
    }
    case "add_row": {
      if (!(await mayUseTable(db, orgId, step.tableId, owner))) return { status: "failed", error: "Table access required." };
      const r = await addRow(db, orgId, step.tableId, renderValues(step.values, scope), `workflow:${workflow.id}`);
      if (r.error) return { status: "failed", error: r.error };
      await onRowChange(env, { orgId, table: r.table, before: null, row: r.row, by: `workflow:${workflow.id}`, depth: depth + 1 });
      return { status: "ok", output: r.row.id, rowId: r.row.id };
    }
    case "update_row": {
      const tableId = step.tableId || scope.input?.tableId;
      const rowId = step.rowId ? render(step.rowId, scope) : scope.row?.id;
      if (tableId && !(await mayUseTable(db, orgId, tableId, owner))) return { status: "failed", error: "Table access required." };
      if (!tableId || !rowId) return { status: "failed", error: "No row to change." };
      const r = await updateRow(db, orgId, tableId, rowId, renderValues(step.values, scope), `workflow:${workflow.id}`);
      if (r.error) return { status: "failed", error: r.error };
      await onRowChange(env, { orgId, table: r.table, before: r.before, row: r.row, by: `workflow:${workflow.id}`, depth: depth + 1 });
      return { status: "ok", output: rowId, rowId };
    }
    case "approval": {
      // Checked again here: a placeholder names someone only now, and a
      // fixed login may have left the workspace since the workflow was saved.
      const to = await approverIn(db, orgId, render(step.to, scope));
      if (!to) return { status: "failed", error: "Nobody by that name here." };
      // One card for each approval in the run, so a decision on an earlier
      // one can never be taken as the answer to a later one, and the earlier
      // card is kept as it was decided.
      const card = {
        id: `wf-${runId}-${number}`,
        recipientUserID: to.login,
        senderUserID: to.login,
        type: "approval",
        title: render(step.title, scope).slice(0, 120),
        summary: render(step.summary || "", scope).slice(0, 600),
        context: `Workflow: ${workflow.name}`,
        priority: "medium",
        status: "pending",
        createdAt: now(),
        sourceApp: "Workflow",
        sourceDetail: workflow.name,
        requestedBy: { login: to.login, name: workflow.name },
        workflowApproval: { runId, workflowId: workflow.id, step: number },
      };
      await saveCard(db, orgId, card);
      await appendCardEvent(db, orgId, { cardId: card.id, type: "created", actorUserId: to.login, note: "workflow", snapshot: card }).catch(() => {});
      const shown = await localizeForRecipient(env, orgId, card).catch(() => card);
      await announceCards(env, orgId, [shown]).catch(() => {});
      if (anyChannelConfigured(env)) await notifyCard(env, { card: shown, kind: "created", excludeLogin: null, orgId }).catch(() => {});
      return { status: "waiting", cardId: card.id, output: `Waiting for ${to.name || to.login}` };
    }
    case "followup": {
      // Scheduled as the workflow's maker, the person whose access it acts
      // with: the follow-up checks that access now and again when it is due,
      // and that person pays for its answer. The run's log is what says a
      // workflow made it.
      const r = await scheduleFollowup(db, {
        orgId, channel: step.channel, agentId: step.agentId || null, instruction: render(step.text, scope),
        dueAt: new Date(Date.now() + step.minutes * 60000).toISOString(), by: owner,
      });
      return r.error ? { status: "failed", error: r.error } : { status: "ok", output: r.followup.id };
    }
    default:
      return { status: "failed", error: "Unknown step." };
  }
}

/// A workflow's approval card, decided: approve carries the run on,
/// decline ends it. Once only, only by the person it was made to, and only
/// for the approval the run waits on now: an answer to an earlier one in the
/// same run settles nothing.
export async function settleWorkflowApproval(env, orgId, card) {
  const ref = card?.workflowApproval;
  if (!ref?.runId) return null;
  const action = card.decision?.action;
  const run = await getRun(env.DB, orgId, ref.runId);
  if (!run || run.status !== "waiting" || run.cardId !== card.id) return null;
  if (ref.step !== undefined && ref.step !== run.nextStep) return null;
  if (card.decision?.actorUserID && card.decision.actorUserID !== card.recipientUserID) return null;
  const approved = action === "approve" || action === "choose";
  if (!approved && action !== "decline") return null;
  const claimed = await env.DB
    .prepare("UPDATE hx_workflow_runs SET status = 'running' WHERE id = ?1 AND org_id = ?2 AND status = 'waiting' AND card_id = ?3")
    .bind(run.id, orgId, card.id)
    .run();
  if (!claimed.meta?.changes) return null;
  const log = run.log;
  const last = log.length - 1;
  if (last >= 0) log[last] = { ...log[last], status: approved ? "ok" : "declined", output: `${approved ? "Approved" : "Declined"} by ${(await getUserByLogin(env.DB, card.recipientUserID).catch(() => null))?.name || card.recipientUserID}${card.decision?.note ? `: ${card.decision.note}` : ""}` };
  if (!approved) {
    await env.DB.prepare("UPDATE hx_workflow_runs SET status = 'declined', log = ?1, finished_at = ?2 WHERE id = ?3 AND org_id = ?4").bind(JSON.stringify(log), now(), run.id, orgId).run();
    return getRun(env.DB, orgId, run.id);
  }
  await env.DB.prepare("UPDATE hx_workflow_runs SET log = ?1 WHERE id = ?2 AND org_id = ?3").bind(JSON.stringify(log), run.id, orgId).run();
  return continueRun(env, { orgId, runId: run.id });
}

// ── Triggers ────────────────────────────────────────────────────────────

const whereHolds = (where, values, columns) => {
  if (!where) return true;
  return Object.entries(where).every(([k, allowed]) => {
    const col = columns.find((c) => c.id === k || c.name.toLowerCase() === String(k).toLowerCase());
    const v = col ? values[col.id] : values[k];
    return (Array.isArray(allowed) ? allowed : [allowed]).map(String).includes(String(v ?? ""));
  });
};

/// A row added or changed: every enabled workflow watching that table runs,
/// when the change is the kind it watches and the row now matches. A
/// change that leaves the watched column as it was starts nothing.
export async function onRowChange(env, { orgId, table, before, row, by, depth = 0 }) {
  if (depth >= MAX_DEPTH) return 0;
  const { results } = await env.DB
    .prepare("SELECT * FROM hx_workflows WHERE org_id = ?1 AND enabled = 1 AND json_extract(trigger, '$.type') = 'row' AND json_extract(trigger, '$.tableId') = ?2")
    .bind(orgId, table.id)
    .all()
    .catch(() => ({ results: [] }));
  let started = 0;
  for (const r of results || []) {
    const wf = publicWorkflow(r);
    const t = wf.trigger;
    if (!(await mayUseTable(env.DB, orgId, table.id, wf.createdBy))) continue;
    // A workflow's own change does not start the same workflow again.
    if (by === `workflow:${wf.id}`) continue;
    if (t.on === "added" && before) continue;
    if (t.on === "changed" && !before) continue;
    if (!whereHolds(t.where, row.values, table.columns)) continue;
    if (before && t.column) {
      const col = table.columns.find((c) => c.id === t.column || c.name.toLowerCase() === t.column.toLowerCase());
      if (col && before.values[col.id] === row.values[col.id]) continue;
    }
    // When the change already matched before, it is not news.
    if (before && t.where && whereHolds(t.where, before.values, table.columns) && !t.column) continue;
    await startRun(env, {
      orgId, workflow: wf, trigger: "row", startedBy: by, depth,
      input: { tableId: table.id, row: await rowScope(env.DB, orgId, table.id, row), before: before ? await rowScope(env.DB, orgId, table.id, before) : null },
    });
    started += 1;
  }
  return started;
}

/// The cron's part: scheduled workflows whose time has come.
export async function runDueWorkflows(env, { now: at = new Date(), limit = 25 } = {}) {
  const { results } = await env.DB
    // Every workspace's, by design: the cron's sweep. Each run then acts
    // only in its workflow's own org_id.
    .prepare("SELECT * FROM hx_workflows WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?1 ORDER BY next_run_at LIMIT ?2")
    .bind(at.toISOString(), limit)
    .all()
    .catch(() => ({ results: [] }));
  let ran = 0;
  for (const r of results || []) {
    const wf = publicWorkflow(r);
    // Claimed by moving its next time on, so two crons cannot both run it.
    const claim = await env.DB
      .prepare("UPDATE hx_workflows SET next_run_at = ?1 WHERE id = ?2 AND org_id = ?4 AND next_run_at = ?3")
      .bind(nextRunAt(wf.trigger, at), wf.id, r.next_run_at, wf.orgId)
      .run();
    if (!claim.meta?.changes) continue;
    try {
      await startRun(env, { orgId: wf.orgId, workflow: wf, trigger: "schedule" });
      ran += 1;
    } catch (e) {
      console.error("workflow run failed", e?.message);
    }
  }
  return ran;
}

/// A webhook call: the workflow named by id, its secret in the URL or the
/// x-hook-secret header. The posted JSON is the run's input.
export async function handleWorkflowHook(request, env, url) {
  const m = url.pathname.match(/^\/hooks\/workflows\/([A-Za-z0-9_]+)$/);
  if (!m || request.method !== "POST") return null;
  // By id alone, by design: the caller is outside every workspace, and the
  // secret checked below is what lets it in.
  const row = await env.DB.prepare("SELECT * FROM hx_workflows WHERE id = ?1").bind(m[1]).first();
  const secret = request.headers.get("x-hook-secret") || url.searchParams.get("secret") || "";
  const wf = row && publicWorkflow(row, { withSecret: true });
  const reply = (body, status) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (!wf || wf.trigger.type !== "webhook" || !wf.hookSecret || !timingSafeEqual(secret, wf.hookSecret)) return reply({ message: "No such hook." }, 404);
  if (!wf.enabled) return reply({ message: "This workflow is off." }, 409);
  const text = await request.text();
  if (text.length > 64000) return reply({ message: "Too large." }, 413);
  const input = parse(text, { text });
  const run = await startRun(env, { orgId: wf.orgId, workflow: wf, trigger: "webhook", input: input && typeof input === "object" ? input : { text } });
  return reply({ runId: run?.id, status: run?.status }, 202);
}

function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}
