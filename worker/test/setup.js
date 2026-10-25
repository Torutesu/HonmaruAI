import { reset, env } from "cloudflare:test";
import { beforeEach } from "vitest";
import workflowRuntimeSql from "../workflow-runtime.sql?raw";
import workspaceFilesSql from "../workspace-files.sql?raw";
import schemaSql from "../schema.sql?raw";
import migrationsSql from "../migrations.sql?raw";
import workflowRevisionSql from "../workflow-revisions.sql?raw";

// vitest-pool-workers 0.22 isolates storage per FILE — the suite was written
// against per-test isolation, where a test's writes never reached the next
// one. reset() gives that back: wipe everything, then put the schema back so
// a file's beforeEach seeds land on real tables. Hooks here run before the
// test file's own beforeEach, so seeds still apply on top.
beforeEach(async () => {
  await reset();
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  for (const sql of workflowWebhookColumns) await env.DB.exec(sql);
  // Keep the workflow budget columns in step with the production migration.
  for (const sql of workflowBudgetColumns) await env.DB.exec(sql);
  await env.DB.exec(workspaceFilesSql.replace(/\n/g, " "));
  await env.DB.exec(workflowRuntimeSql.replace(/\n/g, " "));
  await env.DB.exec(workflowRevisionSql.replace(/\n/g, " "));
  // The indexes that live in migrations.sql, as a deploy builds them: the
  // columns are already in the fresh tables, so only those statements count.
  for (const sql of migrationIndexes) await env.DB.exec(sql);
});

const migrationIndexes = migrationsSql.split("\n").filter((line) => /^CREATE (UNIQUE )?INDEX IF NOT EXISTS/.test(line));
const workflowWebhookColumns = [
  'ALTER TABLE hx_workflow_held_events ADD COLUMN webhook_event_id TEXT',
  'ALTER TABLE hx_workflow_held_events ADD COLUMN payload_hash TEXT',
  'ALTER TABLE hx_workflows ADD COLUMN webhook_signature_required INTEGER NOT NULL DEFAULT 0 CHECK(webhook_signature_required IN (0,1))',
  "CREATE TABLE IF NOT EXISTS hx_workflow_webhook_receipts (org_id TEXT NOT NULL, workflow_id TEXT NOT NULL REFERENCES hx_workflows(id) ON DELETE CASCADE, event_id TEXT NOT NULL, payload_hash TEXT NOT NULL, received_at TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('accepted','held','replayed')), run_id TEXT, held_event_id TEXT, PRIMARY KEY(org_id,workflow_id,event_id))",
];
const workflowBudgetColumns = [
  "ALTER TABLE hx_workflow_safety ADD COLUMN daily_run_limit INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE hx_workflow_safety ADD COLUMN weekly_run_limit INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE hx_workflow_safety ADD COLUMN monthly_run_limit INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE hx_workflow_safety ADD COLUMN budget_revision INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE hx_workflow_safety ADD COLUMN daily_ai_budget_micros INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE hx_workflow_safety ADD COLUMN weekly_ai_budget_micros INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE hx_workflow_safety ADD COLUMN monthly_ai_budget_micros INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE hx_workflow_safety ADD COLUMN ai_budget_action TEXT NOT NULL DEFAULT 'warn'",
  "ALTER TABLE hx_workflow_usage ADD COLUMN estimated_micros INTEGER CHECK(estimated_micros>=0)",
  "CREATE TABLE IF NOT EXISTS hx_workflow_ai_budget_notices (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workflow_id TEXT NOT NULL, period TEXT NOT NULL CHECK(period IN ('24h','7d','30d')), budget_revision INTEGER NOT NULL, bucket_start TEXT NOT NULL, run_id TEXT NOT NULL, recipient_id TEXT NOT NULL, estimated_micros INTEGER NOT NULL, limit_micros INTEGER NOT NULL, unpriced_calls INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, delivered_at TEXT, last_attempt_at TEXT, UNIQUE(org_id,workflow_id,period,budget_revision,bucket_start))",
];
