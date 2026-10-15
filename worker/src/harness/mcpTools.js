// The harness over MCP (docs/kylon-gap-plan.md): what Kylon's Tools API and
// workspace CLI give an outside agent — the workspace's apps, tables,
// workflows and follow-ups — offered only by a workspace in harness mode.
// A key needs "write" for anything that changes a row or starts a run.

import { listApps, renderApp } from "./apps.js";
import { listTables, listRows, addRow, updateRow } from "./tables.js";
import { listWorkflows, getWorkflow, startRun } from "./workflows.js";
import { listFollowups, scheduleFollowup } from "./followups.js";
import { onRowChange } from "./workflows.js";

export const HARNESS_TOOL_SCOPE = { add_row: "write", update_row: "write", run_workflow: "write", schedule_followup: "write" };

export const HARNESS_TOOLS = [
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
      properties: { tableId: { type: "string" }, q: { type: "string" }, where: { type: "object" }, sort: { type: "string" }, limit: { type: "number" } },
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
    inputSchema: { type: "object", properties: { tableId: { type: "string" }, rowId: { type: "string" }, values: { type: "object" } }, required: ["tableId", "rowId", "values"] },
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
  const db = env.DB;
  const orgId = agent.orgId;
  const by = agent.githubId;
  switch (name) {
    case "list_apps":
      return out({ apps: (await listApps(db, orgId)).map((a) => ({ id: a.id, name: a.name, description: a.description, tableId: a.tableId, rooms: a.channels })) });
    case "read_app": {
      const r = await renderApp(db, orgId, String(args.appId || ""));
      if (r.error) return err(r.error);
      return out({ app: { id: r.app.id, name: r.app.name }, columns: r.table.columns, rows: r.rows.slice(0, 200).map((x) => ({ id: x.id, ...x.values })), views: r.views.map((v) => (v.type === "metrics" ? { name: v.name, metrics: v.values.map((m) => ({ label: m.label, value: m.value })) } : v.type === "board" ? { name: v.name, lanes: v.lanes.map((l) => ({ lane: l.key, count: l.rows.length })) } : { name: v.name, rows: v.rows.length })) });
    }
    case "list_tables":
      return out({ tables: await listTables(db, orgId) });
    case "query_rows": {
      const r = await listRows(db, orgId, String(args.tableId || ""), { q: args.q, where: args.where, sort: args.sort, limit: Math.min(Number(args.limit) || 100, 500) });
      return r.error ? err(r.error) : out({ rows: r.rows.map((x) => ({ id: x.id, ...x.values })) });
    }
    case "add_row": {
      const r = await addRow(db, orgId, String(args.tableId || ""), args.values, by);
      if (r.error) return err(r.error);
      await onRowChange(env, { orgId, table: r.table, before: null, row: r.row, by });
      return out({ row: { id: r.row.id, ...r.row.values } });
    }
    case "update_row": {
      const r = await updateRow(db, orgId, String(args.tableId || ""), String(args.rowId || ""), args.values, by);
      if (r.error) return err(r.error);
      await onRowChange(env, { orgId, table: r.table, before: r.before, row: r.row, by });
      return out({ row: { id: r.row.id, ...r.row.values } });
    }
    case "list_workflows":
      return out({ workflows: (await listWorkflows(db, orgId)).map((w) => ({ id: w.id, name: w.name, enabled: w.enabled, trigger: w.trigger, steps: w.steps.map((s) => s.type) })) });
    case "run_workflow": {
      const wf = await getWorkflow(db, orgId, String(args.workflowId || ""));
      if (!wf) return err("No such workflow.");
      if (!wf.enabled) return err("This workflow is off.");
      const run = await startRun(env, { orgId, workflow: wf, trigger: "manual", input: { text: String(args.text || "") }, startedBy: by });
      return out({ run: { id: run.id, status: run.status, steps: run.log.map((l) => ({ type: l.type, status: l.status, output: l.output || l.error || null })) } });
    }
    case "schedule_followup": {
      const minutes = Number(args.minutes);
      const r = await scheduleFollowup(db, { orgId, channel: String(args.channel || ""), instruction: args.instruction, dueAt: new Date(Date.now() + (minutes > 0 ? minutes : 0) * 60000).toISOString(), by });
      return r.error ? err(r.error) : out({ followup: r.followup });
    }
    case "list_followups":
      return out({ followups: await listFollowups(db, orgId, { channel: args.channel || undefined }) });
    default:
      return null;
  }
}
