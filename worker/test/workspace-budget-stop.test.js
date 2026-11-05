import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { cancelWorkspaceGatewayJobs } from "../src/workspaceBudgetStop.js";
import { allowanceFor } from "../src/gate.js";

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});

test("budget stop cancels queued and running gateway work and clears active leases", async () => {
  await env.DB.prepare("INSERT INTO hx_gateways (id,org_id,name,token_hash,created_by,created_at) VALUES ('gw','org','Node','hash','owner',1)").run();
  for (const [id, status, lease] of [["queued","queued",null],["running","running","lease-hash"],["done","succeeded","finished-hash"]]) {
    await env.DB.prepare("INSERT INTO hx_gateway_jobs (id,org_id,gateway_id,created_by,request_id,payload,status,lease_hash,created_at) VALUES (?1,'org','gw','owner',?1,'{}',?2,?3,1)")
      .bind(id,status,lease).run();
  }

  expect(await cancelWorkspaceGatewayJobs(env.DB,"org",1234)).toBe(2);
  const rows = await env.DB.prepare("SELECT id,status,lease_hash,finished_at FROM hx_gateway_jobs ORDER BY id").all();
  expect(rows.results).toEqual([
    {id:"done",status:"succeeded",lease_hash:"finished-hash",finished_at:null},
    {id:"queued",status:"cancelled",lease_hash:null,finished_at:1234},
    {id:"running",status:"cancelled",lease_hash:null,finished_at:1234},
  ]);
  expect(await cancelWorkspaceGatewayJobs(env.DB,"other",1234)).toBe(0);
});

test("workspace deployment budget denial cancels existing gateway work", async () => {
  const at = new Date().toISOString();
  await env.DB.prepare("INSERT INTO org_ai_settings (org_id,daily_budget_micros,updated_at) VALUES ('org',1000000,?1)").bind(at).run();
  await env.DB.prepare("INSERT INTO ai_calls (org_id,purpose,provider,model,usd,byok,created_at) VALUES ('org','agent','openai','gpt-4o-mini',2,0,?1)").bind(at).run();
  await env.DB.prepare("INSERT INTO hx_gateways (id,org_id,name,token_hash,created_by,created_at) VALUES ('gw','org','Node','hash','owner',1)").run();
  await env.DB.prepare("INSERT INTO hx_gateway_jobs (id,org_id,gateway_id,created_by,request_id,payload,status,lease_hash,created_at) VALUES ('run','org','gw','owner','run','{}','running','active-lease',1)").run();

  const allowance = await allowanceFor(env,"org",{githubId:"owner"});
  expect(allowance.allowed).toBe(false);
  expect(allowance.workspaceBudgetExceeded).toBe(true);
  const stopped = await env.DB.prepare("SELECT status,lease_hash FROM hx_gateway_jobs WHERE id='run'").first();
  expect(stopped).toEqual({status:"cancelled",lease_hash:null});
});
