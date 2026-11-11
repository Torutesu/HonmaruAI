import {FILE_WRITE_TOOLS,callFileWriteTool} from './fileWriteTools.js';
import {FILE_READ_TOOLS,callFileReadTool} from './fileTools.js';
import { EXECUTION_TOOLS, callExecutionTool } from './executionTools.js';
import { mayUseApp, mayUseTable, mayEditTable, mayReadAppRows, visibleResources, visibleAppLinks } from './resourceAccess.js';
// The harness over MCP (docs/kylon-gap-plan.md): what Kylon's Tools API and
// workspace CLI give an outside agent — the workspace's apps, tables,
// workflows and follow-ups — offered only by a workspace in harness mode.
// A key needs "write" for anything that changes a row or starts a run.

import { listApps, renderApp } from "./apps.js";
import { listTables, listRows, addRow, updateRow } from "./tables.js";
import { listWorkflows, getWorkflow, startRun, listRuns, getRun, cancelWorkflowRun, recoverStalledRun, replayWorkflowEvents, changeWorkflowHook } from "./workflows.js";
import { heldWorkflowSummary, readHeldWorkflowEvent, discardWorkflowEvents } from "./workflowHeld.js";
import { workflowRevisions, restoreWorkflowRevision } from "./workflowRevisions.js";
import { readWorkflowSafety, resumeWorkflowSafety } from "./workflowSafety.js";
import { allowed } from "../permissions.js";
import { listFollowups, scheduleFollowup } from "./followups.js";
import { drainWorkflowRowEvents } from "./workflowRowEventDispatch.js";
import { callRemoteMcpTool, remoteMcpTools } from "./remoteMcp.js";

export const HARNESS_TOOL_SCOPE = { create_file_text: "write", create_file_upload: "write", update_file_text: "write", delete_file: "write", restore_file_version: "write", run_app_action: "execute", run_javascript: "execute", cancel_execution: "execute", add_row: "write", update_row: "write", run_workflow: "write", cancel_workflow_run: "write", recover_stalled_workflow_run: "write", restore_workflow_revision: "write", resume_workflow_safety: "write", discard_held_workflow_events: "write", replay_held_workflow_events: "write", rotate_workflow_webhook: "write", revoke_workflow_webhook: "write", schedule_followup: "write" };

