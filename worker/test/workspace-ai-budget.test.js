import { env } from "cloudflare:test";
import { beforeEach, expect, test, vi } from "vitest";
import schemaSql from "../schema.sql?raw";
import { allowanceFor } from "../src/gate.js";
import { jevEntry, noteSearches, noteUsage, settleUsage, webSearchCostMicros } from "../src/ledger.js";
import { claimWorkspaceBudgetNotice, estimateWorkspaceBudgetMicros, releaseWorkspaceAIBudgetReservation, reserveWorkspaceAIBudgetCall, saveWorkspaceAIBudget, workspaceAIBudgetStatus, workspaceBudgetAdmission } from "../src/workspaceAIBudget.js";
import { requestWithWorkspaceBudget } from "../src/workspaceBudgetRequest.js";
import { askJev } from "../src/jev.js";

const ORG = "workspace:shared-budget";
const NOW = () => new Date(Date.now() - 1_000).toISOString();

beforeEach(async () => { await env.DB.exec(schemaSql.replace(/\n/g, " ")); });

test("shared workspace budget stores rolling limits with revision checks", async () => {
  const saved = await saveWorkspaceAIBudget(env.DB, ORG, {
    revision: 0, dailyLimitUsd: 1.25, weeklyLimitUsd: 4, monthlyLimitUsd: 9.5, action: "pause",
  }, "42", NOW());
  expect(saved.status).toMatchObject({ revision: 1, action: "pause" });
  expect(saved.status.periods["24h"]).toMatchObject({ limitMicros: 1_250_000, usedMicros: 0 });
  expect((await saveWorkspaceAIBudget(env.DB, ORG, { revision: 0, dailyLimitUsd: 2, weeklyLimitUsd: 0, monthlyLimitUsd: 0 }, "42", NOW())).status).toBe(409);
  const kept = await saveWorkspaceAIBudget(env.DB, ORG, { revision: 1, dailyLimitUsd: 2 }, "42", NOW());
  expect(kept.status).toMatchObject({ revision: 2, action: "pause" });
  expect(kept.status.periods["7d"].limitUsd).toBe(4);
});

test("the shared stop affects new deployment-key requests after estimated usage reaches the cap", async () => {
  await saveWorkspaceAIBudget(env.DB, ORG, {
    revision: 0, dailyLimitUsd: 0.5, weeklyLimitUsd: 0, monthlyLimitUsd: 0, action: "pause",
  }, "42", NOW());
  await env.DB.prepare(`INSERT INTO ai_calls(org_id,user_github_id,purpose,provider,model,input_tokens,output_tokens,usd,byok,created_at)
    VALUES(?1,'42','ask','OpenAI','gpt-4o-mini',100,100,0.5,0,?2)`).bind(ORG, NOW()).run();
  expect(await workspaceAIBudgetStatus(env.DB, ORG)).toMatchObject({ periods: { "24h": { exhausted: true } } });
  expect(await allowanceFor({ DB: env.DB }, ORG, { githubId: "42" })).toMatchObject({
    allowed: false, workspaceBudgetExceeded: true,
  });
});

test("a reached pause budget notifies current admins once per settings revision", async () => {
  const saved = await saveWorkspaceAIBudget(env.DB, ORG, {
    revision: 0, dailyLimitUsd: 0.5, weeklyLimitUsd: 0, monthlyLimitUsd: 0, action: "pause",
  }, "42", NOW());
  await env.DB.prepare(`INSERT INTO users(github_id,login,created_at) VALUES
    ('owner-1','owner-one',?1),('admin-1','admin-one',?1),('member-1','member-one',?1)`).bind(NOW()).run();
  await env.DB.prepare(`INSERT INTO memberships(org_id,user_github_id,role,created_at) VALUES
    (?1,'owner-1','owner',?2),(?1,'admin-1','admin',?2),(?1,'member-1','member',?2)`).bind(ORG,NOW()).run();
  await env.DB.prepare(`INSERT INTO ai_calls(org_id,user_github_id,purpose,provider,model,input_tokens,output_tokens,usd,byok,created_at)
    VALUES(?1,'42','ask','OpenAI','gpt-4o-mini',100,100,0.5,0,?2)`).bind(ORG,NOW()).run();
  const admission = await workspaceBudgetAdmission(env.DB, ORG);
  expect(admission).toMatchObject({ allowed:false, reason:'workspace_ai_budget', budget:{revision:saved.status.revision} });
  expect(await claimWorkspaceBudgetNotice(env.DB, ORG, admission.budget)).toMatchObject({
    revision: saved.status.revision, periods:['24h'], logins:['admin-one','owner-one'],
  });
  expect(await claimWorkspaceBudgetNotice(env.DB, ORG, admission.budget)).toBeNull();

  await saveWorkspaceAIBudget(env.DB, ORG, { revision:saved.status.revision, dailyLimitUsd:0.4 }, '42', NOW());
  const next = await workspaceBudgetAdmission(env.DB, ORG);
  expect(await claimWorkspaceBudgetNotice(env.DB, ORG, next.budget)).toMatchObject({ revision:saved.status.revision+1, periods:['24h'] });
});

