import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { allowanceFor } from "../src/gate.js";
import { handleGateways } from "../src/harness/gateways.js";
import { upsertUser, upsertMembership } from "../src/db.js";

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("CREATE TABLE IF NOT EXISTS hx_workflow_activations (org_id TEXT NOT NULL,job_id TEXT PRIMARY KEY REFERENCES hx_gateway_jobs(id) ON DELETE CASCADE,run_id TEXT NOT NULL REFERENCES hx_workflow_runs(id) ON DELETE CASCADE,node_id TEXT NOT NULL,node_owner TEXT NOT NULL,node_attempt INTEGER NOT NULL CHECK(node_attempt>0),UNIQUE(org_id,run_id,node_id,node_attempt))");
  await env.DB.prepare("SELECT estimated_micros FROM hx_workflow_usage LIMIT 0").all().catch(() => env.DB.exec("ALTER TABLE hx_workflow_usage ADD COLUMN estimated_micros INTEGER"));
  for (const [column,definition] of [
    ["daily_run_limit","INTEGER NOT NULL DEFAULT 0"],["weekly_run_limit","INTEGER NOT NULL DEFAULT 0"],
    ["monthly_run_limit","INTEGER NOT NULL DEFAULT 0"],["budget_revision","INTEGER NOT NULL DEFAULT 0"],
    ["daily_ai_budget_micros","INTEGER NOT NULL DEFAULT 0"],["weekly_ai_budget_micros","INTEGER NOT NULL DEFAULT 0"],
    ["monthly_ai_budget_micros","INTEGER NOT NULL DEFAULT 0"],["ai_budget_action","TEXT NOT NULL DEFAULT 'warn'"],
  ]) {
    const {results=[]}=await env.DB.prepare("PRAGMA table_info(hx_workflow_safety)").all();
    if(!results.some(item=>item.name===column))await env.DB.exec("ALTER TABLE hx_workflow_safety ADD COLUMN "+column+" "+definition);
  }
  await upsertUser(env.DB,{githubId:"owner",login:"owner",name:"Owner",locale:"en"});
  await upsertMembership(env.DB,"workspace-budget-stop","owner","admin");
});

async function addRun(id, {orgId="workspace-budget-stop", status="running", sources=[], credentialSource}={}) {
  const source = credentialSource || (sources.includes(1) ? "workspace" : sources.includes(0) ? "deployment" : "unknown");
  await env.DB.prepare("INSERT INTO hx_workflow_runs (id,org_id,workflow_id,trigger,status,log,started_at,credential_source) VALUES (?1,?2,'wf','manual',?3,'[]',?4,?5)")
    .bind(id,orgId,status,new Date().toISOString(),source).run();
  for (const [index,byok] of sources.entries()) {
    await env.DB.prepare("INSERT INTO hx_workflow_usage (id,org_id,workflow_id,run_id,step_number,provider,model,byok,created_at) VALUES (?1,?2,'wf',?3,?4,'OpenAI','gpt-4o-mini',?5,?6)")
      .bind(`${id}-usage-${index}`,orgId,id,index+1,byok,new Date().toISOString()).run();
  }
}