export const HARNESS_TOOLS = [
  ...EXECUTION_TOOLS,
  ...FILE_READ_TOOLS,
  ...FILE_WRITE_TOOLS,
  {
    name: "list_apps",
    title: "The workspace's apps",
    description: "Internal apps the team built (CRM, hiring board, invoice tracker…): name, what it is for, its table id and the rooms it is linked to.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_app",
    title: "Read an app",
    description: "An app with rows and computed views. Each row has a system id and recordId and flat column IDs; colliding id, recordId or values columns are under values. If nextOffset is present, continue with query_rows using app.tableId and nextOffset.",
    inputSchema: { type: "object", properties: { appId: { type: "string" } }, required: ["appId"] },
  },
  {
    name: "list_tables",
    title: "The workspace's tables",
    description: "Every table and its columns (id, name, type, select options). Use a column's id or name in add_row and update_row.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "query_rows",
    title: "Find rows",
    description: "Rows of a table, narrowed by text (q), exact column values (where), and sort. Each row has a system id and recordId and flat column IDs; colliding id, recordId or values columns are under values. Follow nextOffset to continue. For a single oversized row, select fewer column IDs with fields.",
    inputSchema: {
      type: "object",
      properties: { tableId: { type: "string" }, q: { type: "string" }, where: { type: "object" }, sort: { type: "string" }, fields: { type: "array", items: { type: "string" }, description: "Optional column IDs to return." }, limit: { type: "integer", minimum: 1, maximum: 500 }, offset: { type: "integer", minimum: 0, maximum: 5000 } },
      required: ["tableId"],
    },
  },
  {
    name: "add_row",
    title: "Add a row",
    description: "Add a row to a table. values is {column name or id: value}; values are converted to the column's type. The result includes the system id, recordId and values. Workflows watching the table run.",
    inputSchema: { type: "object", properties: { tableId: { type: "string" }, values: { type: "object" } }, required: ["tableId", "values"] },
  },
  {
    name: "update_row",
    title: "Change a row",
    description: "Change some values of a row; the rest stay. rowId is the system id or recordId returned by a row tool, not a user column value. Workflows watching the table run.",
    inputSchema: { type: "object", properties: { tableId: { type: "string" }, rowId: { type: "string" }, expectedUpdatedAt: { type: "string", description: "Token from rowVersions[rowId] in query_rows or read_app; rejects stale edits." }, values: { type: "object" } }, required: ["tableId", "rowId", "values"] },
  },
  {
    name: "list_workflows",
    title: "The workspace's workflows",
    description: "Workflows: their trigger, steps, and whether they are on.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_workflow",
    title: "Inspect a workflow",
    description: "Read a workflow definition and safety status. Only its maker or an Admin receives the active webhook secret in a separate field.",
    inputSchema: { type: "object", properties: { workflowId: { type: "string" } }, required: ["workflowId"] },
  },
  {
    name: "list_workflow_revisions",
    title: "Workflow version history",
    description: "List prior workflow definitions that remain visible under current resource permissions. Use the returned revision number to restore one.",
    inputSchema: { type: "object", properties: { workflowId: { type: "string" }, before: { type: "integer", minimum: 1 } }, required: ["workflowId"] },
  },
  {
    name: "restore_workflow_revision",
    title: "Restore a workflow version",
    description: "Restore one visible prior definition using the exact updatedAt from get_workflow. If automatic triggers were safety-paused, confirm their restoration separately; the safety pause still requires a separate resume.",
    inputSchema: { type: "object", properties: { workflowId: { type: "string" }, revision: { type: "integer", minimum: 1 }, expectedUpdatedAt: { type: "string" }, confirmAutoPaused: { type: "boolean" } }, required: ["workflowId", "revision", "expectedUpdatedAt"] },
  },
  {
    name: "resume_workflow_safety",
    title: "Resume a safety-paused workflow",
    description: "Resume only after reloading the workflow and passing its exact safety generation. Workflows paused for exhausted or unpriced budgets cannot be manually resumed.",
    inputSchema: { type: "object", properties: { workflowId: { type: "string" }, generation: { type: "string" } }, required: ["workflowId", "generation"] },
  },
  {
    name: "recover_stalled_workflow_run",
    title: "Reconcile a stalled workflow run",
    description: "Mark a stale running step as interrupted with an unknown outcome. It is never replayed. Confirm no replay and pass the exact startedAt from a freshly loaded run.",
    inputSchema: { type: "object", properties: { workflowId: { type: "string" }, runId: { type: "string" }, expectedStartedAt: { type: "string" }, confirmNoReplay: { type: "boolean" } }, required: ["workflowId", "runId", "expectedStartedAt", "confirmNoReplay"] },
  },
  {
    name: "list_workflow_runs",
    title: "Workflow run history",
    description: "Read recent runs visible to you. Run input and output follow the same App, Table, Agent, Room, and source ACLs as the workflow.",
    inputSchema: { type: "object", properties: { workflowId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 } }, required: ["workflowId"] },
  },
  {
    name: "get_workflow_run",
    title: "Inspect a workflow run",
    description: "Read one run visible to you, including its steps and usage estimate.",
    inputSchema: { type: "object", properties: { workflowId: { type: "string" }, runId: { type: "string" } }, required: ["workflowId", "runId"] },
  },
  {
    name: "cancel_workflow_run",
    title: "Stop a workflow run",
    description: "Stop later steps of a currently running workflow. The current step may already have caused an external effect. Reload and pass its exact startedAt value.",
    inputSchema: { type: "object", properties: { workflowId: { type: "string" }, runId: { type: "string" }, expectedStartedAt: { type: "string" } }, required: ["workflowId", "runId", "expectedStartedAt"] },
  },
  {
    name: "list_held_workflow_events",
    title: "Review held webhook events",
    description: "List event IDs and expiry times held while a webhook workflow is paused or disabled. Payloads are not included.",
    inputSchema: { type: "object", properties: { workflowId: { type: "string" }, offset: { type: "integer", minimum: 0, maximum: 975 } }, required: ["workflowId"] },
  },
  {
    name: "get_held_workflow_event",
    title: "Inspect a held webhook event",
    description: "Read one explicitly selected held webhook payload. Maker or Admin access is required.",
    inputSchema: { type: "object", properties: { workflowId: { type: "string" }, eventId: { type: "string" } }, required: ["workflowId", "eventId"] },
  },
  {
    name: "discard_held_workflow_events",
    title: "Discard held webhook events",
    description: "Permanently discard explicitly selected held events. Maker or Admin access is required.",
    inputSchema: { type: "object", properties: { workflowId: { type: "string" }, eventIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 1000 } }, required: ["workflowId", "eventIds"] },
  },
  {
    name: "replay_held_workflow_events",
    title: "Replay held webhook events",
    description: "Start new runs for explicitly selected held events. Replay is never automatic. Maker or Admin access is required.",
    inputSchema: { type: "object", properties: { workflowId: { type: "string" }, eventIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 } }, required: ["workflowId", "eventIds"] },
  },
  {
    name: "rotate_workflow_webhook",
    title: "Rotate a workflow webhook secret",
    description: "Replace the current webhook credential. Pass the exact secret and updatedAt from an authorized get_workflow response; the newly created secret is returned once.",
    inputSchema: { type: "object", properties: { workflowId: { type: "string" }, expectedSecret: { type: ["string", "null"] }, expectedUpdatedAt: { type: "string" } }, required: ["workflowId", "expectedSecret", "expectedUpdatedAt"] },
  },
  {
    name: "revoke_workflow_webhook",
    title: "Revoke a workflow webhook secret",
    description: "Revoke the current webhook credential. Pass the exact secret and updatedAt from an authorized get_workflow response. Maker or Admin access is required.",
    inputSchema: { type: "object", properties: { workflowId: { type: "string" }, expectedSecret: { type: ["string", "null"] }, expectedUpdatedAt: { type: "string" } }, required: ["workflowId", "expectedSecret", "expectedUpdatedAt"] },
  },
  {
    name: "run_workflow",
    title: "Run a workflow",
    description: "Start a workflow now with some input text. Returns the run: each step's outcome, or where it waits for a person's approval.",
    inputSchema: { type: "object", properties: { workflowId: { type: "string" }, text: { type: "string" } }, required: ["workflowId"] },
  },
  {
    name: "schedule_followup",
    title: "Follow up later",
    description: "Come back to a room at a set time: in `minutes`, the instruction is done and posted there. channel is a room key like b:ops.",
    inputSchema: { type: "object", properties: { channel: { type: "string" }, instruction: { type: "string" }, minutes: { type: "number" } }, required: ["channel", "instruction", "minutes"] },
  },
  {
    name: "list_followups",
    title: "Scheduled follow-ups",
    description: "Follow-ups still to come, optionally in one room.",
    inputSchema: { type: "object", properties: { channel: { type: "string" } } },
  },
];

