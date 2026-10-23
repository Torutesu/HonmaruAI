import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { joined, until } from "./helpers.js";
import { render, runDueWorkflows, normalizeSteps, startRun } from "../src/harness/workflows.js";
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
  expect((await messages(mika)).map((m) => m.body)).toContain("Reminder to Acme approved: Approved by Toru");
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

test("changing away from webhook revokes its URL permanently while pause preserves it", async () => {
  const made = await (await send("POST", "/workflows", mika, {
    orgId: ORG, name: "Webhook lifecycle", trigger: { type: "webhook" },
    steps: [{ type: "add_row", tableId: invoices, values: { Client: "Lifecycle", Status: "Draft" } }],
  })).json();
  const id = made.workflow.id;
  const edit = async patch => {
    const res = await send("PUT", `/workflows/${id}`, mika, { orgId: ORG, ...patch });
    expect(res.status).toBe(200);
    return (await res.json()).workflow;
  };
  const fire = url => call(new URL(url).pathname + new URL(url).search, {
    method: "POST", headers: { "content-type": "application/json" }, body: '{}',
  });
  expect((await edit({ enabled: false })).hookSecret).toBe(made.workflow.hookSecret);
  expect((await fire(made.hookUrl)).status).toBe(202);
  expect((await edit({ enabled: true, name: "Renamed" })).hookSecret).toBe(made.workflow.hookSecret);
  expect((await edit({ trigger: { type: "manual" } })).hookSecret).toBeUndefined();
  expect((await fire(made.hookUrl)).status).toBe(404);
  const restored = await edit({ trigger: { type: "webhook" } });
  expect(restored.hookSecret).toMatch(/^[0-9a-f]{48}$/);
  expect(restored.hookSecret).not.toBe(made.workflow.hookSecret);
  expect((await fire(made.hookUrl)).status).toBe(404);
  const fresh = new URL(made.hookUrl); fresh.searchParams.set('secret', restored.hookSecret);
  expect((await fire(fresh.href)).status).toBe(202);
});

test("webhook rotation and revocation require an editor and reject stale concurrent changes", async () => {
  const made = await (await send("POST", "/workflows", toru, {
    orgId: ORG, name: "Managed webhook", trigger: { type: "webhook" },
    steps: [{ type: "add_row", tableId: invoices, values: { Client: "Managed", Status: "Draft" } }],
  })).json();
  const endpoint = `/workflows/${made.workflow.id}/webhook`;
  const mutate = (token, action, expectedSecret) => send('POST', endpoint, token, { orgId: ORG, action, expectedSecret });
  const fire = secret => call(new URL(made.hookUrl).pathname, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hook-secret': secret }, body: '{}',
  });
  expect((await mutate(mika, 'rotate', made.workflow.hookSecret)).status).toBe(403);
  expect((await mutate(toru, 'rotate', undefined)).status).toBe(400);
  expect((await mutate(toru, 'invalid', made.workflow.hookSecret)).status).toBe(400);
  const attempts = await Promise.all([mutate(toru, 'rotate', made.workflow.hookSecret), mutate(toru, 'rotate', made.workflow.hookSecret)]);
  expect(attempts.map(r => r.status).sort()).toEqual([200, 409]);
  const rotated = (await attempts.find(r => r.status === 200).json()).workflow;
  expect(rotated.hookSecret).not.toBe(made.workflow.hookSecret);
  expect((await fire(made.workflow.hookSecret)).status).toBe(404);
  expect((await fire(rotated.hookSecret)).status).toBe(202);
  expect((await mutate(toru, 'revoke', made.workflow.hookSecret)).status).toBe(409);
  const revoked = await (await mutate(toru, 'revoke', rotated.hookSecret)).json();
  expect(revoked.workflow.hookUrl).toBeUndefined();
  expect(revoked.workflow.hookSecret).toBeUndefined();
  await send('PUT', `/workflows/${made.workflow.id}`, toru, { orgId: ORG, name: 'Still revoked', enabled: true });
  const current = await (await get(`/workflows/${made.workflow.id}?${q({ orgId: ORG })}`, toru)).json();
  expect(current.workflow.hookSecret).toBeUndefined();
  expect((await fire(rotated.hookSecret)).status).toBe(404);
  const resumed = await (await mutate(toru, 'rotate', null)).json();
  expect((await fire(resumed.workflow.hookSecret)).status).toBe(202);
});

