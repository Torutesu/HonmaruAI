import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { allowanceFor } from "../src/gate.js";
import { upsertMembership, upsertUser } from "../src/db.js";
import { cancelDeploymentBudgetWorkflowRuns } from "../src/workspaceBudgetStop.js";

const ORG = "budget-stop-test";
const at = () => new Date().toISOString();

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("CREATE TABLE IF NOT EXISTS hx_workflow_activations (org_id TEXT NOT NULL,job_id TEXT PRIMARY KEY REFERENCES hx_gateway_jobs(id) ON DELETE CASCADE,run_id TEXT NOT NULL REFERENCES hx_workflow_runs(id) ON DELETE CASCADE,node_id TEXT NOT NULL,node_owner TEXT NOT NULL,node_attempt INTEGER NOT NULL CHECK(node_attempt>0),UNIQUE(org_id,run_id,node_id,node_attempt))");
  await upsertUser(env.DB, { githubId: "budget-owner", login: "budget-owner", name: "Owner", locale: "en" });
  await upsertMembership(env.DB, ORG, "budget-owner", "admin");
});

async function addRun(id, credentialSource, usage = []) {
  await env.DB.prepare("INSERT INTO hx_workflow_runs(id,org_id,workflow_id,trigger,status,log,started_at,credential_source) VALUES(?1,?2,'wf','manual','running','[]',?3,?4)")
    .bind(id, ORG, at(), credentialSource).run();
  for (const [index, byok] of usage.entries()) {
    await env.DB.prepare("INSERT INTO hx_workflow_usage(id,org_id,workflow_id,run_id,step_number,provider,model,byok,created_at) VALUES(?1,?2,'wf',?3,?4,'OpenAI','gpt-4o-mini',?5,?6)")
      .bind(`${id}-usage-${index}`, ORG, id, index + 1, byok, at()).run();
  }
}

test("deployment budget pauses and cancels only deployment-pinned active workflow runs", async () => {
  await env.DB.prepare("INSERT INTO org_ai_settings(org_id,daily_budget_micros,budget_action,updated_at) VALUES(?1,1000000,'pause',?2)").bind(ORG, at()).run();
  await env.DB.prepare("INSERT INTO ai_calls(org_id,purpose,provider,model,usd,byok,created_at) VALUES(?1,'agent','openai','gpt-4o-mini',2,0,?2)").bind(ORG, at()).run();
  await addRun("deployment-zero-use", "deployment");
  await addRun("workspace-pinned", "workspace", [1]);
  await addRun("legacy-deployment", "unknown", [0]);
  await addRun("legacy-no-proof", "unknown");
  await addRun("mixed-legacy", "unknown", [0, 1]);
  await addRun("code-only", "none");

  const denied = await allowanceFor({ ...env, OPENAI_API_KEY: "sk-deployment-key" }, ORG, {
    githubId: "budget-owner", credentialSource: "deployment",
  });
  expect(denied.allowed).toBe(false);
  expect(denied.workspaceBudgetExceeded).toBe(true);

  const rows = Object.fromEntries((await env.DB.prepare("SELECT id,status FROM hx_workflow_runs").all()).results.map(row => [row.id, row.status]));
  expect(rows).toMatchObject({
    "deployment-zero-use": "cancelled", "legacy-deployment": "cancelled",
    "workspace-pinned": "running", "legacy-no-proof": "running", "mixed-legacy": "running", "code-only": "running",
  });
  const cancelled = await env.DB.prepare("SELECT finished_at,log FROM hx_workflow_runs WHERE id='deployment-zero-use'").first();
  expect(cancelled.finished_at).toBeTruthy();
  expect(JSON.parse(cancelled.log).at(-1)).toMatchObject({ status: "cancelled", reason: "workspace_budget_exceeded" });
});

test("settling a deployment budget cancellation releases workflow program leases", async () => {
  const now = Date.now();
  await env.DB.prepare("INSERT INTO hx_workflows(id,org_id,name,enabled,trigger,steps,created_by,created_at,updated_at) VALUES('wf',?1,'Budget workflow',1,'{}','[]','budget-owner',?2,?2)").bind(ORG, at()).run();
  await addRun("lease-run", "deployment");
  await env.DB.prepare("INSERT INTO hx_gateways(id,org_id,name,token_hash,created_by,created_at) VALUES('gateway',?1,'Node','hash','budget-owner',?2)").bind(ORG, now).run();
  await env.DB.prepare("INSERT INTO hx_gateway_jobs(id,org_id,gateway_id,created_by,request_id,payload,status,lease_hash,lease_until,deadline,created_at,started_at) VALUES('job',?1,'gateway','budget-owner','request','{}','running','lease-hash',?2,?3,?4,?4)").bind(ORG, now + 60000, now + 120000, now).run();
  await env.DB.prepare("INSERT INTO hx_workflow_activations(org_id,job_id,run_id,node_id,node_owner,node_attempt) VALUES(?1,'job','lease-run','code','budget-owner',1)").bind(ORG).run();
  expect(await cancelDeploymentBudgetWorkflowRuns(env.DB, ORG, at())).toBe(1);
  expect(await env.DB.prepare("SELECT status,lease_hash FROM hx_gateway_jobs WHERE id='job'").first()).toEqual({ status: "cancelled", lease_hash: null });
});