const out = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value });
const err = (message) => ({ content: [{ type: "text", text: message }], isError: true });
// Keep the legacy flat columns and reserve identity/values keys. Only the
// colliding fields need a nested copy, avoiding a second copy of every row.
const presentRow = row => {
  const flat = { ...row.values }, reserved = {};
  for (const key of ['id', 'recordId', 'values']) if (Object.hasOwn(flat, key)) { reserved[key] = flat[key]; delete flat[key]; }
  return { ...flat, id: row.id, recordId: row.id, ...(Object.keys(reserved).length ? { values: reserved } : {}) };
};
// ACP serializes both content and structuredContent and limits the whole
// result to 200 KB. Return complete rows only, with a usable continuation.
const PAGE_BYTES = 190000;
function pageResult(base, rows, offset, total) {
  const make = count => out({ ...base, total, nextOffset: offset + count < total ? offset + count : null,
    rowVersions: Object.fromEntries(rows.slice(0, count).map(x => [x.id, x.updatedAt])), rows: rows.slice(0, count).map(presentRow) });
  const fits = result => new TextEncoder().encode(JSON.stringify(result)).length <= PAGE_BYTES;
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(make(mid))) lo = mid; else hi = mid - 1; }
  const result = make(lo);
  if (!fits(result) || (rows.length && !lo)) return err('This result is too large. Use query_rows with fewer selected fields to read an oversized row.');
  return result;
}