test("budget admission announces one scoped event only to current workspace admins", async () => {
  const orgId = `${ORG}:relay`;
  await saveWorkspaceAIBudget(env.DB, orgId, {
    revision:0, dailyLimitUsd:0.5, weeklyLimitUsd:0, monthlyLimitUsd:0, action:'pause',
  }, '42', NOW());
  await env.DB.prepare(`INSERT INTO users(github_id,login,created_at) VALUES
    ('owner-r','owner-relay',?1),('admin-r','admin-relay',?1),('member-r','member-relay',?1)`).bind(NOW()).run();
  await env.DB.prepare(`INSERT INTO memberships(org_id,user_github_id,role,created_at) VALUES
    (?1,'owner-r','owner',?2),(?1,'admin-r','admin',?2),(?1,'member-r','member',?2)`).bind(orgId,NOW()).run();
  await env.DB.prepare(`INSERT INTO ai_calls(org_id,user_github_id,purpose,provider,model,input_tokens,output_tokens,usd,byok,created_at)
    VALUES(?1,'42','ask','OpenAI','gpt-4o-mini',100,100,0.5,0,?2)`).bind(orgId,NOW()).run();
  const sent=[];
  const notificationEnv={DB:env.DB,ORG_RELAY:{idFromName:(id)=>id,get:()=>({fetch:async(_url,init)=>{sent.push(JSON.parse(init.body));return new Response('{}')}})}};

  await allowanceFor(notificationEnv,orgId,{githubId:'42'});
  await allowanceFor(notificationEnv,orgId,{githubId:'42'});

  expect(sent).toHaveLength(1);
  expect(sent[0].deliveries.map((delivery)=>delivery.to).sort()).toEqual(['admin-relay','owner-relay']);
  expect(sent[0].deliveries[0].event).toMatchObject({type:'CUSTOM',name:'workspace_ai_budget_reached',value:{orgId,periods:['24h'],revision:1}});
});

test("warn-only and BYOK usage do not block the deployment-key budget", async () => {
  await saveWorkspaceAIBudget(env.DB, ORG, {
    revision: 0, dailyLimitUsd: 0.01, weeklyLimitUsd: 0, monthlyLimitUsd: 0, action: "warn",
  }, "42", NOW());
  await env.DB.prepare(`INSERT INTO ai_calls(org_id,purpose,provider,model,usd,byok,created_at)
    VALUES(?1,'ask','OpenAI','gpt-4o',1,1,?2)`).bind(ORG, NOW()).run();
  expect((await workspaceAIBudgetStatus(env.DB, ORG)).periods["24h"]).toMatchObject({ usedUsd: 0, exhausted: false });
  expect(await allowanceFor({ DB: env.DB }, ORG, { githubId: "42" })).toMatchObject({ allowed: true });
});

test("pause fails closed for unknown model prices in each active rolling window", async () => {
  const now = Date.now();
  const cases = [
    ["24h", 1, 0, 0, 23 * 60 * 60 * 1000],
    ["7d", 0, 1, 0, 6 * 86_400_000],
    ["30d", 0, 0, 1, 29 * 86_400_000],
  ];
  let revision = 0;
  for (const [period, daily, weekly, monthly, age] of cases) {
    await env.DB.prepare("DELETE FROM ai_calls WHERE org_id=?1").bind(ORG).run();
    await saveWorkspaceAIBudget(env.DB, ORG, {
      revision, dailyLimitUsd: daily, weeklyLimitUsd: weekly, monthlyLimitUsd: monthly, action: "pause",
    }, "42", new Date(now).toISOString());
    revision += 1;
    await env.DB.prepare(`INSERT INTO ai_calls(org_id,user_github_id,purpose,provider,model,input_tokens,output_tokens,usd,byok,created_at)
      VALUES(?1,'42','ask','OpenAI','gpt-9-preview',1000,500,0.0001,0,?2)`)
      .bind(ORG, new Date(now - age).toISOString()).run();
    const status = await workspaceAIBudgetStatus(env.DB, ORG, now);
    expect(status.periods[period]).toMatchObject({ calls: 1, unpricedCalls: 1, indeterminate: true, exhausted: false });
    expect(await workspaceBudgetAdmission(env.DB, ORG, now)).toMatchObject({
      allowed: false, reason: "workspace_ai_budget", status: 409,
      message: expect.stringContaining("model without a known list price"),
    });
  }
});

