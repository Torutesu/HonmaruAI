import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { allowanceFor } from "../src/gate.js";

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});

async function addRun(id, {orgId="org", status="running", sources=[]}={}) {
  await env.DB.prepare("INSERT INTO hx_workflow_runs (id,org_id,workflow_id,trigger,status,log,started_at) VALUES (?1,?2,'wf','manual',?3,'[]',?4)")
    .bind(id,orgId,status,new Date().toISOString()).run();
  for (const [index,byok] of sources.entries()) {
    await env.DB.prepare("INSERT INTO hx_workflow_usage (id,org_id,workflow_id,run_id,step_number,provider,model,byok,created_at) VALUES (?1,?2,'wf',?3,?4,'OpenAI','gpt-4o-mini',?5,?6)")
      .bind(`${id}-usage-${index}`,orgId,id,index+1,byok,new Date().toISOString()).run();
  }
}

test("workspace deployment budget cancels only exclusively deployment-key workflow runs", async () => {
  const at = new Date().toISOString();
  await env.DB.prepare("INSERT INTO org_ai_settings (org_id,daily_budget_micros,updated_at) VALUES ('org',1000000,?1)").bind(at).run();
  await env.DB.prepare("INSERT INTO ai_calls (org_id,purpose,provider,model,usd,byok,created_at) VALUES ('org','agent','openai','gpt-4o-mini',2,0,?1)").bind(at).run();

  await addRun("deployment",{sources:[0]});
  await addRun("workspace-key",{sources:[1]});
  await addRun("mixed-credentials",{sources:[0,1]});
  await addRun("no-ai-usage");
  await addRun("already-done",{status:"done",sources:[0]});
  await addRun("other-workspace",{orgId:"other",sources:[0]});

  // Direct JavaScript/app actions have no deployment-key provider usage and
  // must remain independent of the model budget gate.
  await env.DB.prepare("INSERT INTO hx_gateways (id,org_id,name,token_hash,created_by,created_at) VALUES ('gw','org','Node','hash','owner',1)").run();
  await env.DB.prepare("INSERT INTO hx_gateway_jobs (id,org_id,gateway_id,created_by,request_id,payload,status,lease_hash,created_at) VALUES ('direct-js','org','gw','owner','direct-js','{}','running','lease',1)").run();

  const allowance = await allowanceFor(env,"org",{githubId:"owner"});
  expect(allowance.allowed).toBe(false);
  expect(allowance.workspaceBudgetExceeded).toBe(true);

  const {results=[]} = await env.DB.prepare("SELECT id,status,finished_at,log FROM hx_workflow_runs ORDER BY id").all();
  const rows = Object.fromEntries(results.map(row=>[row.id,row]));
  expect(rows.deployment.status).toBe("cancelled");
  expect(rows.deployment.finished_at).toBeTruthy();
  expect(JSON.parse(rows.deployment.log).at(-1)).toMatchObject({status:"cancelled",reason:"workspace_budget_exceeded"});
  for (const id of ["workspace-key","mixed-credentials","no-ai-usage","already-done","other-workspace"]) {
    expect(rows[id].status).toBe(id==="already-done"?"done":"running");
  }
  expect(await env.DB.prepare("SELECT status,lease_hash FROM hx_gateway_jobs WHERE id='direct-js'").first())
    .toEqual({status:"running",lease_hash:"lease"});
});