test("workspace deployment budget cancels only exclusively deployment-key workflow runs", async () => {
  const at = new Date().toISOString();
  await env.DB.prepare("INSERT INTO org_ai_settings (org_id,daily_budget_micros,budget_action,updated_at) VALUES ('workspace-budget-stop',1000000,'pause',?1)").bind(at).run();
  await env.DB.prepare("INSERT INTO ai_calls (org_id,purpose,provider,model,usd,byok,created_at) VALUES ('workspace-budget-stop','agent','openai','gpt-4o-mini',2,0,?1)").bind(at).run();

  await addRun("deployment",{sources:[0]});
  await addRun("workspace-key",{sources:[1]});
  await addRun("mixed-credentials",{sources:[0,1]});
  await addRun("no-ai-usage");
  await addRun("zero-usage-deployment",{credentialSource:"deployment"});
  await addRun("code-only",{credentialSource:"none"});
  await addRun("already-done",{status:"done",sources:[0]});
  await addRun("other-workspace",{orgId:"other",sources:[0]});

  const nodeToken = "hgw_" + "x".repeat(64);
  const tokenHash = await sha256(nodeToken);
  await env.DB.prepare("INSERT INTO hx_gateways (id,org_id,name,token_hash,created_by,created_at) VALUES ('gw','workspace-budget-stop','Node',?1,'owner',1)").bind(tokenHash).run();
  const addProgramJob = async (jobId,runId) => {
    const lease = "lease-" + jobId, leaseHash = await sha256(lease), now = Date.now();
    await env.DB.prepare("INSERT INTO hx_gateway_jobs (id,org_id,gateway_id,created_by,request_id,payload,status,lease_hash,lease_until,deadline,created_at,started_at) VALUES (?1,'workspace-budget-stop','gw','owner',?1,'{\"workflowProgram\":1}','running',?2,?3,?4,?5,?5)")
      .bind(jobId,leaseHash,now+60000,now+120000,now).run();
    await env.DB.prepare("INSERT INTO hx_workflow_activations (org_id,job_id,run_id,node_id,node_owner,node_attempt) VALUES ('workspace-budget-stop',?1,?2,'program','owner',1)")
      .bind(jobId,runId).run();
    return lease;
  };
  const deploymentLease = await addProgramJob("deployment-program","deployment");
  await addProgramJob("code-only-program","code-only");
  await addProgramJob("workspace-key-program","workspace-key");
  await addProgramJob("mixed-program","mixed-credentials");
  // Direct JavaScript/app actions have no deployment-key usage and remain independent.
  await env.DB.prepare("INSERT INTO hx_gateway_jobs (id,org_id,gateway_id,created_by,request_id,payload,status,lease_hash,created_at) VALUES ('direct-js','workspace-budget-stop','gw','owner','direct-js','{}','running','lease',1)").run();
  await env.DB.prepare("INSERT INTO hx_gateway_jobs (id,org_id,gateway_id,created_by,request_id,payload,status,lease_hash,created_at) VALUES ('app-action','workspace-budget-stop','gw','owner','app-action','{}','running','app-lease',1)").run();
  await env.DB.prepare("INSERT INTO hx_app_action_jobs (org_id,app_id,job_id,action_name,action_version,created_by) VALUES ('workspace-budget-stop','app','app-action','run',1,'owner')").run();

  const allowance = await allowanceFor(env,"workspace-budget-stop",{githubId:"owner"});
  expect(allowance.allowed).toBe(false);
  expect(allowance.workspaceBudgetExceeded).toBe(true);

  const {results=[]} = await env.DB.prepare("SELECT id,status,finished_at,log FROM hx_workflow_runs ORDER BY id").all();
  const rows = Object.fromEntries(results.map(row=>[row.id,row]));
  expect(rows.deployment.status).toBe("cancelled");
  expect(rows["zero-usage-deployment"].status).toBe("cancelled");
  expect(rows.deployment.finished_at).toBeTruthy();
  expect(JSON.parse(rows.deployment.log).at(-1)).toMatchObject({status:"cancelled",reason:"workspace_budget_exceeded"});
  for (const id of ["workspace-key","mixed-credentials","no-ai-usage","code-only","already-done","other-workspace"]) {
    expect(rows[id].status).toBe(id==="already-done"?"done":"running");
  }
  expect(await env.DB.prepare("SELECT status,lease_hash FROM hx_gateway_jobs WHERE id='deployment-program'").first())
    .toEqual({status:"cancelled",lease_hash:null});

  const heartbeatRequest = new Request("https://example.com/gateways/jobs/deployment-program/heartbeat",{
    method:"POST",headers:{authorization:"Bearer " + nodeToken,"content-type":"application/json"},body:JSON.stringify({lease:deploymentLease}),
  });
  const heartbeat = await handleGateways(heartbeatRequest,env,new URL(heartbeatRequest.url),{lease:deploymentLease});
  expect(heartbeat.status).toBe(409);
  const finishRequest = new Request("https://example.com/gateways/jobs/deployment-program/finish",{
    method:"POST",headers:{authorization:"Bearer " + nodeToken,"content-type":"application/json"},body:JSON.stringify({lease:deploymentLease,status:"succeeded",stdout:"done"}),
  });
  const finish = await handleGateways(finishRequest,env,new URL(finishRequest.url),{lease:deploymentLease,status:"succeeded",stdout:"done"});
  expect(finish.status).toBe(409);

  for (const id of ["workspace-key-program","mixed-program","code-only-program","direct-js","app-action"]) {
    const row = await env.DB.prepare("SELECT status,lease_hash FROM hx_gateway_jobs WHERE id=?1").bind(id).first();
    expect(row.status).toBe("running");
    expect(row.lease_hash).toBeTruthy();
  }
});

async function sha256(value) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))]
    .map(byte=>byte.toString(16).padStart(2,"0")).join("");
}