test("warning mode reports unknown model prices without blocking; explicit search and Jev prices remain known", async () => {
  const now = Date.now();
  await saveWorkspaceAIBudget(env.DB, ORG, {
    revision: 0, dailyLimitUsd: 0.01, weeklyLimitUsd: 0, monthlyLimitUsd: 0, action: "warn",
  }, "42", new Date(now).toISOString());
  await env.DB.prepare(`INSERT INTO ai_calls(org_id,user_github_id,purpose,provider,model,input_tokens,output_tokens,usd,byok,created_at)
    VALUES(?1,'42','ask','OpenAI','gpt-9-preview',1000,500,0.0001,0,?2),
          (?1,'42','search','OpenAI','web_search',0,0,0.01,0,?2),
          (?1,'42','ask','jev','jev-latest',1000,0,0.000042,0,?2)`)
    .bind(ORG, new Date(now - 1_000).toISOString()).run();
  const status = await workspaceAIBudgetStatus(env.DB, ORG, now);
  expect(status.periods["24h"]).toMatchObject({ calls: 3, unpricedCalls: 1, indeterminate: true });
  expect(await workspaceBudgetAdmission(env.DB, ORG, now)).toMatchObject({ allowed: true });
  expect(await allowanceFor({ DB: env.DB }, ORG, { githubId: "42" })).toMatchObject({ allowed: true });
});

test("workspace pause reservations atomically include concurrent deployment model calls", async () => {
  const now = Date.now();
  await saveWorkspaceAIBudget(env.DB, ORG, {
    revision: 0, dailyLimitUsd: 0.001, weeklyLimitUsd: 0, monthlyLimitUsd: 0, action: "pause",
  }, "42", new Date(now).toISOString());
  const request = { orgId: ORG, model: "gpt-4o-mini", inputTokens: 1000, outputTokens: 1000, now };
  const [left, right] = await Promise.all([
    reserveWorkspaceAIBudgetCall(env.DB, request),
    reserveWorkspaceAIBudgetCall(env.DB, request),
  ]);
  expect([left, right].filter((result) => result.allowed)).toHaveLength(1);
  expect([left, right].filter((result) => !result.allowed)).toMatchObject([{ reason: "workspace_ai_budget" }]);
  const first = left.allowed ? left : right;
  expect((await workspaceAIBudgetStatus(env.DB, ORG, now)).periods["24h"])
    .toMatchObject({ usedMicros: 750, calls: 1, exhausted: false });
  await releaseWorkspaceAIBudgetReservation(env.DB, first.reservationId, now);
  expect(await reserveWorkspaceAIBudgetCall(env.DB, request)).toMatchObject({ allowed: true, reservedMicros: 750 });
});

test("expired dispatch reservations become unknown usage and fail closed for capped windows", async () => {
  const now = Date.now();
  await saveWorkspaceAIBudget(env.DB, ORG, {
    revision: 0, dailyLimitUsd: 1, weeklyLimitUsd: 0, monthlyLimitUsd: 0, action: "pause",
  }, "42", new Date(now).toISOString());
  const held = await reserveWorkspaceAIBudgetCall(env.DB, {
    orgId: ORG, model: "gpt-4o-mini", inputTokens: 100, outputTokens: 100, now: now - 600_000,
  });
  expect(held.allowed).toBe(true);
  const status = await workspaceAIBudgetStatus(env.DB, ORG, now);
  expect(status.periods["24h"]).toMatchObject({ calls: 1, unpricedCalls: 1, indeterminate: true });
  expect(await workspaceBudgetAdmission(env.DB, ORG, now)).toMatchObject({ allowed: false, reason: "workspace_ai_budget" });
});

test("provider usage settles its workspace reservation with the ledger entry", async () => {
  const now = Date.now();
  await saveWorkspaceAIBudget(env.DB, ORG, {
    revision: 0, dailyLimitUsd: 1, weeklyLimitUsd: 0, monthlyLimitUsd: 0, action: "pause",
  }, "42", new Date(now).toISOString());
  const reservation = await reserveWorkspaceAIBudgetCall(env.DB, {
    orgId: ORG, model: "gpt-4o-mini", inputTokens: 1000, outputTokens: 1000, now,
  });
  const provider = { model: "gpt-4o-mini", providerName: "OpenAI", usage: [] };
  noteUsage(provider, "budgeted-call", { model: "gpt-4o-mini", usage: { prompt_tokens: 1000, completion_tokens: 1000 } });
  await settleUsage(env.DB, provider, { orgId: ORG, githubId: "42" }, [], reservation.reservationId);
  expect(await env.DB.prepare("SELECT status FROM hx_workspace_ai_budget_reservations WHERE id=?1").bind(reservation.reservationId).first())
    .toMatchObject({ status: "settled" });
  expect((await workspaceAIBudgetStatus(env.DB, ORG, Date.now())).periods["24h"])
    .toMatchObject({ usedMicros: 750, calls: 1, unpricedCalls: 0 });
});

