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
const workflowBudgetColumns = [
  "ALTER TABLE hx_workflow_safety ADD COLUMN daily_run_limit INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE hx_workflow_safety ADD COLUMN weekly_run_limit INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE hx_workflow_safety ADD COLUMN monthly_run_limit INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE hx_workflow_safety ADD COLUMN budget_revision INTEGER NOT NULL DEFAULT 0",
];
