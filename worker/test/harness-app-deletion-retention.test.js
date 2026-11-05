import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { upsertMembership, upsertUser } from "../src/db.js";
import { deleteApp, getApp, listApps } from "../src/harness/apps.js";
import { getMode } from "../src/harness/mode.js";
import { appAccess, mayReadAppRows, mayUseApp, mayUseTable } from "../src/harness/resourceAccess.js";
import { managedAutomationMayRun } from "../src/harness/appAutomationGuard.js";

const ORG = "personal:app-retention";
const APP = "retained-app";
const TABLE = "retained-table";
const ENTITY_TABLE = "retained-entity-table";
const WORKFLOW = "retained-workflow";
const USER = "9101";
const at = "2026-11-06T00:00:00.000Z";

async function seedApp() {
  await env.DB.prepare("INSERT INTO hx_tables (id,org_id,name,columns,created_by,created_at,updated_at) VALUES (?1,?2,'Records','[]',?3,?4,?4)")
    .bind(TABLE, ORG, USER, at).run();
  await env.DB.prepare("INSERT INTO hx_tables (id,org_id,name,columns,created_by,created_at,updated_at) VALUES (?1,?2,'Related records','[]',?3,?4,?4)")
    .bind(ENTITY_TABLE, ORG, USER, at).run();
  await env.DB.prepare("INSERT INTO hx_apps (id,org_id,name,description,icon,table_id,version,definition,created_by,created_at,updated_at) VALUES (?1,?2,'Records','retention fixture','grid',?3,2,'{\"views\":[]}',?4,?5,?5)")
    .bind(APP, ORG, TABLE, USER, at).run();
  await env.DB.prepare("INSERT INTO hx_app_access (org_id,app_id,visibility,version) VALUES (?1,?2,'workspace',1)")
    .bind(ORG, APP).run();
  await env.DB.prepare("INSERT INTO hx_app_versions (app_id,org_id,version,definition,note,created_by,created_at) VALUES (?1,?2,1,'{\"views\":[]}','original',?3,?4)")
    .bind(APP, ORG, USER, at).run();
  await env.DB.prepare("INSERT INTO hx_app_entities (org_id,app_id,entity_key,table_id) VALUES (?1,?2,'related',?3)")
    .bind(ORG, APP, ENTITY_TABLE).run();
  await env.DB.prepare("INSERT INTO hx_rows (id,table_id,org_id,data,position,created_by,updated_by,created_at,updated_at) VALUES (?1,?2,?3,'{\"title\":\"Primary\"}',0,?4,?4,?5,?5)")
    .bind("retention-row-primary", TABLE, ORG, USER, at).run();
  await env.DB.prepare("INSERT INTO hx_rows (id,table_id,org_id,data,position,created_by,updated_by,created_at,updated_at) VALUES (?1,?2,?3,'{\"parent\":\"retention-row-primary\"}',0,?4,?4,?5,?5)")
    .bind("retention-row-related", ENTITY_TABLE, ORG, USER, at).run();
  await env.DB.prepare("INSERT INTO hx_app_links (app_id,org_id,channel,created_by,created_at) VALUES (?1,?2,'b:ops',?3,?4)")
    .bind(APP, ORG, USER, at).run();
  await env.DB.prepare("INSERT INTO hx_app_connections (org_id,app_id,created_by,name,version,endpoint,method,token,enabled) VALUES (?1,?2,?3,'crm',1,'https://api.example.test','GET','secret-token',1)")
    .bind(ORG, APP, USER).run();
  await env.DB.prepare("INSERT INTO hx_app_env_vars (org_id,app_id,name,value,version,updated_by,updated_at) VALUES (?1,?2,'API_KEY','secret-value',1,?3,?4)")
    .bind(ORG, APP, USER, at).run();
  await env.DB.prepare("INSERT INTO hx_workflows (id,org_id,name,enabled,trigger,steps,created_by,created_at,updated_at) VALUES (?1,?2,'Managed automation',1,'{\"type\":\"manual\"}','[]',?3,?4,?4)")
    .bind(WORKFLOW, ORG, USER, at).run();
  await env.DB.prepare("INSERT INTO hx_app_automation_state (org_id,app_id,revision,draft,published,release_id,published_at,updated_at,updated_by) VALUES (?1,?2,1,'{\"items\":[]}','{\"items\":[{\"key\":\"main\",\"enabled\":true}]}','release-1',?3,?3,?4)")
    .bind(ORG, APP, at, USER).run();
  await env.DB.prepare("INSERT INTO hx_app_automation_bindings (org_id,app_id,declaration_key,workflow_id,applied,release_id) VALUES (?1,?2,'main',?3,'{}','release-1')")
    .bind(ORG, APP, WORKFLOW).run();
}

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await upsertUser(env.DB, { githubId: USER, login: "owner", name: "Owner", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, USER, "admin");
  await seedApp();
});