test("direct provider requests reserve before dispatch and settle against their recorded usage", async () => {
  await saveWorkspaceAIBudget(env.DB, ORG, {
    revision: 0, dailyLimitUsd: 1, weeklyLimitUsd: 0, monthlyLimitUsd: 0, action: "pause",
  }, "42", NOW());
  const provider = {
    model: "gpt-4o-mini", providerName: "OpenAI", apiKey: "deployment-key", byok: false,
    usage: [], workspaceBudgetDb: env.DB, workspaceBudgetOrgId: ORG, workspaceBudgetReservations: [],
  };
  const originalFetch = globalThis.fetch;
  let dispatched = 0;
  vi.stubGlobal("fetch", async () => {
    dispatched += 1;
    return Response.json({ id: "resp-direct", model: "gpt-4o-mini", usage: { prompt_tokens: 50, completion_tokens: 1000 } });
  });
  try {
    const response = await requestWithWorkspaceBudget(provider, "https://provider.invalid", {
      method: "POST", body: JSON.stringify({ model: provider.model, max_tokens: 1000, messages: [{ role: "user", content: "hello" }] }),
    });
    expect(response.ok).toBe(true);
    const data = await response.json();
    noteUsage(provider, "direct-route", data);
    const reservationId = provider.usage[0]?.workspaceReservationId;
    expect(reservationId).toBeTruthy();
    await settleUsage(env.DB, provider, { orgId: ORG, githubId: "42" });
    expect(await env.DB.prepare("SELECT status FROM hx_workspace_ai_budget_reservations WHERE id=?1").bind(reservationId).first())
      .toMatchObject({ status: "settled" });
    const call = await env.DB.prepare("SELECT purpose,usd FROM ai_calls WHERE org_id=?1").bind(ORG).first();
    expect(call.purpose).toBe("direct-route");
    expect(call.usd).toBeCloseTo(0.0006075, 9);
    expect(dispatched).toBe(1);
  } finally {
    vi.stubGlobal("fetch", originalFetch);
  }
});

test("direct provider requests fail closed before dispatch when a capped reservation cannot fit", async () => {
  await saveWorkspaceAIBudget(env.DB, ORG, {
    revision: 0, dailyLimitUsd: 0.0001, weeklyLimitUsd: 0, monthlyLimitUsd: 0, action: "pause",
  }, "42", NOW());
  const provider = {
    model: "gpt-4o-mini", providerName: "OpenAI", apiKey: "deployment-key", byok: false,
    usage: [], workspaceBudgetDb: env.DB, workspaceBudgetOrgId: ORG, workspaceBudgetReservations: [],
  };
  const originalFetch = globalThis.fetch;
  let dispatched = 0;
  vi.stubGlobal("fetch", async () => { dispatched += 1; return Response.json({}); });
  try {
    const response = await requestWithWorkspaceBudget(provider, "https://provider.invalid", {
      method: "POST", body: JSON.stringify({ model: provider.model, max_tokens: 1000, messages: [{ role: "user", content: "a sufficiently long direct request" }] }),
    });
    expect(response.status).toBe(429);
    expect(dispatched).toBe(0);
  } finally {
    vi.stubGlobal("fetch", originalFetch);
  }
});