export async function callHarnessTool(env, agent, name, args) {
  if (name.startsWith("mcp_")) {
    const remoteTool = (await remoteMcpTools(env.DB, agent.orgId).catch(() => [])).find((tool) => tool.name === name);
    if (remoteTool) return callRemoteMcpTool(env, agent, remoteTool, args);
  }
  if (EXECUTION_TOOLS.some(t => t.name === name)) return callExecutionTool(env, agent, name, args);
  if (FILE_WRITE_TOOLS.some(t => t.name === name)) return callFileWriteTool(env, agent, name, args);
  if (FILE_READ_TOOLS.some(t => t.name === name)) return callFileReadTool(env, agent, name, args);
  const db = env.DB;
  const orgId = agent.orgId;
  const by = agent.githubId;
  switch (name) {
    case "list_apps":
      return out({ apps: (await visibleAppLinks(db, orgId, await visibleResources(await listApps(db, orgId), a => mayUseApp(db, orgId, a.id, by)), agent)).map((a) => ({ id: a.id, name: a.name, description: a.description, tableId: a.tableId, rooms: a.channels })) });
    case "read_app": {
      if (!(await mayUseApp(db, orgId, String(args.appId || ""), by))) return err("No such app.");
      const r = await renderApp(db, orgId, String(args.appId || ""));
      if (r.error) return err(r.error);
      if (!(await mayReadAppRows(db, orgId, r.app.id, r.app.tableId, by))) return err("No such app.");
      return pageResult({ app: { id: r.app.id, name: r.app.name, tableId: r.app.tableId }, columns: r.table.columns, views: r.views.map((v) => (v.type === "metrics" ? { name: v.name, metrics: v.values.map((m) => ({ label: m.label, value: m.value })) } : v.type === "board" ? { name: v.name, lanes: v.lanes.map((l) => ({ lane: l.key, count: l.rows.length })) } : v.type === "calendar" ? { name: v.name, days: v.days.map(d => ({ date: d.date, count: d.rows.length })), undated: v.undated.length } : { name: v.name, rows: v.rows.length })) }, r.rows.slice(0, 200), 0, r.rows.length);
    }
    case "list_tables":
      return out({ tables: await visibleResources(await listTables(db, orgId), t => mayUseTable(db, orgId, t.id, by)) });
    case "query_rows": {
      if (!(await mayUseTable(db, orgId, String(args.tableId || ""), by))) return err("No such table.");
      const r = await listRows(db, orgId, String(args.tableId || ""), { q: args.q, where: args.where, sort: args.sort, limit: Math.min(Number(args.limit ?? 100), 500), offset: args.offset });
      if (r.error) return err(r.error);
      if (args.fields !== undefined && (!Array.isArray(args.fields) || args.fields.some(id => typeof id !== 'string' || !r.table.columns.some(c => c.id === id)))) return err('fields must contain valid column IDs.');
      const rows = args.fields === undefined ? r.rows : r.rows.map(row => ({ ...row, values: Object.fromEntries(Object.entries(row.values).filter(([id]) => args.fields.includes(id))) }));
      return pageResult({}, rows, r.offset, r.total);
    }
    case "add_row": {
      if (!(await mayEditTable(db, orgId, String(args.tableId || ""), by))) return err("No such table.");
      const r = await addRow(db, orgId, String(args.tableId || ""), args.values, by, undefined, by);
      if (r.error) return err(r.error);
      if(r.rowEventId)await drainWorkflowRowEvents(env,{eventId:r.rowEventId,limit:1});
      return out({ row: presentRow(r.row), rowVersions: { [r.row.id]: r.row.updatedAt } });
    }
    case "update_row": {
      if (!(await mayEditTable(db, orgId, String(args.tableId || ""), by))) return err("No such table.");
      const r = await updateRow(db, orgId, String(args.tableId || ""), String(args.rowId || ""), args.values, by, args.expectedUpdatedAt, undefined, by);
      if (r.error) return err(r.error);
      if(r.rowEventId)await drainWorkflowRowEvents(env,{eventId:r.rowEventId,limit:1});
      return out({ row: presentRow(r.row), rowVersions: { [r.row.id]: r.row.updatedAt } });
    }
    case "list_workflows":
      return out({ workflows: (await listWorkflows(db, orgId, { viewerId: by })).map((w) => ({ id: w.id, name: w.name, enabled: w.enabled, trigger: w.trigger, steps: w.steps.map((s) => s.type) })) });
    case "get_workflow": {
      const wf = await getWorkflow(db, orgId, String(args.workflowId || ""), { viewerId: by, withSecret: true });
      if (!wf) return err("No such workflow.");
      const canManage = String(wf.createdBy) === String(by) || await allowed(db, orgId, by, "harness.delete_others");
      const { hookSecret, ...safeWorkflow } = wf;
      return out({ workflow: safeWorkflow, ...(canManage && wf.trigger?.type === "webhook" ? { webhook: { active: Boolean(hookSecret), ...(hookSecret ? { secret: hookSecret } : {}) } } : {}) });
    }
    case "list_workflow_revisions": {
      const result = await workflowRevisions(db, orgId, String(args.workflowId || ""), by, { before: args.before });
      return result.error ? err(result.error) : out(result);
    }
    case "restore_workflow_revision": {
      const wf = await getWorkflow(db, orgId, String(args.workflowId || ""), { viewerId: by });
      if (!wf) return err("No such workflow.");
      if (String(wf.createdBy) !== String(by) && !(await allowed(db, orgId, by, "harness.delete_others"))) return err("Only its maker or an admin can restore a workflow revision.");
      const result = await restoreWorkflowRevision(db, orgId, wf.id, by, args);
      return result.error ? err(result.error) : out(result);
    }
    case "resume_workflow_safety": {
      const workflowId = String(args.workflowId || "");
      const wf = await getWorkflow(db, orgId, workflowId, { viewerId: by });
      if (!wf) return err("No such workflow.");
      if (String(wf.createdBy) !== String(by) && !(await allowed(db, orgId, by, "harness.delete_others"))) return err("Only its maker or an admin can resume this workflow.");
      const safety = await readWorkflowSafety(db, orgId, workflowId);
      if (safety?.pause_reason?.startsWith("budget_ai_")) return err("This workflow reached its estimated AI usage limit or has unpriced usage. It can run again after the rolling window resets or after you change its budget.");
      if (safety?.pause_reason?.startsWith("budget_")) return err("This workflow can run again on its next trigger after the budget window resets, or as soon as you raise the limit.");
      if (typeof args.generation !== "string" || !await resumeWorkflowSafety(db, orgId, workflowId, args.generation)) return err("The workflow state changed. Reload before resuming.");
      return out({ workflowId, safety: await readWorkflowSafety(db, orgId, workflowId) });
    }
    case "list_workflow_runs": {
      const workflowId = String(args.workflowId || "");
      if (!(await getWorkflow(db, orgId, workflowId, { viewerId: by }))) return err("No such workflow.");
      return out({ runs: await listRuns(db, orgId, workflowId, Math.min(Number(args.limit ?? 50), 200), by) });
    }
    case "get_workflow_run": {
      const workflowId = String(args.workflowId || ""), runId = String(args.runId || "");
      const run = await getRun(db, orgId, runId, { viewerId: by });
      return run && run.workflowId === workflowId ? out({ run }) : err("No such run.");
    }
    case "cancel_workflow_run": {
      const wf = await getWorkflow(db, orgId, String(args.workflowId || ""), { viewerId: by });
      if (!wf) return err("No such workflow.");
      if (String(wf.createdBy) !== String(by) && !(await allowed(db, orgId, by, "harness.delete_others"))) return err("Only its maker or an admin can cancel this workflow run.");
      const result = await cancelWorkflowRun(db, { orgId, workflowId: wf.id, runId: String(args.runId || ""), expectedStartedAt: args.expectedStartedAt, actorId: by });
      return result.error ? err(result.error) : out(result);
    }
    case "recover_stalled_workflow_run": {
      const wf = await getWorkflow(db, orgId, String(args.workflowId || ""), { viewerId: by });
      if (!wf) return err("No such workflow.");
      if (String(wf.createdBy) !== String(by) && !(await allowed(db, orgId, by, "harness.delete_others"))) return err("Only its maker or an admin can reconcile this workflow run.");
      if (args.confirmNoReplay !== true || typeof args.expectedStartedAt !== "string") return err("Confirm that the uncertain step will not be replayed and refresh the run before reconciling it.");
      const result = await recoverStalledRun(db, { orgId, workflowId: wf.id, runId: String(args.runId || ""), expectedStartedAt: args.expectedStartedAt, actorId: by });
      return result.error ? err(result.error) : out(result);
    }
    case "list_held_workflow_events":
    case "get_held_workflow_event":
    case "discard_held_workflow_events":
    case "replay_held_workflow_events":
    case "rotate_workflow_webhook":
    case "revoke_workflow_webhook": {
      const wf = await getWorkflow(db, orgId, String(args.workflowId || ""), { viewerId: by, withSecret: true });
      if (!wf) return err("No such workflow.");
      if (String(wf.createdBy) !== String(by) && !(await allowed(db, orgId, by, "harness.delete_others"))) return err("Only its maker or an admin can manage held events and webhook credentials.");
      if (name === "list_held_workflow_events") return wf.trigger?.type === "webhook" ? out(await heldWorkflowSummary(db, orgId, wf.id, Number(args.offset ?? 0))) : err("This workflow does not use a webhook trigger.");
      if (name === "get_held_workflow_event") {
        const event = await readHeldWorkflowEvent(db, orgId, wf.id, String(args.eventId || ""));
        return event ? out({ event }) : err("No such held event.");
      }
      if (name === "discard_held_workflow_events") {
        const result = await discardWorkflowEvents(db, orgId, wf.id, args.eventIds);
        return result.error ? err(result.error) : out(result);
      }
      if (name === "replay_held_workflow_events") {
        if (wf.trigger?.type !== "webhook") return err("This workflow does not use a webhook trigger.");
        const result = await replayWorkflowEvents(env, orgId, wf, args.eventIds, by);
        return result.error ? err(result.error) : out(result);
      }
      if (wf.trigger?.type !== "webhook") return err("This workflow does not use a webhook trigger.");
      const result = await changeWorkflowHook(db, orgId, wf.id, { action: name === "rotate_workflow_webhook" ? "rotate" : "revoke", expectedSecret: args.expectedSecret, expectedUpdatedAt: args.expectedUpdatedAt });
      if (result.error) return err(result.error);
      return out({ workflowId: wf.id, active: Boolean(result.workflow.hookSecret), ...(result.workflow.hookSecret ? { secret: result.workflow.hookSecret } : {}), updatedAt: result.workflow.updatedAt });
    }
    case "run_workflow": {
      const wf = await getWorkflow(db, orgId, String(args.workflowId || ""), { viewerId: by });
      if (!wf) return err("No such workflow.");
      if (!wf.enabled) return err("This workflow is off.");
      const run = await startRun(env, { orgId, workflow: wf, trigger: "manual", input: { text: String(args.text || "") }, startedBy: by });
      if (!run) return err("This automation is no longer available in its current published release.");
      if (run.status === 'skipped'||run.status==='paused') return out({ status: run.status, reason: run.reason });
      return out({ run: { id: run.id, status: run.status, steps: run.log.map((l) => ({ type: l.type, status: l.status, output: l.output || l.error || null })) } });
    }
    case "schedule_followup": {
      const minutes = Number(args.minutes);
      const r = await scheduleFollowup(db, { orgId, channel: String(args.channel || ""), instruction: args.instruction, dueAt: new Date(Date.now() + (minutes > 0 ? minutes : 0) * 60000).toISOString(), by });
      return r.error ? err(r.error) : out({ followup: r.followup });
    }
    case "list_followups":
      return out({ followups: await listFollowups(db, orgId, { channel: args.channel || undefined, viewerId: by }) });
    default:
      return null;
  }
}
