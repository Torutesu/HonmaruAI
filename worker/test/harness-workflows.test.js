import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { joined, until } from "./helpers.js";
import { render, runDueWorkflows, normalizeSteps } from "../src/harness/workflows.js";
import { runDueFollowups, followupRequest } from "../src/harness/followups.js";

// Workflows, follow-ups and approvals (docs/kylon-gap-plan.md): a trigger,
// steps, every run kept; an approval is a card whose swipe carries the run
// on; a follow-up is an agent coming back to a thread at a set time.

const ORG = "personal:hxflows";
let toru, mika;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const settle = async () => { while (pending.length) await pending.shift(); };
const call = async (path, init, over = {}) => {
  const res = await worker.fetch(new Request("https://example.com" + path, init), { ...env, OPENAI_API_KEY: undefined, ...over }, ctx);
  await settle();
  return res;
};
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const send = (method, path, token, body) => call(path, { method, headers: headers(token), body: JSON.stringify(body) });
const get = (path, token) => call(path, { headers: headers(token) });
const q = (o) => new URLSearchParams(o).toString();
const messages = async (token) => (await (await get(`/channels/messages?${q({ orgId: ORG, channel: "b:ops" })}`, token)).json()).messages || [];

let invoices;
beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  for (const [id, login, name, role] of [["9301", "toru", "Toru", "admin"], ["9302", "mika", "Mika", "member"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, role);
  }
  await upsertBusiness(env.DB, ORG, { name: "Ops", createdBy: "9301" });
  toru = await createSession(env.DB, "9301", "gho_t");
  mika = await createSession(env.DB, "9302", "gho_m");
  await send("PUT", "/orgs/mode", toru, { orgId: ORG, mode: "harness" });
  const app = (await (await send("POST", "/apps", mika, { orgId: ORG, template: "invoices", sample: false })).json()).app;
  invoices = app.tableId;
});

const overdueFlow = () => ({
  orgId: ORG, name: "Chase overdue invoices",
  trigger: { type: "row", tableId: invoices, on: "changed", where: { Status: "Overdue" } },
  steps: [
    { type: "post", channel: "b:ops", text: "{{row.Client}} is overdue on {{row.Invoice #}} ({{row.Amount}})." },
    { type: "approval", to: "toru", title: "Send {{row.Client}} a reminder?", summary: "{{row.Amount}} overdue" },
    { type: "post", channel: "b:ops", text: "Reminder to {{row.Client}} approved: {{steps.2.output}}" },
  ],
});

test("a row turning overdue runs the workflow: it posts, waits on a person's approval, and goes on when approved", async () => {
  const made = await send("POST", "/workflows", mika, overdueFlow());
  expect(made.status).toBe(201);
  const { workflow } = await made.json();

  const row = (await (await send("POST", `/tables/${invoices}/rows`, mika, { orgId: ORG, values: { Client: "Acme", "Invoice #": "INV-7", Amount: 4800, Status: "Sent" } })).json()).row;
  // Added as "Sent": not overdue, nothing runs.
  expect((await (await get(`/workflows/${workflow.id}?${q({ orgId: ORG })}`, mika)).json()).runs).toEqual([]);

  await send("PATCH", `/tables/${invoices}/rows/${row.id}`, mika, { orgId: ORG, values: { Status: "Overdue" } });
  const { runs } = await (await get(`/workflows/${workflow.id}?${q({ orgId: ORG })}`, mika)).json();
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ trigger: "row", status: "waiting", nextStep: 2 });
  expect(runs[0].log.map((l) => [l.type, l.status])).toEqual([["post", "ok"], ["approval", "waiting"]]);
  expect((await messages(mika)).map((m) => m.body)).toContain("Acme is overdue on INV-7 (4800).");

  // Toru sees it among what agents and workflows wait on him for.
  const approvals = await (await get(`/approvals?${q({ orgId: ORG })}`, toru)).json();
  expect(approvals.toDecide).toEqual([expect.objectContaining({ title: "Send Acme a reminder?", kind: "workflow" })]);
  expect((await (await get(`/approvals?${q({ orgId: ORG })}`, mika)).json()).waitingOnOthers).toHaveLength(1);

  // A further change while it already reads "Overdue" is not news.
  await send("PATCH", `/tables/${invoices}/rows/${row.id}`, mika, { orgId: ORG, values: { Amount: 4900 } });
  expect((await (await get(`/workflows/${workflow.id}/runs?${q({ orgId: ORG })}`, mika)).json()).runs).toHaveLength(1);

  const { ws } = await joined(ORG, toru);
  ws.send(JSON.stringify({ type: "tool_result", payload: { toolCallId: "tc-wf", content: { cardId: runs[0].cardId, action: "approve", decidedAt: new Date().toISOString() } } }));
  const done = await until(async () => {
    const r = (await (await get(`/workflows/${workflow.id}/runs/${runs[0].id}?${q({ orgId: ORG })}`, mika)).json()).run;
    return r.status === "done" ? r : null;
  });
  expect(done.log.map((l) => [l.type, l.status])).toEqual([["post", "ok"], ["approval", "ok"], ["post", "ok"]]);
  expect((await messages(mika)).map((m) => m.body)).toContain("Reminder to Acme approved: Approved by @toru");
});