test("deployment web search reserves token and per-call costs before dispatch and bounds built-in search calls", async () => {
  const now = Date.now();
  await saveWorkspaceAIBudget(env.DB, ORG, {
    revision: 0, dailyLimitUsd: 0.25, weeklyLimitUsd: 0, monthlyLimitUsd: 0, action: "pause",
  }, "42", new Date(now).toISOString());
  const tokenOnly = await reserveWorkspaceAIBudgetCall(env.DB, {
    orgId: ORG, model: "gpt-5-mini", inputTokens: 1000, outputTokens: 100,
  });
  expect(tokenOnly).toMatchObject({ allowed: true });
  await releaseWorkspaceAIBudgetReservation(env.DB, tokenOnly.reservationId);

  const provider = {
    model: "gpt-5-mini", providerName: "OpenAI", apiKey: "deployment-key", byok: false,
    usage: [], workspaceBudgetDb: env.DB, workspaceBudgetOrgId: ORG, workspaceBudgetReservations: [],
  };
  const originalFetch = globalThis.fetch;
  let dispatched = 0;
  vi.stubGlobal("fetch", async (_url, init) => {
    dispatched += 1;
    const dispatchedBody = JSON.parse(init.body);
    expect(dispatchedBody.max_tool_calls).toBe(4);
    expect(dispatchedBody.tools[0].return_token_budget).toBe('default');
    return Response.json({
      id: "resp-search-budget", model: provider.model,
      usage: { input_tokens: 1000, output_tokens: 10 },
      output: [
        { type: "web_search_call", action: { type: "search", query: "one" } },
        { type: "web_search_call", action: { type: "search", query: "two" } },
      ],
    });
  });
  try {
    const response = await requestWithWorkspaceBudget(provider, "https://provider.invalid", {
      method: "POST", body: JSON.stringify({
        model: provider.model, max_output_tokens: 100, max_tool_calls: 20,
        tools: [{ type: "web_search", return_token_budget: "unlimited", search_context_size: "high" }], input: "Find this fact",
      }),
    });
    expect(response.ok).toBe(true);
    const data = await response.json();
    noteUsage(provider, "agent", data);
    noteSearches(provider, "agent", data.model, data.output.filter((item) => item.type === "web_search_call" && item.action?.type === "search").length);
    const reservationId = provider.usage.find((entry) => entry.workspaceReservationId)?.workspaceReservationId;
    expect(reservationId).toBeTruthy();
    await settleUsage(env.DB, provider, { orgId: ORG, githubId: "42" });
    expect(dispatched).toBe(1);
    expect(webSearchCostMicros(provider.model, 2)).toBe(20_000);
    expect(webSearchCostMicros('gpt-4o-mini', 2, 'web_search_preview')).toBe(50_000);
    expect(webSearchCostMicros('gpt-5-mini', 2, 'web_search_preview')).toBe(20_000);
    const { results } = await env.DB.prepare("SELECT model,usd FROM ai_calls WHERE org_id=?1 ORDER BY model").bind(ORG).all();
    expect(results).toHaveLength(2);
    expect(results.find((entry) => entry.model === "web_search").usd).toBe(0.02);
    expect(await env.DB.prepare("SELECT status FROM hx_workspace_ai_budget_reservations WHERE id=?1").bind(reservationId).first())
      .toMatchObject({ status: "settled" });
    expect((await workspaceAIBudgetStatus(env.DB, ORG, Date.now())).periods["24h"]).toMatchObject({
      calls: 2, unpricedCalls: 0,
    });
    const reserved = await env.DB.prepare("SELECT reserved_micros FROM hx_workspace_ai_budget_reservations WHERE id=?1").bind(reservationId).first();
    const { estimateWorkspaceBudgetMicros } = await import('../src/workspaceAIBudget.js');
    const inputBytes = new TextEncoder().encode(JSON.stringify({
      model: provider.model, max_output_tokens: 100, max_tool_calls: 20,
      tools: [{ type: 'web_search', return_token_budget: 'unlimited', search_context_size: 'high' }], input: 'Find this fact',
    })).length;
    expect(reserved.reserved_micros).toBe(estimateWorkspaceBudgetMicros(provider.model, inputBytes + 4 * 128_000, 100) + 40_000);
    expect(Number(reserved.reserved_micros)).toBeGreaterThan(150_000);
  } finally {
    vi.stubGlobal("fetch", originalFetch);
  }
});

test("a deployment web search is not dispatched when the search surcharge cannot fit", async () => {
  await saveWorkspaceAIBudget(env.DB, ORG, {
    revision: 0, dailyLimitUsd: 0.05, weeklyLimitUsd: 0, monthlyLimitUsd: 0, action: "pause",
  }, "42", NOW());
  const provider = {
    model: "gpt-5-mini", providerName: "OpenAI", apiKey: "deployment-key", byok: false,
    usage: [], workspaceBudgetDb: env.DB, workspaceBudgetOrgId: ORG, workspaceBudgetReservations: [],
  };
  const originalFetch = globalThis.fetch;
  let dispatched = 0;
  vi.stubGlobal("fetch", async () => { dispatched += 1; return Response.json({}); });
  try {
    const response = await requestWithWorkspaceBudget(provider, "https://provider.invalid", {
      method: "POST", body: JSON.stringify({
        model: provider.model, max_output_tokens: 100,
        tools: [{ type: "web_search" }], input: "Find this fact",
      }),
    });
    expect(response.status).toBe(429);
    expect(dispatched).toBe(0);
  } finally {
    vi.stubGlobal("fetch", originalFetch);
  }
});

