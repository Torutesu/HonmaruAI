import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// The harness over MCP (docs/kylon-gap-plan.md): an outside agent reads and
// writes the workspace's apps and tables, runs its workflows and schedules
// follow-ups — in a harness workspace only, and writing only with "write".

const ORG = "personal:hxmcp";
let toru;
const call = (path, init) => worker.fetch(new Request("https://example.com" + path, init), env);
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
let seq = 0;
const rpc = (bearer, method, params) => call("/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, ...(params ? { params } : {}) }),
});
const tool = async (bearer, name, args = {}) => (await (await rpc(bearer, "tools/call", { name, arguments: args })).json());
const mint = async (scopes) => (await (await call("/tokens", { method: "POST", headers: headers(toru), body: JSON.stringify({ orgId: ORG, name: "Claude Code", scopes }) })).json()).token;
const names = async (token) => (await (await rpc(token, "tools/list")).json()).result.tools.map((t) => t.name);

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9401", login: "toru", name: "Toru", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "9401", "admin");
  toru = await createSession(env.DB, "9401", "gho_toru");
});

test("a simple workspace's agents see the tools they always did", async () => {
  const token = await mint(["read", "write"]);
  expect(await names(token)).toEqual(["request_decision", "get_decision", "list_pending", "search_decisions", "list_members", "get_playbook"]);
  expect((await tool(token, "list_apps")).error.message).toContain("Unknown tool");
});

test("in a harness workspace an agent reads an app's numbers, adds a row, and needs write to change anything", async () => {
  await call("/orgs/mode", { method: "PUT", headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: "harness" }) });
  const { app } = await (await call("/apps", { method: "POST", headers: headers(toru), body: JSON.stringify({ orgId: ORG, template: "crm" }) })).json();
  const writer = await mint(["read", "write"]);
  const reader = await mint(["read"]);
  expect(await names(writer)).toEqual(expect.arrayContaining(["list_apps", "read_app", "query_rows", "add_row", "run_workflow", "schedule_followup"]));
  expect(await names(reader)).not.toContain("add_row");

  const listed = (await tool(reader, "list_apps")).result.structuredContent;
  expect(listed.apps).toEqual([expect.objectContaining({ id: app.id, name: "Sales CRM" })]);
  const read = (await tool(reader, "read_app", { appId: app.id })).result.structuredContent;
  expect(read.views.find((v) => v.name === "Forecast").metrics).toEqual(expect.arrayContaining([{ label: "Open pipeline", value: 42000 }]));

  expect((await tool(reader, "add_row", { tableId: app.tableId, values: { Company: "Hooli" } })).result.isError).toBe(true);
  const added = (await tool(writer, "add_row", { tableId: app.tableId, values: { Company: "Hooli", Stage: "Lead", Value: "9,000" } })).result.structuredContent;
  expect(added.row).toMatchObject({ company: "Hooli", stage: "Lead", value: 9000 });
  const found = (await tool(reader, "query_rows", { tableId: app.tableId, where: { Stage: "Lead" } })).result.structuredContent;
  expect(found.rows.map((r) => r.company).sort()).toEqual(["Hooli", "Initech"]);
});
