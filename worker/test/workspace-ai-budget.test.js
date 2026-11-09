import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { allowanceFor } from "../src/gate.js";
import { saveWorkspaceAIBudget, workspaceAIBudgetStatus, workspaceBudgetAdmission } from "../src/workspaceAIBudget.js";

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
          (?1,'42','search','OpenAI','web_search',0,0,0.025,0,?2),
          (?1,'42','ask','jev','jev-latest',1000,0,0.000042,0,?2)`)
    .bind(ORG, new Date(now - 1_000).toISOString()).run();
  const status = await workspaceAIBudgetStatus(env.DB, ORG, now);
  expect(status.periods["24h"]).toMatchObject({ calls: 3, unpricedCalls: 1, indeterminate: true });
  expect(await workspaceBudgetAdmission(env.DB, ORG, now)).toMatchObject({ allowed: true });
  expect(await allowanceFor({ DB: env.DB }, ORG, { githubId: "42" })).toMatchObject({ allowed: true });
});