test("BYOK web search keeps its provider call limit and does not reserve workspace budget", async () => {
  await saveWorkspaceAIBudget(env.DB, ORG, {
    revision: 0, dailyLimitUsd: 0.000001, weeklyLimitUsd: 0, monthlyLimitUsd: 0, action: "pause",
  }, "42", NOW());
  const provider = {
    model: "gpt-5-mini", providerName: "OpenAI", apiKey: "workspace-key", byok: true,
    usage: [], workspaceBudgetDb: env.DB, workspaceBudgetOrgId: ORG, workspaceBudgetReservations: [],
  };
  const originalFetch = globalThis.fetch;
  let sentBody;
  vi.stubGlobal("fetch", async (_url, init) => { sentBody = JSON.parse(init.body); return Response.json({ id: "resp-byok", model: provider.model, usage: { input_tokens: 1, output_tokens: 1 } }); });
  try {
    const response = await requestWithWorkspaceBudget(provider, "https://provider.invalid", {
      method: "POST", body: JSON.stringify({ model: provider.model, max_tool_calls: 17, tools: [{ type: "web_search" }], input: "find" }),
    });
    await response.json();
    expect(sentBody.max_tool_calls).toBe(17);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_workspace_ai_budget_reservations WHERE org_id=?1").bind(ORG).first())
      .toMatchObject({ n: 0 });
  } finally {
    vi.stubGlobal("fetch", originalFetch);
  }
});

test("minute-priced audio transcription reserves its known provider cost", () => {
  expect(estimateWorkspaceBudgetMicros("audio_transcription", 4, 0)).toBe(12_000);
  expect(estimateWorkspaceBudgetMicros("audio_transcription", 4, 1)).toBeNull();
});

test("direct provider responses without token usage settle as unpriced", async () => {
  await saveWorkspaceAIBudget(env.DB, ORG, {
    revision: 0, dailyLimitUsd: 1, weeklyLimitUsd: 0, monthlyLimitUsd: 0, action: "pause",
  }, "42", NOW());
  const provider = {
    model: "gpt-4o-mini", providerName: "OpenAI", apiKey: "deployment-key", byok: false,
    usage: [], workspaceBudgetDb: env.DB, workspaceBudgetOrgId: ORG, workspaceBudgetReservations: [],
  };
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async () => Response.json({ id: "resp-no-usage", model: "gpt-4o-mini" }));
  try {
    const response = await requestWithWorkspaceBudget(provider, "https://provider.invalid", {
      method: "POST", body: JSON.stringify({ model: provider.model, max_tokens: 100, messages: [{ role: "user", content: "hello" }] }),
    });
    const data = await response.json();
    noteUsage(provider, "direct-route", data);
    expect(provider.usage[0]).toMatchObject({ model: "unknown", workspaceReservationId: expect.any(String) });
    await settleUsage(env.DB, provider, { orgId: ORG, githubId: "42" });
    expect((await workspaceAIBudgetStatus(env.DB, ORG)).periods["24h"]).toMatchObject({ calls: 1, unpricedCalls: 1, indeterminate: true });
  } finally {
    vi.stubGlobal("fetch", originalFetch);
  }
});

test("ambiguous direct provider failures retain the hold and become unknown", async () => {
  const now = Date.now();
  await saveWorkspaceAIBudget(env.DB, ORG, {
    revision: 0, dailyLimitUsd: 1, weeklyLimitUsd: 0, monthlyLimitUsd: 0, action: "pause",
  }, "42", new Date(now).toISOString());
  const provider = {
    model: "gpt-4o-mini", providerName: "OpenAI", apiKey: "deployment-key", byok: false,
    usage: [], workspaceBudgetDb: env.DB, workspaceBudgetOrgId: ORG, workspaceBudgetReservations: [],
  };
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async () => { throw new Error("connection lost after dispatch"); });
  try {
    await expect(requestWithWorkspaceBudget(provider, "https://provider.invalid", {
      method: "POST", body: JSON.stringify({ model: provider.model, max_tokens: 100, messages: [{ role: "user", content: "hello" }] }),
    })).rejects.toThrow("connection lost after dispatch");
    const held = await env.DB.prepare("SELECT status FROM hx_workspace_ai_budget_reservations WHERE org_id=?1").bind(ORG).first();
    expect(held).toMatchObject({ status: "held" });
    const status = await workspaceAIBudgetStatus(env.DB, ORG, now + 10 * 60_000);
    expect(status.periods["24h"]).toMatchObject({ calls: 1, unpricedCalls: 1, indeterminate: true });
  } finally {
    vi.stubGlobal("fetch", originalFetch);
  }
});