test("declined, a run ends where it stood", async () => {
  const { workflow } = await (await send("POST", "/workflows", mika, overdueFlow())).json();
  const row = (await (await send("POST", `/tables/${invoices}/rows`, mika, { orgId: ORG, values: { Client: "Globex", Status: "Sent" } })).json()).row;
  await send("PATCH", `/tables/${invoices}/rows/${row.id}`, mika, { orgId: ORG, values: { Status: "Overdue" } });
  const [run] = (await (await get(`/workflows/${workflow.id}/runs?${q({ orgId: ORG })}`, mika)).json()).runs;
  const { ws } = await joined(ORG, toru);
  ws.send(JSON.stringify({ type: "tool_result", payload: { toolCallId: "tc-wf2", content: { cardId: run.cardId, action: "decline", decidedAt: new Date().toISOString() } } }));
  const ended = await until(async () => {
    const r = (await (await get(`/workflows/${workflow.id}/runs/${run.id}?${q({ orgId: ORG })}`, mika)).json()).run;
    return r.status === "declined" ? r : null;
  });
  expect(ended.log).toHaveLength(2);
  expect((await messages(mika)).some((m) => m.body.startsWith("Reminder to Globex"))).toBe(false);
});

test("a webhook starts a run with what was posted, and only with its secret", async () => {
  const made = await (await send("POST", "/workflows", mika, {
    orgId: ORG, name: "New invoice from billing",
    trigger: { type: "webhook" },
    steps: [{ type: "add_row", tableId: invoices, values: { Client: "{{input.client}}", Amount: "{{input.amount}}", Status: "Draft" } }],
  })).json();
  expect(made.hookUrl).toMatch(/\/hooks\/workflows\/wf_[0-9a-f]+\?secret=[0-9a-f]{48}$/);
  const path = new URL(made.hookUrl).pathname;
  const hook = (secret, body) => call(`${path}?secret=${secret}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await hook("wrong", { client: "X" })).status).toBe(404);
  expect((await hook(made.workflow.hookSecret, { client: "Initech", amount: "1,500" })).status).toBe(202);
  const { rows } = await (await get(`/tables/${invoices}?${q({ orgId: ORG })}`, mika)).json();
  expect(rows.map((r) => r.values)).toEqual([expect.objectContaining({ client: "Initech", amount: 1500, status: "Draft" })]);
  // Someone who may not change it never sees the secret.
  const seen = await (await get(`/workflows/${made.workflow.id}?${q({ orgId: ORG })}`, toru)).json();
  expect(seen.canEdit).toBe(true);
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9303", login: "kai", name: "Kai", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "9303", "member");
  const kai = await createSession(env.DB, "9303", "gho_kai");
  const kaiSees = await (await get(`/workflows/${made.workflow.id}?${q({ orgId: ORG })}`, kai)).json();
  expect(kaiSees.workflow.hookSecret).toBeUndefined();
  expect((await send("PUT", `/workflows/${made.workflow.id}`, kai, { orgId: ORG, enabled: false })).status).toBe(403);
});

test("a scheduled workflow runs when its time comes, once, and a manual one when asked", async () => {
  const { workflow } = await (await send("POST", "/workflows", mika, {
    orgId: ORG, name: "Monday nudge",
    trigger: { type: "schedule", cadence: "weekly", weekday: 1, hour: 9, timezone: "UTC" },
    steps: [{ type: "post", channel: "b:ops", text: "Weekly: check the invoice tracker." }],
  })).json();
  expect(Date.parse(workflow.nextRunAt)).toBeGreaterThan(Date.now());
  const after = new Date(Date.parse(workflow.nextRunAt) + 60000);
  expect(await runDueWorkflows(env, { now: after })).toBe(1);
  expect(await runDueWorkflows(env, { now: after })).toBe(0);
  expect((await messages(mika)).filter((m) => m.body === "Weekly: check the invoice tracker.")).toHaveLength(1);

  const run = (await (await send("POST", `/workflows/${workflow.id}/run`, mika, { orgId: ORG, text: "now please" })).json()).run;
  expect(run).toMatchObject({ trigger: "manual", status: "done", input: { text: "now please" } });
});

test("a follow-up is listed where it was made, may be cancelled, and posts when due", async () => {
  const made = await (await send("POST", "/followups", mika, { orgId: ORG, channel: "b:ops", instruction: "Check whether Acme paid", minutes: 60 })).json();
  const other = await (await send("POST", "/followups", mika, { orgId: ORG, channel: "b:ops", instruction: "Never mind this one", minutes: 60 })).json();
  expect((await (await get(`/followups?${q({ orgId: ORG, channel: "b:ops" })}`, toru)).json()).followups).toHaveLength(2);
  expect((await call(`/followups/${other.followup.id}?${q({ orgId: ORG })}`, { method: "DELETE", headers: headers(toru) })).status).toBe(200);
  expect(await runDueFollowups(env, { now: new Date(Date.now() + 2 * 3600000) })).toBe(1);
  expect((await messages(mika)).map((m) => m.body)).toContain("⏰ Follow-up: Check whether Acme paid");
  expect((await (await get(`/followups?${q({ orgId: ORG, status: "done" })}`, toru)).json()).followups.map((f) => f.id)).toEqual([made.followup.id]);
  expect((await send("POST", "/followups", mika, { orgId: ORG, channel: "b:ops", instruction: "past", dueAt: "2020-01-01T00:00:00Z" })).status).toBe(400);
});

test("asked in the chat, an agent schedules its own follow-up in the thread", async () => {
  const agent = (await (await send("POST", "/channels/agents", mika, { orgId: ORG, name: "Billy", handle: "billy", instructions: "You chase invoices.", scope: "team" })).json()).agent;
  const sent = await (await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:ops", body: "@billy follow up in 2 days: check whether Acme paid" })).json();
  const { followups } = await (await get(`/followups?${q({ orgId: ORG, channel: "b:ops" })}`, mika)).json();
  expect(followups).toEqual([expect.objectContaining({ agentId: agent.id, instruction: "check whether Acme paid", threadId: sent.message.id })]);
  expect(Date.parse(followups[0].dueAt) - Date.now()).toBeGreaterThan(47 * 3600000);
});

test("templates, steps and follow-up sentences are read strictly", () => {
  expect(render("{{row.Client}} owes {{row.amount}}{{row.missing}}", { row: { client: "Acme", amount: 5 } })).toBe("Acme owes 5");
  expect(render("{{steps.1.output}}", { steps: { 1: { output: "ok" } } })).toBe("ok");
  expect(normalizeSteps([{ type: "rm -rf" }]).error).toBeTruthy();
  expect(normalizeSteps([]).error).toBeTruthy();
  expect(followupRequest("follow up in 3 days: chase Acme")).toEqual({ minutes: 4320, text: "chase Acme" });
  expect(followupRequest("2時間後にフォローして: 見積の返事")).toEqual({ minutes: 120, text: "見積の返事" });
  expect(followupRequest("follow up later")).toBeNull();
});
