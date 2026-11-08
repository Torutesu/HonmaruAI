import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import { createWorkflow, workflowRunSummary } from '../src/harness/workflows.js';
import { upsertMembership, upsertUser, upsertBusiness } from '../src/db.js';

const org = 'summary-workspace';
const owner = 'summary-owner';
const admin = 'summary-admin';
let workflow;

beforeEach(async () => {
  await upsertUser(env.DB, { githubId: owner, login: owner, name: 'Owner', locale: 'en' });
  await upsertUser(env.DB, { githubId: admin, login: admin, name: 'Admin', locale: 'en' });
  await upsertMembership(env.DB, org, owner, 'member');
  await upsertMembership(env.DB, org, admin, 'admin');
  await upsertBusiness(env.DB, org, { name: 'Summary workspace', createdBy: owner });
  const result = await createWorkflow(env.DB, org, { name: 'Summary', trigger: { type: 'manual' }, steps: [{ type: 'approval', to: owner, title: 'Approve', summary: 'Summary' }] }, owner);
  workflow = result.workflow;
  expect(workflow).toBeTruthy();
});

async function addRun(id, startedAt, durationMs, status = 'done', input = null) {
  const finishedAt = new Date(Date.parse(startedAt) + durationMs).toISOString();
  await env.DB.prepare(`INSERT INTO hx_workflow_runs
    (id,org_id,workflow_id,trigger,status,input,log,next_step,started_by,started_at,finished_at)
    VALUES(?1,?2,?3,'manual',?4,?5,'[]',0,?6,?7,?8)`)
    .bind(id, org, workflow.id, status, input ? JSON.stringify(input) : null, owner, startedAt, finishedAt).run();
}

async function addUsage(id, micros) {
  await env.DB.prepare(`INSERT INTO hx_workflow_usage
    (id,org_id,workflow_id,run_id,step_number,provider,model,input_tokens,output_tokens,byok,created_at,estimated_micros)
    VALUES(?1,?2,?3,?4,1,'test','known-model',100,100,0,?5,?6)`)
    .bind(`usage-${id}`, org, workflow.id, id, new Date().toISOString(), micros).run();
}

test('seven-day summary reports median duration and excludes runs the viewer cannot open', async () => {
  await env.DB.prepare(`INSERT INTO hx_apps(id,org_id,name,table_id,definition,created_by,created_at,updated_at)
    VALUES('private-app',?1,'Private app','private-table','{}',?3,?2,?2)`)
    .bind(org, new Date().toISOString(), owner).run();
  await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES(?1,'private-app','private',1)")
    .bind(org).run();

  const now = Date.now();
  const instant = (agoMs) => new Date(now - agoMs).toISOString();
  await addRun('fast', instant(10_000), 1_000);
  await addRun('slow', instant(20_000), 9_000, 'failed');
  await addRun('private', instant(5_000), 3_000, 'done', { records: [{ appId: 'private-app' }] });
  await addRun('old', instant(8 * 24 * 60 * 60 * 1000), 7_000);
  await addUsage('fast', 123);
  await addUsage('slow', 234);
  await addUsage('private', 987654);
  await addUsage('old', 54321);

  const hiddenFromAdmin = await workflowRunSummary(env.DB, org, workflow.id, admin);
  const visibleToOwner = await workflowRunSummary(env.DB, org, workflow.id, owner);
  expect(hiddenFromAdmin).toMatchObject({
    timezone: 'UTC', windowHours: 168, runCount: 2, failedCount: 1,
    completedDurationCount: 2, typicalDurationMs: 5_000,
    usage: { calls: 2, estimatedMicros: 357, trackedRuns: 2 }, truncated: false,
  });
  expect(visibleToOwner).toMatchObject({
    runCount: 3, failedCount: 1, completedDurationCount: 3, typicalDurationMs: 3_000,
    usage: { calls: 3, estimatedMicros: 988011, trackedRuns: 3 }, truncated: false,
  });
});

test('empty workflow summary exposes its UTC window without inventing usage', async () => {
  const summary = await workflowRunSummary(env.DB, org, workflow.id, owner);
  expect(summary).toMatchObject({
    timezone: 'UTC', windowHours: 168, runCount: 0, failedCount: 0,
    completedDurationCount: 0, typicalDurationMs: null,
    usage: { trackedRuns: 0, calls: 0, estimatedMicros: 0 }, truncated: false,
  });
  expect(Date.parse(summary.windowEnd) - Date.parse(summary.windowStart)).toBe(168 * 60 * 60 * 1000);
});