test("interrupted dispatched calls are recorded as unknown, not released as free", async () => {
  const now = Date.now();
  await saveWorkspaceAIBudget(env.DB, ORG, {
    revision: 0, dailyLimitUsd: 1, weeklyLimitUsd: 0, monthlyLimitUsd: 0, action: "pause",
  }, "42", new Date(now).toISOString());
  const reservation = await reserveWorkspaceAIBudgetCall(env.DB, {
    orgId: ORG, model: "gpt-4o-mini", inputTokens: 1000, outputTokens: 1000, now,
  });
  const provider = { model: "gpt-4o-mini", providerName: "OpenAI", usage: [] };
  noteUsage(provider, "interrupted-call", { model: "unknown", usage: {} });
  await settleUsage(env.DB, provider, { orgId: ORG, githubId: "42" }, [], reservation.reservationId);
  expect(await env.DB.prepare("SELECT status FROM hx_workspace_ai_budget_reservations WHERE id=?1").bind(reservation.reservationId).first())
    .toMatchObject({ status: "settled" });
  expect((await workspaceAIBudgetStatus(env.DB, ORG, Date.now())).periods["24h"])
    .toMatchObject({ calls: 1, unpricedCalls: 1, indeterminate: true });
});

test("deployment-key Jev reserves before dispatch and settles its metered usage", async () => {
  await saveWorkspaceAIBudget(env.DB, ORG, {
    revision: 0, dailyLimitUsd: 1, weeklyLimitUsd: 0, monthlyLimitUsd: 0, action: "pause",
  }, "42", NOW());
  const config = {
    apiKey: "deployment-typesafe-key", endpoint: "https://jev.invalid", model: "jev-latest",
    workspaceBudgetDb: env.DB, workspaceBudgetOrgId: ORG, byok: false,
  };
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async () => Response.json({ answers: { ok: true }, model: "jev-latest", usage: { input_tokens: 450, output_tokens: 0 } }));
  try {
    const result = await askJev(config, { state: { instruction: "route this" }, questions: { ok: { type: "noul" } } });
    const entry = jevEntry("route", result.usage, result.model);
    expect(entry).toMatchObject({ model: "jev-latest", input: 450, output: 0, workspaceReservationId: expect.any(String) });
    await settleUsage(env.DB, null, { orgId: ORG, githubId: "42" }, [entry]);
    expect(await env.DB.prepare("SELECT status FROM hx_workspace_ai_budget_reservations WHERE id=?1").bind(entry.workspaceReservationId).first())
      .toMatchObject({ status: "settled" });
    const logged = await env.DB.prepare("SELECT purpose,provider,model,input_tokens,byok,usd FROM ai_calls WHERE org_id=?1").bind(ORG).first();
    expect(logged).toMatchObject({ purpose: "route", provider: "jev", model: "jev-latest", input_tokens: 450, byok: 0 });
    expect(logged.usd).toBeCloseTo(0.0000189, 12);
    expect((await workspaceAIBudgetStatus(env.DB, ORG)).periods["24h"]).toMatchObject({ calls: 1, unpricedCalls: 0 });
  } finally {
    vi.stubGlobal("fetch", originalFetch);
  }
});

test("deployment-key Jev is stopped before TypeSafe when the shared pause budget cannot fit", async () => {
  await saveWorkspaceAIBudget(env.DB, ORG, {
    revision: 0, dailyLimitUsd: 0.000001, weeklyLimitUsd: 0, monthlyLimitUsd: 0, action: "pause",
  }, "42", NOW());
  const config = { apiKey: "deployment-typesafe-key", endpoint: "https://jev.invalid", model: "jev-latest", workspaceBudgetDb: env.DB, workspaceBudgetOrgId: ORG };
  const originalFetch = globalThis.fetch;
  let dispatched = 0;
  vi.stubGlobal("fetch", async () => { dispatched += 1; return Response.json({ answers: {} }); });
  try {
    await expect(askJev(config, { state: { instruction: "large request" }, questions: { ok: { type: "noul" } } }))
      .rejects.toMatchObject({ code: "workspace_ai_budget" });
    expect(dispatched).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_workspace_ai_budget_reservations WHERE org_id=?1").bind(ORG).first())
      .toMatchObject({ n: 0 });
  } finally {
    vi.stubGlobal("fetch", originalFetch);
  }
});