test("paused webhook deliveries are held and explicit replay cannot dispatch the same event twice", async () => {
  const made = await (await send('POST', '/workflows', toru, {
    orgId: ORG, name: 'Paused input', enabled: false, trigger: { type: 'webhook' },
    steps: [{ type: 'add_row', tableId: invoices, values: { Client: '{{input.client}}', Status: 'Draft' } }],
  })).json();
  const id = made.workflow.id;
  const detail = async () => (await get(`/workflows/${id}?${q({ orgId: ORG })}`, toru)).json();
  const fire = client => call(new URL(made.hookUrl).pathname + new URL(made.hookUrl).search, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client }),
  });
  const first = await (await fire('First')).json();
  const second = await (await fire('Second')).json();
  expect(first.status).toBe('held');
  expect((await detail()).runs).toHaveLength(0);
  expect((await detail()).held.count).toBe(2);
  const replay = (token, ids) => send('POST', `/workflows/${id}/webhook/replay`, token, { orgId: ORG, eventIds: ids });
  expect((await replay(toru, [first.eventId])).status).toBe(409);
  expect((await replay(mika, [first.eventId])).status).toBe(403);
  await send('PUT', `/workflows/${id}`, toru, { orgId: ORG, enabled: true });
  expect((await detail()).runs).toHaveLength(0);
  const attempts = await Promise.all([replay(toru, [first.eventId]), replay(toru, [first.eventId])]);
  const results = await Promise.all(attempts.map(r => r.json()));
  expect(results.reduce((n,r) => n + r.runs.length, 0)).toBe(1);
  expect((await detail()).held.count).toBe(1);
  expect((await (await replay(toru, [first.eventId])).json()).runs).toHaveLength(0);
  expect((await (await replay(toru, [second.eventId])).json()).runs).toHaveLength(1);
  const { rows } = await (await get(`/tables/${invoices}?${q({ orgId: ORG })}`, toru)).json();
  expect(rows.map(r => r.values.client).sort()).toEqual(['First', 'Second']);
});

