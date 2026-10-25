import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { allowanceFor } from "../src/gate.js";
import { saveWorkspaceAIBudget, workspaceAIBudgetStatus } from "../src/workspaceAIBudget.js";

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