test("ambiguous Jev provider failure retains its reservation as unknown usage", async () => {
  const now = Date.now();
  await saveWorkspaceAIBudget(env.DB, ORG, {
    revision: 0, dailyLimitUsd: 1, weeklyLimitUsd: 0, monthlyLimitUsd: 0, action: "pause",
  }, "42", new Date(now).toISOString());
  const config = { apiKey: "deployment-typesafe-key", endpoint: "https://jev.invalid", model: "jev-latest", workspaceBudgetDb: env.DB, workspaceBudgetOrgId: ORG };
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async () => { throw new Error("connection lost after dispatch"); });
  try {
    await expect(askJev(config, { state: { instruction: "classify this" }, questions: { ok: { type: "noul" } } }))
      .rejects.toThrow("connection lost after dispatch");
    expect(await env.DB.prepare("SELECT status FROM hx_workspace_ai_budget_reservations WHERE org_id=?1").bind(ORG).first())
      .toMatchObject({ status: "held" });
    expect((await workspaceAIBudgetStatus(env.DB, ORG, now + 10 * 60_000)).periods["24h"])
      .toMatchObject({ calls: 1, unpricedCalls: 1, indeterminate: true });
  } finally {
    vi.stubGlobal("fetch", originalFetch);
  }
});

test("workspace TypeSafe key usage is logged as BYOK and bypasses deployment reservations", async () => {
  await saveWorkspaceAIBudget(env.DB, ORG, {
    revision: 0, dailyLimitUsd: 0.000001, weeklyLimitUsd: 0, monthlyLimitUsd: 0, action: "pause",
  }, "42", NOW());
  await env.DB.prepare(`INSERT INTO ai_calls(org_id,purpose,provider,model,input_tokens,output_tokens,usd,byok,created_at)
    VALUES(?1,'ask','OpenAI','gpt-4o',100,0,1,0,?2)`).bind(ORG, NOW()).run();
  const config = { apiKey: "workspace-typesafe-key", endpoint: "https://jev.invalid", model: "jev-latest", workspaceBudgetDb: env.DB, workspaceBudgetOrgId: ORG, byok: true };
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async () => Response.json({ answers: { ok: true }, usage: { input_tokens: 300, output_tokens: 0 } }));
  try {
    const result = await askJev(config, { state: { instruction: "route this" }, questions: { ok: { type: "noul" } } });
    const entry = jevEntry("route", result.usage, result.model);
    expect(entry).toMatchObject({ byok: true });
    expect(entry.workspaceReservationId).toBeUndefined();
    await settleUsage(env.DB, null, { orgId: ORG, githubId: "42" }, [entry]);
    expect(await env.DB.prepare("SELECT byok FROM ai_calls WHERE purpose='route' AND org_id=?1").bind(ORG).first())
      .toMatchObject({ byok: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_workspace_ai_budget_reservations WHERE org_id=?1").bind(ORG).first())
      .toMatchObject({ n: 0 });
  } finally {
    vi.stubGlobal("fetch", originalFetch);
  }
});

test("deployment Jev usage remains workspace-paid when the same route uses a BYOK OpenAI key", async () => {
  await saveWorkspaceAIBudget(env.DB, ORG, {
    revision: 0, dailyLimitUsd: 1, weeklyLimitUsd: 0, monthlyLimitUsd: 0, action: "pause",
  }, "42", NOW());
  const provider = { model: "gpt-4o", providerName: "OpenAI", byok: true, usage: [] };
  noteUsage(provider, "route", { model: "gpt-4o", usage: { prompt_tokens: 100, completion_tokens: 100 } });
  const reservation = await reserveWorkspaceAIBudgetCall(env.DB, { orgId: ORG, model: "jev-latest", inputTokens: 450, outputTokens: 0 });
  expect(reservation.allowed).toBe(true);
  const jev = jevEntry("route", { input_tokens: 450, output_tokens: 0, byok: false, __honmaruWorkspaceReservationId: reservation.reservationId });
  await settleUsage(env.DB, provider, { orgId: ORG, githubId: "42", byok: true }, [jev]);
  const { results } = await env.DB.prepare("SELECT provider,byok FROM ai_calls WHERE org_id=?1 AND purpose='route' ORDER BY provider").bind(ORG).all();
  expect(results).toEqual([{ provider: "OpenAI", byok: 1 }, { provider: "jev", byok: 0 }]);
  expect(await env.DB.prepare("SELECT status FROM hx_workspace_ai_budget_reservations WHERE id=?1").bind(reservation.reservationId).first())
    .toMatchObject({ status: "settled" });
  expect((await workspaceAIBudgetStatus(env.DB, ORG)).periods["24h"]).toMatchObject({ calls: 1, unpricedCalls: 0 });
});