test("paused webhook queue has a hard cap and expires stored payloads", async () => {
  const made = await (await send('POST', '/workflows', toru, {
    orgId: ORG, name: 'Bounded input', enabled: false, trigger: { type: 'webhook' },
    steps: [{ type: 'add_row', tableId: invoices, values: { Client: 'Bounded', Status: 'Draft' } }],
  })).json();
  const future = new Date(Date.now() + 86400000).toISOString();
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000)
    INSERT INTO hx_workflow_held_events(id,org_id,workflow_id,input,received_at,expires_at)
    SELECT 'test_held_'||x,?1,?2,'{}',?3,?3 FROM n`).bind(ORG, made.workflow.id, future).run();
  const fire = () => call(new URL(made.hookUrl).pathname + new URL(made.hookUrl).search, { method: 'POST', body: '{}' });
  expect((await fire()).status).toBe(429);
  await env.DB.prepare("UPDATE hx_workflow_held_events SET expires_at='2000-01-01T00:00:00.000Z'").run();
  expect((await fire()).status).toBe(202);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_held_events').first()).n).toBe(1);
  await runDueWorkflows(env, { now: new Date(Date.now() + 8 * 86400000) });
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_held_events').first()).n).toBe(0);
});

test("a webhook checked before credential revocation cannot create a run afterward", async () => {
  const made = await (await send('POST', '/workflows', toru, {
    orgId: ORG, name: 'In flight delivery', trigger: { type: 'webhook' },
    steps: [{ type: 'add_row', tableId: invoices, values: { Client: 'Must not execute', Status: 'Draft' } }],
  })).json();
  await send('POST', `/workflows/${made.workflow.id}/webhook`, toru, { orgId: ORG, action: 'revoke', expectedSecret: made.workflow.hookSecret });
  const run = await startRun(env, { orgId: ORG, workflow: made.workflow, trigger: 'webhook', input: {}, incomingHookSecret: made.workflow.hookSecret });
  expect(run).toBeNull();
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_runs WHERE workflow_id=?1').bind(made.workflow.id).first()).n).toBe(0);
});

test("scheduled expiry cleanup removes old payloads across workspaces and preserves unexpired events", async () => {
  const made = await (await send('POST', '/workflows', toru, {
    orgId: ORG, name: 'Expiry sweep', enabled: false, trigger: { type: 'webhook' },
    steps: [{ type: 'add_row', tableId: invoices, values: { Client: 'No run', Status: 'Draft' } }],
  })).json();
  await env.DB.prepare(`INSERT INTO hx_workflows(id,org_id,name,enabled,trigger,steps,created_by,created_at,updated_at)
    SELECT 'wf_other_expiry','other:expiry',name,enabled,trigger,steps,created_by,created_at,updated_at FROM hx_workflows WHERE id=?1 AND org_id=?2`)
    .bind(made.workflow.id, ORG).run();
  const at = new Date().toISOString(), future = new Date(Date.now()+86400000).toISOString();
  for (const [id,org,wf,expires] of [['expired_here',ORG,made.workflow.id,'2000-01-01T00:00:00Z'],['expired_elsewhere','other:expiry','wf_other_expiry','2000-01-01T00:00:00Z'],['future_elsewhere','other:expiry','wf_other_expiry',future]]) {
    await env.DB.prepare('INSERT INTO hx_workflow_held_events(id,org_id,workflow_id,input,received_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6)')
      .bind(id,org,wf,'{}',at,expires).run();
  }
  expect(await runDueWorkflows(env)).toBe(0);
  expect((await env.DB.prepare('SELECT id FROM hx_workflow_held_events ORDER BY id').all()).results).toEqual([{id:'future_elsewhere'}]);
});

test("discard removes only reviewed pending events in the authorized workflow", async () => {
  const make = async name => (await (await send('POST', '/workflows', toru, {
    orgId: ORG, name, enabled: false, trigger: { type: 'webhook' },
    steps: [{ type: 'add_row', tableId: invoices, values: { Client: 'Not executed', Status: 'Draft' } }],
  })).json()).workflow;
  const a = await make('Discard target'), b = await make('Other workflow');
  const at = new Date().toISOString(), expires = new Date(Date.now()+86400000).toISOString();
  for (const [id,wf,runId] of [['reviewed',a,null],['new_arrival',a,null],['already_dispatched',a,'existing_run'],['other_workflow',b,null]]) {
    await env.DB.prepare('INSERT INTO hx_workflow_held_events(id,org_id,workflow_id,input,received_at,expires_at,run_id) VALUES(?1,?2,?3,?4,?5,?6,?7)')
      .bind(id,ORG,wf.id,'{}',at,expires,runId).run();
  }
  const discard = (token, eventIds) => send('POST', `/workflows/${a.id}/webhook/discard`, token, { orgId: ORG, eventIds });
  expect((await discard(mika, ['reviewed'])).status).toBe(403);
  expect((await discard(toru, [])).status).toBe(400);
  expect((await discard(toru, ['reviewed','reviewed'])).status).toBe(400);
  expect(await (await discard(toru, ['reviewed','already_dispatched','other_workflow'])).json()).toEqual({ discarded: 1 });
  const { results } = await env.DB.prepare('SELECT id FROM hx_workflow_held_events ORDER BY id').all();
  expect(results.map(x=>x.id)).toEqual(['already_dispatched','new_arrival','other_workflow']);
  expect(await (await discard(toru, ['reviewed'])).json()).toEqual({ discarded: 0 });
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_runs').first()).n).toBe(0);
});

test("a paused workflow can run manually without resuming its schedule", async () => {
  const made = await (await send('POST', '/workflows', toru, {
    orgId: ORG, name: 'Explicit trial while paused', enabled: false,
    trigger: { type: 'schedule', cadence: 'daily', hour: 9, timezone: 'UTC' },
    steps: [{ type: 'add_row', tableId: invoices, values: { Client: 'Manual trial', Status: 'Draft' } }],
  })).json();
  const response = await send('POST', `/workflows/${made.workflow.id}/run`, toru, { orgId: ORG, text: 'Run once' });
  expect(response.status).toBe(201);
  expect((await response.json()).run).toMatchObject({ trigger: 'manual', status: 'done' });
  const detail = await (await get(`/workflows/${made.workflow.id}?${q({ orgId: ORG })}`, toru)).json();
  expect(detail.workflow.enabled).toBe(false);
  expect(detail.workflow.nextRunAt).toBeNull();
  expect(await runDueWorkflows(env, { now: new Date(Date.now() + 86400000) })).toBe(0);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_runs WHERE workflow_id=?1').bind(made.workflow.id).first()).n).toBe(1);
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

test("a follow-up made by an account from SSO or the directory is answered by the AI, on its maker's allowance", async () => {
  const { upsertUser, upsertMembership } = await import("../src/db.js");
  const { scheduleFollowup } = await import("../src/harness/followups.js");
  const makers = ["sso:personal:hxflows:aaaa", "scim:personal:hxflows:bbbb"];
  for (const [i, id] of makers.entries()) {
    await upsertUser(env.DB, { githubId: id, login: `u:maker${i}@corp.example`, name: `Maker ${i}`, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, "member", i ? "scim" : "sso");
    const made = await scheduleFollowup(env.DB, { orgId: ORG, channel: "b:ops", instruction: `Say the test phrase ${i}`, dueAt: new Date(Date.now() + 60_000).toISOString(), by: id });
    expect(made.followup).toBeTruthy();
  }
  // Nobody's account: a synthetic maker gets the reminder and spends nothing.
  await env.DB.prepare(`INSERT INTO hx_followups (id, org_id, channel, instruction, due_at, status, created_by, created_at)
    VALUES ('fu_synthetic', ?1, 'b:ops', 'Synthetic', ?2, 'scheduled', 'workflow:wf_1', ?2)`).bind(ORG, new Date(Date.now() + 60_000).toISOString()).run();
  fetchMock.activate();
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, { choices: [{ message: { content: "FOLLOWUP COMPLETE" } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }).times(2);
  try {
    await runDueFollowups({ ...env, OPENAI_API_KEY: "sk-test" }, { now: new Date(Date.now() + 2 * 60_000) });
    fetchMock.assertNoPendingInterceptors();
  } finally {
    fetchMock.deactivate();
  }
  const { results } = await env.DB.prepare("SELECT created_by, status, result FROM hx_followups WHERE org_id = ?1 ORDER BY created_by").bind(ORG).all();
  const byMaker = Object.fromEntries(results.map((r) => [r.created_by, r]));
  for (const id of makers) expect(byMaker[id]).toMatchObject({ status: "done", result: "FOLLOWUP COMPLETE" });
  expect(byMaker["workflow:wf_1"].result).not.toBe("FOLLOWUP COMPLETE");
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

test("the harness's home answers in one call: what waits on me, the apps' numbers, the agents' roles, how each workflow last ran", async () => {
  const { workflow } = await (await send("POST", "/workflows", mika, overdueFlow())).json();
  const row = (await (await send("POST", `/tables/${invoices}/rows`, mika, { orgId: ORG, values: { Client: "Acme", Amount: 4800, Status: "Sent" } })).json()).row;
  await send("PATCH", `/tables/${invoices}/rows/${row.id}`, mika, { orgId: ORG, values: { Status: "Overdue" } });
  const agent = (await (await send("POST", "/channels/agents", mika, { orgId: ORG, name: "Billy", handle: "billy", instructions: "You chase invoices.", scope: "team" })).json()).agent;
  expect((await (await get(`/harness/home?${q({ orgId: ORG })}`, toru)).json()).agents).toEqual([]);
  await send("PUT", "/channels/agents", mika, { orgId: ORG, id: agent.id, scope: "team" });
  await send("PUT", `/hx/agents/${agent.id}/profile`, mika, { orgId: ORG, specialty: "Accounts receivable" });
  await send("POST", "/followups", mika, { orgId: ORG, channel: "b:ops", instruction: "Check Acme", minutes: 60 });

  const home = await (await get(`/harness/home?${q({ orgId: ORG })}`, toru)).json();
  expect(home.mode).toBe("harness");
  expect(home.approvals.toDecide).toEqual([expect.objectContaining({ title: "Send Acme a reminder?", kind: "workflow" })]);
  expect(home.approvals.pendingDecisions).toBe(1);
  expect(home.apps).toEqual([expect.objectContaining({ name: "Invoice tracker", rows: 1, headline: { label: "Open invoices", value: 1 } })]);
  expect(home.agents).toEqual([expect.objectContaining({ handle: "billy", specialty: "Accounts receivable", tier: "standard" })]);
  expect(home.workflows).toEqual([expect.objectContaining({ id: workflow.id, trigger: "row", lastRun: expect.objectContaining({ status: "waiting" }) })]);
  expect(home.followups.map((f) => f.instruction)).toEqual(["Check Acme"]);
});

test("approval resumes the frozen definition even after its workflow is edited", async () => {
  const { createWorkflow, startRun, updateWorkflow, settleWorkflowApproval } = await import('../src/harness/workflows.js');
  const { workflow } = await createWorkflow(env.DB, ORG, {
    name: 'Frozen', trigger: { type: 'manual' }, steps: [
      { type: 'approval', to: 'toru', title: 'Approve original?' },
      { type: 'post', channel: 'b:ops', text: 'Original approved action' },
    ],
  }, '9302');
  const run = await startRun(env, { orgId: ORG, workflow, trigger: 'manual', startedBy: '9302' });
  expect(run.status).toBe('waiting');
  await updateWorkflow(env.DB, ORG, workflow.id, { steps: [{ type: 'post', channel: 'b:ops', text: 'Replacement' }] });
  const done = await settleWorkflowApproval(env, ORG, {
    id: run.cardId, workflowApproval: { runId: run.id }, recipientUserID: 'toru',
    decision: { action: 'approve', actorUserID: 'toru' },
  });
  expect(done.status).toBe('done');
  expect((await messages(mika)).map(m => m.body)).toContain('Original approved action');
  expect((await messages(mika)).map(m => m.body)).not.toContain('Replacement');
});

test("deferred posts cannot enter a room after the owner loses access", async () => {
  const { createWorkflow, startRun } = await import('../src/harness/workflows.js');
  const { workflow } = await createWorkflow(env.DB, ORG, {
    name: 'Access recheck', trigger: { type: 'manual' }, steps: [{ type: 'post', channel: 'b:ops', text: 'Forbidden' }],
  }, '9302');
  await env.DB.prepare("UPDATE businesses SET private = 1 WHERE org_id = ?1 AND slug = 'ops'").bind(ORG).run();
  const run = await startRun(env, { orgId: ORG, workflow, trigger: 'manual' });
  expect(run.status).toBe('failed');
  expect(run.log[0].error).toBe('Conversation access required.');
});

test('private follow-ups are hidden in lists and home and cannot be cancelled by outsiders', async () => {
  const made = await send('POST', '/followups', mika, { orgId: ORG, channel: 'b:ops', instruction: 'Confidential', minutes: 60 });
  expect(made.status).toBe(201);
  const { followup } = await made.json();
  await env.DB.prepare("UPDATE businesses SET private = 1 WHERE org_id = ?1 AND slug = 'ops'").bind(ORG).run();
  await env.DB.prepare("INSERT INTO conversation_members (org_id, channel, login, added_by, added_at) VALUES (?1, 'b:ops', 'mika', 'mika', ?2)").bind(ORG, new Date().toISOString()).run();
  expect((await (await get(`/followups?${q({ orgId: ORG })}`, toru)).json()).followups).toEqual([]);
  expect((await (await get(`/harness/home?${q({ orgId: ORG })}`, toru)).json()).followups).toEqual([]);
  expect((await call(`/followups/${followup.id}?${q({ orgId: ORG })}`, { method: 'DELETE', headers: headers(toru) })).status).toBe(404);
  expect((await (await get(`/followups?${q({ orgId: ORG })}`, mika)).json()).followups).toHaveLength(1);
});

test('run history retains its original room restrictions after the workflow is edited', async () => {
  const { createWorkflow, startRun, updateWorkflow, getRun } = await import('../src/harness/workflows.js');
  const { workflow } = await createWorkflow(env.DB, ORG, { name: 'Private output', trigger: { type: 'manual' }, steps: [{ type: 'post', channel: 'b:ops', text: 'Private result' }] }, '9302');
  const run = await startRun(env, { orgId: ORG, workflow, trigger: 'manual' });
  await env.DB.prepare("UPDATE businesses SET private = 1 WHERE org_id = ?1 AND slug = 'ops'").bind(ORG).run();
  expect((await get(`/workflows/${workflow.id}?${q({ orgId: ORG })}`, toru)).status).toBe(404);
  await updateWorkflow(env.DB, ORG, workflow.id, { steps: [{ type: 'approval', to: 'toru', title: 'Public' }] });
  expect(await getRun(env.DB, ORG, run.id, { viewerId: '9301' })).toBeNull();
});

test('natural language generation refuses unavailable AI instead of silently making a substitute', async () => {
  const response = await send('POST', '/workflows/generate', mika, { orgId: ORG, prompt: 'Every day post a reminder', channel: 'b:ops', useModel: false });
  expect(response.status).toBe(503);
  expect((await (await get(`/workflows?${q({ orgId: ORG })}`, mika)).json()).workflows).toEqual([]);
});

test('generated workflows are paused and reject inaccessible resources and unsupported steps', async () => {
  const { workflowFromPrompt } = await import('../src/harness/workflowGeneration.js');
  const spec = { name: 'Daily reminder', trigger: { type: 'schedule', cadence: 'daily', hour: 9, minute: 15, timezone: 'Asia/Tokyo' }, steps: [{ type: 'post', channel: 'b:ops', text: 'Check tasks' }], enabled: true };
  const made = await workflowFromPrompt(env.DB, ORG, '9302', { prompt: 'Every day at 9:15 remind us', complete: async () => JSON.stringify(spec) });
  expect(made.workflow.enabled).toBe(false);
  const saved = (await (await send('POST', '/workflows', mika, { orgId: ORG, ...made.workflow })).json()).workflow;
  expect(saved.enabled).toBe(false);
  expect(saved.nextRunAt).toBeNull();
  expect(saved.steps[0].text).toBe('Check tasks');
  expect((await messages(mika)).some(message => message.body === 'Check tasks')).toBe(false);
  expect((await send('POST', `/workflows/${saved.id}/run`, mika, { orgId: ORG })).status).toBe(201);
  expect((await messages(mika)).some(message => message.body === 'Check tasks')).toBe(true);
  expect((await (await get(`/workflows/${saved.id}?${q({ orgId: ORG })}`, mika)).json()).workflow.enabled).toBe(false);
  spec.steps[0].channel = 'b:nonexistent';
  expect((await workflowFromPrompt(env.DB, ORG, '9302', { prompt: 'Post', complete: async () => JSON.stringify(spec) })).status).toBe(403);
  spec.steps = [{ type: 'shell', command: 'echo unsafe' }];
  expect((await workflowFromPrompt(env.DB, ORG, '9302', { prompt: 'Run', complete: async () => JSON.stringify(spec) })).error).toBeTruthy();
});

test('generation validates malformed output, invalid schedules and foreign rooms', async () => {
  const { workflowFromPrompt } = await import('../src/harness/workflowGeneration.js');
  expect((await workflowFromPrompt(env.DB, ORG, '9302', { prompt: 'do something', complete: async () => 'not json' })).error).toBeTruthy();
  expect((await workflowFromPrompt(env.DB, ORG, '9302', { prompt: 'daily', complete: async () => JSON.stringify({ name: 'bad', trigger: { type: 'schedule', cadence: 'daily', hour: 99 }, steps: [{ type: 'post', channel: 'b:ops', text: 'hello' }] }) })).error).toBeTruthy();
  expect((await send('POST', '/workflows/generate', mika, { orgId: ORG, prompt: 'Post', channel: 'b:foreign', useModel: false })).status).toBe(403);
  expect((await send('POST', '/apps/generate', mika, { orgId: ORG, prompt: 'Tracker', channel: 'b:foreign', useModel: false })).status).toBe(403);
});

test('an app generated in an agent DM resolves the room and remains private', async () => {
  const { agent } = await (await send('POST', '/channels/agents', mika, { orgId: ORG, name: 'Builder', handle: 'builder', instructions: 'Build apps.', scope: 'personal' })).json();
  const room = `ag:${agent.id}`;
  const response = await send('POST', '/apps/generate', mika, { orgId: ORG, prompt: 'Task tracker', channel: room, useModel: false });
  expect(response.status).toBe(201);
  const { app } = await response.json();
  const listed = await (await get(`/apps?${q({ orgId: ORG, channel: room })}`, mika)).json();
  expect(listed.apps.map(a => a.id)).toContain(app.id);
  expect(listed.apps.find(a => a.id === app.id).channels).toEqual([`${room}|mika`]);
  expect((await get(`/apps/${app.id}?${q({ orgId: ORG })}`, toru)).status).toBe(404);
});

test("an approval goes only to someone in this workspace, checked when saved and again when it runs", async () => {
  const { upsertUser, upsertMembership } = await import("../src/db.js");
  // Zed has an account, in another workspace; Kai is here until removed.
  await upsertUser(env.DB, { githubId: "9304", login: "zed", name: "Zed", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, "personal:elsewhere", "9304", "admin");
  await upsertUser(env.DB, { githubId: "9303", login: "kai", name: "Kai", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "9303", "member");
  const flow = (to) => ({ orgId: ORG, name: `Ask ${to}`, trigger: { type: "manual" }, steps: [{ type: "approval", to, title: "Secret plan", summary: "Only for us" }] });

  const refused = await send("POST", "/workflows", mika, flow("zed"));
  expect(refused.status).toBe(400);
  expect((await refused.json()).message).toMatch(/zed/);
  const { workflow: viaTemplate } = await (await send("POST", "/workflows", mika, flow("{{input.who}}"))).json();
  expect((await send("PUT", `/workflows/${viaTemplate.id}`, mika, { orgId: ORG, steps: flow("@zed").steps })).status).toBe(400);
  const { workflow: toKai } = await (await send("POST", "/workflows", mika, flow("kai"))).json();

  const outsider = (await (await send("POST", `/workflows/${viaTemplate.id}/run`, mika, { orgId: ORG, input: { who: "zed" } })).json()).run;
  expect(outsider).toMatchObject({ status: "failed", cardId: null });
  expect(outsider.log[0]).toMatchObject({ status: "failed", error: "Nobody by that name here." });
  await env.DB.prepare("DELETE FROM memberships WHERE org_id = ?1 AND user_github_id = '9303'").bind(ORG).run();
  const removed = (await (await send("POST", `/workflows/${toKai.id}/run`, mika, { orgId: ORG })).json()).run;
  expect(removed.status).toBe("failed");
  // Nothing was saved or queued for either of them.
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cards WHERE org_id = ?1").bind(ORG).first()).n).toBe(0);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_jobs").first()).n).toBe(0);

  // A member named through the template still gets the approval.
  const member = (await (await send("POST", `/workflows/${viaTemplate.id}/run`, mika, { orgId: ORG, input: { who: "toru" } })).json()).run;
  expect(member.status).toBe("waiting");
  expect((await (await get(`/approvals?${q({ orgId: ORG })}`, toru)).json()).toDecide).toEqual([expect.objectContaining({ title: "Secret plan", kind: "workflow" })]);
});

test("a decision on a run's first approval, replayed, does not answer its second", async () => {
  const { createWorkflow, startRun, settleWorkflowApproval, getRun } = await import("../src/harness/workflows.js");
  const { getCard } = await import("../src/db.js");
  const { workflow } = await createWorkflow(env.DB, ORG, {
    name: "Two gates", trigger: { type: "manual" }, steps: [
      { type: "approval", to: "toru", title: "Approve A?" },
      { type: "approval", to: "toru", title: "Approve B?" },
      { type: "post", channel: "b:ops", text: "Reached the final step" },
    ],
  }, "9302");
  const run = await startRun(env, { orgId: ORG, workflow, trigger: "manual", startedBy: "9302" });
  const decided = (card) => ({ ...card, status: "approved", decision: { action: "approve", actorUserID: "toru", decidedAt: new Date().toISOString() } });
  const first = await getCard(env.DB, ORG, run.cardId);
  const atSecond = await settleWorkflowApproval(env, ORG, decided(first));
  expect(atSecond).toMatchObject({ status: "waiting", nextStep: 2 });
  expect(atSecond.cardId).not.toBe(first.id);
  // The first card is kept as it was, beside the second.
  expect((await getCard(env.DB, ORG, first.id)).title).toBe("Approve A?");
  expect((await getCard(env.DB, ORG, atSecond.cardId)).title).toBe("Approve B?");

  expect(await settleWorkflowApproval(env, ORG, decided(first))).toBeNull();
  expect(await getRun(env.DB, ORG, run.id)).toMatchObject({ status: "waiting", nextStep: 2, cardId: atSecond.cardId });
  expect((await messages(mika)).map((m) => m.body)).not.toContain("Reached the final step");

  const done = await settleWorkflowApproval(env, ORG, decided(await getCard(env.DB, ORG, atSecond.cardId)));
  expect(done.status).toBe("done");
  expect((await messages(mika)).map((m) => m.body)).toContain("Reached the final step");
});

test("a workflow's approval card has a priority every client reads, and old ones are repaired", async () => {
  const { createWorkflow, startRun } = await import("../src/harness/workflows.js");
  const { getCard, saveCard } = await import("../src/db.js");
  const { PRIORITIES } = await import("../src/agui/validate.js");
  const { workflow } = await createWorkflow(env.DB, ORG, { name: "Gate", trigger: { type: "manual" }, steps: [{ type: "approval", to: "toru", title: "Go?" }] }, "9302");
  const run = await startRun(env, { orgId: ORG, workflow, trigger: "manual", startedBy: "9302" });
  expect(PRIORITIES.has((await getCard(env.DB, ORG, run.cardId)).priority)).toBe(true);

  await saveCard(env.DB, ORG, { id: "wf-run_old", recipientUserID: "toru", senderUserID: "toru", type: "approval", title: "Old", summary: "", status: "pending", priority: "normal", createdAt: new Date().toISOString(), workflowApproval: { runId: "run_old" } });
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  expect((await getCard(env.DB, ORG, "wf-run_old")).priority).toBe("medium");
  expect((await env.DB.prepare("SELECT priority FROM cards WHERE card_id = 'wf-run_old'").first()).priority).toBe("medium");
});

test("a workflow's follow-up is scheduled with its maker's access, and checked again when due", async () => {
  const { createWorkflow, startRun } = await import("../src/harness/workflows.js");
  const { workflow } = await createWorkflow(env.DB, ORG, {
    name: "Chase later", trigger: { type: "manual" }, steps: [{ type: "followup", channel: "b:ops", text: "Did {{input.text}} pay?", minutes: 60 }],
  }, "9302");
  const run = await startRun(env, { orgId: ORG, workflow, trigger: "manual", input: { text: "Acme" }, startedBy: "9302" });
  expect(run.status).toBe("done");
  const { followups } = await (await get(`/followups?${q({ orgId: ORG, channel: "b:ops" })}`, mika)).json();
  expect(followups).toEqual([expect.objectContaining({ id: run.log[0].output, instruction: "Did Acme pay?", createdBy: "9302" })]);
  expect(await runDueFollowups(env, { now: new Date(Date.now() + 2 * 3600000) })).toBe(1);
  expect((await messages(mika)).map((m) => m.body)).toContain("⏰ Follow-up: Did Acme pay?");

  // Its maker gone from the workspace, the next one is never posted.
  const again = await startRun(env, { orgId: ORG, workflow, trigger: "manual", input: { text: "Globex" }, startedBy: "9302" });
  expect(again.status).toBe("done");
  await env.DB.prepare("DELETE FROM memberships WHERE org_id = ?1 AND user_github_id = '9302'").bind(ORG).run();
  expect(await runDueFollowups(env, { now: new Date(Date.now() + 2 * 3600000) })).toBe(0);
  expect((await messages(toru)).map((m) => m.body)).not.toContain("⏰ Follow-up: Did Globex pay?");
  expect((await startRun(env, { orgId: ORG, workflow, trigger: "manual", input: { text: "Initech" } })).status).toBe("failed");
});

test("what starts a run is kept whole: a large webhook body still renders, and one too large to keep fails before any step", async () => {
  const { createWorkflow, startRun, continueRun, getRun, MAX_INPUT } = await import("../src/harness/workflows.js");
  const made = await (await send("POST", "/workflows", mika, {
    orgId: ORG, name: "Customer hook", trigger: { type: "webhook" },
    steps: [{ type: "post", channel: "b:ops", text: "Customer: {{input.customer}}" }],
  })).json();
  const path = new URL(made.hookUrl).pathname;
  const body = JSON.stringify({ customer: "Acme \"東京\"", padding: "x".repeat(25000) });
  const hooked = await (await call(`${path}?secret=${made.workflow.hookSecret}`, { method: "POST", headers: { "content-type": "application/json" }, body })).json();
  expect(hooked.status).toBe("done");
  expect((await messages(mika)).map((m) => m.body)).toContain("Customer: Acme \"東京\"");
  expect((await getRun(env.DB, ORG, hooked.runId)).input.customer).toBe("Acme \"東京\"");

  const { workflow } = await createWorkflow(env.DB, ORG, { name: "Big", trigger: { type: "manual" }, steps: [{ type: "post", channel: "b:ops", text: "Got {{input.customer}}" }] }, "9302");
  const huge = await startRun(env, { orgId: ORG, workflow, trigger: "manual", input: { customer: "Initech", padding: "x".repeat(MAX_INPUT) } });
  expect(huge).toMatchObject({ status: "failed", input: null });
  expect(huge.log).toEqual([expect.objectContaining({ step: 1, status: "failed", error: expect.stringMatching(/over/) })]);
  expect((await messages(mika)).map((m) => m.body)).not.toContain("Got Initech");

  // A run whose stored input no longer reads as JSON fails rather than
  // going on as though nothing had started it.
  await env.DB.prepare(`INSERT INTO hx_workflow_runs (id, org_id, workflow_id, trigger, status, input, log, next_step, started_at)
    VALUES ('run_cut', ?1, ?2, 'webhook', 'running', '{"customer":"Globex","padding":"xx', '[]', 0, ?3)`).bind(ORG, workflow.id, new Date().toISOString()).run();
  const cut = await continueRun(env, { orgId: ORG, runId: "run_cut", workflow });
  expect(cut.status).toBe("failed");
  expect(cut.log[0]).toMatchObject({ status: "failed", error: "What started this run can no longer be read." });
  expect((await messages(mika)).some((m) => m.body.startsWith("Got "))).toBe(false);
});

test.each(['workflow', 'followup'])('%s reads an installed skill through its execution entry and records both model rounds', async kind => {
  const agent = (await (await send('POST','/channels/agents',mika,{orgId:ORG,name:'Procedure helper',handle:'procedure',instructions:'Follow the installed procedure.',scope:'team'})).json()).agent;
  const skill = (await (await send('POST','/skills',mika,{orgId:ORG,name:'Release procedure',description:'Review a release',body:'CHECK THE FINAL RELEASE RESULT',visibility:'workspace'})).json()).skill;
  expect((await send('POST',`/hx/agents/${agent.id}/skills`,mika,{orgId:ORG,skillId:skill.id})).status).toBe(200);
  const bodies=[];
  fetchMock.activate();
  fetchMock.get('https://api.openai.com').intercept({path:'/v1/chat/completions',method:'POST'}).reply(200,opts=>{
    bodies.push(JSON.parse(opts.body));
    return {choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'read-procedure',type:'function',function:{name:'read_installed_skill',arguments:JSON.stringify({skill_id:skill.id})}}]}}],usage:{prompt_tokens:10,completion_tokens:4}};
  });
  fetchMock.get('https://api.openai.com').intercept({path:'/v1/chat/completions',method:'POST'}).reply(200,opts=>{
    bodies.push(JSON.parse(opts.body));
    return {choices:[{message:{content:'PROCEDURE VERIFIED'}}],usage:{prompt_tokens:20,completion_tokens:6}};
  });
  try {
    const modelEnv={...env,OPENAI_API_KEY:'sk-test'};
    if(kind==='workflow') {
      const {createWorkflow,startRun}=await import('../src/harness/workflows.js');
      const {workflow}=await createWorkflow(env.DB,ORG,{name:'Review release',trigger:{type:'manual'},steps:[{type:'agent',agentId:agent.id,channel:'b:ops',prompt:'Review the release'}]},'9302');
      const result=await startRun(modelEnv,{orgId:ORG,workflow,trigger:'manual',startedBy:'9302'});
      expect(result.status).toBe('done');
      expect(result.log[0].output).toBe('PROCEDURE VERIFIED');
    } else {
      const {scheduleFollowup}=await import('../src/harness/followups.js');
      const {followup}=await scheduleFollowup(env.DB,{orgId:ORG,channel:'b:ops',agentId:agent.id,instruction:'Review the release',dueAt:new Date(Date.now()+60000).toISOString(),by:'9302'});
      await runDueFollowups(modelEnv,{now:new Date(Date.now()+120000)});
      expect(await env.DB.prepare('SELECT status,result FROM hx_followups WHERE id=?').bind(followup.id).first()).toMatchObject({status:'done',result:'PROCEDURE VERIFIED'});
    }
    fetchMock.assertNoPendingInterceptors();
  } finally { fetchMock.deactivate(); }
  expect(bodies[0].messages[0].content).toContain(skill.id);
  expect(bodies[0].messages[0].content).not.toContain('CHECK THE FINAL RELEASE RESULT');
  expect(bodies[1].messages.find(m=>m.role==='tool').content).toContain('CHECK THE FINAL RELEASE RESULT');
  const {results:calls}=await env.DB.prepare('SELECT purpose,input_tokens,output_tokens,user_github_id FROM ai_calls WHERE org_id=? ORDER BY id').bind(ORG).all();
  expect(calls).toEqual([
    {purpose:kind==='workflow'?'workflow_agent':'followup',input_tokens:10,output_tokens:4,user_github_id:'9302'},
    {purpose:kind==='workflow'?'workflow_agent':'followup',input_tokens:20,output_tokens:6,user_github_id:'9302'},
  ]);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM ai_reservations').first()).n).toBe(0);
});
