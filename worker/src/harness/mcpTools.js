import {FILE_WRITE_TOOLS,callFileWriteTool} from './fileWriteTools.js';
import {FILE_READ_TOOLS,callFileReadTool} from './fileTools.js';
import { EXECUTION_TOOLS, callExecutionTool } from './executionTools.js';
import { mayUseApp, mayUseTable, visibleResources } from './resourceAccess.js';
// The harness over MCP (docs/kylon-gap-plan.md): what Kylon's Tools API and
// workspace CLI give an outside agent — the workspace's apps, tables,
// workflows and follow-ups — offered only by a workspace in harness mode.
// A key needs "write" for anything that changes a row or starts a run.

import { listApps, renderApp } from "./apps.js";
import { listTables, listRows, addRow, updateRow } from "./tables.js";
import { listWorkflows, getWorkflow, startRun } from "./workflows.js";
import { listFollowups, scheduleFollowup } from "./followups.js";
import { onRowChange } from "./workflows.js";
import { callRemoteMcpTool, remoteMcpTools } from "./remoteMcp.js";

export const HARNESS_TOOL_SCOPE = { create_file_text: "write", update_file_text: "write", run_app_action: "execute", run_javascript: "execute", cancel_execution: "execute", add_row: "write", update_row: "write", run_workflow: "write", schedule_followup: "write" };

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
    description: "An app with its rows and every view worked out: board lanes, metric values (open pipeline, overdue count…). Use it to answer questions about the app's data.",
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
    description: "Rows of a table, narrowed by text (q), by exact column values (where: {column: value}), and sorted (sort: column, or -column for descending).",
    inputSchema: {
      type: "object",
      properties: { tableId: { type: "string" }, q: { type: "string" }, where: { type: "object" }, sort: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 500 }, offset: { type: "integer", minimum: 0, maximum: 5000 } },
      required: ["tableId"],
    },
  },
  {
    name: "add_row",
    title: "Add a row",
    description: "Add a row to a table. values is {column name or id: value}; values are converted to the column's type. Workflows watching the table run.",
    inputSchema: { type: "object", properties: { tableId: { type: "string" }, values: { type: "object" } }, required: ["tableId", "values"] },
  },
  {
    name: "update_row",
    title: "Change a row",
    description: "Change some values of a row; the rest stay. Workflows watching the table run.",
    inputSchema: { type: "object", properties: { tableId: { type: "string" }, rowId: { type: "string" }, expectedUpdatedAt: { type: "string", description: "Token from rowVersions[rowId] in query_rows or read_app; rejects stale edits." }, values: { type: "object" } }, required: ["tableId", "rowId", "values"] },
  },
  {
    name: "list_workflows",
    title: "The workspace's workflows",
    description: "Workflows: their trigger, steps, and whether they are on.",
    inputSchema: { type: "object", properties: {} },
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
      return out({ apps: (await visibleResources(await listApps(db, orgId), a => mayUseApp(db, orgId, a.id, by))).map((a) => ({ id: a.id, name: a.name, description: a.description, tableId: a.tableId, rooms: a.channels })) });
    case "read_app": {
      if (!(await mayUseApp(db, orgId, String(args.appId || ""), by))) return err("No such app.");
      const r = await renderApp(db, orgId, String(args.appId || ""));
      if (r.error) return err(r.error);
      return out({ app: { id: r.app.id, name: r.app.name }, columns: r.table.columns, rowVersions: Object.fromEntries(r.rows.slice(0, 200).map(x => [x.id, x.updatedAt])), rows: r.rows.slice(0, 200).map((x) => ({ id: x.id, ...x.values })), views: r.views.map((v) => (v.type === "metrics" ? { name: v.name, metrics: v.values.map((m) => ({ label: m.label, value: m.value })) } : v.type === "board" ? { name: v.name, lanes: v.lanes.map((l) => ({ lane: l.key, count: l.rows.length })) } : v.type === "calendar" ? { name: v.name, days: v.days.map(d => ({ date: d.date, count: d.rows.length })), undated: v.undated.length } : { name: v.name, rows: v.rows.length })) });
    }
    case "list_tables":
      return out({ tables: await visibleResources(await listTables(db, orgId), t => mayUseTable(db, orgId, t.id, by)) });
    case "query_rows": {
      if (!(await mayUseTable(db, orgId, String(args.tableId || ""), by))) return err("No such table.");
      const r = await listRows(db, orgId, String(args.tableId || ""), { q: args.q, where: args.where, sort: args.sort, limit: Math.min(Number(args.limit ?? 100), 500), offset: args.offset });
      return r.error ? err(r.error) : out({ total: r.total, nextOffset: r.nextOffset, rowVersions: Object.fromEntries(r.rows.map(x => [x.id, x.updatedAt])), rows: r.rows.map((x) => ({ id: x.id, ...x.values })) });
    }
    case "add_row": {
      if (!(await mayUseTable(db, orgId, String(args.tableId || ""), by))) return err("No such table.");
      const r = await addRow(db, orgId, String(args.tableId || ""), args.values, by);
      if (r.error) return err(r.error);
      await onRowChange(env, { orgId, table: r.table, before: null, row: r.row, by });
      return out({ row: { id: r.row.id, ...r.row.values }, rowVersions: { [r.row.id]: r.row.updatedAt } });
    }
    case "update_row": {
      if (!(await mayUseTable(db, orgId, String(args.tableId || ""), by))) return err("No such table.");
      const r = await updateRow(db, orgId, String(args.tableId || ""), String(args.rowId || ""), args.values, by, args.expectedUpdatedAt);
      if (r.error) return err(r.error);
      await onRowChange(env, { orgId, table: r.table, before: r.before, row: r.row, by });
      return out({ row: { id: r.row.id, ...r.row.values }, rowVersions: { [r.row.id]: r.row.updatedAt } });
    }
    case "list_workflows":
      return out({ workflows: (await listWorkflows(db, orgId, { viewerId: by })).map((w) => ({ id: w.id, name: w.name, enabled: w.enabled, trigger: w.trigger, steps: w.steps.map((s) => s.type) })) });
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