test("App deletion retains its database, entity relations, history and room links until workspace purge", async () => {
  expect(await getMode(env.DB, ORG)).toBe("simple");
  expect(await managedAutomationMayRun(env.DB, ORG, WORKFLOW, "release-1")).toBe(true);

  const result = await deleteApp(env.DB, ORG, APP);
  expect(result).toEqual({ deleted: true, dataRetained: true, retention: "until_workspace_deletion" });
  expect(await getApp(env.DB, ORG, APP)).toBeNull();
  expect(await listApps(env.DB, ORG)).toEqual([]);
  expect(await appAccess(env.DB, ORG, APP)).toBeNull();
  expect(await mayUseApp(env.DB, ORG, APP, USER)).toBe(false);
  expect(await mayUseTable(env.DB, ORG, TABLE, USER)).toBe(false);
  expect(await mayUseTable(env.DB, ORG, ENTITY_TABLE, USER)).toBe(false);
  expect(await mayReadAppRows(env.DB, ORG, APP, TABLE, USER)).toBe(false);

  expect(await env.DB.prepare("SELECT id,data FROM hx_rows WHERE org_id=?1 ORDER BY id").bind(ORG).all().then(x => x.results))
    .toEqual([
      { id: "retention-row-primary", data: '{"title":"Primary"}' },
      { id: "retention-row-related", data: '{"parent":"retention-row-primary"}' },
    ]);
  expect(await env.DB.prepare("SELECT id FROM hx_tables WHERE org_id=?1 ORDER BY id").bind(ORG).all().then(x => x.results))
    .toEqual([{ id: ENTITY_TABLE }, { id: TABLE }]);
  expect(await env.DB.prepare("SELECT version,note FROM hx_app_versions WHERE org_id=?1 AND app_id=?2").bind(ORG, APP).all().then(x => x.results))
    .toEqual([{ version: 1, note: "original" }]);
  expect(await env.DB.prepare("SELECT entity_key,table_id FROM hx_app_entities WHERE org_id=?1 AND app_id=?2").bind(ORG, APP).all().then(x => x.results))
    .toEqual([{ entity_key: "related", table_id: ENTITY_TABLE }]);
  expect(await env.DB.prepare("SELECT channel FROM hx_app_links WHERE org_id=?1 AND app_id=?2").bind(ORG, APP).all().then(x => x.results))
    .toEqual([{ channel: "b:ops" }]);

  expect(await env.DB.prepare("SELECT enabled,token FROM hx_app_connections WHERE org_id=?1 AND app_id=?2").bind(ORG, APP).first())
    .toEqual({ enabled: 0, token: null });
  expect(await env.DB.prepare("SELECT value FROM hx_app_env_vars WHERE org_id=?1 AND app_id=?2 AND name='API_KEY'").bind(ORG, APP).first())
    .toEqual({ value: "" });
  expect(await env.DB.prepare("SELECT enabled FROM hx_workflows WHERE org_id=?1 AND id=?2").bind(ORG, WORKFLOW).first())
    .toEqual({ enabled: 0 });
  expect(await managedAutomationMayRun(env.DB, ORG, WORKFLOW, "release-1")).toBe(false);
  expect(await getMode(env.DB, ORG)).toBe("simple");
});

test.each(["running", "waiting"])("App deletion is refused atomically while a managed run is %s", async status => {
  await env.DB.prepare("INSERT INTO hx_workflow_runs (id,org_id,workflow_id,trigger,status,log,next_step,started_by,started_at) VALUES ('active-run',?1,?2,'{\"type\":\"manual\"}',?3,'[]',0,?4,?5)")
    .bind(ORG, WORKFLOW, status, USER, at).run();

  const result = await deleteApp(env.DB, ORG, APP);
  expect(result).toMatchObject({ status: 409 });
  expect(result.error).toContain("still running, queued, or waiting");
  expect(await env.DB.prepare("SELECT deleted_at FROM hx_apps WHERE org_id=?1 AND id=?2").bind(ORG, APP).first())
    .toEqual({ deleted_at: null });
  expect(await env.DB.prepare("SELECT enabled FROM hx_workflows WHERE org_id=?1 AND id=?2").bind(ORG, WORKFLOW).first())
    .toEqual({ enabled: 1 });
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM hx_rows WHERE org_id=?1").bind(ORG).first())
    .toEqual({ count: 2 });
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM hx_app_versions WHERE org_id=?1 AND app_id=?2").bind(ORG, APP).first())
    .toEqual({ count: 1 });
  expect(await env.DB.prepare("SELECT token FROM hx_app_connections WHERE org_id=?1 AND app_id=?2").bind(ORG, APP).first())
    .toEqual({ token: "secret-token" });
});

test.each(["queued", "running"])("App deletion is refused atomically while a custom action is %s", async status => {
  await env.DB.prepare("INSERT INTO hx_gateways (id,org_id,name,token_hash,created_by,created_at) VALUES ('retention-gateway',?1,'Worker','retention-token-hash',?2,1)")
    .bind(ORG, USER).run();
  await env.DB.prepare("INSERT INTO hx_gateway_jobs (id,org_id,gateway_id,created_by,request_id,payload,status,created_at) VALUES ('action-job',?1,'retention-gateway',?2,'request-1','{}',?3,1)")
    .bind(ORG, USER, status).run();
  await env.DB.prepare("INSERT INTO hx_app_action_jobs (org_id,app_id,job_id,action_name,action_version,created_by) VALUES (?1,?2,'action-job','publish',1,?3)")
    .bind(ORG, APP, USER).run();

  const result = await deleteApp(env.DB, ORG, APP);
  expect(result).toMatchObject({ status: 409 });
  expect(result.error).toContain("action is still running");
  expect(await env.DB.prepare("SELECT deleted_at FROM hx_apps WHERE org_id=?1 AND id=?2").bind(ORG, APP).first())
    .toEqual({ deleted_at: null });
  expect(await env.DB.prepare("SELECT status FROM hx_gateway_jobs WHERE id='action-job'").first())
    .toEqual({ status });
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM hx_rows WHERE org_id=?1").bind(ORG).first())
    .toEqual({ count: 2 });
});
